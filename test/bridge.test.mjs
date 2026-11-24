import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, startQueue } from '../src/core.mjs';
import { ILink, decodeWireJson, pollWeixin, sendOutbox } from '../src/ilink.mjs';
import { Dot, dotRpcTransport } from '../src/dot.mjs';

const account = 'bot-A';
const peer = 'owner';
const allowed = new Set([peer]);
const ready = () => null;
const message = (id, text, overrides = {}) => ({
  message_type: 1, message_id: id, from_user_id: peer, context_token: `ctx-${id}`,
  item_list: [{ type: 1, text_item: { text } }], ...overrides,
});

function memory(t) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.putTarget({ alias: 'first', kind: 'echo' });
  store.putTarget({ alias: 'second', kind: 'echo' });
  store.select(account, peer, 'first');
  return store;
}

async function until(predicate, ms = 4000) {
  const stop = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > stop) throw new Error('Timed out');
    await delay(25);
  }
}

test('route is snapshotted with cursor, one-shot overrides do not change it, and replay is ignored', t => {
  const store = memory(t);
  const batch = [message('1', 'before'), message('2', '/use second'), message('3', 'after'),
    message('4', '/to first one-shot'), message('5', 'keep second'),
    message('6', '/use first', { from_user_id: 'stranger' }), message('7', 'group', { group_id: 'group' })];
  store.ingest(account, batch, 'cursor-a', allowed, ready);
  store.ingest(account, batch, 'cursor-a', allowed, ready);
  assert.deepEqual(store.all('SELECT alias,prompt FROM jobs ORDER BY rowid').map(row => [row.alias, row.prompt]), [
    ['first', 'before'], ['second', 'after'], ['first', 'one-shot'], ['second', 'keep second'],
  ]);
  assert.equal(store.route(account, peer), 'second');
  assert.equal(store.get(`cursor:${account}`), 'cursor-a');
  assert.equal(store.one('SELECT count(*) AS count FROM inbox').count, 5);
  store.select(account, peer, 'first');
  store.ingest(account, [message('8', 'desktop switching')], 'cursor-b', allowed, ready);
  assert.equal(store.recent(account, peer)[0].alias, 'first');
});

test('long tasks and switches use distinct sessions and result recipients', async t => {
  const store = memory(t);
  const stop = new AbortController();
  const blocked = Promise.withResolvers();
  const seen = [];
  const worker = startQueue(store, async (target, job, ctx) => {
    seen.push([target.alias, job.prompt, ctx.session]);
    if (job.prompt === 'slow') await blocked.promise;
    ctx.saveSession(`${target.alias}-session`);
    return 'result';
  }, stop.signal, error => { throw error; });
  try {
    store.ingest(account, [message('1', 'slow')], null, allowed, ready);
    await until(() => seen.length === 1);
    store.ingest(account, [message('2', '/use second'), message('3', 'parallel')], null, allowed, ready);
    await until(() => store.recent(account, peer)[0].status === 'done');
    assert.equal(store.recent(account, peer).find(job => job.alias === 'first').status, 'running');
    store.select(account, peer, 'first');
    store.ingest(account, [message('4', 'resume')], null, allowed, ready);
    blocked.resolve();
    await until(() => store.recent(account, peer).every(job => job.status === 'done'));
    assert.deepEqual(seen, [['first', 'slow', undefined], ['second', 'parallel', undefined], ['first', 'resume', 'first-session']]);
    assert.equal(store.one("SELECT count(*) AS count FROM outbox WHERE peer=? AND job IS NOT NULL", peer).count, 3);
  } finally { blocked.resolve(); stop.abort(); await worker; }
});

