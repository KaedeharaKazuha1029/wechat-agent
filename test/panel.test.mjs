import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('local panel and simulated Weixin share the same default route', { timeout: 15000 }, async () => {
  const available = createServer();
  await new Promise((resolve, reject) => { available.once('error', reject); available.listen(0, '127.0.0.1', resolve); });
  const port = available.address().port;
  await new Promise(resolve => available.close(resolve));
  const data = await mkdtemp(join(tmpdir(), 'weixin-panel-'));
  const address = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), '--demo'], {
    env: { ...process.env, WEIXIN_BRIDGE_DATA: data, WEIXIN_BRIDGE_PORT: String(port), WEIXIN_BRIDGE_DOT_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Panel exited with ${code}`)));
      child.stdout.once('data', resolve);
    });
    const page = await (await fetch(address)).text();
    const token = page.match(/name="bridge-token" content="([^"]+)"/)[1];
    async function api(path, payload) {
      const response = await fetch(`${address}/api/${path}`, {
        method: payload ? 'POST' : 'GET', headers: {
          'x-bridge-admin': token, origin: address, ...(payload ? { 'content-type': 'application/json' } : {}),
        }, body: payload && JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    assert.equal((await fetch(`${address}/api/state`)).status, 403);
    assert.equal((await api('state')).route, 'fast');
    await api('demo', { text: '/use slow' });
    assert.equal((await api('state')).route, 'slow');
    await api('demo', { text: 'ordinary slow' });
    await api('route', { alias: 'fast' });
    await api('demo', { text: 'ordinary fast' });
    await api('demo', { text: '/to slow one shot' });
    let state;
    for (let retry = 0; retry < 100; retry++) {
      state = await api('state');
      if (state.jobs.length === 3 && state.jobs.every(job => job.delivery === 'simulated')) break;
      await delay(80);
    }
    assert.equal(state.route, 'fast');
    assert.deepEqual(state.jobs.map(job => [job.alias, job.status, job.result, job.delivery]), [
      ['slow', 'done', '第 2 轮 · one shot', 'simulated'],
      ['fast', 'done', '第 1 轮 · ordinary fast', 'simulated'],
      ['slow', 'done', '第 1 轮 · ordinary slow', 'simulated'],
    ]);
  } finally {
    child.kill();
    await closed;
    await rm(data, { recursive: true, force: true });
  }
});
