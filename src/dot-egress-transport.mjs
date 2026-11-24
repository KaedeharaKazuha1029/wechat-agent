import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

export const dotCallbackHost = 'connectors.api.openai.com';

export function publicIPv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

export function dotHttpsAgent(socketPath, hostname, signal) {
  if (hostname !== dotCallbackHost) throw new Error('Dot proxy destination not authorized');
  return egressAgent(socketPath, hostname, signal);
}

function egressAgent(socketPath, hostname, signal) {
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, done) => {
    const authority = `${hostname}:443`;
    const connect = httpRequest({
      socketPath, method: 'CONNECT', path: authority, headers: { host: authority }, agent: false, signal,
    });
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        done(new Error(`Dot proxy did not establish CONNECT (${response.statusCode})`));
        return;
      }
      // TLS stays end-to-end between the bridge and OpenAI. The proxy only forwards bytes.
      done(null, tlsConnect({ socket, servername: hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2' }));
    });
    connect.once('error', done);
    connect.end();
  };
  return agent;
}

export function cloudApiFetch(socketPath) {
  return async (input, options) => {
    const url = new URL(input);
    if (url.origin !== 'https://api.openai.com' || url.username || url.password || url.hash
      || !/^\/v1\/(agents\/sessions(?:[/?]|$)|models$)/.test(url.pathname)) throw new Error('Cloud API proxy destination not authorized');
    const agent = egressAgent(socketPath, url.hostname, options.signal);
    try {
      return await new Promise((resolve, reject) => {
        const req = httpsRequest(url, { method: options.method, headers: options.headers, signal: options.signal, agent }, res => {
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) res.destroy(new Error('Cloud API response too large'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
            const status = res.statusCode;
            const headers = Object.entries(res.headers).filter(([, value]) => value !== undefined);
            const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, headers }));
            } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end(options.body);
      });
    } finally { agent.destroy(); }
  };
}
