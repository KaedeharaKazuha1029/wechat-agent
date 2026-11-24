import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const aliasPattern = /^[a-z][a-z0-9-]{0,30}$/;
export const kinds = ['codex-local', 'codex-cloud', 'claude', 'deepseek', 'dot', 'chat', 'work'];
export const usesMcpEvents = kind => kind === 'dot' || kind === 'work';
export const usesMcp = kind => kind === 'dot' || kind === 'chat';
const labels = { queued: '排队', chat_pending: '等 Chat 领取', running: '运行中', done: '完成', failed: '失败', interrupted: '中断' };
export const jobLabel = status => labels[status] ?? status;
const now = () => Date.now();
const bounded = (s, n) => Array.from(String(s)).slice(0, n).join('');
const shortcuts = { '/dot': 'dot', '/chat': 'chat', '/cc': 'claude', '/codex': 'codex-local', '/dsh': 'deepseek' };
const names = { 'codex-local': 'Codex', 'codex-cloud': 'Codex Cloud', claude: 'Claude Code', deepseek: 'DeepSeek Harness', chat: 'Chat', dot: 'Dot', work: 'Work' };
const taskTitle = prompt => bounded(String(prompt ?? '').trim().split(/\r?\n/)[0].replace(/\s+/g, ' '), 30) || '微信任务';

