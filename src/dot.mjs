import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { chatInbox, chatTools } from './chat-inbox.mjs';
import { usesMcpEvents } from './core.mjs';
import { publicIPv4, dotCallbackHost, dotHttpsAgent } from './dot-egress-transport.mjs';

const eventName = 'weixin.message.received';
const modernVersion = '2026-07-28';
const serverInfo = { name: 'weixin-bridge', version: '0.1.5' };
const capabilities = { events: {}, tools: {} };
const subscriptionLife = 7 * 24 * 60 * 60 * 1000;
const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
const bubbleSchema = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 1200 } };
const validBubbles = items => Array.isArray(items) && items.length >= 1 && items.length <= 5
  && items.every(text => typeof text === 'string' && text.trim() && Array.from(text).length <= 1200);
const equals = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const callbackError = (reason, host) => Object.assign(new Error('无法验证 Dot 的回调。'), {
  rpcCode: -32015, reason, ...(host && /^[a-z0-9.-]{1,253}$/.test(host) ? { callbackHost: host } : {}),
});

export function dotRpcTransport(rpc, headers) {
  const declared = rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const protocol = headers['mcp-protocol-version'];
  const modern = rpc.method === 'server/discover' || protocol === modernVersion || declared === modernVersion;
  if (modern && ((rpc.method !== 'server/discover' && (protocol !== modernVersion || !headers['mcp-method']))
      || (protocol && protocol !== modernVersion) || (declared && declared !== modernVersion)
      || (headers['mcp-method'] && headers['mcp-method'] !== rpc.method)
      || (rpc.method === 'tools/call' && headers['mcp-name'] !== rpc.params?.name))) {
    throw Object.assign(new Error('MCP routing headers do not match the request'), { rpcCode: -32020, httpStatus: 400 });
  }
  return {
    response: result => modern ? { ...result, resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } } : result,
    protocol: modern ? modernVersion : 'legacy',
  };
}

async function signedPost(sub, id, payload, suffixes, signal, proxySocket) {
  let url;
  try { url = new URL(sub.url); } catch { throw callbackError('invalid_callback_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw callbackError('invalid_callback_url');
  if (!suffixes.some(name => url.hostname === name || url.hostname.endsWith(`.${name}`))) throw callbackError('callback_domain_denied', url.hostname);
  const scopedProxy = Boolean(proxySocket && url.hostname === dotCallbackHost);
  let addresses;
  if (!scopedProxy) {
    try { addresses = await lookup(url.hostname, { family: 4, all: true }); }
    catch { throw callbackError('callback_dns_failed', url.hostname); }
    if (!addresses.length || !addresses.every(({ address }) => publicIPv4(address))) throw callbackError('callback_address_denied', url.hostname);
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = createHmac('sha256', Buffer.from(sub.secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
  const deadline = AbortSignal.timeout(12000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  const agent = scopedProxy ? dotHttpsAgent(proxySocket, url.hostname, requestSignal) : null;
  try { return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', ...(agent ? { agent } : { family: 4, lookup(_host, _options, callback) { callback(null, addresses[0].address, 4); } }),
      signal: requestSignal, headers: {
        'content-type': 'application/json', accept: 'application/json', 'user-agent': `${serverInfo.name}/${serverInfo.version}`,
        'content-length': Buffer.byteLength(body), 'webhook-id': id,
        'webhook-timestamp': timestamp, 'webhook-signature': `v1,${mac}`, 'X-MCP-Subscription-Id': sub.id,
      },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('error', () => reject(callbackError('callback_connection_failed', url.hostname)));
      response.on('data', chunk => { text += chunk; if (text.length > 16000) req.destroy(callbackError('callback_response_too_large', url.hostname)); });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(text);
        else {
          let reason = `callback_http_${response.statusCode}`;
          if (response.statusCode === 403) {
            if (response.headers['cf-mitigated'] === 'challenge') reason += '_challenge';
            else if (/unsupported_country_region_territory|country or region banned/i.test(text)) reason += '_region';
            else if (/sorry, you have been blocked/i.test(text)) reason += '_edge_block';
          }
          reject(callbackError(reason, url.hostname));
        }
      });
    });
    req.on('error', error => reject(error.rpcCode ? error : callbackError(deadline.aborted ? 'timeout' : scopedProxy ? 'callback_proxy_failed' : 'callback_connection_failed', url.hostname)));
    req.end(body);
  }); } finally { agent?.destroy(); }
}

