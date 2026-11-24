import { createServer, request } from 'node:http';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { dotCallbackHost, publicIPv4 } from './dot-egress-transport.mjs';

const authority = `${dotCallbackHost}:443`;
const reject = (socket, status, label) => socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

export function createDotEgress(upstream, resolveHost = lookup) {
  const proxy = new URL(upstream);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || proxy.username || proxy.password
    || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('Dot egress requires a local HTTP proxy.');
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ relay: 'weixin-dot-only' }));
  });
  server.on('connect', async (req, client, input) => {
    client.on('error', () => client.destroy());
    if (req.url !== authority) { reject(client, 403, 'Forbidden'); return; }
    const controller = new AbortController();
    client.once('close', () => controller.abort());
    try {
      const addresses = await resolveHost(dotCallbackHost, { family: 4, all: true });
      if (client.destroyed) return;
      if (!addresses.length || !addresses.every(item => publicIPv4(item.address))) { reject(client, 502, 'Bad Gateway'); return; }
      const destination = `${addresses[0].address}:443`;
      const connect = request({ hostname: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: destination,
        headers: { host: destination }, agent: false, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]) });
      connect.on('error', () => { if (!client.destroyed) reject(client, 502, 'Bad Gateway'); });
      connect.on('connect', (response, upstreamSocket, head) => {
        upstreamSocket.on('error', () => client.destroy());
        if (client.destroyed || response.statusCode !== 200) {
          upstreamSocket.destroy();
          if (!client.destroyed) reject(client, 502, 'Bad Gateway');
          return;
        }
        client.once('close', () => upstreamSocket.destroy());
        upstreamSocket.once('close', () => client.destroy());
        client.setTimeout(35000, () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) client.write(head);
        if (input.length) upstreamSocket.write(input);
        client.pipe(upstreamSocket).pipe(client);
      });
      connect.end();
    } catch { if (!client.destroyed) reject(client, 502, 'Bad Gateway'); }
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.WEIXIN_BRIDGE_DOT_EGRESS_PORT ?? 17868);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid Dot egress port.');
  const upstream = process.env.WEIXIN_BRIDGE_DOT_EGRESS_UPSTREAM;
  if (!upstream) throw Error('Configure WEIXIN_BRIDGE_DOT_EGRESS_UPSTREAM first.');
  createDotEgress(upstream)
    .listen(port, '127.0.0.1', () => console.log(`Dot callback relay listening on 127.0.0.1:${port}`));
}
