import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://ilinkai.weixin.qq.com';
const version = '3.0.0';
const clientVersion = String((3 << 16));
const requestTimeout = Symbol('poll timeout');

function weixinOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)+weixin\.qq\.com$/i.test(url.hostname)
      || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('微信返回的 API 地址未通过校验。');
  }
  return url.origin;
}

// Preserve IDs wider than the exact integer range of JavaScript numbers.
export function decodeWireJson(body) {
  return JSON.parse(body, (key, value, context) => {
    if (key === 'message_id' && typeof value === 'number' && /^\d+$/.test(context?.source ?? '')) return context.source;
    return value;
  });
}

export class ILink {
  constructor(fetcher = fetch, base = origin) { this.fetch = fetcher; this.base = base; }
  async call(base, endpoint, { query, data, token, signal, timeout = 15000 } = {}) {
    const url = new URL(`/ilink/bot/${endpoint}`, base);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': clientVersion };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const deadline = AbortSignal.timeout(timeout);
    try {
      const response = await this.fetch(url, {
        method: data ? 'POST' : 'GET', headers, body: data && JSON.stringify(data), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!response.ok) throw new Error(`微信接口 ${endpoint} HTTP ${response.status}`);
      return decodeWireJson(await response.text());
    } catch (error) {
      if (deadline.aborted && !signal?.aborted && endpoint === 'getupdates') return requestTimeout;
      if (signal?.aborted) throw signal.reason;
      if (error.message?.startsWith('微信接口')) throw error;
      throw new Error(`微信接口 ${endpoint} 请求失败。`);
    }
  }
  async qr(signal) {
    const data = await this.call(this.base, 'get_bot_qrcode', { query: { bot_type: '3' }, data: { local_token_list: [] }, signal });
    if (typeof data.qrcode !== 'string' || !data.qrcode || typeof data.qrcode_img_content !== 'string' || !data.qrcode_img_content) {
      throw new Error(`未收到绑定二维码（微信返回 ${Number(data.errcode ?? data.ret ?? 0)}）。`);
    }
    return { id: data.qrcode, content: data.qrcode_img_content, base: this.base };
  }
  async qrStatus(qr, pin, signal) {
    const result = await this.call(qr.base, 'get_qrcode_status', {
      query: { qrcode: qr.id, ...(pin ? { verify_code: pin } : {}) }, timeout: 38000, signal,
    });
    if (result.status === 'scaned_but_redirect') qr.base = weixinOrigin(`https://${result.redirect_host}`);
    if (result.status === 'confirmed') {
      if (![result.bot_token, result.ilink_bot_id, result.ilink_user_id].every(s => typeof s === 'string' && s.length)) {
        throw new Error('微信未返回完整绑定凭证或账号身份，请重新绑定。');
      }
      return { status: result.status, account: {
        id: result.ilink_bot_id, owner: result.ilink_user_id, token: result.bot_token,
        url: weixinOrigin(result.baseurl || qr.base),
      } };
    }
    return { status: result.status || 'wait' };
  }
  async bot(account, endpoint, data, signal, timeout) {
    return this.call(account.url, endpoint, {
      data: { ...data, base_info: { channel_version: `${version}/weixin-bridge`, bot_agent: 'WeixinBridge/0.1.0' } },
      token: account.token, signal, timeout,
    });
  }
  updates(account, cursor, signal, timeout) { return this.bot(account, 'getupdates', { get_updates_buf: cursor }, signal, timeout); }
  async send(account, recipient, text, context, id = randomUUID(), signal) {
    if (!context) throw new Error('缺少微信回复上下文。');
    const data = await this.bot(account, 'sendmessage', { msg: {
      from_user_id: '', to_user_id: recipient, client_id: id,
      message_type: 2, message_state: 2, context_token: context,
      item_list: [{ type: 1, text_item: { text } }],
    } }, signal);
    if (data.ret != null && data.ret !== 0) throw new Error(`微信拒绝发送（${Number(data.ret)}）。`);
    if (data.errcode != null && data.errcode !== 0) throw new Error(`微信拒绝发送（${Number(data.errcode)}）。`);
    if (data.message_id != null) return 'accepted';
    if (data.ret === 0) return 'unconfirmed';
    throw new Error('微信返回了无法识别的发送回执。');
  }
}

export async function pollWeixin(client, store, account, readiness, signal, state) {
  const allowed = new Set([account.owner]);
  let timeout = 38000;
  let failures = 0;
  const sleep = ms => delay(ms, undefined, { signal }).catch(() => {});
  await client.bot(account, 'msg/notifystart', {}, signal, 5000).catch(() => {});
  while (!signal.aborted) {
    try {
      const cursor = store.get(`cursor:${account.id}`) ?? '';
      const data = await client.updates(account, cursor, signal, timeout);
      if (signal.aborted) break;
      if (data === requestTimeout) continue;
      const errorCodes = [data.errcode, data.ret];
      if (errorCodes.includes(-14)) { state('微信登录会话失效，请在电脑上重新扫码。'); return; }
      if (errorCodes.some(code => code !== undefined && code !== 0)) throw new Error(`微信收取消息失败（${Number(data.errcode || data.ret)}）。`);
      if (data.longpolling_timeout_ms > 0) timeout = Math.min(120000, Math.max(1000, data.longpolling_timeout_ms)) + 3000;
      store.ingest(account.id, Array.isArray(data.msgs) ? data.msgs : [], data.get_updates_buf, allowed, readiness);
      state('微信已连接，正在接收消息。');
      failures = 0;
      await sleep(200);
    } catch (error) {
      if (signal.aborted) break;
      state(error.message);
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)));
    }
  }
}

export async function sendOutbox(client, store, getAccount, signal, emitDemo) {
  while (!signal.aborted) {
    const account = getAccount();
    const item = account && store.one("SELECT * FROM outbox WHERE account=? AND peer=? AND status='pending' ORDER BY rowid LIMIT 1", account.id, account.owner);
    if (!item) {
      await delay(200, undefined, { signal }).catch(() => {});
      continue;
    }
    store.run("UPDATE outbox SET status='sending' WHERE id=?", item.id);
    try {
      const status = emitDemo ? emitDemo(item) : await client.send(account, item.peer, item.body,
        store.one('SELECT token FROM contexts WHERE account=? AND peer=?', item.account, item.peer)?.token, item.id, signal);
      store.run('UPDATE outbox SET status=? WHERE id=?', status, item.id);
    } catch (error) {
      const status = /缺少|拒绝/.test(error.message) ? 'failed' : 'unknown';
      store.run('UPDATE outbox SET status=?,detail=? WHERE id=?', status, error.message, item.id);
    }
  }
}
