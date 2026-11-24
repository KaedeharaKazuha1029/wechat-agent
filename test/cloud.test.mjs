import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core.mjs';
import { runHostedCloud } from '../src/hosted-cloud.mjs';

test('owner switches between Dot, Chat and two independent short cloud sessions', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  for (const [alias, kind] of [['dot','dot'], ['chat','chat'], ['cloud','codex-cloud'], ['local','codex-local'], ['cc','claude'], ['dsh','deepseek']]) store.putTarget({ alias, kind });
  const send = text => store.handleMessage('account','peer',text, () => null);
  assert.equal(store.route('account','peer'), 'dot');
  send('/chat 这条给 Chat');
  assert.equal(store.route('account','peer'), 'chat');
  send('/cc'); assert.equal(store.route('account','peer'), 'cc');
  send('/dsh'); assert.equal(store.route('account','peer'), 'dsh');
  send('/codex'); assert.equal(store.route('account','peer'), 'local');
  send('/cloud new 网站'); send('第一轮');
  send('/cloud new 运维'); send('第二个');
  send('/cloud c1'); send('续聊');
  send('/dot'); send('/to cloud 单次');
  assert.equal(store.route('account','peer'), 'dot');
  assert.equal(store.selectedCloud('account','peer').code, 'c1');
  const jobs = store.all("SELECT * FROM jobs WHERE alias='cloud' ORDER BY rowid");
  assert.deepEqual(jobs.map(job => JSON.parse(job.target).cloudCode), ['c1','c2','c1','c1']);
  store.saveSession(jobs[0], JSON.parse(jobs[0].target), 'session-site');
  assert.equal(store.session(jobs[1], JSON.parse(jobs[1].target)), undefined);
  assert.equal(store.session(jobs[2], JSON.parse(jobs[2].target)), 'session-site');
  assert.throws(() => store.useCloud('account', 'another-peer', 'c1'), /找不到/);
  assert.equal(store.one("SELECT status FROM jobs WHERE alias='chat'").status, 'chat_pending');
});

test('hosted Codex submits follow-ups to the same API session and returns only the new turn result', async () => {
  let turn = 0;
  let saved;
  const seen = [];
  const request = async (url, opts) => {
    const path = new URL(url).pathname;
    seen.push({ path, method: opts.method, idempotency: opts.headers['idempotency-key'], body: opts.body && JSON.parse(opts.body) });
    assert.equal(opts.headers['OpenAI-Beta'], 'agents=v1');
    if (path.endsWith('/sessions')) { turn = 1; return Response.json({ id: 'session-cloud' }); }
    if (path.endsWith('/events')) { turn++; return new Response(null, { status: 204 }); }
    if (path.endsWith('/turns')) return Response.json({ data: [{ id: 'subagent-turn', subagent_id: 'child' }, { id: `turn-${turn}`, status: 'completed' }] });
    if (path.endsWith('/items')) return Response.json({ data: [
      { type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'working' }] },
      { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: `reply ${turn}` }] },
    ] });
    throw Error('unexpected API path');
  };
  const signal = AbortSignal.timeout(5000);
  const opts = { key: 'sk-test-fixture-not-real', request };
  assert.equal(await runHostedCloud({}, { id: 'job-a', prompt: 'one' }, { saveSession: id => { saved = id; } }, signal, opts), 'reply 1');
  assert.equal(await runHostedCloud({}, { id: 'job-b', prompt: 'two' }, { session: saved }, signal, opts), 'reply 2');
  assert.deepEqual(seen.filter(call => call.method === 'POST').map(call => call.idempotency), ['job-a:create','job-b:input']);
  assert.equal(seen.find(call => call.path.endsWith('/events')).body.events[0].input[0].content[0].text, 'two');
});
