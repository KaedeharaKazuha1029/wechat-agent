const jobIdFormat = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const jobId = { type: 'string', description: '由 list_pending 返回的完整 job_id。' };
const readOnly = { readOnlyHint: true };

export const chatTools = [
  { name: 'list_pending', description: '列出分给本 ChatGPT Chat 收件箱且没有回复的微信任务。', annotations: readOnly,
    inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 10 }, chat_session: { type: 'string', description: '可选，微信桥接里的 Chat 短号，例如 h1。' } }) },
  { name: 'get_message', description: '读取本 Chat 收件箱中指定待回复任务的完整文字。', annotations: readOnly,
    inputSchema: object({ job_id: jobId }, ['job_id']) },
  { name: 'reply', description: '确认后把答复排队发回这个微信任务的原会话。同一个任务只能回复一次。',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: object({ job_id: jobId, text: { type: 'string', minLength: 1, maxLength: 10000 } }, ['job_id', 'text']) },
];

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
const invalid = text => ({ content: [{ type: 'text', text }], isError: true });

export function chatInbox(store, target, name, args = {}, clientHint) {
  const active = store.get('account');
  if (!active?.id || !active?.owner) return invalid('桥接服务未绑定微信。');
  const filters = [active.id, active.owner, target.alias, target.revision];
  const belongs = "account=? AND peer=? AND alias=? AND json_extract(target,'$.revision')=?";
  if (name === 'list_pending') {
    const limit = args.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return invalid('limit 须为 1 到 10。');
    if (Object.hasOwn(args, 'chat_session') && (typeof args.chat_session !== 'string' || !/^h[1-9]\d{0,12}$/.test(args.chat_session))) return invalid('Chat 会话短号格式不正确。');
    let code;
    try { code = store.chatClientThread(active.id, active.owner, target.alias, args.chat_session, clientHint); }
    catch (error) { return invalid(error.message); }
    const jobs = store.all(`SELECT id AS job_id, created, substr(prompt,1,160) AS preview FROM jobs
      WHERE ${belongs} AND status='chat_pending' AND coalesce(json_extract(target,'$.chatCode'),'h1')=? ORDER BY rowid LIMIT ?`, ...filters, code, limit);
    return result({ chat_session: code, jobs: jobs.map(job => ({ ...job, created: new Date(job.created).toISOString() })) });
  }
  if (name !== 'get_message' && name !== 'reply') return invalid('未知 Chat MCP 工具。');
  if (typeof args.job_id !== 'string' || !jobIdFormat.test(args.job_id)) return invalid('请输入 list_pending 返回的完整任务 ID。');
  const job = store.one(`SELECT * FROM jobs WHERE id=? AND ${belongs} AND status IN ('chat_pending','done')`, args.job_id, ...filters);
  if (!job) return invalid('找不到此 Chat 收件箱中的任务。');
  const code = JSON.parse(job.target).chatCode ?? 'h1';
  try { store.chatClientThread(active.id, active.owner, target.alias, code, clientHint); }
  catch (error) { return invalid(error.message); }
  if (name === 'get_message') {
    if (job.status !== 'chat_pending') return invalid('这个任务已回复。');
    return result({ job_id: job.id, text: job.prompt });
  }
  if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 10000) return invalid('请输入 1 至 10000 个字符的回复。');
  if (job.status === 'done') return result({ job_id: job.id, status: 'already_replied' });
  const changed = store.finish(job, 'done', args.text, 'chat_pending');
  return result({ job_id: job.id, status: changed ? 'queued_for_weixin' : 'already_replied' });
}
