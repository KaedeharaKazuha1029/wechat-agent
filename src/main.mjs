import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, startQueue, usesMcp, usesMcpEvents } from './core.mjs';
import { createAdapters, validateTarget } from './adapters.mjs';
import { ILink, pollWeixin, sendOutbox } from './ilink.mjs';
import { Dot, dotRpcTransport } from './dot.mjs';
import { DotOAuth } from './oauth.mjs';
import { loadCloudKey, validCloudKey } from './hosted-cloud.mjs';
import { PublicAdmin } from './public-admin.mjs';
import { cloudApiFetch } from './dot-egress-transport.mjs';

const demo = process.argv.includes('--demo');
const root = resolve(process.env.WEIXIN_BRIDGE_DATA ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'WeixinBridge'));
const stateDir = join(root, demo ? 'demo' : 'live');
const port = Number(process.env.WEIXIN_BRIDGE_PORT ?? 17865);
const dotPort = Number(process.env.WEIXIN_BRIDGE_DOT_PORT ?? 0);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(dotPort) || dotPort < 0 || dotPort > 65535 || port === dotPort) {
  throw new Error('管理面板与 Dot 必须使用不同的有效端口。');
}
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const lock = new DatabaseSync(join(stateDir, 'service-lock.sqlite'));
try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
catch { lock.close(); throw new Error('这个数据目录已有一个桥接服务在运行。'); }
const cloudEnabled = process.env.WEIXIN_BRIDGE_CLOUD_ENABLED === '1';
const store = new Store(join(stateDir, 'bridge.sqlite'), { cloudEnabled });
store.recover();
const abort = new AbortController();
const log = error => console.error(error.message);
const csrf = randomBytes(32).toString('base64url');
const adminOrigin = `http://127.0.0.1:${port}`;
const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const client = new ILink();
const dotKey = store.get('dot-key') ?? randomBytes(32).toString('base64url');
store.set('dot-key', dotKey);
const suffixes = process.env.WEIXIN_BRIDGE_DOT_CALLBACK_DOMAINS?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const dot = new Dot(store, dotKey, { ...(suffixes?.length ? { suffixes } : {}), proxySocket: process.env.WEIXIN_BRIDGE_DOT_PROXY_SOCKET });
const oauth = dotPort && !demo ? new DotOAuth(store, process.env.WEIXIN_BRIDGE_DOT_PUBLIC_ORIGIN ?? '') : null;
const publicAdmin = oauth && process.env.WEIXIN_BRIDGE_PUBLIC_ADMIN === '1' ? new PublicAdmin(store, oauth.origin) : null;
if (oauth && !store.get('dot-oauth-initialized')) {
  for (const target of store.targets()) if (usesMcpEvents(target.kind)) dot.unbind(target.alias);
  store.set('dot-oauth-initialized', true);
}
const cloudKeyPath = join(stateDir, 'cloud-openai.key');
const cloudSocket = process.env.WEIXIN_BRIDGE_CLOUD_API_PROXY_SOCKET;
const adapters = createAdapters(dot, demo, { cloudKeyPath, cloudRequest: cloudSocket ? cloudApiFetch(cloudSocket) : undefined });
const readiness = target => !oauth && (usesMcp(target.kind) || usesMcpEvents(target.kind)) ? '未启用 MCP OAuth' : adapters.readiness(target);
const demoAccount = { id: 'demo', owner: 'demo-owner' };
const demoReplies = [];
let account = demo ? demoAccount : store.get('account');
let connection = account ? '正在连接微信。' : '未绑定微信。';
let binding;
let polling;

if (demo && !store.targets().length) {
  store.putTarget({ alias: 'fast', kind: 'echo' });
  store.putTarget({ alias: 'slow', kind: 'echo' });
  store.select(demoAccount.id, demoAccount.owner, 'fast');
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('请求必须是 JSON。');
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 65536) throw new Error('请求太大。');
    parts.push(part);
  }
  const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('请求格式错误。');
  return data;
}

