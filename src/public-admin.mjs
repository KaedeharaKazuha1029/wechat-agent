import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const cookieName = '__Secure-weixin-admin';
const lifetime = 12 * 60 * 60 * 1000;
const failureWindow = 10 * 60 * 1000;
const digest = input => createHash('sha256').update(input).digest('base64url');
const passwordKey = 'public-admin-password';
const validPassword = password => typeof password === 'string' && !/[\r\n\0]/.test(password) && password.trim().length >= 16 && Buffer.byteLength(password) <= 128;
const cookie = (value, age) => `${cookieName}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${age}`;
const securityHeaders = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

async function parseLogin(req) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')) return null;
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 4096) return null;
    parts.push(part);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8')).get('password');
}

function loginPage(res, status, message) {
  res.writeHead(status, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>微信桥接管理</title>
    <style>body{font:16px/1.6 system-ui;max-width:35rem;margin:8vh auto;padding:0 1rem;background:#f3f7f5;color:#163529}main{background:white;border:1px solid #ceded6;border-radius:12px;padding:1.5rem}input,button{font:inherit;padding:.55rem .8rem;margin:.5rem 0}input{width:min(92%,27rem)}button{background:#176249;border:0;color:white;border-radius:5px}</style>
    <main><h1>微信桥接管理</h1><p>${message}</p><form method="post" action="/admin/login"><label>管理密码<br><input autofocus name="password" type="password" autocomplete="current-password" maxlength="128" required></label><br><button>登录</button></form></main></html>`);
}

function redirect(res, location, sessionCookie) {
  res.writeHead(303, { ...securityHeaders, location, ...(sessionCookie ? { 'set-cookie': sessionCookie } : {}) });
  res.end();
}

export class PublicAdmin {
  constructor(store, origin) {
    this.store = store;
    this.origin = origin;
    this.failures = new Map();
    this.checking = 0;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS admin_sessions (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  }
  configured() { return Boolean(this.store.get(passwordKey)); }
  async setPassword(password) {
    if (!validPassword(password)) throw new Error('管理密码至少 16 个字符，最多 128 字节。');
    const salt = randomBytes(24);
    const hash = await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
    this.store.tx(() => {
      this.store.set(passwordKey, { salt: salt.toString('base64url'), hash: hash.toString('base64url') });
      this.store.run('DELETE FROM admin_sessions');
    });
  }
  async login(password) {
    const record = this.store.get(passwordKey);
    if (!record || !validPassword(password)) return null;
    const expected = Buffer.from(record.hash, 'base64url');
    const actual = await derive(password, Buffer.from(record.salt, 'base64url'), 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
    if (!timingSafeEqual(expected, actual) || this.store.get(passwordKey)?.hash !== record.hash) return null;
    const token = randomBytes(32).toString('base64url');
    this.store.tx(() => {
      this.store.run('DELETE FROM admin_sessions WHERE expires<=?', Date.now());
      this.store.run('INSERT INTO admin_sessions VALUES (?,?)', digest(token), Date.now() + lifetime);
    });
    return token;
  }
  session(req) {
    const candidate = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
    const value = candidate?.slice(cookieName.length + 1);
    if (!value || !/^[a-z0-9_-]{43}$/i.test(value)) return null;
    const key = digest(value);
    return this.store.one('SELECT 1 FROM admin_sessions WHERE digest=? AND expires>?', key, Date.now()) ? key : null;
  }
  async route(req, res, url, json, serve) {
    const path = url.pathname;
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    if (req.headers.host !== new URL(this.origin).host) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    if (path === '/admin/login') {
      if (req.method === 'GET') loginPage(res, 200, '请输入管理密码。');
      else if (req.method === 'POST' && req.headers.origin === this.origin) {
        const source = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64);
        const now = Date.now();
        for (const [ip, row] of this.failures) if (row.until <= now) this.failures.delete(ip);
        const recent = this.failures.get(source);
        if (this.checking >= 2 || (recent?.count ?? 0) >= 8 || (this.failures.size >= 512 && !recent)) {
          loginPage(res, 429, '暂时无法继续尝试，请稍后重试。');
          return true;
        }
        this.checking++;
        try {
          const password = await parseLogin(req);
          const token = await this.login(password);
          if (token) {
            this.failures.delete(source);
            redirect(res, '/admin', cookie(token, lifetime / 1000));
          } else {
            const previous = this.failures.get(source);
            this.failures.set(source, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + failureWindow });
            loginPage(res, 401, '密码不正确，或后台尚未设置密码。');
          }
        } finally { this.checking--; }
      } else json(res, 403, { error: 'Forbidden' });
      return true;
    }
    const session = this.session(req);
    if (!session) {
      if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) redirect(res, '/admin/login');
      else json(res, 401, { error: '请登录或重新登录管理后台。' });
      return true;
    }
    if (path === '/admin/logout' && req.method === 'POST' && req.headers.origin === this.origin) {
      this.store.run('DELETE FROM admin_sessions WHERE digest=?', session);
      redirect(res, '/admin/login', cookie('', 0));
      return true;
    }
    await serve(req, res, path.slice('/admin'.length) || '/');
    return true;
  }
}
