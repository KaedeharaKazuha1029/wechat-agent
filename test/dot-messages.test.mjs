import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core.mjs';
import { Dot } from '../src/dot.mjs';
import { cloudApiFetch } from '../src/dot-egress-transport.mjs';

test('Dot replies produce standalone bubbles without queue notices or task IDs', async t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.putTarget({ alias: 'dot', kind: 'dot' });
  store.handleMessage('bot', 'owner', '/dot 测试', () => null);
  const job = store.one('SELECT * FROM jobs');
  assert.equal(store.one('SELECT count(*) n FROM outbox').n, 0);
  store.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
  const dot = new Dot(store, 'test-key');
  let result;
  dot.pending.set(job.id, { alias: 'dot', resolve: messages => { result = messages; } });
  const args = { job_id: job.id, messages: ['第一条\n保留换行', '第二条'] };
  await dot.rpc('dot', { method: 'tools/call', params: { name: 'reply', arguments: args } });
  await dot.rpc('dot', { method: 'tools/call', params: { name: 'reply', arguments: { ...args, messages: ['不能覆盖'] } } });
  store.finish(job, 'done', result);
  assert.deepEqual(store.all('SELECT body FROM outbox ORDER BY rowid').map(row => row.body), args.messages);
  assert.equal(store.recent('bot', 'owner')[0].title, '测试');
});

test('proactive messages go only to the bound owner and replaying a batch does not enqueue twice', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.set('account', { id: 'bot', owner: 'owner' });
  assert.throws(() => store.pushDot('dot', 'notification-0001', ['hi']), /上下文/);
  store.run('INSERT INTO contexts VALUES (?,?,?)', 'bot', 'owner', 'fixture');
  const ids = store.pushDot('dot', 'notification-0001', ['甲', '乙']);
  assert.deepEqual(store.pushDot('dot', 'notification-0001', ['甲', '乙']), ids);
  assert.throws(() => store.pushDot('dot', 'notification-0001', ['其他消息']), /不同/);
  assert.deepEqual(store.all('SELECT peer,body FROM outbox ORDER BY rowid').map(row => [row.peer, row.body]), [['owner', '甲'], ['owner', '乙']]);
});

test('the cloud proxy client rejects unrelated hosts and OpenAI endpoints', async () => {
  const request = cloudApiFetch('/unused.sock');
  await assert.rejects(request('https://example.com/v1/models', {}), /not authorized/);
  await assert.rejects(request('https://api.openai.com/v1/files', {}), /not authorized/);
});