function safeEquals(value, expected) {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function enablePolling() {
  if (demo || !account) return;
  polling?.cancel.abort();
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, abort.signal]);
  const run = pollWeixin(client, store, account, readiness, signal, message => { if (!signal.aborted) connection = message; }).catch(log);
  polling = { cancel, run };
}

async function bind(current) {
  const signal = AbortSignal.any([abort.signal, current.cancel.signal]);
  try {
    let render;
    try { render = (await import('qrcode')).default; } catch { /* The demo has no dependencies. */ }
    if (!render) throw new Error('需要本地二维码库。请在桥接目录执行 npm.cmd install 后重启。');
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
      const qr = await client.qr(signal);
      current.image = await render.toDataURL(qr.content, { width: 256, margin: 3 });
      current.status = 'wait';
      const expiry = Date.now() + 150000;
      while (!signal.aborted && Date.now() < expiry) {
        if (current.status.includes('need_verifycode') && !current.pin) {
          await delay(200, undefined, { signal });
          continue;
        }
        const pin = current.pin;
        current.pin = undefined;
        let result;
        try { result = await client.qrStatus(qr, pin, signal); }
        catch (error) {
          if (signal.aborted || !error.message.includes('请求失败')) throw error;
          if (pin) current.pin = pin;
          await delay(1000, undefined, { signal });
          continue;
        }
        current.status = result.status;
        if (result.account) {
          const nextAccount = result.account;
          if (account && account.id !== nextAccount.id) throw new Error('此数据目录已关联另一个微信 Bot。请用新的 WEIXIN_BRIDGE_DATA 目录绑定。');
          if (account && account.owner !== nextAccount.owner) throw new Error('本地数据属于另一个微信用户。');
          store.set('account', nextAccount);
          account = nextAccount;
          current.image = null;
          connection = '已绑定，正在连接微信。';
          enablePolling();
          return;
        }
        if (result.status === 'binded_redirect') throw new Error('微信表示 Bot 已绑定，未签发新凭证。请在微信里查看现有绑定。');
        if (['expired', 'verify_code_blocked'].includes(result.status)) break;
        await delay(350, undefined, { signal });
      }
    }
    if (!signal.aborted) throw new Error('二维码已过期，请重新开始绑定。');
  } catch (error) {
    if (!signal.aborted) { current.status = 'error'; current.error = error.message; }
  } finally {
    current.image = null;
    current.pin = undefined;
    current.running = false;
  }
}

function dashboard(external) {
  return {
    demo, connection: demo ? '模拟微信已连接' : connection, bound: Boolean(account),
    route: account && store.route(account.id, account.owner),
    cloudEnabled, cloudChats: account && cloudEnabled ? store.cloudChats(account.id, account.owner) : [],
    cloudKeyConfigured: cloudEnabled && Boolean(loadCloudKey(cloudKeyPath)),
    publicAdminAvailable: Boolean(publicAdmin) && !external,
    publicAdminConfigured: Boolean(publicAdmin?.configured()) && !external,
    targets: store.targets().map(({ revision, ...target }) => ({ ...target, unavailable: readiness(target),
      ...(oauth && usesMcp(target.kind) ? { mcpUrl: oauth.resource(target.alias) } : {}),
      ...(account && target.kind === 'chat' ? { chatSession: store.activeChatThread(account.id, account.owner, target.alias).code } : {}),
    })),
    jobs: account ? store.recent(account.id, account.owner) : [], demoReplies,
    binding: binding && { status: binding.status, image: binding.image, error: binding.error }, dotPort,
  };
}

