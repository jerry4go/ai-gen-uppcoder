'use strict';
// 前台：提示词框在上，生成结果在下。后台：登录验证后才能管理渠道。
const BASE = location.pathname.indexOf('/app') === 0 ? '/app' : '';
const api = (p) => BASE + p;
const media = (p) => BASE + p;
const $ = (id) => document.getElementById(id);
let genType = 'image';
let channels = [];
let token = localStorage.getItem('ai-gen-token') || '';
let refDataUrl = '';
let refSourceId = ''; // 图生视频时：已生成图片的记录 id

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function apiJson(path, opts) {
  const res = await fetch(api(path), opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 200) }; }
  if (!res.ok && data && data.ok === undefined) data = { ok: false, error: 'HTTP ' + res.status };
  return { res, data };
}
function authHeaders(extra) {
  return { ...(extra || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
}
function setStatus(el, msg, isErr) {
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

// ---------- 顶部 / 标签 ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('main .tab').forEach((x) => x.classList.remove('active'));
    $('tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'admin') refreshAdmin();
  });
});

async function loadHealth() {
  try {
    const { data } = await apiJson('/api/health');
    $('health').textContent = data.ok ? `服务正常 · ${data.channels} 个渠道 · ${data.generations} 条记录` : '服务异常';
  } catch { $('health').textContent = '服务未连通'; }
}

