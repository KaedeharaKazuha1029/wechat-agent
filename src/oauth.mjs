import { createHash, randomBytes } from 'node:crypto';
import { aliasPattern, usesMcp } from './core.mjs';

// Pre-register the exact client and redirect published in ChatGPT's CIMD document.
// This private server accepts only this client and never fetches user-supplied metadata URLs.
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const scopes = { dot: 'weixin.dot', chat: 'weixin.chat' };
const minute = 60 * 1000;
const hour = 60 * minute;
const accessLife = hour;
const refreshLife = 30 * 24 * hour;
const random = () => randomBytes(32).toString('base64url');
const hash = text => createHash('sha256').update(text).digest('base64url');
const value = /^[A-Za-z0-9_-]{43}$/;
const verifier = /^[A-Za-z0-9._~-]{43,128}$/;
const browserCookie = '__Host-wx-bridge-pair';

async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('Expected form data');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 8192) throw new Error('Form too large');
  }
  return new URLSearchParams(data);
}

function html(res, status, message, requestId) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>微信桥接授权</title>
    <style>body{font:16px/1.6 system-ui;max-width:34rem;margin:8vh auto;padding:0 1rem;background:#f3f7f5;color:#163529}main{background:white;border:1px solid #ceded6;border-radius:12px;padding:1.5rem}input,button{font:inherit;padding:.55rem .8rem;margin:.5rem 0}input{width:90%}button{background:#176249;border:0;color:white;border-radius:5px}</style>
    <main><h1>微信桥接授权</h1><p>${message}</p>${requestId ? `<p>授权后，ChatGPT 可读取分给该连接的任务，并回复到原微信会话。</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${requestId}"><label>一次性配对码<br><input name="pair" type="password" autocomplete="one-time-code" maxlength="32" required></label><br><button>授权连接</button></form>` : ''}</main></html>`);
}

export class DotOAuth {
  constructor(store, origin) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Dot OAuth 需要 HTTPS 公网源地址。');
    this.origin = parsed.origin;
    this.store = store;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS dot_oauth (
        kind TEXT NOT NULL, digest TEXT NOT NULL, alias TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(kind,digest)
      );
      CREATE INDEX IF NOT EXISTS dot_oauth_alias ON dot_oauth(kind,alias);
      CREATE INDEX IF NOT EXISTS dot_oauth_expiry ON dot_oauth(expires);
    `);
  }
  resource(alias) { return `${this.origin}/mcp/${alias}`; }
  scopeFor(alias) { return scopes[this.store.target(alias)?.kind]; }
  metaUrl(alias) { return `${this.origin}/.well-known/oauth-protected-resource/mcp/${alias}`; }
  metadata() {
    return { issuer: this.origin, authorization_endpoint: `${this.origin}/oauth/authorize`, token_endpoint: `${this.origin}/oauth/token`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: Object.values(scopes), client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true };
  }
  aliasFor(resource) {
    if (typeof resource !== 'string' || !resource.startsWith(`${this.origin}/mcp/`)) return null;
    const alias = resource.slice(`${this.origin}/mcp/`.length);
    return aliasPattern.test(alias) && usesMcp(this.store.target(alias)?.kind) ? alias : null;
  }
  challenge(alias) { return `Bearer resource_metadata="${this.metaUrl(alias)}", scope="${this.scopeFor(alias)}"`; }
  put(kind, secret, alias, data, life) {
    this.store.run('INSERT INTO dot_oauth VALUES (?,?,?,?,?)', kind, hash(secret), alias, JSON.stringify(data), Date.now() + life);
  }
  get(kind, secret) {
    const row = this.store.one('SELECT alias,data FROM dot_oauth WHERE kind=? AND digest=? AND expires>?', kind, hash(secret), Date.now());
    return row && { ...JSON.parse(row.data), alias: row.alias };
  }
  remove(kind, secret) { this.store.run('DELETE FROM dot_oauth WHERE kind=? AND digest=?', kind, hash(secret)); }
  purge() { this.store.run('DELETE FROM dot_oauth WHERE expires<=?', Date.now()); }
  issuePair(alias) {
    if (this.aliasFor(this.resource(alias)) !== alias) throw new Error('找不到此 MCP 目标。');
    const code = randomBytes(8).toString('hex').toUpperCase();
    this.store.tx(() => {
      this.purge();
      this.store.run("DELETE FROM dot_oauth WHERE kind='pair' AND alias=?", alias);
      this.put('pair', code, alias, {}, 10 * minute);
    });
    return { code, expiresIn: 600 };
  }
  revoke(alias) {
    this.store.run('DELETE FROM dot_oauth WHERE alias=?', alias);
    this.clearSubscriptions(alias);
  }
  clearSubscriptions(alias) {
    const workAlias = this.store.workForChat(alias)?.alias;
    this.store.run('DELETE FROM subscriptions WHERE id=? OR id=?', alias, workAlias ?? null);
    this.store.set(`dot-rev:${alias}`, random());
    if (workAlias) this.store.set(`dot-rev:${workAlias}`, random());
  }
  authorized(alias, header) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '');
    if (!match) return false;
    const grant = this.get('access', match[1]);
    return grant?.alias === alias && grant.resource === this.resource(alias) && grant.scope === this.scopeFor(alias) && grant.issuer === this.origin;
  }
  startAuthorization(params) {
    const request = {
      resource: params.get('resource'), challenge: params.get('code_challenge'), state: params.get('state'),
    };
    const alias = this.aliasFor(request.resource);
    if (!alias || params.get('response_type') !== 'code' || params.get('client_id') !== clientId || params.get('redirect_uri') !== redirectUri
      || params.get('code_challenge_method') !== 'S256' || !value.test(request.challenge ?? '')
      || !request.state || request.state.length > 1024 || (params.get('scope') && params.get('scope') !== this.scopeFor(alias))) return null;
    this.purge();
    if (this.store.one("SELECT count(*) AS n FROM dot_oauth WHERE kind='request'").n >= 100) return null;
    const id = random();
    this.put('request', id, alias, request, 10 * minute);
    return id;
  }
  authorize(id, pair) {
    if (!value.test(id) || !/^[a-f0-9]{16}$/i.test(pair)) return null;
    return this.store.tx(() => {
      const request = this.get('request', id);
      const owner = this.get('pair', pair.toUpperCase());
      if (!request || owner?.alias !== request.alias) return null;
      this.remove('pair', pair.toUpperCase());
      this.remove('request', id);
      const code = random();
      this.put('code', code, request.alias, { resource: request.resource, challenge: request.challenge }, 2 * minute);
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', request.state);
      redirect.searchParams.set('iss', this.origin);
      return redirect.href;
    });
  }
  token(params) {
    const flow = params.get('grant_type');
    const resource = params.get('resource');
    if (params.get('client_id') !== clientId) return { error: 'invalid_client' };
    if (!['authorization_code', 'refresh_token'].includes(flow)) return { error: 'unsupported_grant_type' };
    const exchanging = flow === 'authorization_code';
    if ((exchanging || resource) && !this.aliasFor(resource)) return { error: 'invalid_target' };
    const type = exchanging ? 'code' : 'refresh';
    const secret = params.get(exchanging ? 'code' : 'refresh_token') ?? '';
    if (!value.test(secret)) return { error: 'invalid_grant' };
    return this.store.tx(() => {
      const grant = this.get(type, secret);
      const alias = this.aliasFor(grant?.resource);
      if (!alias || grant.alias !== alias || (resource && grant.resource !== resource)) return { error: 'invalid_grant' };
      const scope = this.scopeFor(alias);
      if (exchanging) {
        const proof = params.get('code_verifier') ?? '';
        if (params.get('redirect_uri') !== redirectUri || !verifier.test(proof) || hash(proof) !== grant.challenge) return { error: 'invalid_grant' };
        this.clearSubscriptions(alias);
      } else {
        if (grant.scope !== scope || grant.issuer !== this.origin) return { error: 'invalid_grant' };
        if (params.get('scope') && params.get('scope') !== scope) return { error: 'invalid_scope' };
      }
      this.remove(type, secret);
      this.store.run("DELETE FROM dot_oauth WHERE alias=? AND kind IN ('access','refresh')", alias);
      const access = random(), refresh = random();
      const details = { resource: grant.resource, scope, issuer: this.origin };
      this.put('access', access, alias, details, accessLife);
      this.put('refresh', refresh, alias, details, refreshLife);
      return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: accessLife / 1000, scope };
    });
  }
  async route(req, res, url, json) {
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, this.metadata());
      return true;
    }
    const resourceMatch = /^\/\.well-known\/oauth-protected-resource\/mcp\/([a-z0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && resourceMatch) {
      const resource = this.resource(resourceMatch[1]);
      if (!this.aliasFor(resource)) json(res, 404, { error: 'not_found' });
      else json(res, 200, { resource, authorization_servers: [this.origin], scopes_supported: [this.scopeFor(resourceMatch[1])], bearer_methods_supported: ['header'] });
      return true;
    }
    if (url.pathname === '/oauth/authorize') {
      if (req.method === 'GET') {
        const id = this.startAuthorization(url.searchParams);
        if (id) res.setHeader('Set-Cookie', `${browserCookie}=${id}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`);
        html(res, id ? 200 : 400, id ? '请在本机微信桥接面板生成配对码，并在此输入。' : '授权请求无效，请从 ChatGPT 插件设置重新打开。', id);
      } else if (req.method === 'POST' && (!req.headers.origin || req.headers.origin === 'null' || req.headers.origin === this.origin)) {
        const params = await readForm(req);
        const id = params.get('request') ?? '';
        const cookie = (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${browserCookie}=`));
        if (!value.test(id) || cookie !== `${browserCookie}=${id}`) {
          html(res, 400, '授权页面已过期，请从 ChatGPT 插件设置重新打开。');
          return true;
        }
        const redirect = this.authorize(id, (params.get('pair') ?? '').trim());
        if (redirect) {
          res.setHeader('Set-Cookie', `${browserCookie}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
          res.writeHead(303, { location: redirect, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
          res.end();
        }
        else html(res, 400, '配对码无效或已过期。请从本机面板重新获取。', value.test(id) && this.get('request', id) ? id : undefined);
      } else json(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      let result;
      try { result = this.token(await readForm(req)); } catch { result = { error: 'invalid_request' }; }
      json(res, result.error ? 400 : 200, result);
      return true;
    }
    return false;
  }
}
