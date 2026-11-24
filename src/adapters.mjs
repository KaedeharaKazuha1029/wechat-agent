import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, isAbsolute, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { aliasPattern, kinds, usesMcpEvents } from './core.mjs';
import { runHostedCloud, loadCloudKey, defaultCloudModel } from './hosted-cloud.mjs';

const packages = {
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
  claude: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  dsh: ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
};
const apiNames = { 'codex-local': 'codex', 'codex-cloud': 'codex', claude: 'claude', deepseek: 'dsh' };
const nativeRunnerKinds = ['codex-local', 'claude', 'deepseek'];
const runsOnWindows = target => nativeRunnerKinds.includes(target.kind)
  && (target.runtime === 'windows' || (!target.runtime && target.kind === 'codex-local' && Boolean(remoteCodex())));

function remoteCodex() {
  const value = process.env.WEIXIN_BRIDGE_CODEX_RUNNER_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Codex Runner 必须通过私有回环隧道连接。');
  }
  return url.origin;
}

function launcher(name) {
  const override = process.env[`WEIXIN_BRIDGE_${name.toUpperCase()}_BIN`];
  if (override) {
    if (!isAbsolute(override) || !existsSync(override) || /\.(cmd|bat|ps1)$/i.test(override)) return null;
    return override.endsWith('.js') || override.endsWith('.mjs') ? [process.execPath, override] : [override];
  }
  const windows = process.platform === 'win32';
  const path = process.env.PATH ?? '';
  const directories = path.split(windows ? ';' : ':').map(dir => dir.replace(/^"|"$/g, '')).filter(isAbsolute);
  if (windows && process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'));
  for (const dir of directories) {
    const exe = join(dir, windows ? `${name}.exe` : name);
    if (existsSync(exe) && statSync(exe).isFile()) return [exe];
    if (!windows) continue;
    if (name === 'codex') {
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const native = join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`,
        'vendor', `${arch}-pc-windows-msvc`, 'codex', 'codex.exe');
      if (existsSync(native)) return [native];
    }
    const entry = join(dir, 'node_modules', ...packages[name]);
    if (existsSync(entry)) return entry.endsWith('.js') ? [process.execPath, entry] : [entry];
  }
  return null;
}

export function validateTarget(input, demo) {
  const alias = String(input.alias ?? '').trim();
  const kind = String(input.kind ?? '');
  if (!aliasPattern.test(alias)) throw new Error('别名须以小写英文字母开头，且只包含小写字母、数字或连字符，最多 31 个字符。');
  if (!kinds.includes(kind) && !(demo && kind === 'echo')) throw new Error('请选择有效的 Agent 类型。');
  const target = { alias, kind };
  if (kind === 'work') {
    target.chatAlias = String(input.chatAlias ?? 'chat').trim() || 'chat';
    if (!aliasPattern.test(target.chatAlias)) throw new Error('请输入有效的 Chat 插件目标别名。');
  }
  if (nativeRunnerKinds.includes(kind) && input.runtime && input.runtime !== 'auto') {
    if (!['server', 'windows'].includes(input.runtime)) throw new Error('请选择有效的运行位置。');
    target.runtime = input.runtime;
  }
  if (['codex-local', 'claude', 'deepseek', 'codex-cloud'].includes(kind)) {
    const cwd = String(input.cwd ?? '').trim();
    if (runsOnWindows(target)) {
      if (!win32.isAbsolute(cwd)) throw new Error('填写已登记的 Windows Runner 工作目录。');
      target.cwd = cwd;
    } else if (kind !== 'codex-cloud' || (cwd && input.cloudMode !== 'hosted')) {
      if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('请选择存在的绝对工作目录。');
      target.cwd = cwd;
    }
  }
  if (kind === 'codex-cloud') {
    const mode = input.cloudMode ?? 'native';
    if (!['native', 'hosted'].includes(mode)) throw new Error('请选择云运行方式。');
    if (mode === 'hosted') {
      delete target.cwd;
      target.cloudMode = 'hosted';
      target.model = String(input.model || defaultCloudModel).trim();
      if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/i.test(target.model)) throw new Error('请输入有效的云模型名称。');
    } else {
      target.environment = String(input.environment ?? '').trim();
      if (!/^[\w.-]{1,128}$/.test(target.environment) || target.environment.startsWith('-')) throw new Error('请填写有效的 Codex 云环境 ID。');
    }
  }
  if (['codex-local', 'claude', 'deepseek'].includes(kind)) {
    const sessionId = String(input.sessionId ?? '').trim();
    if (sessionId) {
      if (!/^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('会话 ID 格式无效。');
      target.sessionId = sessionId;
    }
  }
  if (kind === 'codex-local' && input.write === true) target.write = true;
  return target;
}

function agentEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^WEIXIN_BRIDGE_/i.test(key)));
}

function processFor(name, args, cwd, signal) {
  const command = launcher(name);
  if (!command) throw new Error(`找不到 ${name}。请确认该平台的 CLI 已配置。`);
  return spawn(command[0], [...command.slice(1), ...args], {
    cwd, signal, env: agentEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
}

async function runCli(name, args, { cwd, signal, input, onEvent }) {
  const child = processFor(name, args, cwd, signal);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signalName) => resolve({ code, signalName }));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.stderr.resume();
  let output = '';
  let parseError;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (output.length < 2_000_000) output += `${line}\n`;
    if (!onEvent || parseError) return;
    try { if (line.startsWith('{')) onEvent(JSON.parse(line)); }
    catch (error) { parseError = error; child.kill(); }
  });
  const result = await completion;
  if (parseError) throw parseError;
  if (result.code !== 0) throw new Error(`${name} 运行失败（${result.code ?? result.signalName}）。请在电脑上检查该平台的登录和目标配置。`);
  return output.trim();
}

async function codexLocal(target, job, context, signal) {
  const cli = [];
  if (process.platform === 'win32' && process.env.WEIXIN_BRIDGE_CODEX_PREFER_MXC === '1') {
    cli.push('-c', 'windows.sandbox="mxc"');
  }
  const child = processFor('codex', [...cli, 'app-server'], target.cwd, signal);
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map();
  let nextId = 0;
  let turnId;
  let earlyCompletion;
  const items = new Map();
  let resolveTurn, rejectTurn;
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  completed.catch(() => {});
  const fail = () => {
    const error = new Error('Codex App Server 连接结束，请检查本机登录和目标目录。');
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    rejectTurn(error);
  };
  child.once('error', fail);
  child.once('close', fail);
  const send = payload => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    const { id, method, params } = packet;
    if (method && id !== undefined) {
      send({ id, error: { code: -32601, message: '此桥接任务不接受远程审批或额外输入。' } });
      return;
    }
    if (id !== undefined && pending.has(id)) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (packet.error) waiter.reject(new Error('Codex 拒绝了请求，请检查目标目录、会话和权限设置。'));
      else waiter.resolve(packet.result);
      return;
    }
    if (method === 'item/completed' && params?.item?.type === 'agentMessage' && (!turnId || params.turnId === turnId)) {
      const item = params.item;
      if (typeof item.text === 'string' && item.phase !== 'commentary') items.set(item.id, item.text);
    }
    if (method === 'turn/completed' && params?.turn) {
      if (!turnId) earlyCompletion = params.turn;
      else if (params.turn.id === turnId) resolveTurn(params.turn);
    }
  });
  try {
    await request('initialize', { clientInfo: { name: 'weixin-bridge', version: '0.1.0' } });
    send({ method: 'initialized' });
    const options = { cwd: target.cwd, approvalPolicy: 'never', sandbox: target.write ? 'workspace-write' : 'read-only' };
    const { thread } = context.session ? await request('thread/resume', { ...options, threadId: context.session }) : await request('thread/start', options);
    context.saveSession(thread.id);
    const { turn } = await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: job.prompt, text_elements: [] }] });
    turnId = turn.id;
    if (earlyCompletion?.id === turnId) resolveTurn(earlyCompletion);
    const finished = await completed;
    if (finished.status !== 'completed') throw new Error(`Codex 任务结束，状态 ${finished.status}。`);
    return [...items.values()].at(-1) || 'Codex 已完成，未返回文字结果。';
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    await closed;
  }
}

async function codexRunner(target, job, context, signal, origin) {
  const tokenFile = process.env.WEIXIN_BRIDGE_CODEX_RUNNER_TOKEN_FILE;
  if (!tokenFile) throw new Error('Windows Runner 凭证路径未配置。');
  const token = readFileSync(tokenFile, 'utf8').trim();
  let response;
  try {
    response = await fetch(`${origin}/run`, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: target.kind, cwd: target.cwd, prompt: job.prompt, session: context.session, write: Boolean(target.write) }),
    });
  } catch { throw new Error('无法连接 Windows Runner，请检查电脑和 SSH 通道。'); }
  if (!response.ok) throw new Error(`Windows Runner 拒绝请求（HTTP ${response.status}）。`);
  const result = await response.json();
  if (result.session) context.saveSession(result.session);
  if (!result.ok || typeof result.text !== 'string') throw new Error(result.error || 'Windows Runner 未返回任务结果。');
  return result.text;
}

async function claude(target, job, context, signal) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'];
  if (context.session) args.push('--resume', context.session);
  let final;
  await runCli('claude', args, { cwd: target.cwd, signal, input: job.prompt, onEvent(event) {
    if (event.type === 'system' && event.subtype === 'init') context.saveSession(event.session_id);
    if (event.type === 'result') final = event;
  } });
  if (final?.session_id) context.saveSession(final.session_id);
  if (!final || final.is_error || final.subtype !== 'success') throw new Error('Claude Code 未返回成功的任务结果。');
  return final.result || 'Claude Code 已完成，未返回文字结果。';
}

async function deepseek(target, job, context, signal) {
  const args = ['headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never'];
  if (context.session) args.push('--session-id', context.session);
  args.push('-');
  let final;
  await runCli('dsh', args, { cwd: target.cwd, signal, input: job.prompt, onEvent(event) {
    if (event.type === 'session') context.saveSession(event.sessionId);
    if (event.type === 'final') final = event.text;
  } });
  if (typeof final !== 'string') throw new Error('DeepSeek Harness 未返回任务结果。');
  return final || 'DeepSeek Harness 已完成，未返回文字结果。';
}

async function codexCloud(target, job, context, signal) {
  const args = ['cloud', 'exec', '--env', target.environment, '--', job.prompt];
  const cwd = target.cwd || process.cwd();
  const output = await runCli('codex', args, { cwd, signal });
  const id = output.match(/\btask_e_[\da-z-]+\b/i)?.[0] ?? output.match(/\btask_[\da-z-]{8,}\b/i)?.[0];
  if (!id) throw new Error('提交命令成功，但无法识别云端任务编号。请在 Codex Cloud 查找本次任务。');
  const url = `https://chatgpt.com/codex/tasks/${id}`;
  context.saveExternal(url);
  for (let attempt = 0; attempt < 120; attempt++) {
    const data = await runCli('codex', ['cloud', 'list', '--env', target.environment, '--json', '--limit', '20'], { cwd, signal });
    const task = JSON.parse(data).tasks?.find(item => item.id === id);
    const status = typeof task?.status === 'string' ? task.status.toLowerCase() : '';
    if (['completed', 'complete', 'ready', 'done', 'succeeded', 'success'].includes(status)) return `${task.summary || '云端任务已完成。'}\n${url}`;
    if (['failed', 'error', 'cancelled', 'canceled', 'stopped'].includes(status)) throw new Error(`Codex Cloud 任务状态为 ${status}。\n${url}`);
    await delay(10000, undefined, { signal });
  }
  throw new Error(`已提交云端任务，桥接等待已超时。可打开链接查看进展。\n${url}`);
}

export function createAdapters(dot, demo, { cloudKeyPath, cloudRequest } = {}) {
  return {
    readiness(target) {
      if (demo) return target.kind === 'echo' ? null : '演示模式仅运行测试 Agent';
      if (target.kind === 'chat') return null;
      if (target.kind === 'codex-cloud' && target.cloudMode === 'hosted') return loadCloudKey(cloudKeyPath) ? null : 'ECS 尚未配置 OpenAI API 密钥';
      if (usesMcpEvents(target.kind)) {
        if (target.kind === 'work' && dot.store.target(target.chatAlias ?? 'chat')?.kind !== 'chat') return '请先配置关联的 Chat 插件';
        return dot.subscription(target.alias) ? null : `等待 ${target.kind === 'work' ? '网页 Work' : 'Dot'} 完成 MCP 事件订阅`;
      }
      if (runsOnWindows(target)) return remoteCodex() && process.env.WEIXIN_BRIDGE_CODEX_RUNNER_TOKEN_FILE ? null : 'Windows Runner 未配置';
      if (!apiNames[target.kind] || !launcher(apiNames[target.kind])) return '找不到平台 CLI';
      return null;
    },
    async run(target, job, context) {
      if (demo) {
        await delay(target.alias === 'slow' ? 2200 : 450, undefined, { signal: context.signal });
        const count = Number(context.session ?? 0) + 1;
        context.saveSession(String(count));
        return `第 ${count} 轮 · ${job.prompt}`;
      }
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(25 * 60_000)]);
      if (runsOnWindows(target)) {
        const remote = remoteCodex();
        if (!remote) throw new Error('Windows Runner 未配置。');
        return codexRunner(target, job, context, signal, remote);
      }
      if (target.kind === 'codex-local') return codexLocal(target, job, context, signal);
      if (target.kind === 'codex-cloud') {
        return target.cloudMode === 'hosted' ? runHostedCloud(target, job, context, signal, { key: loadCloudKey(cloudKeyPath), request: cloudRequest }) : codexCloud(target, job, context, signal);
      }
      if (target.kind === 'claude') return claude(target, job, context, signal);
      if (target.kind === 'deepseek') return deepseek(target, job, context, signal);
      if (usesMcpEvents(target.kind)) return dot.dispatch(target, job, signal);
      throw new Error('未知 Agent 类型。');
    },
  };
}