// ---------- 前台 ----------
async function loadChannels() {
  const { data } = await apiJson('/api/channels');
  channels = data.ok ? data.channels : [];
  const sel = $('gen-channel');
  sel.innerHTML = '<option value="">自动选择渠道</option>' + channels.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.isDefault ? '（默认）' : ''}</option>`).join('');
  $('channel-hint').textContent = channels.length
    ? `已配置 ${channels.length} 个渠道。生视频需要支持视频的渠道和 videoModel，没有就去后台添加。`
    : '还没有配置渠道？点上方“后台 · 渠道配置”登录后添加一个 OpenAI 兼容渠道（Base URL + API Key + 模型名）。';
  refreshModels();
}
function refreshModels() {
  const chId = $('gen-channel').value;
  const list = channels.filter((c) => !chId || c.id === chId).filter((c) => c.capabilities.includes(genType));
  const models = [...new Set(list.map((c) => genType === 'video' ? c.videoModel : c.imageModel).filter(Boolean))];
  const sel = $('gen-model');
  sel.innerHTML = '<option value="">自动选择模型</option>' + models.map((m) => `<option>${esc(m)}</option>`).join('');
}
$('gen-channel').addEventListener('change', refreshModels);
document.querySelectorAll('#type-seg button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#type-seg button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    genType = b.dataset.type;
    $('image-opts').hidden = genType !== 'image';
    $('video-opts').hidden = genType !== 'video';
    $('ref-row').hidden = genType !== 'video';
    if (genType !== 'video') { refDataUrl = ''; refSourceId = ''; renderRef(); }
    refreshModels();
  });
});
function renderRef() {
  $('ref-name').textContent = refDataUrl ? '已选择参考图' : (refSourceId ? '已用生成图片作首帧' : '');
  $('btn-clear-ref').hidden = !refDataUrl && !refSourceId;
  $('ref-preview').innerHTML = refDataUrl ? `<img src="${refDataUrl}" alt="参考图">` : '';
}
$('ref-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { refDataUrl = String(r.result); refSourceId = ''; renderRef(); };
  r.readAsDataURL(f);
});
$('btn-clear-ref').addEventListener('click', () => { refDataUrl = ''; refSourceId = ''; $('ref-file').value = ''; renderRef(); });
$('btn-clear-prompt').addEventListener('click', () => { $('prompt').value = ''; });

$('btn-generate').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) { setStatus($('gen-status'), '请先输入提示词', true); return; }
  const btn = $('btn-generate');
  btn.disabled = true;
  setStatus($('gen-status'), genType === 'video' ? '视频生成中（模型那边生成需要时间，请稍等）…' : '图片生成中…');
  try {
    const body = { type: genType, prompt, channelId: $('gen-channel').value || undefined };
    if (genType === 'image') { body.size = $('img-size').value; body.count = $('img-count').value; if ($('gen-model').value) body.imageModel = $('gen-model').value; }
    else { body.seconds = $('vid-seconds').value; body.size = $('vid-size').value; if ($('gen-model').value) body.videoModel = $('gen-model').value; if (refDataUrl) body.referenceImage = refDataUrl; if (refSourceId) body.sourceGenerationId = refSourceId; }
    const { data } = await apiJson('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!data.ok) { setStatus($('gen-status'), '生成失败：' + (data.error || '未知错误'), true); }
    else { setStatus($('gen-status'), `已生成 ${data.generations.length} 个结果`); }
    await loadResults();
  } catch (e) { setStatus($('gen-status'), '生成失败：' + e.message, true); }
  btn.disabled = false;
});

async function loadResults() {
  const { data } = await apiJson('/api/generations');
  const list = data.ok ? data.generations : [];
  $('result-count').textContent = list.length ? `共 ${list.length} 条` : '';
  $('empty-state').hidden = list.length > 0;
  $('results').innerHTML = list.map((g) => {
    const mediaHtml = g.type === 'video'
      ? `<video src="${media(g.url)}" controls preload="metadata"></video>`
      : (g.url ? `<img src="${media(g.url)}" alt="">` : `<div style="padding:40px;text-align:center;color:#999">图片已失效</div>`);
    const extra = g.type === 'image' ? `<button class="btn" data-act="to-video" data-id="${g.id}">🎬 用这张图生成视频</button><button class="btn" data-act="edit-prompt" data-id="${g.id}">✏️ 编辑提示词</button>` : '';
    return `<div class="result">${mediaHtml}<div class="meta">
      <p><b>${g.type === 'video' ? '视频' : '图片'}</b> · ${esc(g.channelName || '')} · ${esc(g.model || '')}</p>
      <p>${esc(g.prompt || '')}</p>
      <p class="muted">${esc(g.createdAt || '')} ${g.source ? '· ' + esc(g.source) : ''} ${g.status === 'failed' ? '· 生成失败：' + esc(g.error || '') : ''}</p>
      </div><div class="actions">${extra}
      ${g.url ? `<a class="btn" href="${media(g.url)}" download>⬇️ 下载</a>` : ''}
      <button class="btn danger" data-act="delete" data-id="${g.id}">删除</button>
      </div></div>`;
  }).join('');
  document.querySelectorAll('#results [data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const g = list.find((x) => x.id === b.dataset.id);
      if (!g) return;
      if (b.dataset.act === 'delete') { deleteResult(g.id); }
      if (b.dataset.act === 'edit-prompt') { $('prompt').value = g.prompt || ''; $('prompt').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (b.dataset.act === 'to-video') {
        // 图生视频：切到生视频，这张图作首帧，提示词填回去可改
        document.querySelector('#type-seg button[data-type="video"]').click();
        $('prompt').value = g.prompt || '';
        refSourceId = g.id; refDataUrl = '';
        renderRef();
        $('ref-name').textContent = '已用这张生成图片作首帧';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setStatus($('gen-status'), '已把这张图设为视频首帧，提示词已填回，改好点“生成”即可');
      }
    });
  });
}
async function deleteResult(id) {
  if (!confirm('确定删除这条生成记录吗？文件也会一起删掉。')) return;
  await apiJson('/api/generations/' + encodeURIComponent(id), { method: 'DELETE' });
  await loadResults();
}
$('btn-refresh').addEventListener('click', loadResults);

// ---------- 后台 ----------
async function refreshAdmin() {
  const { data } = await apiJson('/api/auth/status', { headers: authHeaders() });
  const loggedIn = !!(data && data.loggedIn);
  $('btn-logout').hidden = !loggedIn;
  if (!loggedIn) { $('login-card').hidden = false; $('change-card').hidden = true; $('admin-main').hidden = true; return; }
  if (data.mustChangePassword) { $('login-card').hidden = true; $('change-card').hidden = false; $('admin-main').hidden = true; return; }
  $('login-card').hidden = true; $('change-card').hidden = true; $('admin-main').hidden = false;
  await loadAdminChannels();
}
$('btn-login').addEventListener('click', async () => {
  setStatus($('login-status'), '登录中…');
  const { data } = await apiJson('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value }) });
  if (!data.ok) { setStatus($('login-status'), data.error || '登录失败', true); return; }
  token = data.token; localStorage.setItem('ai-gen-token', token);
  setStatus($('login-status'), '');
  await refreshAdmin();
});
$('btn-logout').addEventListener('click', async () => {
  await apiJson('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  token = ''; localStorage.removeItem('ai-gen-token');
  await refreshAdmin();
});
async function changePassword(currentEl, newEl, confirmEl, statusEl, afterOk) {
  const cur = $(currentEl).value; const nw = $(newEl).value; const cf = confirmEl ? $(confirmEl).value : nw;
  if (nw.length < 6) { setStatus($(statusEl), '新密码至少 6 位', true); return; }
  if (nw !== cf) { setStatus($(statusEl), '两次输入的新密码不一致', true); return; }
  const { data } = await apiJson('/api/auth/change-password', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
  if (!data.ok) { setStatus($(statusEl), data.error || '修改失败', true); return; }
  setStatus($(statusEl), '密码已修改，请用新密码重新登录');
  token = ''; localStorage.removeItem('ai-gen-token');
  if (afterOk) setTimeout(afterOk, 600);
}
$('btn-change-pass').addEventListener('click', () => changePassword('cp-current', 'cp-new', 'cp-confirm', 'cp-status', refreshAdmin));
$('btn-change-pass2').addEventListener('click', () => changePassword('cp2-current', 'cp2-new', null, 'cp2-status', refreshAdmin));

async function loadAdminChannels() {
  const { res, data } = await apiJson('/api/admin/channels', { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) { await refreshAdmin(); return; }
  const list = data.ok ? data.channels : [];
  $('channel-count').textContent = list.length ? `共 ${list.length} 个` : '';
  $('channel-list').innerHTML = list.length ? list.map((c) => `<div class="channel">
    <h3>${esc(c.name)} ${c.isDefault ? '<span class="tag">默认</span>' : ''} ${c.enabled ? '' : '<span class="tag off">已停用</span>'}</h3>
    <p>Base URL：${esc(c.baseUrl)}</p>
    <p>Key：${esc(c.apiKeyMasked || '')}</p>
    <p>生图模型：${esc(c.imageModel || '—')}　生视频模型：${esc(c.videoModel || '—')}</p>
    <p>能力：${(c.capabilities || []).map((x) => x === 'image' ? '生图' : '生视频').join('、') || '—'}</p>
    <div class="actions">
      <button class="btn" data-test="${c.id}">测连接</button>
      <button class="btn" data-edit="${c.id}">编辑</button>
      <button class="btn" data-toggle="${c.id}">${c.enabled ? '停用' : '启用'}</button>
      <button class="btn danger" data-del="${c.id}">删除</button>
      <span class="status" id="test-${c.id}"></span>
    </div></div>`).join('') : '<p class="muted">还没有渠道，点下面添加一个。</p>';
  document.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const el = $('test-' + b.dataset.test); setStatus(el, '测试中…');
    const { data } = await apiJson('/api/admin/channels/' + encodeURIComponent(b.dataset.test) + '/test', { method: 'POST', headers: authHeaders() });
    setStatus(el, data.ok ? `连接正常，返回 ${data.total} 个模型` : ('连接失败：' + (data.error || '')), !data.ok);
  }));
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const c = list.find((x) => x.id === b.dataset.edit); if (!c) return;
    $('ch-id').value = c.id; $('ch-name').value = c.name; $('ch-base').value = c.baseUrl; $('ch-key').value = '';
    $('ch-img-model').value = c.imageModel || ''; $('ch-vid-model').value = c.videoModel || '';
    $('ch-cap-image').checked = (c.capabilities || []).includes('image');
    $('ch-cap-video').checked = (c.capabilities || []).includes('video');
    $('ch-enabled').checked = c.enabled; $('ch-default').checked = !!c.isDefault;
    $('channel-form-title').textContent = '编辑渠道：' + c.name;
    window.scrollTo({ top: document.querySelector('#channel-form-title').offsetTop, behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const c = list.find((x) => x.id === b.dataset.toggle); if (!c) return;
    await apiJson('/api/admin/channels/' + encodeURIComponent(c.id), { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled: !c.enabled }) });
    await loadAdminChannels(); await loadChannels();
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定删除这个渠道吗？')) return;
    await apiJson('/api/admin/channels/' + encodeURIComponent(b.dataset.del), { method: 'DELETE', headers: authHeaders() });
    await loadAdminChannels(); await loadChannels();
  }));
}
$('btn-save-channel').addEventListener('click', async () => {
  const id = $('ch-id').value;
  const body = { name: $('ch-name').value.trim(), baseUrl: $('ch-base').value.trim(), apiKey: $('ch-key').value.trim(), imageModel: $('ch-img-model').value.trim(), videoModel: $('ch-vid-model').value.trim(), capabilities: [...($('ch-cap-image').checked ? ['image'] : []), ...($('ch-cap-video').checked ? ['video'] : [])], enabled: $('ch-enabled').checked, isDefault: $('ch-default').checked };
  if (!id && !body.apiKey) { setStatus($('channel-status'), '请填写 API Key', true); return; }
  if (id && !body.apiKey) delete body.apiKey;
  const path = id ? '/api/admin/channels/' + encodeURIComponent(id) : '/api/admin/channels';
  const { data } = await apiJson(path, { method: id ? 'PUT' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (!data.ok) { setStatus($('channel-status'), data.error || '保存失败', true); return; }
  setStatus($('channel-status'), '已保存');
  $('ch-id').value = ''; $('ch-name').value = ''; $('ch-base').value = ''; $('ch-key').value = ''; $('ch-img-model').value = ''; $('ch-vid-model').value = '';
  $('channel-form-title').textContent = '添加渠道';
  await loadAdminChannels(); await loadChannels();
});
$('btn-cancel-channel').addEventListener('click', () => {
  $('ch-id').value = ''; $('ch-name').value = ''; $('ch-base').value = ''; $('ch-key').value = ''; $('ch-img-model').value = ''; $('ch-vid-model').value = '';
  $('channel-form-title').textContent = '添加渠道';
});

loadHealth(); loadChannels(); loadResults();