test('restart retains selection and does not replay an uncertain run or send', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weixin-bridge-'));
  const file = join(dir, 'test.sqlite');
  let store;
  try {
    store = new Store(file);
    store.putTarget({ alias: 'persist', kind: 'echo' });
    store.select(account, peer, 'persist');
    store.ingest(account, [message('1', 'in flight'), message('2', 'queued')], 'saved', allowed, ready);
    store.run("UPDATE jobs SET status='running' WHERE prompt='in flight'");
    store.run("UPDATE outbox SET status='sending' WHERE rowid=1");
    store.db.close();
    store = new Store(file);
    store.recover();
    assert.equal(store.route(account, peer), 'persist');
    assert.equal(store.get(`cursor:${account}`), 'saved');
    assert.deepEqual(store.all('SELECT status FROM jobs ORDER BY rowid').map(row => row.status), ['interrupted', 'queued']);
    assert.equal(store.one('SELECT status FROM outbox WHERE rowid=1').status, 'unknown');
  } finally { store?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('iLink wire flow uses bound user, durable cursor and reply context and distinguishes unconfirmed delivery', async t => {
  const store = memory(t);
  const credentials = { id: account, owner: peer, token: 'mock-token', url: 'https://ilinkai.weixin.qq.com' };
  const seen = [];
  const client = new ILink(async (url, options) => {
    const data = options.body ? JSON.parse(options.body) : null;
    seen.push([url.pathname, data, options.headers.Authorization]);
    if (url.pathname.endsWith('get_bot_qrcode')) return Response.json({ qrcode: 'id', qrcode_img_content: 'https://example.test/qr' });
    if (url.pathname.endsWith('get_qrcode_status')) return Response.json({ status: 'confirmed', bot_token: credentials.token, ilink_bot_id: account, ilink_user_id: peer });
    if (url.pathname.endsWith('getupdates') && !data.get_updates_buf) return Response.json({ ret: 0, msgs: [message('999', '/agents')], get_updates_buf: 'next' });
    return Response.json({ ret: 0 });
  });
  const controller = new AbortController();
  const qr = await client.qr(controller.signal);
  assert.deepEqual((await client.qrStatus(qr, undefined, controller.signal)).account, credentials);
  const poll = pollWeixin(client, store, credentials, ready, controller.signal, () => {});
  const send = sendOutbox(client, store, () => credentials, controller.signal);
  try {
    await until(() => store.one("SELECT status FROM outbox WHERE status='unconfirmed'"));
    const sent = seen.find(([path]) => path.endsWith('sendmessage'));
    assert.equal(sent[1].msg.to_user_id, peer);
    assert.equal(sent[1].msg.context_token, 'ctx-999');
    assert.equal(sent[2], 'Bearer mock-token');
    assert.equal(store.get(`cursor:${account}`), 'next');
    assert.equal(decodeWireJson('{"message_id":18446744073709551615}').message_id, '18446744073709551615');
  } finally { controller.abort(); await Promise.all([poll, send]); }
});

test('Dot completes a verified subscription and scopes replies to the addressed target', async t => {
  const store = memory(t);
  store.putTarget({ alias: 'my-dot', kind: 'dot' });
  store.putTarget({ alias: 'other-dot', kind: 'dot' });
  const signal = AbortSignal.timeout(4000);
  const events = [];
  const dot = new Dot(store, 'test-master-key', { deliver: async (_sub, _id, body) => {
    events.push(body);
    return body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '{}';
  } });
  const name = 'weixin.message.received';
  const initialization = await dot.rpc('my-dot', { method: 'initialize', params: { protocolVersion: '2025-03-26' } }, signal);
  assert.deepEqual(initialization.capabilities.events, {});
  const discover = { method: 'server/discover' };
  const discovered = dotRpcTransport(discover, {}).response(await dot.rpc('my-dot', discover, signal));
  assert.deepEqual(discovered.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discovered.capabilities.events, {});
  assert.equal(discovered.resultType, 'complete');
  const list = { method: 'events/list' };
  const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'events/list' };
  const definitions = dotRpcTransport(list, headers).response(await dot.rpc('my-dot', list, signal));
  assert.equal(definitions.resultType, 'complete');
  assert.deepEqual(definitions.events.find(event => event.name === name).delivery, ['webhook']);
  assert.throws(() => dotRpcTransport(list, { ...headers, 'mcp-method': 'tools/list' }), { rpcCode: -32020 });
  await dot.rpc('my-dot', { method: 'events/subscribe', params: { name, delivery: {
    mode: 'webhook', url: 'https://chatgpt.com/test-only', secret: `whsec_${Buffer.alloc(32).toString('base64')}`,
  } } }, signal);
  const job = { id: 'mock-job', created: Date.now(), prompt: 'private prompt' };
  const run = dot.dispatch(store.target('my-dot'), job, signal);
  await until(() => events.some(event => event.name === name));
  const call = (alias, tool, values = {}) => dot.rpc(alias, { method: 'tools/call', params: {
    name: tool, arguments: { job_id: job.id, ...values },
  } }, signal);
  assert.equal((await call('other-dot', 'get_message')).isError, true);
  assert.equal((await call('my-dot', 'get_message')).content[0].text, job.prompt);
  assert.equal((await call('my-dot', 'reply', { text: 'reply body' })).isError, undefined);
  assert.equal(await run, 'reply body');
  const old = dot.capability('my-dot');
  dot.unbind('my-dot');
  assert.equal(dot.authorized('my-dot', old), false);
});
