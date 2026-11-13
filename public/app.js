'use strict';
// 前台：提示词框在上，生成结果在下。后台：登录验证后才能管理渠道。
const BASE = location.pathname.indexOf('/app') === 0 ? '/app' : '';
const api = (p) => BASE + p;
const media = (p) => BASE + p;
const $ = (id) => document.getElementById(id);
let genType = 'image';
let channels = [];
let token = localStorage.getItem('ai-gen-token') || '';
// ---------- 主题切换：白昼 / 墨夜 / 青瓷 / 深海，存在 localStorage，刷新后保持 ----------
const THEMES = ['daylight', 'ink', 'celadon', 'deepsea'];
function applyTheme(name) {
  const t = THEMES.includes(name) ? name : 'daylight';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ai-gen-theme', t); } catch {}
  document.querySelectorAll('#theme-switcher .theme-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
}
document.querySelectorAll('#theme-switcher .theme-btn').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
applyTheme(localStorage.getItem('ai-gen-theme') || 'daylight');
// 参考图（多张，用于换装等场景）：按用户选择的顺序排，第一张作首帧 / 主参考图。
// 每项是 {key, kind:'upload'|'generation', label, dataUrl?, generationId?}。
const MAX_REFS = 5;
let refItems = [];

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
    // 参考图行生图和生视频都用（换装等多张参考图），切换类型时不再清空
    refreshModels();
  });
});
function refThumb(item) {
  if (item.kind === 'upload') return item.dataUrl || '';
  return media('/api/media/' + encodeURIComponent(item.fileName || ''));
}
function renderRef() {
  $('ref-name').textContent = refItems.length ? `已选 ${refItems.length} 张参考图（第 1 张作首帧 / 主参考图）` : '';
  $('btn-clear-ref').hidden = !refItems.length;
  $('ref-preview').innerHTML = refItems.map((item) => `<span class="ref-thumb" style="display:inline-block;position:relative;margin:4px 6px 0 0">
    <img src="${refThumb(item)}" alt="${esc(item.label || '参考图')}" style="width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb">
    <button type="button" data-ref-remove="${item.key}" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid #d1d5db;background:#fff;cursor:pointer;line-height:1">×</button>
    <span style="display:block;font-size:11px;color:#9ca3af;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.label || '')}</span>
  </span>`).join('');
  document.querySelectorAll('[data-ref-remove]').forEach((b) => b.addEventListener('click', () => {
    refItems = refItems.filter((x) => x.key !== b.dataset.refRemove);
    renderRef();
  }));
}
function addRefUploads(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  let added = 0;
  const readers = list.map((f) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve({ file: f, dataUrl: String(r.result) });
    r.onerror = () => resolve(null);
    r.readAsDataURL(f);
  }));
  Promise.all(readers).then((results) => {
    for (const item of results) {
      if (!item) continue;
      if (refItems.length >= MAX_REFS) break;
      refItems.push({ key: 'u' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), kind: 'upload', label: item.file.name || '上传图片', dataUrl: item.dataUrl });
      added++;
    }
    if (refItems.length >= MAX_REFS && list.length > added) setStatus($('gen-status'), '参考图最多 ' + MAX_REFS + ' 张', true);
    renderRef();
  });
}
$('ref-file').addEventListener('change', (e) => {
  addRefUploads(e.target.files);
  e.target.value = '';
});
$('btn-clear-ref').addEventListener('click', () => { refItems = []; $('ref-file').value = ''; renderRef(); });
$('btn-clear-prompt').addEventListener('click', () => { $('prompt').value = ''; });
// ---------- 提示词框按内容自动增高 ----------
// 扩写后的提示词很长，4 行的框装不下，得拉滚动条才能看全。让框随内容
// 自动撑高（上限约 45% 屏高，超了才出现滚动条）；输入时、扩写填回时、
// 从生成记录填回提示词时都重新算一次高度。
function autoGrowPrompt() {
  const el = $('prompt');
  el.style.height = 'auto';
  const max = Math.floor(window.innerHeight * 0.45);
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
}
$('prompt').addEventListener('input', autoGrowPrompt);
window.addEventListener('resize', autoGrowPrompt);
// ---------- 图片预览（点结果图全屏看，像 Zipline 的预览） ----------
// 点结果图打开全屏预览；再点图切到原尺寸（可滚动看细节）；点空白处、
// 点 × 或按 Esc 关闭。视频自带播放控件，不走预览。
function openLightbox(src) {
  const img = $('lightbox-img');
  img.classList.remove('zoomed');
  img.src = src;
  $('lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-img').src = '';
  document.body.style.overflow = '';
}
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
$('lightbox-img').addEventListener('click', (e) => { e.stopPropagation(); $('lightbox-img').classList.toggle('zoomed'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

// ---------- 保存到相册（手机） ----------
// iOS 上点“下载”只会存到“文件”，进不了照片。改用系统分享（Web Share API）
// 把文件发到分享面板，里面点“存储图像 / 存储视频”就直接进相册了。
// 文件是现取的（视频要下载几 MB，点后稍等一下分享面板才会出来）。
// 不支持分享的浏览器就回退到普通下载。
async function shareToPhotos(g) {
  const url = media(g.url);
  const fileName = g.fileName || (g.url || '').split('/').pop() || 'media';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('下载失败');
    const blob = await res.blob();
    const file = new File([blob], fileName, { type: blob.type || (g.type === 'video' ? 'video/mp4' : 'image/png') });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    throw new Error('不支持分享');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 用户在分享面板点了取消，不算错
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus($('gen-status'), '这个浏览器不支持直接存相册，已改用普通下载（会存到“文件”里）');
  }
}

// ---------- 扩写提示词（文本模型） ----------
// 文本模型只做纯文本扩写：把提示词框里的短提示词扩写成详细的生成提示词，
// 填回框里，用户改好再点生成。渠道的文本接口是纯文本的，不支持看图，
// 所以没有“描述参考图”按钮（不是没做，是渠道根本不支持）。
$('btn-enhance').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) { setStatus($('gen-status'), '请先输入提示词再扩写', true); return; }
  const btn = $('btn-enhance');
  btn.disabled = true;
  setStatus($('gen-status'), '正在扩写提示词…');
  try {
    const { data } = await apiJson('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, type: genType, channelId: $('gen-channel').value || undefined }) });
    if (!data.ok) setStatus($('gen-status'), '扩写失败：' + (data.error || '未知错误'), true);
    else { $('prompt').value = data.text || prompt; autoGrowPrompt(); setStatus($('gen-status'), '已扩写，检查一下再点生成'); }
  } catch (e) { setStatus($('gen-status'), '扩写失败：' + e.message, true); }
  btn.disabled = false;
});
// ---------- 生成参数：与原版 infinite-canvas 对齐（web/src/lib/media-size.ts） ----------
// 生图：规格（1k/2k/4k/auto）× 比例 → 像素尺寸；生视频：清晰度 × 比例 → 像素尺寸。
const IMAGE_SIZE_PRESETS = {
  '1k': { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1536x864', '9:16': '864x1536', '21:9': '2016x864', '9:21': '864x2016' },
  '2k': { '1:1': '2048x2048', '2:3': '1360x2048', '3:2': '2048x1360', '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048', '21:9': '2688x1152', '9:21': '1152x2688' },
  '4k': { '1:1': '2880x2880', '2:3': '2336x3520', '3:2': '3520x2336', '4:3': '3312x2480', '3:4': '2480x3312', '16:9': '3840x2160', '9:16': '2160x3840', '21:9': '3840x1648', '9:21': '1648x3840' },
};
function computeImageSize(scale, ratio) {
  if (!ratio || ratio === 'auto') return 'auto';
  const s = String(scale || '1k').toLowerCase();
  if (s === 'auto') return ratio;
  return (IMAGE_SIZE_PRESETS[s] && IMAGE_SIZE_PRESETS[s][ratio]) || '1024x1024';
}
function computeVideoSize(resolution, ratio) {
  if (!ratio || ratio === 'auto') return 'auto';
  const parts = String(ratio).split(':');
  if (parts.length !== 2) return 'auto';
  const w = Number(parts[0]), h = Number(parts[1]);
  if (!w || !h) return 'auto';
  const p = Math.max(1, Math.floor(Number(resolution) || 720));
  const landscape = w >= h;
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const width = even(landscape ? (p * w) / h : p);
  const height = even(landscape ? p : (p * h) / w);
  return width + 'x' + height;
}
function refreshSizeLabels() {
  const imgSize = computeImageSize($('img-scale').value, $('img-ratio').value);
  $('img-size-show').textContent = imgSize === 'auto' ? '尺寸：自动' : '尺寸：' + imgSize;
  const vidSize = computeVideoSize($('vid-res').value, $('vid-ratio').value);
  $('vid-size-show').textContent = vidSize === 'auto' ? '尺寸：自动' : '尺寸：' + vidSize;
}
['img-scale', 'img-ratio'].forEach((id) => $(id).addEventListener('change', refreshSizeLabels));
['vid-res', 'vid-ratio'].forEach((id) => $(id).addEventListener('change', refreshSizeLabels));
refreshSizeLabels();

let pollTimer = null;
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
// 轮询生成记录：只要还有 status='generating' 的记录就每 2.5 秒刷新一次，
// 直到全部翻转为 completed / failed 才停。失败只以服务端记录为准，绝不提前报失败。
async function pollUntilDone(onDone) {
  stopPolling();
  pollTimer = setInterval(async () => {
    const { data } = await apiJson('/api/generations');
    const list = data.ok ? data.generations : [];
    await loadResults(list);
    const generating = list.find((g) => g.status === 'generating');
    if (generating && generating.note) setStatus($('gen-status'), generating.note);
    if (!list.some((g) => g.status === 'generating')) {
      stopPolling();
      const btn = $('btn-generate');
      btn.disabled = false;
      const latest = list[0];
      if (latest && latest.status === 'failed') setStatus($('gen-status'), '生成失败：' + (latest.error || '未知错误'), true);
      else if (latest) setStatus($('gen-status'), '已生成结果');
      if (onDone) onDone(list);
    }
  }, 2500);
}

$('btn-generate').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) { setStatus($('gen-status'), '请先输入提示词', true); return; }
  const btn = $('btn-generate');
  btn.disabled = true;
  setStatus($('gen-status'), '生成中（模型那边还在生成，请稍等）…');
  try {
    const body = { type: genType, prompt, channelId: $('gen-channel').value || undefined };
    // 参考图（多张，按选择顺序，第一张作首帧 / 主参考图）：生图和生视频都用
    if (refItems.length) body.references = refItems.map((item) => item.kind === 'upload' ? { dataUrl: item.dataUrl } : { generationId: item.generationId });
    if (genType === 'image') { body.size = computeImageSize($('img-scale').value, $('img-ratio').value); body.quality = $('img-quality').value; body.count = $('img-count').value; if ($('gen-model').value) body.imageModel = $('gen-model').value; }
    else { body.seconds = $('vid-seconds').value; body.size = computeVideoSize($('vid-res').value, $('vid-ratio').value); body.resolution = $('vid-res').value; body.generateAudio = $('vid-audio').checked; body.watermark = $('vid-watermark').checked; if ($('gen-model').value) body.videoModel = $('gen-model').value;  }
    const { data } = await apiJson('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!data.ok) { setStatus($('gen-status'), '生成失败：' + (data.error || '未知错误'), true); btn.disabled = false; }
    else {
      setStatus($('gen-status'), '生成中（模型那边还在生成，请稍等）…');
      await loadResults();
      pollUntilDone();
    }
  } catch (e) { setStatus($('gen-status'), '生成失败：' + e.message, true); btn.disabled = false; }
});