async function handleAdmin(req, res, { external = false, path = req.url } = {}) {
  if (!external && req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: '请使用本机地址。' });
  if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
    const html = path === '/';
    res.writeHead(200, {
      'content-type': html ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    return res.end(html ? page.replace('__CSRF__', csrf).replaceAll('__ADMIN_BASE__', external ? '/admin' : '') : path.endsWith('.js') ? script : style);
  }
  if (!safeEquals(req.headers['x-bridge-admin'], csrf) || (req.method !== 'GET' && req.headers.origin !== (external ? oauth.origin : adminOrigin))) {
    return json(res, 403, { error: '页面已过期，请重新打开管理面板。' });
  }
  if (req.method === 'GET' && path === '/api/state') return json(res, 200, dashboard(external));
  if (req.method !== 'POST') return json(res, 404, { error: '找不到此页面。' });
  const data = await body(req);
  switch (path) {
    case '/api/target': {
      const target = validateTarget(data, demo);
      const previous = store.target(target.alias);
      if (usesMcp(previous?.kind) && previous.kind !== target.kind) {
        if (usesMcpEvents(previous.kind)) dot.unbind(target.alias);
        if (previous.kind === 'chat') store.run('DELETE FROM chat_client_threads WHERE alias=?', target.alias);
        oauth?.revoke(target.alias);
      }
      store.putTarget(target);
      break;
    }
    case '/api/route': {
      if (!account) throw new Error('请先绑定微信。');
      store.select(account.id, account.owner, String(data.alias ?? ''));
      break;
    }
    case '/api/cloud': {
      if (!cloudEnabled) return json(res, 404, { error: 'Codex Cloud 已停用。' });
      if (!account) throw new Error('请先绑定微信。');
      if (data.action === 'new') return json(res, 200, store.tx(() => store.openCloud(account.id, account.owner, String(data.alias ?? '') || undefined, data.title)));
      if (data.action === 'select') return json(res, 200, store.tx(() => store.useCloud(account.id, account.owner, String(data.code ?? ''))));
      throw new Error('未知云会话操作。');
    }
    case '/api/cloud-key': {
      if (!cloudEnabled) return json(res, 404, { error: 'Codex Cloud 已停用。' });
      if (demo || !validCloudKey(data.key)) throw new Error('请输入有效的 OpenAI API 密钥。');
      const temporary = `${cloudKeyPath}.${randomUUID()}.next`;
      try {
        writeFileSync(temporary, data.key + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, cloudKeyPath);
      } finally { rmSync(temporary, { force: true }); }
      break;
    }
    case '/api/public-password': {
      if (external || !publicAdmin) return json(res, 404, { error: '找不到此操作。' });
      await publicAdmin.setPassword(data.password);
      break;
    }
    case '/api/bind': {
      if (demo) throw new Error('演示模式不连接微信。');
      if (binding?.running) throw new Error('正在等待扫码。');
      binding = { status: 'starting', running: true, cancel: new AbortController() };
      bind(binding).catch(log);
      break;
    }
    case '/api/cancel-bind': binding?.cancel.abort(); binding = undefined; break;
    case '/api/pin': {
      if (!binding?.running || !binding.status.includes('need_verifycode') || !/^\d{4,8}$/.test(data.pin)) throw new Error('请填入本次微信扫码显示的 PIN。');
      binding.pin = data.pin;
      break;
    }
    case '/api/dot-unbind': {
      const alias = String(data.alias);
      const target = store.target(alias);
      if (!usesMcp(target?.kind)) throw new Error('找不到此 MCP 目标。');
      if (usesMcpEvents(target.kind)) dot.unbind(alias);
      if (target.kind === 'chat') store.run('DELETE FROM chat_client_threads WHERE alias=?', alias);
      oauth?.revoke(alias);
      break;
    }
    case '/api/dot-pair': {
      if (!oauth) throw new Error('此服务未配置 MCP OAuth。');
      return json(res, 200, oauth.issuePair(String(data.alias ?? '')));
    }
    case '/api/demo': {
      if (!demo || typeof data.text !== 'string' || !data.text.trim()) throw new Error('请输入测试消息。');
      store.ingest(account.id, [{ message_type: 1, message_id: randomUUID(), from_user_id: account.owner,
        context_token: 'demo', item_list: [{ type: 1, text_item: { text: data.text } }] }], null, new Set([account.owner]), readiness);
      break;
    }
    default: return json(res, 404, { error: '找不到此操作。' });
  }
  return json(res, 200, { ok: true });
}

