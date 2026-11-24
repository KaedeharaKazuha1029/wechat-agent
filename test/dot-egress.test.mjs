import { createServer, request } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDotEgress } from '../src/dot-egress-local.mjs';
import { dotCallbackHost, dotHttpsAgent } from '../src/dot-egress-transport.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
function probe(port, authority) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: authority,
      headers: { host: authority }, agent: false, signal: AbortSignal.timeout(3000) });
    req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.once('error', reject);
    req.end();
  });
}

test('Dot egress allows only the callback CONNECT and pins its validated public address', async t => {
  const seen = [];
  const upstream = createServer();
  upstream.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const proxyPort = await listen(upstream);
  t.after(() => upstream.close());
  let address = '104.18.33.45';
  const relay = createDotEgress(`http://127.0.0.1:${proxyPort}`, async host => {
    assert.equal(host, dotCallbackHost);
    return [{ address, family: 4 }];
  });
  const port = await listen(relay);
  t.after(() => relay.close());
  assert.equal(await probe(port, 'example.com:443'), 403);
  assert.equal(await probe(port, `${dotCallbackHost}:80`), 403);
  assert.equal(await probe(port, `${dotCallbackHost}:443`), 502);
  assert.deepEqual(seen, ['104.18.33.45:443']);
  address = '127.0.0.1';
  assert.equal(await probe(port, `${dotCallbackHost}:443`), 502);
  assert.deepEqual(seen, ['104.18.33.45:443']);
  assert.throws(() => dotHttpsAgent('/unused.sock', 'example.com', AbortSignal.timeout(1000)), /not authorized/);
});