export class Store {
  constructor(path, { cloudEnabled = true } = {}) {
    this.cloudEnabled = cloudEnabled;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (alias TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (account TEXT, peer TEXT, alias TEXT NOT NULL, PRIMARY KEY(account, peer));
      CREATE TABLE IF NOT EXISTS sessions (account TEXT, peer TEXT, alias TEXT, revision TEXT, id TEXT NOT NULL, PRIMARY KEY(account,peer,alias,revision));
      CREATE TABLE IF NOT EXISTS inbox (account TEXT, peer TEXT, mid TEXT, PRIMARY KEY(account,peer,mid));
      CREATE TABLE IF NOT EXISTS contexts (account TEXT, peer TEXT, token TEXT NOT NULL, PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL, alias TEXT NOT NULL, target TEXT NOT NULL,
        prompt TEXT NOT NULL, status TEXT NOT NULL, result TEXT, external TEXT, created INTEGER NOT NULL, finished INTEGER
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created);
      CREATE INDEX IF NOT EXISTS jobs_peer ON jobs(account,peer,created);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL, body TEXT NOT NULL, job TEXT,
        status TEXT NOT NULL, created INTEGER NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(account,status,created);
      CREATE TABLE IF NOT EXISTS dot_pushes (
        account TEXT NOT NULL, alias TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, ids TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(account,alias,request_id)
      );
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_chats (
        account TEXT NOT NULL, peer TEXT NOT NULL, code TEXT NOT NULL, target TEXT NOT NULL, revision TEXT NOT NULL,
        title TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(account,peer,code)
      );
      CREATE TABLE IF NOT EXISTS cloud_selected (account TEXT, peer TEXT, code TEXT NOT NULL, PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS chat_threads (
        account TEXT NOT NULL, peer TEXT NOT NULL, alias TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
        PRIMARY KEY(account,peer,alias,code)
      );
      CREATE TABLE IF NOT EXISTS chat_client_threads (
        account TEXT NOT NULL, peer TEXT NOT NULL, alias TEXT NOT NULL, code TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(account,peer,alias,code), UNIQUE(account,peer,alias,digest)
      );
    `);
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key) { const row = this.one('SELECT value FROM kv WHERE key=?', key); return row && JSON.parse(row.value); }
  set(key, value) { this.run('REPLACE INTO kv VALUES (?,?)', key, JSON.stringify(value)); }
  target(alias) {
    const row = this.one('SELECT config FROM targets WHERE alias=?', alias);
    const target = row && JSON.parse(row.config);
    return target && (this.cloudEnabled || target.kind !== 'codex-cloud') ? target : undefined;
  }
  targets() { return this.all('SELECT config FROM targets ORDER BY alias').map(row => JSON.parse(row.config)).filter(item => this.cloudEnabled || item.kind !== 'codex-cloud'); }
  putTarget(config) {
    if (!this.cloudEnabled && config.kind === 'codex-cloud') throw new Error('Codex Cloud 已停用。');
    const previous = this.target(config.alias);
    const { revision, ...fields } = previous ?? {};
    const next = { ...config, revision: JSON.stringify(fields) === JSON.stringify(config) ? revision : randomUUID() };
    this.run('REPLACE INTO targets VALUES (?,?)', next.alias, JSON.stringify(next));
    return next;
  }
  route(account, peer) {
    const alias = this.one('SELECT alias FROM routes WHERE account=? AND peer=?', account, peer)?.alias;
    return (alias && this.target(alias) ? alias : null) ?? this.byKind('dot', 'dot')?.alias;
  }
  byKind(kind, preferred) {
    const target = this.target(preferred);
    return target?.kind === kind ? target : this.targets().find(item => item.kind === kind);
  }
  workForChat(alias) {
    return this.targets().find(item => item.kind === 'work' && (item.chatAlias ?? 'chat') === alias);
  }
  select(account, peer, alias) {
    if (!this.target(alias)) throw new Error('没有这个 Agent。');
    this.run('REPLACE INTO routes VALUES (?,?,?)', account, peer, alias);
  }
  activeChatThread(account, peer, alias) {
    return this.one('SELECT code,title FROM chat_threads WHERE account=? AND peer=? AND alias=? ORDER BY rowid DESC LIMIT 1', account, peer, alias)
      ?? { code: 'h1', title: '默认会话' };
  }
  chatThread(account, peer, alias, code) {
    if (code === 'h1') return { code, title: '默认会话' };
    return this.one('SELECT code,title FROM chat_threads WHERE account=? AND peer=? AND alias=? AND code=?', account, peer, alias, code);
  }
  newChatThread(account, peer, alias, title) {
    if (this.target(alias)?.kind !== 'chat') throw new Error('请先配置 Chat 目标。');
    const previous = this.activeChatThread(account, peer, alias);
    const code = `h${Number(previous.code.slice(1)) + 1}`;
    const label = bounded(String(title ?? '').trim(), 40) || `Chat ${code}`;
    this.run('INSERT INTO chat_threads VALUES (?,?,?,?,?)', account, peer, alias, code, label);
    return { code, title: label };
  }
  chatClientThread(account, peer, alias, code, clientHint) {
    if (code && !this.chatThread(account, peer, alias, code)) throw new Error('找不到这个 Chat 会话。');
    const active = this.activeChatThread(account, peer, alias).code;
    if (typeof clientHint !== 'string' || !clientHint.trim() || clientHint.length > 512) return code ?? active;
    const digest = createHash('sha256').update(JSON.stringify([account, peer, alias, clientHint])).digest('hex');
    const known = this.one('SELECT code FROM chat_client_threads WHERE account=? AND peer=? AND alias=? AND digest=?', account, peer, alias, digest);
    if (known) {
      if (code && code !== known.code) throw new Error(`这个 ChatGPT 对话已绑定 ${known.code}。请在对应的对话里处理该任务。`);
      return known.code;
    }
    const requested = code ?? active;
    const assigned = this.one('SELECT 1 FROM chat_client_threads WHERE account=? AND peer=? AND alias=? AND code=?', account, peer, alias, requested);
    if (assigned) throw new Error(`${requested} 已绑定另一个 ChatGPT 对话。请打开原对话；需要另开会话时，在微信发送 /chat new。`);
    this.run('INSERT INTO chat_client_threads VALUES (?,?,?,?,?)', account, peer, alias, requested, digest);
    return requested;
  }
  cloudTarget(chat) {
    const target = chat && this.target(chat.target);
    return target?.kind === 'codex-cloud' && target.revision === chat.revision ? target : null;
  }
  selectedCloud(account, peer) {
    return this.one(`SELECT c.* FROM cloud_selected s JOIN cloud_chats c
      ON s.account=c.account AND s.peer=c.peer AND s.code=c.code WHERE s.account=? AND s.peer=?`, account, peer);
  }
  cloudChats(account, peer) {
    const selected = this.selectedCloud(account, peer)?.code;
    return this.all('SELECT code,target,revision,title,created FROM cloud_chats WHERE account=? AND peer=? ORDER BY rowid DESC', account, peer)
      .map(chat => ({ ...chat, selected: chat.code === selected, available: Boolean(this.cloudTarget(chat)) }));
  }
  openCloud(account, peer, alias, title = '', select = true) {
    const target = alias ? this.target(alias) : (this.cloudTarget(this.selectedCloud(account, peer)) ?? this.byKind('codex-cloud', 'cloud'));
    if (target?.kind !== 'codex-cloud') throw new Error('请先在面板新增 Codex Cloud 目标。');
    const number = this.one("SELECT coalesce(max(CAST(substr(code,2) AS INTEGER)),0)+1 AS n FROM cloud_chats WHERE account=? AND peer=?", account, peer).n;
    const code = `c${number}`;
    const label = bounded(String(title ?? '').trim(), 40) || `云会话 ${code}`;
    this.run('INSERT INTO cloud_chats VALUES (?,?,?,?,?,?,?)', account, peer, code, target.alias, target.revision, label, now());
    return select ? this.useCloud(account, peer, code) : { code, title: label, target: target.alias, revision: target.revision };
  }
  useCloud(account, peer, code) {
    const chat = this.one('SELECT code,title,target,revision FROM cloud_chats WHERE account=? AND peer=? AND code=?', account, peer, code);
    if (!chat) throw new Error('找不到云会话。用 /cloud list 查看短号。');
    if (!this.cloudTarget(chat)) throw new Error('原云目标配置已改变。请新建云会话。');
    this.run('REPLACE INTO cloud_selected VALUES (?,?,?)', account, peer, code);
    this.select(account, peer, chat.target);
    return chat;
  }
  reply(account, peer, body, job = null) {
    const parts = Array.from(bounded(body, 10000));
    const ids = [];
    if (parts.length === 10000) parts.push(...'\n（已截断）');
    for (let offset = 0; offset < parts.length; offset += 1200) {
      const id = randomUUID();
      this.run('INSERT INTO outbox VALUES (?,?,?,?,?,?,?,NULL)', id, account, peer,
        parts.slice(offset, offset + 1200).join(''), job, 'pending', now());
      ids.push(id);
    }
    return ids;
  }
  pushDot(alias, requestId, messages) {
    const account = this.get('account');
    if (!account?.id || !account.owner || !this.one('SELECT 1 FROM contexts WHERE account=? AND peer=?', account.id, account.owner)) {
      throw new Error('没有可用的微信会话上下文。请先在绑定的微信会话中发一条消息。');
    }
    return this.tx(() => {
      const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
      const previous = this.one('SELECT digest,ids FROM dot_pushes WHERE account=? AND alias=? AND request_id=?', account.id, alias, requestId);
      if (previous) {
        if (previous.digest !== digest) throw new Error('这个发送标识已用于不同的消息。');
        return JSON.parse(previous.ids);
      }
      const ids = messages.flatMap(text => this.reply(account.id, account.owner, text));
      this.run('INSERT INTO dot_pushes VALUES (?,?,?,?,?,?)', account.id, alias, requestId, digest, JSON.stringify(ids), now());
      return ids;
    });
  }
  jobSource(job, target) {
    const base = names[target.kind] ?? job.alias;
    if (target.kind === 'codex-cloud' && target.cloudCode) {
      const title = this.one('SELECT title FROM cloud_chats WHERE account=? AND peer=? AND code=?', job.account, job.peer, target.cloudCode)?.title;
      if (title) return `${base} · ${title}`;
    }
    return base;
  }
  recent(account, peer) {
    return this.all(`SELECT id,alias,status,result,external,created,finished,prompt,target,json_extract(target,'$.cloudCode') AS cloudCode,
      CASE WHEN json_extract(target,'$.kind')='chat' THEN coalesce(json_extract(target,'$.chatCode'),'h1') END AS chatCode,
      (SELECT group_concat(DISTINCT status) FROM outbox WHERE job=jobs.id) AS delivery
      FROM jobs WHERE account=? AND peer=? ORDER BY rowid DESC LIMIT 20`, account, peer)
      .map(({ prompt, target, ...job }) => ({ ...job, title: taskTitle(prompt), source: this.jobSource({ ...job, account, peer }, JSON.parse(target)) }));
  }
  ingest(account, messages, cursor, allowed, readiness) {
    this.tx(() => {
      for (const item of messages) {
        const peer = item.from_user_id;
        if (item.message_type !== 1 || (item.message_state != null && item.message_state !== 2)
          || item.group_id || typeof peer !== 'string' || !allowed.has(peer)) continue;
        const identity = item.message_id ?? (item.client_id || item.seq);
        if (identity == null || identity === '') continue;
        const inserted = this.run('INSERT OR IGNORE INTO inbox VALUES (?,?,?)', account, peer, String(identity));
        if (!inserted.changes) continue;
        if (typeof item.context_token === 'string' && item.context_token) {
          this.run('REPLACE INTO contexts VALUES (?,?,?)', account, peer, item.context_token);
        }
        const prompt = (Array.isArray(item.item_list) ? item.item_list : [])
          .filter(part => part?.type === 1 && typeof part.text_item?.text === 'string' && part.is_completed !== false)
          .map(part => part.text_item.text).join('\n').trim();
        this.handleMessage(account, peer, prompt, readiness);
      }
      if (typeof cursor === 'string' && cursor) this.set(`cursor:${account}`, cursor);
    });
  }
  handleMessage(account, peer, text, readiness) {
    const reply = (body, job) => this.reply(account, peer, body, job);
    if (!text) return reply('目前支持文字消息。');
    if (text.length > 16000) return reply('消息过长，请拆成多条发送。');
    const current = this.route(account, peer);
    const [verb, ...args] = text.split(/\s+/);
    const work = this.byKind('work', 'cloud');
    if (verb === '/agents') {
      const targets = this.targets().map(t => `${t.alias}${t.alias === current ? '（当前）' : ''} · ${readiness(t) ?? '可提交'}`);
      return reply(`快捷切换 /dot /chat /cc /codex /dsh${work || this.cloudEnabled ? ' /cloud' : ''}\n${targets.join('\n') || '请先在管理面板登记一个 Agent。'}`);
    }
    if (verb === '/use') {
      if (args.length !== 1 || !this.target(args[0])) return reply('用法 /use <目标>。发送 /agents 查看目标。');
      this.select(account, peer, args[0]);
      return reply(`默认目标已切到 ${args[0]}。`);
    }
    if (verb === '/status') {
      const recent = this.recent(account, peer);
      if (args.length) {
        const job = /^\d{1,2}$/.test(args[0]) ? recent[Number(args[0]) - 1] : recent.find(job => job.id.startsWith(args[0]));
        if (!job) return reply('找不到任务。发送 /status 查看最近任务。');
        return reply(`${job.source} · ${job.title} · ${jobLabel(job.status)}${job.result ? `\n${job.result}` : ''}`);
      }
      return reply(`当前目标 ${current ?? '未设置'}\n${recent.slice(0, 6).map((job, index) =>
        `${index + 1}. ${job.source} · ${job.title} · ${jobLabel(job.status)}`).join('\n')}\n发送 /status 1 查看最近一条结果。`);
    }
    let alias = current;
    let prompt = text;
    let cloud;
    if (verb === '/cloud' && !work) {
      if (!this.cloudEnabled) return reply('Codex Cloud 已停用。发 /agents 查看可用目标。');
      try {
        const [action] = args;
        if (action === 'list') {
          const rows = this.cloudChats(account, peer).slice(0, 20);
          return reply(rows.length ? rows.map(row => `${row.code} ${row.title}${row.selected ? '（已选）' : ''}${row.available ? '' : '（原配置已更改）'}`).join('\n') : '暂无云会话。发 /cloud new 项目名 创建。');
        }
        if (action === 'new') cloud = this.openCloud(account, peer, undefined, args.slice(1).join(' '));
        else if (/^c[1-9]\d*$/.test(action ?? '') && args.length === 1) cloud = this.useCloud(account, peer, action);
        else if (action) return reply('用法 /cloud、/cloud list、/cloud new 名称 或 /cloud c1。');
        else {
          const selected = this.selectedCloud(account, peer);
          cloud = this.cloudTarget(selected) ? this.useCloud(account, peer, selected.code) : this.openCloud(account, peer);
        }
        const unavailable = readiness(this.cloudTarget(cloud));
        return reply(`已切到 ${cloud.code} ${cloud.title}。${unavailable ? `\n${unavailable}` : ''}`);
      } catch (error) { return reply(error.message); }
    }
    if (verb === '/to') {
      const match = /^\/to\s+([a-z][a-z0-9-]{0,30})\s+([\s\S]+)$/.exec(text);
      if (!match) return reply('用法 /to <目标> <消息>。');
      [, alias, prompt] = match;
    } else if (verb === '/cloud' || Object.hasOwn(shortcuts, verb)) {
      const target = verb === '/cloud' ? work : this.byKind(shortcuts[verb], verb.slice(1));
      if (!target) return reply('这个 Agent 还未配置。发送 /agents 查看已登记目标。');
      alias = target.alias;
      this.select(account, peer, alias);
      if (verb === '/chat' && args[0] === 'new') {
        const chat = this.newChatThread(account, peer, alias, args.slice(1).join(' '));
        return reply(`已新建 ${alias}/${chat.code} ${chat.title}。接下来微信消息进入此会话。`);
      }
      if (!args.length) {
        const unavailable = readiness(target);
        const label = verb === '/chat' ? `${alias}/${this.activeChatThread(account, peer, alias).code}` : alias;
        return reply(`默认目标已切到 ${label}。${unavailable ? `\n${unavailable}` : ''}`);
      }
      prompt = text.slice(verb.length).trim();
    } else if (/^\/[a-z-]+(?:\s|$)/i.test(text)) {
      return reply(`可用指令 /agents /use /to /status /dot /chat /cc /codex /dsh${work || this.cloudEnabled ? ' /cloud' : ''}。`);
    }
    if (!alias) return reply('请用 /agents 查看目标，再用 /use <目标> 设为默认。');
    const target = this.target(alias);
    if (!target) return reply(`找不到 ${alias}。发送 /agents 查看可用目标。`);
    const unavailable = readiness(target);
    if (unavailable) return reply(`${alias} 暂不可用：${unavailable}`);
    const manual = target.kind === 'chat';
    const chat = manual ? this.activeChatThread(account, peer, alias) : null;
    const pending = manual
      ? this.one("SELECT count(*) AS total FROM jobs WHERE account=? AND peer=? AND alias=? AND status='chat_pending' AND json_extract(target,'$.revision')=? AND coalesce(json_extract(target,'$.chatCode'),'h1')=?", account, peer, alias, target.revision, chat.code)
      : this.one("SELECT count(*) AS total FROM jobs WHERE account=? AND peer=? AND status IN ('queued','running')", account, peer);
    if (pending.total >= 20) {
      return reply('你有 20 条任务等待处理，请稍后再试。');
    }
    const id = randomUUID();
    if (target.kind === 'codex-cloud') {
      const selected = this.selectedCloud(account, peer);
      cloud = selected?.target === alias && this.cloudTarget(selected) ? selected
        : this.one('SELECT code FROM cloud_chats WHERE account=? AND peer=? AND target=? AND revision=? ORDER BY rowid DESC LIMIT 1', account, peer, alias, target.revision)
          ?? this.openCloud(account, peer, alias, taskTitle(prompt), false);
      this.run('UPDATE cloud_chats SET title=? WHERE account=? AND peer=? AND code=? AND title=?', taskTitle(prompt), account, peer, cloud.code, `云会话 ${cloud.code}`);
      if (verb !== '/to' && cloud.code !== selected?.code) this.useCloud(account, peer, cloud.code);
    }
    const snapshot = cloud ? { ...target, cloudCode: cloud.code } : chat ? { ...target, chatCode: chat.code } : target;
    this.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,NULL,NULL,?,NULL)', id, account, peer, alias, JSON.stringify(snapshot), prompt, manual ? 'chat_pending' : 'queued', now());
    if (target.kind !== 'dot') reply(`[${this.jobSource({ account, peer, alias }, snapshot)}] ${manual ? '等 Chat 领取。' : '已排队。'}`);
  }
  session(job, target) {
    const revision = target.cloudCode ? `${target.revision}:${target.cloudCode}` : target.revision;
    return this.one('SELECT id FROM sessions WHERE account=? AND peer=? AND alias=? AND revision=?', job.account, job.peer, job.alias, revision)?.id;
  }
  saveSession(job, target, id) {
    const revision = target.cloudCode ? `${target.revision}:${target.cloudCode}` : target.revision;
    this.run('REPLACE INTO sessions VALUES (?,?,?,?,?)', job.account, job.peer, job.alias, revision, id);
  }
  finish(job, status, text, previous = 'running') {
    return this.tx(() => {
      const pieces = Array.isArray(text) ? text : [text];
      const result = bounded(pieces.join('\n\n'), 10000);
      const updated = this.run('UPDATE jobs SET status=?,result=?,finished=? WHERE id=? AND status=?', status, result, now(), job.id, previous);
      if (updated.changes) {
        const target = JSON.parse(job.target);
        if (target.kind === 'dot') {
          for (const piece of pieces) this.reply(job.account, job.peer, piece, job.id);
        } else if (target.kind === 'work' && pieces.length > 1) {
          pieces.forEach((piece, index) => this.reply(job.account, job.peer, index === 0 ? `[Work] ${jobLabel(status)}\n${piece}` : piece, job.id));
        } else this.reply(job.account, job.peer, `[${this.jobSource(job, target)}] ${jobLabel(status)}\n${result}`, job.id);
      }
      return Boolean(updated.changes);
    });
  }
  recover() {
    this.run("UPDATE jobs SET status='interrupted',result='桥接服务重启。请在原平台确认任务是否仍在运行。',finished=? WHERE status='running'", now());
    this.run("UPDATE outbox SET status='unknown',detail='服务在发送过程中重启' WHERE status='sending'");
  }
}

export function startQueue(store, adapter, signal, log) {
  const active = new Map();
  return (async () => {
    try {
      while (!signal.aborted) {
        for (const job of store.all("SELECT * FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 100")) {
          if (active.size >= 4) break;
          const target = JSON.parse(job.target);
          if (!store.cloudEnabled && target.kind === 'codex-cloud') {
            store.run("UPDATE jobs SET status='interrupted',result='Codex Cloud 已停用。',finished=? WHERE id=? AND status='queued'", now(), job.id);
            continue;
          }
          const key = createHash('sha256').update(JSON.stringify([job.account, job.peer, job.alias, target.cloudCode])).digest('hex');
          if (active.has(key)) continue;
          store.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
          const work = Promise.resolve().then(() => adapter(target, job, {
            signal,
            session: store.session(job, target) ?? target.sessionId,
            saveSession: id => { if (id) store.saveSession(job, target, id); },
            saveExternal: url => store.run('UPDATE jobs SET external=? WHERE id=?', url, job.id),
          })).then(result => store.finish(job, 'done', result), error => {
            store.finish(job, signal.aborted ? 'interrupted' : 'failed', error.message || '运行失败。');
          }).catch(error => log(error)).finally(() => active.delete(key));
          active.set(key, work);
        }
        await delay(150, undefined, { signal }).catch(() => {});
      }
    } finally { await Promise.allSettled(active.values()); }
  })();
}
