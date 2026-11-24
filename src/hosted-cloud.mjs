import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = 'https://api.openai.com/v1/agents/sessions';
export const defaultCloudModel = 'gpt-6-astra';
const inactive = new Set(['completed', 'failed', 'cancelled', 'canceled']);
export const validCloudKey = key => typeof key === 'string' && /^sk-[a-z0-9_-]{16,490}$/i.test(key);

export function loadCloudKey(path) {
  if (!path) return null;
  try { const key = readFileSync(path, 'utf8').trim(); return validCloudKey(key) ? key : null; }
  catch { return null; }
}

function safeId(id) { return typeof id === 'string' && /^[a-z0-9_-]{3,140}$/i.test(id); }

export async function runHostedCloud(target, job, context, signal, { key, request = fetch, wait = delay } = {}) {
  if (!validCloudKey(key)) throw new Error('请在 ECS 管理面板配置 OpenAI API 密钥。');
  async function api(path, body, idem) {
    let response;
    try {
      response = await request(`${endpoint}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'OpenAI-Beta': 'agents=v1',
          ...(body ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error('ECS 无法连接 OpenAI 云会话接口。');
    }
    if (!response.ok) throw new Error(`OpenAI 云会话请求失败（HTTP ${response.status}）。`);
    // Event creation may return an empty acknowledgement.
    return response.status === 204 || response.headers.get('content-length') === '0' ? {} : await response.json();
  }

  let session = context.session;
  let baseline;
  const latestRoot = async path => (await api(`${path}/turns?order=desc&limit=50`)).data?.find(turn => !turn.subagent_id);
  if (!session) {
    const opened = await api('', { agent: { model: target.model || defaultCloudModel }, environment: { type: 'openai_hosted' }, input: job.prompt }, `${job.id}:create`);
    session = opened.id;
    if (!safeId(session)) throw new Error('OpenAI 没有返回可保存的云会话 ID。');
    context.saveSession(session);
  } else {
    if (!safeId(session)) throw new Error('保存的云会话 ID 无效。');
    const previous = await latestRoot(`/${session}`);
    if (previous && !inactive.has(previous.status)) throw new Error('这个云会话上一轮仍在运行，请稍后再发。');
    baseline = previous?.id;
    await api(`/${session}/events`, { events: [{ type: 'agent.session.input.message', input: [
      { role: 'user', content: [{ type: 'input_text', text: job.prompt }] },
    ] }] }, `${job.id}:input`);
  }
  const path = `/${session}`;
  let turnId;
  while (!signal.aborted) {
    const turn = turnId ? await api(`${path}/turns/${turnId}`) : await latestRoot(path);
    if (turn && turn.id !== baseline) {
      if (!safeId(turn.id)) throw new Error('OpenAI 云会话返回的轮次 ID 无效。');
      turnId = turn.id;
      if (turn.status === 'completed') {
        const items = (await api(`${path}/turns/${turnId}/items?order=desc&limit=50`)).data ?? [];
        const answers = items.filter(item => item.type === 'message' && item.role === 'assistant'
          && item.status === 'completed' && item.phase !== 'commentary');
        const answer = answers.find(item => item.phase === 'final_answer') ?? answers[0];
        const text = answer?.content?.filter(part => part.type === 'output_text').map(part => part.text).join('\n').trim();
        return text || '云会话已完成，本轮没有最终文字。';
      }
      if (inactive.has(turn.status)) throw new Error(`云会话未完成（${turn.status}）。`);
      if (turn.status === 'waiting') {
        const state = await api(path);
        if (state.required_actions?.length) throw new Error('云会话正在等待外部输入或批准。请在 OpenAI 端检查。');
      }
    }
    await wait(1800, undefined, { signal });
  }
  throw signal.reason;
}