export class Dot {
  constructor(store, key, { suffixes = ['chatgpt.com', 'openai.com'], deliver = signedPost, proxySocket } = {}) {
    this.store = store;
    this.key = key;
    this.suffixes = suffixes;
    this.deliver = deliver;
    this.proxySocket = proxySocket;
    this.pending = new Map();
  }
  capability(alias) { return createHmac('sha256', this.key).update(`dot:${alias}:${this.store.get(`dot-rev:${alias}`) ?? ''}`).digest('base64url'); }
  authorized(alias, token) { return usesMcpEvents(this.store.target(alias)?.kind) && equals(token, this.capability(alias)); }
  unbind(alias) {
    this.store.tx(() => {
      this.store.run('DELETE FROM subscriptions WHERE id=?', alias);
      this.store.set(`dot-rev:${alias}`, randomUUID());
    });
  }
  subscription(alias) {
    const row = this.store.one('SELECT data FROM subscriptions WHERE id=?', alias);
    const sub = row && JSON.parse(row.data);
    return sub?.expires > Date.now() ? sub : null;
  }
  async subscribe(alias, params, signal) {
    const delivery = params.delivery ?? {};
    const secret = delivery.secret ?? delivery.signingSecret;
    if (params.name !== eventName || Object.keys(params.arguments ?? {}).length || delivery.mode !== 'webhook'
      || typeof delivery.url !== 'string' || typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/=]+$/.test(secret)
      || Buffer.from(secret.slice(6), 'base64').length < 24 || Buffer.from(secret.slice(6), 'base64').length > 64) {
      throw new Error('无效的 Dot 订阅参数。');
    }
    const current = this.subscription(alias);
    if (current && current.url !== delivery.url) throw new Error('该目标已有订阅。请先在电脑上解除绑定。');
    const capability = this.capability(alias);
    const ttl = params.ttlMs == null ? subscriptionLife : Math.min(subscriptionLife, params.ttlMs);
    if (!Number.isFinite(ttl) || ttl < 1000) throw new Error('无效的订阅有效期。');
    const sub = { id: current?.id ?? randomUUID(), url: delivery.url, secret, expires: Date.now() + ttl };
    const challenge = randomUUID();
    let payload, answer;
    try { payload = await this.deliver(sub, randomUUID(), { type: 'verification', challenge }, this.suffixes, signal, this.proxySocket); }
    catch (error) { throw error.rpcCode ? error : callbackError('callback_connection_failed'); }
    try { answer = JSON.parse(payload); } catch { throw callbackError('callback_invalid_json'); }
    if (!equals(answer?.challenge, challenge)) throw callbackError('challenge_failed');
    if (!this.authorized(alias, capability)) throw new Error('该目标在验证期间解除绑定。');
    const latest = this.subscription(alias);
    if (latest && latest.url !== sub.url) throw new Error('该目标已有订阅。');
    if (latest && latest.id !== sub.id) throw new Error('已有验证请求完成，请重试。');
    this.store.run('REPLACE INTO subscriptions VALUES (?,?)', alias, JSON.stringify(sub));
    return { id: sub.id, refreshBefore: new Date(sub.expires - Math.min(ttl / 2, 60 * 60 * 1000)).toISOString(), cursor: null, truncated: false };
  }
  async rpc(alias, request, signal) {
    const params = request.params ?? {};
    const target = this.store.target(alias);
    const isChat = target?.kind === 'chat';
    const isDot = target?.kind === 'dot';
    const work = isChat ? this.store.workForChat(alias) : null;
    const eventAlias = work?.alias ?? (isDot ? alias : null);
    const advertised = eventAlias ? capabilities : { tools: {} };
    switch (request.method) {
      case 'initialize': {
        const supported = ['2025-03-26', '2025-06-18', '2025-11-25'];
        return {
          protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : supported.at(-1),
          serverInfo, capabilities: advertised,
          instructions: isChat ? '手动领取时，用 list_pending 读取 /chat 待办。网页 Work 收到 /cloud 事件时，用事件的 job_id 调用 get_message 和 reply。'
            : '使用微信事件里的 job_id 调用 get_message 和 reply。需要多个气泡时传入 messages 数组，每个元素发成独立消息。'
              + (isDot ? '用户允许主动通知时，用 send_to_owner 发给已绑定的主人，不需要 job_id。' : ''),
        };
      }
      case 'server/discover': return { supportedVersions: [modernVersion], capabilities: advertised };
      case 'ping': return {};
      case 'events/list': return { events: !eventAlias ? [] : [{
        name: eventName, title: work ? '微信收到 Work 任务' : '微信收到任务', description: work ? '在路由到 /cloud 的微信消息到达时触发。' : '在路由到这个 Dot 的微信消息到达时触发。',
        delivery: ['webhook'],
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        payloadSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
      }] };
      case 'events/subscribe': {
        if (!eventAlias) throw Object.assign(new Error('这个 Chat 收件箱使用手动领取。'), { rpcCode: -32601 });
        return this.subscribe(eventAlias, params, signal);
      }
      case 'events/unsubscribe': {
        const sub = eventAlias && this.subscription(eventAlias);
        if (sub?.url === params.delivery?.url && params.name === eventName) this.store.run('DELETE FROM subscriptions WHERE id=?', eventAlias);
        return {};
      }
      case 'tools/list': return { tools: isChat ? chatTools : [
        { name: 'get_message', description: '读取本次微信任务的文字。', annotations: { readOnlyHint: true }, inputSchema: {
          type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false,
        } },
        { name: 'reply', description: '回复一个微信任务。text 发普通回复，messages 每个元素单独发一个气泡，两者选一个。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: {
          type: 'object', properties: { job_id: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 10000 }, messages: bubbleSchema },
          required: ['job_id'], additionalProperties: false,
        } },
        ...(isDot ? [{ name: 'send_to_owner', description: '主动向绑定的主人发微信，不需要 job_id。只在用户允许主动通知时用，每个 messages 元素各发一个气泡。重试同一次发送时复用 request_id。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: {
          type: 'object', properties: { request_id: { type: 'string', description: '本批通知的唯一标识，建议使用 UUID。' }, messages: bubbleSchema }, required: ['request_id', 'messages'], additionalProperties: false,
        } }] : []),
      ] };
      case 'tools/call': {
        const id = params.arguments?.job_id;
        const delivery = typeof id === 'string' ? this.pending.get(id) : null;
        const workReply = work && ['get_message', 'reply'].includes(params.name) && delivery?.alias === work.alias;
        const storedWork = work && !delivery && typeof id === 'string' && params.name === 'reply'
          && this.store.one("SELECT 1 FROM jobs WHERE id=? AND alias=? AND status='done'", id, work.alias);
        if (storedWork) return toolResult('该任务已接收过答复。');
        if (isChat && !workReply) return chatInbox(this.store, target, params.name, params.arguments, params._meta?.['openai/session']);
        if (params.name === 'send_to_owner') {
          const { request_id: requestId, messages } = params.arguments ?? {};
          if (target?.kind !== 'dot' || typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{6,128}$/.test(requestId) || !validBubbles(messages)) return toolResult('需要有效发送标识，以及 1 至 5 条微信消息。', true);
          try {
            const ids = this.store.pushDot(alias, requestId, messages);
            const until = Date.now() + 6500;
            let statuses;
            do {
              statuses = ids.map(id => this.store.one('SELECT status FROM outbox WHERE id=?', id)?.status ?? 'unknown');
              if (statuses.every(status => !['pending', 'sending'].includes(status)) || signal?.aborted) break;
              await delay(180, undefined, { signal }).catch(() => {});
            } while (Date.now() < until);
            const labels = { accepted: '微信接口已接收', pending: '等待发送', sending: '发送中', unconfirmed: '微信接口未明确确认', failed: '发送失败', unknown: '发送结果未知' };
            return toolResult(statuses.map((status, index) => `第 ${index + 1} 条：${labels[status] ?? status}`).join('\n'), statuses.every(status => status === 'failed'));
          } catch (error) { return toolResult(error.message, true); }
        }
        if (typeof id !== 'string' || id.length > 80) return toolResult('无效的任务 ID。', true);
        if (!delivery || delivery.alias !== (workReply ? work.alias : alias)) {
          const stored = this.store.one('SELECT alias,status FROM jobs WHERE id=?', id);
          if (stored?.alias === alias && stored.status === 'done' && params.name === 'reply') return toolResult('该任务已接收过答复。');
          return toolResult('任务不存在、已过期或不属于该目标。', true);
        }
        if (params.name === 'get_message') return toolResult(delivery.prompt);
        if (params.name === 'reply') {
          if (delivery.replied) return toolResult('该任务已接收过答复。');
          const { text, messages } = params.arguments;
          if (messages !== undefined ? text !== undefined || !validBubbles(messages) : typeof text !== 'string' || !text.trim() || text.length > 10000) {
            return toolResult('请填写 text，或用 messages 发送 1 至 5 个独立气泡。', true);
          }
          delivery.replied = true;
          delivery.resolve(messages ?? text);
          return toolResult(messages ? `已接收 ${messages.length} 个独立气泡，将分别发往微信。` : '桥接服务已接收答复。');
        }
        return toolResult('未知工具。', true);
      }
      default: throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    }
  }
  async dispatch(target, job, signal) {
    const sub = this.subscription(target.alias);
    const label = target.kind === 'work' ? 'Work' : 'Dot';
    if (!sub) throw new Error(`${label} 订阅不可用，请重新绑定。`);
    const id = `weixin_${job.id}`;
    const event = { eventId: id, name: eventName, timestamp: new Date(job.created).toISOString(), data: { job_id: job.id }, cursor: null };
    const reply = Promise.withResolvers();
    const cancelled = () => reply.reject(new Error(`${label} 未在等待期限内回传答复。`));
    reply.promise.catch(() => {});
    signal.throwIfAborted();
    signal.addEventListener('abort', cancelled, { once: true });
    this.pending.set(job.id, { alias: target.alias, prompt: job.prompt, resolve: reply.resolve });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await this.deliver(sub, id, event, this.suffixes, signal, this.proxySocket); break; }
        catch { if (attempt >= 2 || signal.aborted) throw new Error(`${label} 事件投递失败。`); }
        await delay(1000 * 2 ** attempt, undefined, { signal });
      }
      return await reply.promise;
    } finally {
      this.pending.delete(job.id);
      signal.removeEventListener('abort', cancelled);
    }
  }
}
