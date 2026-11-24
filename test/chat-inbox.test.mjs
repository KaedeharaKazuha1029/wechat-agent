import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core.mjs';
import { Dot } from '../src/dot.mjs';
import { DotOAuth } from '../src/oauth.mjs';

test('Chat and Dot routes keep independent queues and a Chat reply can be queued just once', async t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.set('account', { id: 'account', owner: 'owner' });
  store.putTarget({ alias: 'chat', kind: 'chat' });
  store.putTarget({ alias: 'dot', kind: 'dot' });
  store.handleMessage('account', 'owner', '/use dot', () => null);
  store.handleMessage('account', 'owner', '/to chat chat prompt', () => null);
  store.handleMessage('account', 'owner', 'dot prompt', () => null);
  store.handleMessage('account', 'someone-else', '/to chat different owner', () => null);
  assert.equal(store.route('account', 'owner'), 'dot');
  const queued = store.one("SELECT id FROM jobs WHERE alias='dot'");
  store.recover();
  const router = new Dot(store, 'test-key');
  const call = (alias, name, args) => router.rpc(alias, { method: 'tools/call', params: { name, arguments: args } });
  const caps = await router.rpc('chat', { method: 'server/discover' });
  assert.equal(Object.hasOwn(caps.capabilities, 'events'), false);
  assert.deepEqual((await router.rpc('chat', { method: 'events/list' })).events, []);
  assert.deepEqual((await router.rpc('chat', { method: 'tools/list' })).tools.map(tool => tool.name), ['list_pending', 'get_message', 'reply']);
  const list = await call('chat', 'list_pending', {});
  assert.deepEqual(list.structuredContent.jobs.map(job => job.preview), ['chat prompt']);
  const job_id = list.structuredContent.jobs[0].job_id;
  assert.equal((await call('dot', 'get_message', { job_id })).isError, true);
  assert.equal((await call('chat', 'get_message', { job_id: queued.id })).isError, true);
  assert.equal((await call('chat', 'reply', { job_id: randomUUID(), text: 'wrong destination' })).isError, true);
  assert.equal((await call('chat', 'get_message', { job_id })).structuredContent.text, 'chat prompt');
  assert.equal((await call('chat', 'reply', { job_id, text: 'first' })).structuredContent.status, 'queued_for_weixin');
  assert.equal((await call('chat', 'reply', { job_id, text: 'second' })).structuredContent.status, 'already_replied');
  assert.equal((await call('chat', 'list_pending', {})).structuredContent.jobs.length, 0);
  assert.match(store.one('SELECT body FROM outbox WHERE job=? AND peer=?', job_id, 'owner').body, /first$/);
  assert.equal(store.one('SELECT count(*) AS n FROM outbox WHERE job=?', job_id).n, 1);
});

test('Chat advertises its own OAuth resource scope', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.putTarget({ alias: 'chat', kind: 'chat' });
  store.putTarget({ alias: 'dot', kind: 'dot' });
  const oauth = new DotOAuth(store, 'https://bridge.example.test');
  assert.equal(oauth.aliasFor(oauth.resource('chat')), 'chat');
  assert.match(oauth.challenge('chat'), /scope="weixin.chat"$/);
  assert.match(oauth.challenge('dot'), /scope="weixin.dot"$/);
});

test('plain /chat stays on the same session, and native chat hints keep old and new mailboxes separate', async t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.set('account', { id: 'account', owner: 'owner' });
  store.putTarget({ alias: 'chat', kind: 'chat' });
  store.putTarget({ alias: 'dot', kind: 'dot' });
  const send = text => store.handleMessage('account', 'owner', text, () => null);
  const router = new Dot(store, 'test-key');
  const tool = (hint, name, args = {}) => router.rpc('chat', { method: 'tools/call', params: { name, arguments: args,
    ...(hint ? { _meta: { 'openai/session': hint } } : {}) } });
  send('/chat first');
  store.run("UPDATE jobs SET target=json_remove(target,'$.chatCode') WHERE prompt='first'");
  send('/dot'); send('/chat'); send('/chat second');
  assert.equal(store.activeChatThread('account', 'owner', 'chat').code, 'h1');
  const first = (await tool('chatgpt-thread-old', 'list_pending')).structuredContent;
  assert.equal(first.chat_session, 'h1');
  assert.deepEqual(first.jobs.map(job => job.preview), ['first', 'second']);
  assert.equal((await tool('unexpected-different-thread', 'list_pending')).isError, true);
  send('/chat new Work'); send('/chat third');
  const second = (await tool('chatgpt-thread-new', 'list_pending')).structuredContent;
  assert.equal(second.chat_session, 'h2');
  assert.deepEqual(second.jobs.map(job => job.preview), ['third']);
  assert.equal((await tool('chatgpt-thread-old', 'list_pending')).structuredContent.chat_session, 'h1');
  assert.equal((await tool('chatgpt-thread-old', 'get_message', { job_id: second.jobs[0].job_id })).isError, true);
  assert.equal((await tool('chatgpt-thread-old', 'reply', { job_id: first.jobs[0].job_id, text: 'old reply' })).structuredContent.status, 'queued_for_weixin');
  assert.equal((await tool(undefined, 'list_pending', { chat_session: 'h1' })).structuredContent.jobs.length, 1);
  assert.equal((await tool(undefined, 'list_pending')).structuredContent.chat_session, 'h2');
});