async function loadResults(preloaded) {
  const data = preloaded ? { ok: true, generations: preloaded } : (await apiJson('/api/generations')).data;
  const list = data.ok ? data.generations : [];
  $('result-count').textContent = list.length ? `共 ${list.length} 条` : '';
  $('empty-state').hidden = list.length > 0;
  $('results').innerHTML = list.map((g) => {
    const mediaHtml = g.status === 'generating'
      ? `<div style="padding:40px;text-align:center;color:#666">⏳ ${esc(g.note || '生成中（模型那边还在生成，请稍等）…')}</div>`
      : g.type === 'video'
      ? `<div class="video-wrap"><video src="${media(g.url)}" controls preload="metadata" playsinline webkit-playsinline></video><div class="video-loading" hidden><span class="spinner"></span></div></div>`
      : (g.url ? `<img src="${media(g.url)}" alt="">` : `<div style="padding:40px;text-align:center;color:#999">图片已失效</div>`);
    const extra = g.type === 'image' && g.status !== 'generating' ? `<button class="btn" data-act="to-video" data-id="${g.id}">🎬 用这张图生成视频</button><button class="btn" data-act="add-ref" data-id="${g.id}">＋ 设为参考图</button><button class="btn" data-act="edit-prompt" data-id="${g.id}">✏️ 编辑提示词</button>` : '';
    return `<div class="result">${mediaHtml}<div class="meta">
      <p><b>${g.type === 'video' ? '视频' : '图片'}</b> · ${esc(g.channelName || '')} · ${esc(g.model || '')}</p>
      <p>${esc(g.prompt || '')}</p>
      <p class="muted">${esc(g.createdAt || '')} ${g.source ? '· ' + esc(g.source) : ''} ${g.status === 'generating' ? '· ' + esc(g.note || '生成中…') : ''} ${g.status === 'failed' ? '· 生成失败：' + esc(g.error || '') : ''}</p>
      </div><div class="actions">${extra}
      ${g.url ? `<button class="btn save-photos" data-act="save-photos" data-id="${g.id}">📲 保存到相册</button><a class="btn dl-desktop" href="${media(g.url)}" download>⬇️ 下载</a>` : ''}
      <button class="btn danger" data-act="delete" data-id="${g.id}">删除</button>
      </div></div>`;
  }).join('');
  document.querySelectorAll('#results [data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const g = list.find((x) => x.id === b.dataset.id);
      if (!g) return;
      if (b.dataset.act === 'delete') { deleteResult(g.id); }
      if (b.dataset.act === 'save-photos') { shareToPhotos(g); }
      if (b.dataset.act === 'edit-prompt') { $('prompt').value = g.prompt || ''; autoGrowPrompt(); $('prompt').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (b.dataset.act === 'add-ref') {
        // 把这张生成图片加进参考图列表（换装等多张参考图时用）
        if (refItems.some((x) => x.kind === 'generation' && x.generationId === g.id)) { setStatus($('gen-status'), '这张图已经是参考图了'); return; }
        if (refItems.length >= MAX_REFS) { setStatus($('gen-status'), '参考图最多 ' + MAX_REFS + ' 张', true); return; }
        refItems.push({ key: 'g' + g.id, kind: 'generation', label: '生成图片', generationId: g.id, fileName: g.fileName });
        renderRef();
        setStatus($('gen-status'), '已加为参考图（第 ' + refItems.length + ' 张），生图和生视频都可以用');
      }
      if (b.dataset.act === 'to-video') {
        // 图生视频：切到生视频，这张图作首帧（参考图列表第 1 张），提示词填回去可改
        document.querySelector('#type-seg button[data-type="video"]').click();
        $('prompt').value = g.prompt || '';
        autoGrowPrompt();
        refItems = [{ key: 'g' + g.id, kind: 'generation', label: '生成图片', generationId: g.id, fileName: g.fileName }];
        renderRef();
        $('ref-name').textContent = '已用这张生成图片作首帧';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setStatus($('gen-status'), '已把这张图设为视频首帧，提示词已填回，改好点“生成”即可');
      }
    });
  });
  // 点结果图打开全屏预览
  document.querySelectorAll('#results .result img').forEach((im) => {
    im.addEventListener('click', () => openLightbox(im.src));
  });

  // 视频缓冲提示：点播放后数据没到就转圈，只有真正播起来才藏。
  // 注意：不能在 canplay / loadeddata 时藏——那两个事件只表示“有足够
  // 数据可以开始播”，iPhone 上从 canplay 到第一帧真正出来（playing）
  // 还要等好几秒，提前藏掉转圈，0:00 那几秒就看着像卡死了。
  document.querySelectorAll('#results .result video').forEach((v) => {
    const overlay = v.closest('.video-wrap').querySelector('.video-loading');
    const show = () => { overlay.hidden = false; };
    const hide = () => { overlay.hidden = true; };
    v.addEventListener('waiting', show);
    v.addEventListener('stalled', show);
    v.addEventListener('play', show);
    v.addEventListener('playing', hide);
    v.addEventListener('pause', hide);
    v.addEventListener('error', hide);
  });

  // 刷新后仍有未完成的生成（例如刷新页面时后台还在生成），继续轮询直到它完成
  if (list.some((g) => g.status === 'generating') && !pollTimer) {
    $('btn-generate').disabled = true;
    setStatus($('gen-status'), '生成中（模型那边还在生成，请稍等）…');
    pollUntilDone();
  }
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
    <p>生图模型：${esc(c.imageModel || '—')}　生视频模型：${esc(c.videoModel || '—')}　文本模型：${esc(c.textModel || '—')}</p>
    <p>能力：${(c.capabilities || []).map((x) => x === 'image' ? '生图' : x === 'video' ? '生视频' : '文本').join('、') || '—'}</p>
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
    $('ch-cap-image').checked = (c.capabilities || []).includes('image');
    $('ch-cap-video').checked = (c.capabilities || []).includes('video');
    $('ch-cap-text').checked = (c.capabilities || []).includes('text');
    $('ch-enabled').checked = c.enabled; $('ch-default').checked = !!c.isDefault;
    $('channel-form-title').textContent = '编辑渠道：' + c.name;
    // 编辑时用已保存的 Key 自动拉一次模型列表，下拉框里回填已选的模型
    fetchedModels = []; fillModelSelects();
    fetchModelsForForm({ imageModel: c.imageModel, videoModel: c.videoModel, textModel: c.textModel });
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
// ---------- 渠道表单：模型只能从 /models 返回的列表里下拉选择，不能手填 ----------
let fetchedModels = [];
function fillModelSelects(preset) {
  const imgSel = $('ch-img-model'); const vidSel = $('ch-vid-model'); const txtSel = $('ch-text-model');
  const imgVal = (preset && preset.imageModel) || imgSel.value;
  const vidVal = (preset && preset.videoModel) || vidSel.value;
  const txtVal = (preset && preset.textModel) || txtSel.value;
  const opts = '<option value="">— 请选择 —</option>' + fetchedModels.map((m) => `<option>${esc(m)}</option>`).join('');
  imgSel.innerHTML = opts; vidSel.innerHTML = opts; txtSel.innerHTML = opts;
  imgSel.disabled = !fetchedModels.length; vidSel.disabled = !fetchedModels.length; txtSel.disabled = !fetchedModels.length;
  if (imgVal && fetchedModels.includes(imgVal)) imgSel.value = imgVal;
  if (vidVal && fetchedModels.includes(vidVal)) vidSel.value = vidVal;
  if (txtVal && fetchedModels.includes(txtVal)) txtSel.value = txtVal;
}
async function fetchModelsForForm(preset) {
  // preset: 编辑已有渠道时，预先选中的生图/生视频模型（获取成功后回填）
  const id = $('ch-id').value;
  const body = id ? { channelId: id } : { baseUrl: $('ch-base').value.trim(), apiKey: $('ch-key').value.trim() };
  if (!id && (!body.baseUrl || !body.apiKey)) { setStatus($('model-fetch-status'), '请先填 Base URL 和 API Key', true); return false; }
  setStatus($('model-fetch-status'), '获取模型列表中…');
  const { data } = await apiJson('/api/admin/models', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (!data.ok) {
    fetchedModels = []; fillModelSelects();
    setStatus($('model-fetch-status'), '获取失败：' + (data.error || '未知错误'), true);
    return false;
  }
  if (!data.models || !data.models.length) {
    fetchedModels = []; fillModelSelects();
    setStatus($('model-fetch-status'), '渠道没有返回任何模型，请检查 Base URL / Key，模型下拉框保持禁用', true);
    return false;
  }
  fetchedModels = data.models;
  fillModelSelects(preset);
  setStatus($('model-fetch-status'), `已获取 ${data.total} 个模型，请在下拉框里选生图 / 生视频 / 文本模型`);
  return true;
}
$('btn-fetch-models').addEventListener('click', () => fetchModelsForForm(null));

$('btn-save-channel').addEventListener('click', async () => {
  const id = $('ch-id').value;
  const body = { name: $('ch-name').value.trim(), baseUrl: $('ch-base').value.trim(), apiKey: $('ch-key').value.trim(), imageModel: $('ch-img-model').value, videoModel: $('ch-vid-model').value, textModel: $('ch-text-model').value, capabilities: [...($('ch-cap-image').checked ? ['image'] : []), ...($('ch-cap-video').checked ? ['video'] : []), ...($('ch-cap-text').checked ? ['text'] : [])], enabled: $('ch-enabled').checked, isDefault: $('ch-default').checked };
  if (!id && !body.apiKey) { setStatus($('channel-status'), '请填写 API Key', true); return; }
  if (id && !body.apiKey) delete body.apiKey;
  // 模型只能从“获取模型列表”返回的下拉选项里选，不能手填、不能留空蒙过去
  if (!fetchedModels.length) { setStatus($('channel-status'), '请先点“获取模型列表”，从返回的模型里下拉选择', true); return; }
  if (body.capabilities.includes('image') && (!body.imageModel || !fetchedModels.includes(body.imageModel))) { setStatus($('channel-status'), '请在生图模型下拉框里选一个模型', true); return; }
  if (body.capabilities.includes('video') && body.videoModel && !fetchedModels.includes(body.videoModel)) { setStatus($('channel-status'), '生视频模型只能从下拉框里选', true); return; }
  if (body.capabilities.includes('text') && (!body.textModel || !fetchedModels.includes(body.textModel))) { setStatus($('channel-status'), '请在文本模型下拉框里选一个模型', true); return; }
  const path = id ? '/api/admin/channels/' + encodeURIComponent(id) : '/api/admin/channels';
  const { data } = await apiJson(path, { method: id ? 'PUT' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (!data.ok) { setStatus($('channel-status'), data.error || '保存失败', true); return; }
  setStatus($('channel-status'), '已保存');
  $('ch-id').value = ''; $('ch-name').value = ''; $('ch-base').value = ''; $('ch-key').value = '';
  fetchedModels = []; fillModelSelects(); setStatus($('model-fetch-status'), '');
  $('channel-form-title').textContent = '添加渠道';
  await loadAdminChannels(); await loadChannels();
});
$('btn-cancel-channel').addEventListener('click', () => {
  $('ch-id').value = ''; $('ch-name').value = ''; $('ch-base').value = ''; $('ch-key').value = '';
  fetchedModels = []; fillModelSelects(); setStatus($('model-fetch-status'), '');
  $('channel-form-title').textContent = '添加渠道';
});

loadHealth(); loadChannels(); loadResults();