async function handleDot(req, res) {
  const url = new URL(req.url, oauth.origin);
  if (url.origin !== oauth.origin) return json(res, 404, { error: 'Not found' });
  if (publicAdmin && await publicAdmin.route(req, res, url, json, (req, res, path) => handleAdmin(req, res, { external: true, path }))) return;
  if (await oauth.route(req, res, url, json)) return;
  const alias = !url.search && oauth.aliasFor(`${oauth.origin}${url.pathname}`);
  if (!alias) return json(res, 404, { error: 'Not found' });
  if (!oauth.authorized(alias, req.headers.authorization)) {
    res.setHeader('WWW-Authenticate', oauth.challenge(alias));
    return json(res, 401, { error: 'unauthorized' });
  }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  // Browser cross-origin access is unnecessary for the server-to-server transport.
  if (req.headers.origin && !['https://chatgpt.com', 'https://chat.openai.com'].includes(req.headers.origin)) return json(res, 403, { error: 'Forbidden' });
  let rpc;
  try { rpc = await body(req); }
  catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  if (!Object.hasOwn(rpc, 'id')) { res.writeHead(202); return res.end(); }
  const trace = ['initialize', 'server/discover', 'tools/list', 'events/list', 'events/subscribe'].includes(rpc.method);
  try {
    const transport = dotRpcTransport(rpc, req.headers);
    const result = transport.response(await dot.rpc(alias, rpc, abort.signal));
    if (trace) console.info(`dot_mcp ${rpc.method} ${transport.protocol} ok target=${alias}`);
    return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
  } catch (error) {
    const code = error.rpcCode ?? -32602;
    if (trace) console.info(`dot_mcp ${rpc.method} error ${code}${error.reason ? ` ${error.reason}` : ''} target=${alias}${error.callbackHost ? ` callback_host=${error.callbackHost}` : ''}`);
    return json(res, error.httpStatus ?? 200, { jsonrpc: '2.0', id: rpc.id, error: {
      code, message: error.message, ...(error.reason ? { data: { reason: error.reason } } : {}),
    } });
  }
}

const wrap = handler => createServer((req, res) => handler(req, res).catch(error => {
  if (!res.headersSent) json(res, 400, { error: error.message });
  else res.end();
}));
const adminServer = wrap(handleAdmin);
const dotServer = dotPort && !demo ? wrap(handleDot) : null;
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
await listen(adminServer, port);
if (dotServer) await listen(dotServer, dotPort);
console.log(`${demo ? '微信桥接演示' : '微信桥接'} ${adminOrigin}`);
if (dotServer) console.log(`Dot MCP 可通过反向代理访问 127.0.0.1:${dotPort}`);
enablePolling();
const queue = startQueue(store, adapters.run, abort.signal, log);
const outbox = sendOutbox(client, store, () => account, abort.signal, demo ? item => {
  demoReplies.unshift({ text: item.body, id: item.id });
  if (demoReplies.length > 40) demoReplies.pop();
  return 'simulated';
} : undefined);

async function shutdown() {
  if (abort.signal.aborted) return;
  abort.abort();
  adminServer.close();
  dotServer?.close();
  if (binding?.running) binding.cancel.abort();
  await Promise.allSettled([queue, outbox, polling?.run]);
  if (account && !demo) await client.bot(account, 'msg/notifystop', {}, undefined, 2500).catch(() => {});
  store.db.close();
  lock.close();
}
process.on('SIGINT', () => shutdown().catch(log));
process.on('SIGTERM', () => shutdown().catch(log));
