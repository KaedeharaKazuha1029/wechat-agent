import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../src/adapters.mjs';

const stub = String.raw`
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const send = value => console.log(JSON.stringify(value));
if (args[0] === 'app-server') {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') send({ id, result: {} });
    if (method === 'thread/resume') {
      if (params.threadId !== 'existing-thread' || params.sandbox !== 'read-only') process.exit(2);
      send({ id, result: { thread: { id: params.threadId } } });
    }
    if (method === 'turn/start') {
      send({ id, result: { turn: { id: 'turn' } } });
      send({ method: 'item/completed', params: { turnId: 'turn', item: { id: 'message', type: 'agentMessage', text: params.input[0].text } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
    }
  }
} else if (args[0] === 'cloud') {
  if (args[1] === 'exec') {
    if (args[2] !== '--env' || args[3] !== 'env-A' || args[4] !== '--') process.exit(2);
    console.log('Submitted https://chatgpt.com/codex/tasks/task_e_0123456789abcdef');
  } else {
    send({ tasks: [{ id: 'task_e_0123456789abcdef', status: 'completed', summary: 'cloud result' }] });
  }
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (args[0] === 'headless') {
    if (!args.includes('--session-id') || args.at(-1) !== '-') process.exit(2);
    send({ type: 'session', sessionId: 'existing-thread' });
    send({ type: 'final', text: input });
  } else {
    if (!args.includes('--resume') || !args.includes('Read,Glob,Grep')) process.exit(2);
    send({ type: 'system', subtype: 'init', session_id: 'existing-thread' });
    send({ type: 'result', subtype: 'success', result: input, session_id: 'existing-thread' });
  }
}
`;

test('platform adapters preserve prompts, session IDs and the submitted cloud task link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-adapters-'));
  const override = join(root, 'cli stub.mjs');
  const keys = ['WEIXIN_BRIDGE_CODEX_BIN', 'WEIXIN_BRIDGE_CLAUDE_BIN', 'WEIXIN_BRIDGE_DSH_BIN'];
  const previous = keys.map(key => process.env[key]);
  try {
    await writeFile(override, stub);
    for (const key of keys) process.env[key] = override;
    const adapters = createAdapters(null, false);
    const sessionIds = [];
    const external = [];
    const context = {
      signal: AbortSignal.timeout(6000), session: 'existing-thread',
      saveSession: id => sessionIds.push(id), saveExternal: url => external.push(url),
    };
    const job = { prompt: '特殊字符 " & $(anything)\n换行' };
    for (const kind of ['codex-local', 'claude', 'deepseek']) {
      assert.equal(await adapters.run({ alias: kind, kind, cwd: root }, job, context), job.prompt);
    }
    const result = await adapters.run({ alias: 'cloud', kind: 'codex-cloud', cwd: root, environment: 'env-A' }, job, context);
    assert.ok(result.startsWith('cloud result\n'));
    assert.deepEqual(external, ['https://chatgpt.com/codex/tasks/task_e_0123456789abcdef']);
    assert.ok(sessionIds.length >= 3 && sessionIds.every(id => id === 'existing-thread'));
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
    await rm(root, { recursive: true, force: true });
  }
});
