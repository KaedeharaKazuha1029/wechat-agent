const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="bridge-token"]').content;
const base = location.pathname === '/admin' || location.pathname.startsWith('/admin/') ? '/admin' : '';
const targetNames = { 'codex-local': 'Codex Local', 'codex-cloud': 'Codex Cloud', claude: 'Claude Code', deepseek: 'DeepSeek Harness', dot: 'ChatGPT Dot', chat: 'ChatGPT Chat', work: '网页 Work', echo: '测试 Agent' };
const statuses = { queued: '排队', chat_pending: '等 Chat 领取', running: '运行中', done: '完成', failed: '失败', interrupted: '中断' };
const bindingStates = { starting: '正在生成绑定码…', wait: '请用微信扫码并确认。', scaned: '已扫码，请在微信确认。', confirmed: '已绑定。', scaned_but_redirect: '正在切换微信服务节点…', need_verifycode: '请输入微信显示的 PIN。', confirmed_but_need_verifycode: '请输入微信显示的 PIN。' };
let lastTargets, lastJobs, lastReplies, lastCloud;
let refreshing = false;

async function api(path, data) {
  const res = await fetch(`${base}/api/${path}`, {
    method: data ? 'POST' : 'GET', headers: { 'X-Bridge-Admin': token, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data && JSON.stringify(data), cache: 'no-store',
  });
  if (base && res.status === 401) { location.assign('/admin/login'); throw new Error('远程会话已失效。'); }
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? '请求失败。');
  return result;
}

function feedback(message, error = false) {
  const box = $('feedback');
  box.hidden = false;
  box.textContent = message;
  box.classList.toggle('error', error);
}

async function act(path, payload, message) {
  try {
    await api(path, payload);
    if (message) feedback(message);
    await refresh();
    return true;
  } catch (error) { feedback(error.message, true); return false; }
}

function configureFields() {
  const kind = $('kind').value;
  const hosted = kind === 'codex-cloud' && $('cloud-mode').value === 'hosted';
  $('cwd-row').hidden = ['dot', 'chat', 'work', 'echo'].includes(kind) || hosted;
  $('chat-alias-row').hidden = kind !== 'work';
  $('env-row').hidden = kind !== 'codex-cloud' || hosted;
  $('model-row').hidden = !hosted;
  $('cloud-mode-row').hidden = kind !== 'codex-cloud';
  $('runtime-row').hidden = !['codex-local', 'claude', 'deepseek'].includes(kind);
  $('session-row').hidden = !['codex-local', 'claude', 'deepseek'].includes(kind);
  $('write-row').hidden = kind !== 'codex-local';
}

function fillEditor(target) {
  const fields = $('target-form').elements;
  for (const name of ['alias', 'kind', 'cwd', 'environment', 'sessionId', 'model', 'chatAlias']) fields[name].value = target[name] ?? '';
  fields.cloudMode.value = target.cloudMode ?? 'native';
  fields.runtime.value = target.runtime ?? 'auto';
  fields.write.checked = Boolean(target.write);
  $('target-editor').open = true;
  configureFields();
  fields.alias.focus();
}

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action) {
  const node = el('button', label);
  node.type = 'button';
  node.className = 'secondary';
  node.addEventListener('click', action);
  return node;
}

