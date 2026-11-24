import { createServer } from 'node:http';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createAdapters } from './adapters.mjs';

const port = Number(process.env.WEIXIN_BRIDGE_RUNNER_PORT ?? 17867);
const root = realpathSync(process.env.WEIXIN_BRIDGE_RUNNER_ROOT ?? process.cwd());
const token = readFileSync(process.env.WEIXIN_BRIDGE_RUNNER_TOKEN_FILE ?? '', 'utf8').trim();
if (!statSync(root).isDirectory() || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Runner 工作目录或令牌配置错误。');
if (!Number.isInteger(port) || port < 1024 || port > 65535 || process.env.WEIXIN_BRIDGE_CODEX_RUNNER_URL) throw new Error('Runner 端口或上游配置错误。');
const secret = Buffer.from(`Bearer ${token}`);
const adapters = createAdapters(null, false);
const allowed = ['codex-local', 'claude', 'deepseek'];
const active = new Set();

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) return send(res, 404, {});
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, busy: active.size > 0,
    kinds: allowed.filter(kind => !adapters.readiness({ kind, runtime: 'server' })) });
  if (req.url !== '/run' || req.method !== 'POST') return send(res, 404, {});
  let acquired;
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return send(res, 415, {});
    const parts = [];
    let size = 0;
    for await (const part of req) {
      size += part.length;
      if (size > 70_000) { send(res, 413, {}); return; }
      parts.push(part);
    }
    const task = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const kind = task?.kind ?? 'codex-local';
    if (typeof task?.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 16000 || task.write
      || !allowed.includes(kind)
      || typeof task.cwd !== 'string' || !isAbsolute(task.cwd) || realpathSync(task.cwd) !== root
      || (task.session !== undefined && (typeof task.session !== 'string' || !/^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(task.session)
        || (task.session.startsWith('session-') && kind !== 'deepseek')))) return send(res, 400, {});
    if (active.has(kind)) return send(res, 409, {});
    active.add(kind);
    acquired = kind;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.flushHeaders();
    let session;
    try {
      const text = await adapters.run({ alias: kind, kind, cwd: root, runtime: 'server' }, task, {
        signal: controller.signal, session: task.session, saveSession: id => { session = id; },
      });
      res.end(JSON.stringify({ ok: true, text, session }));
    } catch (error) { res.end(JSON.stringify({ ok: false, error: error.message, session })); }
  } catch { if (!res.headersSent) send(res, 400, {}); }
  finally { if (acquired) active.delete(acquired); }
});
server.listen(port, '127.0.0.1', () => console.log(`Windows Runner ready on 127.0.0.1:${port}`));
