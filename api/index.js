export const runtime = 'edge';

const UUID = process.env.UUID || 'cb84c88d-6d6b-4b7b-a05f-b5d89507102e';

export default async function handler(req) {
  const upgrade = req.headers.get('upgrade') || '';

  if (upgrade.toLowerCase() !== 'websocket') {
    return new Response('VLESS is running on Vercel Edge ✓', { status: 200 });
  }

  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  handleVless(server, UUID);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function handleVless(ws, userID) {
  const expectedID = uuidToBytes(userID);

  ws.addEventListener('message', async ({ data }) => {
    try {
      const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
      const view = new DataView(buffer);

      // Check version
      if (view.getUint8(0) !== 0) { ws.close(1000); return; }

      // Verify UUID
      const given = new Uint8Array(buffer, 1, 16);
      if (!expectedID.every((b, i) => b === given[i])) { ws.close(1000); return; }

      const optLen = view.getUint8(17);
      let offset = 18 + optLen;

      const cmd = view.getUint8(offset++);
      if (cmd !== 1) { ws.close(1000); return; } // TCP only

      const port = view.getUint16(offset); offset += 2;
      const atype = view.getUint8(offset++);

      let host = '';
      if (atype === 1) {
        host = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
        offset += 4;
      } else if (atype === 2) {
        const len = view.getUint8(offset++);
        host = new TextDecoder().decode(new Uint8Array(buffer, offset, len));
        offset += len;
      } else if (atype === 3) {
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(view.getUint16(offset + i * 2).toString(16));
        host = `[${parts.join(':')}]`;
        offset += 16;
      }

      const tail = buffer.slice(offset);

      // Connect to target via TCP
      // @ts-ignore
      const tcpSocket = connect({ hostname: host, port });
      const writer = tcpSocket.writable.getWriter();

      // Send VLESS response header
      ws.send(new Uint8Array([0, 0]));

      if (tail.byteLength > 0) await writer.write(tail);

      ws.addEventListener('message', async ({ data }) => {
        try {
          const d = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
          await writer.write(d);
        } catch {}
      });

      ws.addEventListener('close', () => {
        try { writer.close(); } catch {}
      });

      // Pipe TCP → WS
      (async () => {
        const reader = tcpSocket.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(value);
          }
        } catch {}
        ws.close(1000);
      })();

    } catch (e) {
      ws.close(1000);
    }
  });
}