function draw(state) {
  $('connection').textContent = state.connection;
  $('admin-logout').hidden = !base;
  $('public-admin-settings').hidden = !state.publicAdminAvailable;
  $('public-admin-status').textContent = state.publicAdminConfigured ? '公网后台已设置管理密码。' : '公网后台等待设置管理密码。';
  $('cloud-hint').hidden = !state.cloudEnabled && !state.targets.some(target => target.kind === 'work');
  const cloudOption = $('kind').querySelector('option[value="codex-cloud"]');
  if (cloudOption) cloudOption.hidden = cloudOption.disabled = !state.cloudEnabled;
  $('binding').hidden = state.demo;
  $('demo').hidden = !state.demo;
  const route = $('route');
  const cloudTargets = state.targets.filter(target => target.kind === 'codex-cloud');
  $('cloud-panel').hidden = !state.bound || !cloudTargets.length;
  $('key-status').textContent = state.cloudKeyConfigured ? 'OpenAI API 密钥已配置' : '配置 OpenAI API 密钥';
  $('api-key-settings').hidden = !cloudTargets.some(target => target.cloudMode === 'hosted');
  const changedTargets = JSON.stringify(state.targets);
  if (changedTargets !== lastTargets) {
    lastTargets = changedTargets;
    route.replaceChildren(new Option('请选择默认 Agent', ''));
    for (const item of state.targets) route.add(new Option(`${item.alias}${item.unavailable ? '（未就绪）' : ''}`, item.alias));
    const cloudTarget = $('cloud-target');
    const priorCloudTarget = cloudTarget.value;
    cloudTarget.replaceChildren(...cloudTargets.map(target => new Option(target.alias, target.alias)));
    if (cloudTargets.some(target => target.alias === priorCloudTarget)) cloudTarget.value = priorCloudTarget;
    const list = $('targets');
    list.replaceChildren(...state.targets.map(item => {
      const li = el('li');
      li.append(el('strong', item.alias), el('span', ` · ${targetNames[item.kind]}${item.chatSession ? ` · ${item.chatSession}` : ''} · ${item.unavailable ?? (item.kind === 'chat' ? '可排队，需在 Chat 领取' : '可提交')}`));
      if (item.cwd || item.environment) li.append(el('p', item.cwd || item.environment));
      li.append(el('br'), button('编辑', () => fillEditor(item)));
      if (item.mcpUrl) {
        li.append(button('复制 OAuth MCP 地址', async () => {
          try { await navigator.clipboard.writeText(item.mcpUrl); feedback('MCP 地址已复制。请在 ChatGPT 选择 OAuth。'); }
          catch { feedback('浏览器无法访问剪贴板。', true); }
        }));
        li.append(button('生成配对码', async () => {
          try {
            const { code } = await api('dot-pair', { alias: item.alias });
            $('dot-code').textContent = code;
            $('dot-pair').hidden = false;
          } catch (error) { feedback(error.message, true); }
        }));
      }
      if (item.mcpUrl) li.append(button('撤销 MCP 授权', () => act('dot-unbind', { alias: item.alias }, '已撤销此 MCP 连接的授权。')));
      return li;
    }));
  }
  const cloudSessions = JSON.stringify(state.cloudChats);
  if (cloudSessions !== lastCloud) {
    lastCloud = cloudSessions;
    const select = $('cloud-session');
    select.replaceChildren(new Option('请选择云会话', ''), ...state.cloudChats.map(chat => {
      const option = new Option(`${chat.code} · ${chat.title}`, chat.code);
      option.disabled = !chat.available;
      return option;
    }));
    select.value = state.cloudChats.find(chat => chat.selected && chat.available)?.code ?? '';
    $('cloud-select-form').querySelector('button').disabled = !state.cloudChats.some(chat => chat.available);
  }
  if (document.activeElement !== route && !route.dataset.editing) route.value = state.route ?? '';
  route.disabled = !state.bound || !state.targets.length;
  $('route-form').querySelector('button').disabled = route.disabled;
  if (state.demo && !$('kind').querySelector('option[value="echo"]')) {
    $('kind').replaceChildren(new Option('测试 Agent', 'echo'));
    configureFields();
  }
  const bind = state.binding;
  const busy = bind && !['error', 'confirmed'].includes(bind.status);
  $('bind').disabled = Boolean(busy);
  $('cancel-bind').hidden = !busy;
  $('bind-status').textContent = bind?.error ?? bindingStates[bind?.status] ?? '';
  $('pin-form').hidden = !bind?.status?.includes('need_verifycode');
  $('qr').hidden = !bind?.image;
  if (bind?.image && $('qr').getAttribute('src') !== bind.image) $('qr').src = bind.image;
  if (!bind?.image) $('qr').removeAttribute('src');
  const replies = JSON.stringify(state.demoReplies);
  if (replies !== lastReplies) {
    lastReplies = replies;
    $('demo-replies').replaceChildren(...state.demoReplies.map(r => { const li = el('li'); li.append(el('pre', r.text)); return li; }));
  }
  const jobs = JSON.stringify(state.jobs);
  if (jobs !== lastJobs) {
    lastJobs = jobs;
    const open = new Set([...$('jobs').querySelectorAll('details[open]')].map(node => node.dataset.id));
    $('jobs').replaceChildren(...state.jobs.map(job => {
      const details = el('details');
      details.dataset.id = job.id;
      details.open = open.has(job.id);
      details.append(el('summary', `${job.source ?? job.alias} · ${job.title ?? '微信任务'} · ${statuses[job.status]}`));
      if (job.result) details.append(el('pre', job.result));
      if (job.delivery) details.append(el('p', `微信回执 ${job.delivery.split(',').map(value => ({ accepted: '接口已接收', unconfirmed: '未确认', unknown: '发送结果未知', failed: '发送失败', simulated: '模拟送达', pending: '待发送', sending: '发送中' }[value] ?? value)).join('、')}`));
      if (job.external?.startsWith('https://chatgpt.com/codex/tasks/')) {
        const link = el('a', '打开 Codex Cloud 任务');
        link.href = job.external;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        details.append(link);
      }
      return details;
    }));
    if (!state.jobs.length) $('jobs').append(el('p', '暂无任务。'));
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try { draw(await api('state')); }
  catch (error) { $('connection').textContent = error.message; }
  finally { refreshing = false; }
}

$('route').addEventListener('change', () => { $('route').dataset.editing = 'yes'; });
$('route-form').addEventListener('submit', async event => {
  event.preventDefault();
  const alias = $('route').value;
  if (!alias) return feedback('请先选择目标。', true);
  delete $('route').dataset.editing;
  await act('route', { alias }, `默认目标已切到 ${alias}。`);
});
$('kind').addEventListener('change', configureFields);
$('cloud-mode').addEventListener('change', configureFields);
$('cloud-select-form').addEventListener('submit', async event => {
  event.preventDefault();
  const code = $('cloud-session').value;
  if (code) await act('cloud', { action: 'select', code }, `已切到 ${code}。`);
});
$('cloud-new-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const session = await api('cloud', { action: 'new', alias: $('cloud-target').value, title: $('cloud-title').value });
    $('cloud-title').value = '';
    feedback(`已创建并切到 ${session.code}。`);
    await refresh();
  } catch (error) { feedback(error.message, true); }
});
$('cloud-key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = $('cloud-key');
  const value = key.value.trim();
  key.value = '';
  if (await act('cloud-key', { key: value }, '密钥已保存到桥接服务器。')) $('api-key-settings').open = false;
});
$('public-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('public-password');
  const value = password.value;
  password.value = '';
  await act('public-password', { password: value }, '管理密码已更新。旧远程会话已退出。');
});
$('target-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  data.write = data.write === 'on';
  if (await act('target', data, `已保存 ${data.alias}。`)) $('target-editor').open = false;
});
$('bind').addEventListener('click', () => act('bind', {}));
$('cancel-bind').addEventListener('click', () => act('cancel-bind', {}));
$('pin-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (await act('pin', { pin: $('pin').value })) $('pin').value = '';
});
$('demo-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (await act('demo', { text: $('demo-text').value })) $('demo-text').value = '';
});
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('dot-code').textContent); feedback('配对码已复制。'); }
  catch { feedback('浏览器无法访问剪贴板。', true); }
});
$('hide-code').addEventListener('click', () => { $('dot-code').textContent = ''; $('dot-pair').hidden = true; });
configureFields();
refresh();
setInterval(refresh, 1000);
