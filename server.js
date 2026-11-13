'use strict';
/**
 * AI 生图 / 生视频（简化版无限画布的 Uppcoder 版）
 * 没有画布、没有节点、没有 Agent、没有插件、没有音频。
 * 前台：提示词框在上，生成结果在下；生图 / 生视频；图片可图生视频、可编辑提示词；
 * 生视频可上传本地图片作首帧。
 * 后台：登录验证后才能进，可配置模型渠道（OpenAI 兼容接口）。
 * 零依赖：只用 Node.js 标准库。启动：node server.js（PORT 环境变量，默认 8000）
 * 数据：./data/auth.json / channels.json / generations.json，生成的文件存 ./data/media/
 * 部署要点：Uppcoder 把 /app/ 代理到本服务端口，所以同时接受 /api/... 和 /app/api/...，
 * 静态资源用相对路径。密钥只存在服务器 ./data/，永不写进仓库、永不在前端明文返回。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- JSON 文件存储 ----------
function loadJson(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('load', name, e.message); return fallback; }
}
function saveJson(name, data) {
  const p = path.join(DATA_DIR, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function newId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function cleanBaseUrl(u) { return String(u || '').trim().replace(/\/$/, ''); }

// ---------- 管理员账号（首次登录强制改密码） ----------
// 初始账号 admin / admin123，仅用于首次登录；登录后必须改密码才能管理渠道。
// 密码以加盐 SHA-256 存 ./data/auth.json，仓库里没有任何密码。
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}
function ensureAuth() {
  let auth = loadJson('auth.json', null);
  if (!auth || !auth.username || !auth.salt || !auth.hash) {
    const salt = crypto.randomBytes(16).toString('hex');
    auth = { username: 'admin', salt, hash: hashPassword('admin123', salt), mustChangePassword: true, createdAt: nowIso() };
    saveJson('auth.json', auth);
    console.log('已创建初始管理员账号 admin（首次登录必须改密码）');
  }
  return auth;
}
let auth = ensureAuth();
const sessions = new Map(); // token -> { username, expiresAt }
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}
function authFromReq(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expiresAt < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}

// ---------- 渠道 ----------
let channels = loadJson('channels.json', []);
if (!Array.isArray(channels)) channels = [];
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '********';
  return '********' + k.slice(-4);
}
function publicChannel(c) {
  return { id: c.id, name: c.name, baseUrl: c.baseUrl, apiKeyMasked: maskKey(c.apiKey), imageModel: c.imageModel || '', videoModel: c.videoModel || '', capabilities: c.capabilities || [], enabled: c.enabled !== false, isDefault: !!c.isDefault, createdAt: c.createdAt };
}
function publicChannelForFront(c) {
  // 前台只需要知道名字、模型和能力，绝不返回 Key（哪怕是掩码以外的任何形式）
  return { id: c.id, name: c.name, imageModel: c.imageModel || '', videoModel: c.videoModel || '', capabilities: c.capabilities || [], enabled: c.enabled !== false, isDefault: !!c.isDefault };
}
// 模型只能从渠道 /models 返回的列表里选：保存渠道时先拉一次 /models 校验，
// 填的模型不在列表里就拒绝；拉不到列表也拒绝（不能靠手填蒙过去）。
async function validateModelsAgainstChannel(baseUrl, apiKey, imageModel, videoModel) {
  let models;
  try {
    const r = await fetchTimeout(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey } }, 15000);
    const { json, text } = await readJsonResponse(r);
    if (!r.ok) return '无法获取模型列表：' + channelErrorText(r.status, (json && (json.error && json.error.message)) || text);
    models = ((json && json.data) || []).map(m => (typeof m === 'string' ? m : m.id || '')).filter(Boolean);
  } catch (e) {
    return '无法获取模型列表：' + e.message;
  }
  if (!models.length) return '渠道没有返回任何模型，请检查 Base URL / Key';
  if (imageModel && !models.includes(imageModel)) return '生图模型 ' + imageModel + ' 不在渠道返回的模型列表里（共 ' + models.length + ' 个），请从下拉框里选';
  if (videoModel && !models.includes(videoModel)) return '生视频模型 ' + videoModel + ' 不在渠道返回的模型列表里（共 ' + models.length + ' 个），请从下拉框里选';
  return null;
}
function pickChannel(channelId, kind) {
  const list = channels.filter(c => c.enabled !== false && (c.capabilities || []).includes(kind));
  if (!list.length) return null;
  if (channelId) {
    const c = list.find(x => x.id === channelId);
    if (c) return c;
  }
  return list.find(x => x.isDefault) || list[0];
}

// ---------- 生成记录 ----------
let generations = loadJson('generations.json', []);
if (!Array.isArray(generations)) generations = [];
// 服务启动时：所有还停在 'generating' 的记录，其后台任务已随旧进程消失，
// 不会再完成（重启后没有任何任务能活下来，15 分钟以内的也一样）。
// 直接标记为失败并写明原因，避免前台一直轮询等一个永远不会来的结果。
{
  let stale = 0;
  for (const g of generations) {
    if (g.status === 'generating') {
      g.status = 'failed'; g.note = '';
      g.error = '服务重启/重新部署导致该生成被中断（后台任务已不存在），请重新生成';
      stale++;
    }
  }
  if (stale) { saveJson('generations.json', generations); console.log('已标记 ' + stale + ' 条重启前未完成的生成记录为失败'); }
}
function saveGeneration(g) {
  generations.unshift(g);
  generations = generations.slice(0, 100);
  saveJson('generations.json', generations);
  return g;
}
// 更新一条已存在的生成记录（异步生成任务用：先建 pending 记录，后台完成后再填结果）
function updateGeneration(id, patch) {
  const g = generations.find(x => x.id === id);
  if (!g) return null;
  Object.assign(g, patch);
  saveJson('generations.json', generations);
  return g;
}
function mediaUrlFor(fileName) { return '/api/media/' + encodeURIComponent(fileName); }
function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}
function saveMediaBuffer(buf, mime, prefix) {
  const ext = extForMime(mime);
  const fileName = prefix + '-' + newId() + '.' + ext;
  fs.writeFileSync(path.join(MEDIA_DIR, fileName), buf);
  return { fileName, url: mediaUrlFor(fileName), bytes: buf.length, mimeType: mime || 'application/octet-stream' };
}

// Cloudflare 命名隧道走代理（proxied）时，Browser Integrity Check 会
// 拦截非浏览器 User-Agent（如 Node 默认的 "node"、Python-urllib），
// 返回 403 error 1010。所有渠道请求统一带一个浏览器 UA。
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 20000);
  const o = { ...(opts || {}) };
  const h = { ...(o.headers || {}) };
  if (!Object.keys(h).some(k => k.toLowerCase() === 'user-agent')) h['User-Agent'] = BROWSER_UA;
  o.headers = h;
    return fetch(url, { ...o, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// 用 curl 下载一个 URL 到临时文件，返回响应的 Content-Type。
// 2026-11-13 00:05 实测：同一容器内 curl 下载隧道媒体地址一次成功
// （200，2.1MB，1.8s），而 Node fetch 对同一地址 3 次全是 fetch
// failed——undici 与 Cloudflare 隧道边缘在大文件下载上的交互问题，
// 小 JSON 轮询走 fetch 正常。curl 是容器自带的，优先用它。
function curlDownload(url, tmpPath) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-L', '--max-time', '180', '-A', BROWSER_UA, '-o', tmpPath, '-w', '%{http_code} %{content_type}', url],
             { timeout: 185000, maxBuffer: 1024 * 1024 },
             (err, stdout, stderr) => {
               if (err) {
                 const e = new Error('curl 下载失败: ' + String((stderr && String(stderr).trim()) || err.message || err));
                 return reject(e);
               }
               const out = String(stdout || '').trim();
               const sp = out.indexOf(' ');
               const code = parseInt(sp >= 0 ? out.slice(0, sp) : out, 10);
               const ctype = sp >= 0 ? out.slice(sp + 1).trim() : '';
               if (!code || code < 200 || code >= 300) {
                 const e = new Error('下载生成文件失败 HTTP ' + (code || 'unknown'));
                 e.isHttpError = true; e.httpStatus = code || 0; e.doNotRetry = true;
                 return reject(e);
               }
               resolve(ctype);
             });
  });
}

async function downloadToMedia(url, prefix) {
  // 注意：到这里渠道已经生成好了文件，只是在下载。下载失败时绝不能
  // 让外层重试整个生成调用——那会让渠道侧再烧一次生成。下载错误
  // 一律打上 doNotRetry 标记，外层重试循环会直接放过。
  // 但下载本身是幂等的（文件已在渠道侧生成好，再拉一次不会多烧
  // 一次生成），所以下载内部可以重试：2026-11-12 18:21 实测，视频
  // 已在渠道侧生成好（3.3MB mp4 已落盘），取回时 Instabox 公网
  // 代理瞬时抖动导致 fetch 失败，记录直接判失败、视频丢了。
  // 传输层失败重试 3 次（间隔 10s / 20s）；渠道 HTTP 错误立即失败。
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let mime = '';
      let buf = null;
      const tmpName = 'dl-' + crypto.randomBytes(8).toString('hex') + '.tmp';
      const tmpPath = path.join(MEDIA_DIR, tmpName);
      try {
        mime = await curlDownload(url, tmpPath);
        buf = fs.readFileSync(tmpPath);
      } catch (curlErr) {
        if (curlErr && curlErr.isHttpError) throw curlErr;
        // curl 不可用或传输失败：回退到 fetch 再试一次
        const res = await fetchTimeout(url, {}, 180000);
        if (!res.ok) {
          const err = new Error('下载生成文件失败 HTTP ' + res.status);
          err.isHttpError = true; err.httpStatus = res.status; err.doNotRetry = true;
          throw err;
        }
        mime = (res.headers.get('content-type') || '').split(';')[0].trim();
        buf = Buffer.from(await res.arrayBuffer());
      } finally {
        if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch {} }
      }
      mime = mime || (prefix === 'video' ? 'video/mp4' : 'image/png');
      if (!buf || !buf.length) throw new Error('下载到的文件为空');
      return saveMediaBuffer(buf, mime, prefix);
    } catch (e) {
      lastErr = e;
      if (isHttpError(e) || !isTransportError(e) || attempt >= 3) break;
      console.error('download attempt ' + attempt + ' failed, retrying:', e.message, 'url=' + url);
      await sleep(attempt === 1 ? 10000 : 20000);
    }
  }
  if (lastErr && typeof lastErr === 'object') lastErr.doNotRetry = true;
  throw lastErr;
}
function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) throw new Error('参考图格式不正确');
  const mime = m[1] || 'image/png';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, buf, ext: extForMime(mime) };
}

// ---------- multipart（给 /images/edits 和 /videos 用） ----------
function buildMultipart(fields, files) {
  const boundary = '----ai-gen-' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(f.buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
async function readJsonResponse(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}
function channelErrorText(status, text) {
  return '渠道返回 HTTP ' + status + ': ' + String(text || '').slice(0, 300);
}

// ---------- 渠道 HTTP 错误绝不重试，只有传输层失败才重试 ----------
// 2026-11-12 实测：重试 3 次导致渠道侧直接生成了 3 张图。渠道收到 POST 就会立刻开始生成，
// 报 502 时生成其实已经在渠道侧启动了，再发一次 POST 不是“恢复第一张图”，而是又烧一次全新的生成。
// 所以收到渠道返回的 HTTP 错误（502/503/504/429/401/403/404/400 等）时一次都不重试，立即按原样记失败；
// 想再试由用户手动点生成。注意：旧版同步 /images/generations 没有任务 ID，断开后无法事后查询已生成的图；新版改走异步任务（见下），任务有 ID、可轮询查询。这一点没有变的是“重发”仍是错的——建任务本身就会烧一次生成。
// 只有根本没收到任何 HTTP 响应时（fetch 失败、连接被重置、超时 abort）才重试 1 次（共 2 次调用），间隔 10 秒。
const MAX_GENERATION_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [10000]; // 传输层失败后等 10 秒重试 1 次
const IMAGE_TASK_CREATE_TIMEOUT_MS = 15000; // 建生图任务：一次快速请求
const IMAGE_TASK_POLL_TIMEOUT_MS = 20000; // 轮询任务状态：一次快速请求
const IMAGE_TASK_POLL_INTERVAL_MS = 2500; // 轮询间隔
const IMAGE_TASK_MAX_POLLS = 240; // 最多约 10 分钟
const VIDEO_CREATE_TIMEOUT_MS = 300000; // 生视频建任务 5 分钟
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function channelHttpError(status, text) {   const err = new Error(channelErrorText(status, text));   err.isHttpError = true;   err.httpStatus = status;   return err; } function isHttpError(e) {   if (e && e.isHttpError) return true;   const msg = String((e && e.message) || e || '');   return /^渠道返回 HTTP \d+/.test(msg) || /^下载生成文件失败 HTTP \d+/.test(msg) || /^取回文件失败 HTTP \d+/.test(msg); } function isTransportError(e) {
  const msg = String((e && e.message) || e || '');
  if (e && e.doNotRetry) return false; if (isHttpError(e)) return false; if (e && e.name === 'AbortError') return true;
  // HTTP 错误绝不重试
  if (/aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(msg)) return true;
  return false;
}

// ---------- 与原版 infinite-canvas 对齐的请求格式 ----------
// 原版 web/src/services/api/image.ts requestGeneration / requestEdit：生图带 response_format: "b64_json" + output_format: "png"（gpt-image 模型按原版省略 response_format，它本来就返回 b64），图片以内联 base64 返回，不走 URL 下载。
const IMAGE_OUTPUT_FORMAT = 'png';
function imageFormatFields(model) {
  // gpt-image 模型拒绝 response_format；其它模型按原版加 b64_json + png。
  return /gpt-image/.test(model) ? { output_format: IMAGE_OUTPUT_FORMAT } : { response_format: 'b64_json', output_format: IMAGE_OUTPUT_FORMAT };
}

// 原版 web/src/services/api/video.ts createOpenAIVideoTask：ratio 由 size 推断
// （auto 时省略），resolution_name 默认 720p，generate_audio true，watermark false，
// mode 为 frames（只有 mode=reference 或参考图 >2 张时才是 reference；本应用
// 最多一张参考图，所以始终 frames）。
function inferVideoRatio(size) {
  if (!size || size === 'auto') return 'auto';
  const ratios = [['1:1', 1], ['3:4', 3 / 4], ['4:3', 4 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16], ['21:9', 21 / 9]];
  const direct = ratios.find(([v]) => v === size);
  if (direct) return direct[0];
  const m = String(size).match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) return '16:9';
  const target = Number(m[1]) / Number(m[2]);
  return ratios.reduce((best, [v, r]) => (Math.abs(r - target) < Math.abs(ratios.find(([bv]) => bv === best)[1] - target) ? v : best), '16:9');
}

// ---------- 生图 ----------
// ---------- 生图（异步任务 + 轮询，绕过反代 20 秒超时） ----------
// 2026-11-12 在 my-free-test-vm 上实测的根因：muse2api 的同步
// /images/generations 一次要等 ~27 秒，而 Instabox 公网代理
// （1314-….instabox.tech）在 ~20 秒就把长连接掐断，返回 502
// "The sandbox service disconnected or is unavailable."；机器本地调
// 127.0.0.1:1314 同一请求 27 秒 200 成功。muse2api 自带异步任务
// 接口就是为此设计的（注释原话："Opt-in polling avoids
// reverse-proxy timeouts"）：建任务 0.2 秒返回，之后每次轮询都
// 只要 0.1~0.2 秒，单次请求永远碰不到 20 秒上限，轮询本身不重复
// 生成。生图走 POST /v1/images/tasks，图生图走 POST /images/edits
// 带 async=true，两者都返回 202 {id/task_id}，再轮询
// GET /v1/images/tasks/{id} 直到 completed/failed。
function resolveChannelUrl(channel, url) {
  // 渠道返回的媒体 URL 可能指向它自己的内网地址（muse2api 的
  // public_base 配的是 http://172.16.0.2:1314，任务里返回的视频 URL
  // 就是这个内网地址，Uppcoder 上根本连不上，下载会报 fetch failed）。
  // 只要路径对，换成渠道 Base URL 的域名就能走公网取到：
  // 相对路径按 Base URL 解析；绝对地址但域名不同时，只换域名、保留路径。
  // 注意：必须同时换端口——只换 host 不换 port 时，内网地址的 :1314
  // 端口会被保留下来，拼成 https://域名:1314/...，Cloudflare 边缘根本
  // 不监听 1314 端口，连接会直接超时（2026-11-13 00:36 实测：带 :1314
  // 的地址 curl 15 秒超时、0 字节；去掉端口后 1 秒下载成功）。
  if (!url) return '';
  try {
    const base = new URL(channel.baseUrl.replace(/\/$/, '') + '/');
    const u = new URL(url, base);
    if (u.origin !== base.origin) u.protocol = base.protocol, u.host = base.host, u.port = base.port;
    return u.toString();
  } catch { return url; }
}
async function pollImageTask(channel, taskId) {
  const headers = { Authorization: 'Bearer ' + channel.apiKey };
  for (let attempt = 0; attempt < IMAGE_TASK_MAX_POLLS; attempt++) {
    await sleep(IMAGE_TASK_POLL_INTERVAL_MS);
    let res;
    try {
      res = await fetchTimeout(channel.baseUrl + '/images/tasks/' + encodeURIComponent(taskId), { headers }, IMAGE_TASK_POLL_TIMEOUT_MS);
    } catch (e) {
      // 轮询只是查询已建好的任务，失败绝不能让外层重发生成调用。
      // 2026-11-12 补充：单次轮询遇到传输层抖动时继续轮询（任务还
      // 在渠道侧跑着），而不是直接判失败；只有非传输层错误才抛出。
      if (isTransportError(e)) {
        console.error('image poll attempt ' + attempt + ' transport error, continuing:', e.message);
        continue;
      }
      if (e && typeof e === 'object') e.doNotRetry = true;
      throw e;
    }
    const { json, text } = await readJsonResponse(res);
    if (!res.ok) throw channelHttpError(res.status, (json && (json.error && json.error.message)) || text);
    const task = json || {};
    const status = String(task.status || '');
    if (status === 'failed') {
      const err = new Error('渠道图片任务失败：' + String(task.error || '未知错误').slice(0, 300));
      err.doNotRetry = true;
      throw err;
    }
    if (status === 'completed') {
      const items = (task.data && task.data) || [];
      const item = items[0];
      if (item) {
        if (item.b64_json) return saveMediaBuffer(Buffer.from(item.b64_json, 'base64'), 'image/png', 'image');
        if (item.url) return downloadToMedia(resolveChannelUrl(channel, item.url), 'image');
      }
      const resultUrl = task.result && task.result.url;
      if (resultUrl) return downloadToMedia(resolveChannelUrl(channel, resultUrl), 'image');
      throw new Error('渠道图片任务已完成，但没有返回图片');
    }
  }
  const err = new Error('渠道图片任务轮询超时（约 10 分钟），请稍后重试');
  err.doNotRetry = true;
  throw err;
}
async function generateImage(channel, body) {
  const prompt = String(body.prompt || '').trim();
  const size = String(body.size || '1024x1024');
  const count = Math.min(4, Math.max(1, parseInt(body.count || '1', 10) || 1));
  const model = String(body.imageModel || channel.imageModel || '').trim();
  if (!model) throw new Error('该渠道没有配置生图模型，请先在后台填写 imageModel');
  const headers = { Authorization: 'Bearer ' + channel.apiKey };
  const results = [];
  for (let i = 0; i < count; i++) {
    let taskId = '';
    if (body.referenceImage) {
      const ref = dataUrlToBuffer(body.referenceImage);
      const { body: mpBody, contentType } = buildMultipart(
        { model, prompt, size, n: '1', async: 'true', ...imageFormatFields(model) },
        [{ name: 'image', filename: 'reference.' + ref.ext, mime: ref.mime, buf: ref.buf }]
      );
      const res = await fetchTimeout(channel.baseUrl + '/images/edits', { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body: mpBody }, IMAGE_TASK_CREATE_TIMEOUT_MS);
      const { json, text } = await readJsonResponse(res);
      if (!res.ok) throw channelHttpError(res.status, (json && (json.error && json.error.message)) || text);
      taskId = (json && (json.task_id || json.id)) || '';
    } else {
      const res = await fetchTimeout(channel.baseUrl + '/images/tasks', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size, n: 1, ...imageFormatFields(model) }),
      }, IMAGE_TASK_CREATE_TIMEOUT_MS);
      const { json, text } = await readJsonResponse(res);
      if (!res.ok) throw channelHttpError(res.status, (json && (json.error && json.error.message)) || text);
      taskId = (json && (json.task_id || json.id)) || '';
    }
    if (!taskId) throw new Error('渠道没有返回图片任务 ID');
    results.push(await pollImageTask(channel, taskId));
  }
  return results;
}
async function imageItemToMedia(item, prefix) {
  // 保留供其它调用方使用（生图主流程现走任务轮询，见 pollImageTask）。
  if (item.b64_json) return saveMediaBuffer(Buffer.from(item.b64_json, 'base64'), 'image/png', prefix);
  if (item.url) return downloadToMedia(item.url, prefix);
  throw new Error('渠道返回的图片没有可用的 b64_json 或 url');
}

// ---------- 生视频 ----------
function videoUrlFrom(data) {
  if (!data || typeof data !== 'object') return '';
  // muse2api 的任务结果在 result.url 里（见 2026-11-12 实测：轮询返回
  // {status:"completed", result:{url:"http://172.16.0.2:1314/v1/media/....mp4"}}）。
  // 之前没查 result.url，永远走 /videos/{id}/content，而这版 muse2api
  // 的 /content 直接 404，视频永远取不回来。先查 result.url，再查其它位置。
  return (data.result && (data.result.url || data.result.video_url))
    || data.url || data.video_url || data.result_url
    || (data.content && (data.content.video_url || data.content.url)) || '';
}
async function generateVideo(channel, body) {
  const prompt = String(body.prompt || '').trim();
  const model = String(body.videoModel || channel.videoModel || '').trim();
  if (!model) throw new Error('该渠道没有配置生视频模型，请先在后台填写 videoModel');
  const seconds = String(body.seconds || '5');
  const size = String(body.size || '1280x720');
  const headers = { Authorization: 'Bearer ' + channel.apiKey };
  // 首帧：优先用上传的参考图；其次用已生成图片的记录（sourceGenerationId）
  let firstFrame = null;
  if (body.referenceImage) firstFrame = dataUrlToBuffer(body.referenceImage);
  else if (body.sourceGenerationId) {
    const src = generations.find(g => g.id === body.sourceGenerationId);
    if (src && src.fileName) {
      const p = path.join(MEDIA_DIR, src.fileName);
      if (fs.existsSync(p)) firstFrame = { mime: src.mimeType || 'image/png', buf: fs.readFileSync(p), ext: extForMime(src.mimeType) };
    }
  }
  // 按原版 createOpenAIVideoTask 补齐字段：ratio / resolution_name /
  // generate_audio / watermark / mode（mode 始终 frames，见上）。
  const ratio = inferVideoRatio(size);
  const fields = { model, prompt, seconds, size, ...(ratio && ratio !== 'auto' ? { ratio } : {}), resolution_name: '720p', generate_audio: 'true', watermark: 'false', mode: 'frames' };
  const files = [];
  if (firstFrame) {
    files.push({ name: 'first_frame', filename: 'first.' + firstFrame.ext, mime: firstFrame.mime, buf: firstFrame.buf });
    files.push({ name: 'images', filename: 'first.' + firstFrame.ext, mime: firstFrame.mime, buf: firstFrame.buf });
    
  }
  const { body: mpBody, contentType } = buildMultipart(fields, files);
  let createdRes = null; for (let createAttempt = 1; createAttempt <= MAX_GENERATION_ATTEMPTS; createAttempt++) { try { createdRes = await fetchTimeout(channel.baseUrl + '/videos', { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body: mpBody }, VIDEO_CREATE_TIMEOUT_MS); break; } catch (e) { if (isTransportError(e) && createAttempt < MAX_GENERATION_ATTEMPTS) { await sleep(RETRY_BACKOFF_MS[0]); continue; } e.doNotRetry = true; throw e; } }
  const created = await readJsonResponse(createdRes);
  if (!createdRes.ok) throw channelHttpError(createdRes.status, (created.json && (created.json.error && created.json.error.message)) || created.text);
  const createdData = (created.json && created.json.data) || created.json || {};
  const taskId = createdData.id;
  if (!taskId) {
    // 有些渠道直接返回视频 URL（同步）
    const direct = videoUrlFrom(createdData);
    if (direct) return downloadToMedia(resolveChannelUrl(channel, direct), 'video');
    throw new Error('渠道没有返回视频任务 ID');
  }
  // 轮询：最多约 5 分钟。轮询只是查询已建好的任务，不是重试；但轮询
  // 或取回步骤一旦失败，任务 ID 已存在，外层绝不能重发创建调用
  // （会建重复任务），所以这里的错误一律打上 doNotRetry。
  // 2026-11-12 补充：轮询本身是幂等的，单次轮询请求遇到传输层抖动
  // （如 Instabox 代理瞬时断开）时不应直接判整个生成失败——任务还
  // 在渠道侧跑着，继续轮询就能等到它完成；只有渠道 HTTP 错误、
  // 任务明确 failed/cancelled、或轮询预算耗尽才失败。
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise(r => setTimeout(r, 2500));
    let res;
    try {
      res = await fetchTimeout(channel.baseUrl + '/videos/' + encodeURIComponent(taskId), { headers }, 20000);
    } catch (e) {
      if (isTransportError(e)) {
        console.error('video poll attempt ' + attempt + ' transport error, continuing:', e.message);
        continue;
      }
      if (e && typeof e === 'object') e.doNotRetry = true;
      throw e;
    }
    const { json, text } = await readJsonResponse(res);
    if (!res.ok) throw channelHttpError(res.status, (json && (json.error && json.error.message)) || text);
    const data = (json && json.data) || json || {};
    const url = videoUrlFrom(data);
    if (url) return downloadToMedia(resolveChannelUrl(channel, url), 'video');
    if (data.status === 'completed') {
      // 取回文件：传输层失败时重试 3 次（间隔 10s / 20s），文件已在
      // 渠道侧生成好，重拉不会多烧一次生成；HTTP 错误立即失败。
      let contentRes = null;
      let contentErr = null;
      for (let cAttempt = 1; cAttempt <= 3; cAttempt++) {
        try {
          contentRes = await fetchTimeout(channel.baseUrl + '/videos/' + encodeURIComponent(taskId) + '/content', { headers }, 120000);
          break;
        } catch (e) {
          contentErr = e;
          if (!isTransportError(e) || cAttempt >= 3) break;
          console.error('video content fetch attempt ' + cAttempt + ' failed, retrying:', e.message);
          await sleep(cAttempt === 1 ? 10000 : 20000);
        }
      }
      if (!contentRes) {
        if (contentErr && typeof contentErr === 'object') contentErr.doNotRetry = true;
        throw contentErr;
      }
      if (!contentRes.ok) { const err = new Error('视频已完成但取回文件失败 HTTP ' + contentRes.status); err.isHttpError = true; err.httpStatus = contentRes.status; err.doNotRetry = true; throw err; }
      const buf = Buffer.from(await contentRes.arrayBuffer());
      return saveMediaBuffer(buf, 'video/mp4', 'video');
    }
    if (data.status === 'failed' || data.status === 'cancelled') {
      throw new Error('视频生成失败：' + ((data.error && data.error.message) || data.status));
    }
  }
  throw new Error('视频生成超时（轮询 5 分钟未完成），请稍后在生成记录里查看或重试');
}

// ---------- HTTP 工具 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > (maxBytes || 20 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml' };
function normalizePath(rawPath) {
  let p = decodeURIComponent(rawPath || '/');
  if (p === '/app' || p === '/app/') return '/';
  if (p.startsWith('/app/')) p = p.slice(4);
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}
function requireAdmin(req, res) {
  const s = authFromReq(req);
  if (!s) { sendJson(res, 401, { ok: false, error: '未登录，请先登录后台' }); return null; }
  if (auth.mustChangePassword) { sendJson(res, 403, { ok: false, error: '首次登录必须先修改密码', mustChangePassword: true }); return null; }
  return s;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = normalizePath(u.pathname);
    const method = req.method;

    if (pathname.startsWith('/api/')) {
      // GET /api/health（公开）
      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, service: 'ai-gen-uppcoder', time: nowIso(), channels: channels.filter(c => c.enabled !== false).length, generations: generations.length });
      }
      // GET /api/channels（前台用：只返回名字/模型/能力，不含 Key）
      if (method === 'GET' && pathname === '/api/channels') {
        return sendJson(res, 200, { ok: true, channels: channels.filter(c => c.enabled !== false).map(publicChannelForFront) });
      }
      // GET /api/generations（前台历史）
      if (method === 'GET' && pathname === '/api/generations') {
        return sendJson(res, 200, { ok: true, total: generations.length, generations: generations.map(g => ({ ...g, fileName: undefined })) });
      }
      // GET /api/media/:file（生成的文件，公开播放/查看；文件名是随机 ID，不可猜）
      if (method === 'GET' && pathname.startsWith('/api/media/')) {
        const fileName = pathname.slice('/api/media/'.length);
        if (!fileName || fileName.includes('/') || fileName.includes('..')) return sendJson(res, 400, { ok: false, error: '文件名不正确' });
        const full = path.join(MEDIA_DIR, fileName);
        if (!full.startsWith(MEDIA_DIR) || !fs.existsSync(full)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(full).pipe(res);
      }
      // POST /api/generate（前台生成：生图 / 生视频）
      // 异步生成：渠道侧（尤其 muse2api 驱动 Muse 网页）一次生图常需 30-90 秒以上，
      // 不能让请求一直等到渠道返回。先建 status='generating' 的记录并立即返回，
      // 后台继续调渠道、下载文件、更新记录；前台轮询 /api/generations 直到记录翻转为
      // completed / failed。这样即使渠道很慢也不会出现 "This operation was aborted"。
      if (method === 'POST' && pathname === '/api/generate') {
        const body = JSON.parse(await readBody(req) || '{}');
        const type = body.type === 'video' ? 'video' : 'image';
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return sendJson(res, 400, { ok: false, error: '请先输入提示词' });
        const channel = pickChannel(body.channelId, type);
        if (!channel) return sendJson(res, 400, { ok: false, error: type === 'video' ? '没有可用的生视频渠道，请先在后台添加支持视频的渠道并填写 videoModel' : '没有可用的生图渠道，请先在后台添加渠道并填写 imageModel' });
        const model = type === 'video' ? (body.videoModel || channel.videoModel) : (body.imageModel || channel.imageModel);
        const count = type === 'video' ? 1 : (body.referenceImage ? 1 : Math.min(4, Math.max(1, parseInt(body.count || '1', 10) || 1)));
        const source = body.sourceGenerationId ? 'image-to-video' : (body.referenceImage ? 'reference-image' : 'text');
        const pending = [];
        for (let i = 0; i < count; i++) {
          pending.push(saveGeneration({
            id: newId(), type, prompt, channelId: channel.id, channelName: channel.name, model,
            status: 'generating', url: '', fileName: '', bytes: 0, mimeType: '',
            source, createdAt: nowIso(), note: '', retryCount: 0,
          }));
        }
        // 后台任务：与 POST 响应完全脱离（请求立即返回，任务在后台跑，
        // 不受任何请求超时影响）。失败只写回记录，绝不崩掉服务。
        // 渠道返回 HTTP 错误时一次都不重试：POST 已经在渠道侧烧了一次生成，再发只会再烧一次；
        // 只有根本没收到任何 HTTP 响应的传输层失败才重试 1 次（共 2 次调用），间隔 10 秒。
        // 视频任务的创建重试在 generateVideo 内部做，外层不再重发创建调用。
        // 所以最多重试 1 次（间隔 10 秒），记录保持 generating，
        // 并把重试进度写进 note，前台轮询时能看到。
        const channelSnapshot = { ...channel };
        const jobBody = { ...body };
        (async () => {
          let items = null;
          let lastErr = null;
          for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
            try {
              items = type === 'video'
                ? [await generateVideo(channelSnapshot, { ...jobBody, videoModel: model })]
                : await generateImage(channelSnapshot, { ...jobBody, imageModel: model });
              break;
            } catch (e) {
              lastErr = e;
              console.error('generate attempt ' + attempt + ' failed:', e.message);
              if (!isTransportError(e) || attempt >= MAX_GENERATION_ATTEMPTS) break;
              const waitMs = RETRY_BACKOFF_MS[attempt - 1] || 10000;
              const note = '连接失败，正在重试（第 ' + attempt + '/' + MAX_GENERATION_ATTEMPTS + ' 次，' + (waitMs / 1000) + ' 秒后重试）…';
              pending.forEach(p => updateGeneration(p.id, { status: 'generating', note, retryCount: attempt }));
              await sleep(waitMs);
            }
          }
          if (items) {
            items.forEach((it, i) => {
              if (i < pending.length) {
                updateGeneration(pending[i].id, { status: 'completed', url: it.url, fileName: it.fileName, bytes: it.bytes, mimeType: it.mimeType, note: '' });
              } else {
                saveGeneration({ id: newId(), type, prompt, channelId: channelSnapshot.id, channelName: channelSnapshot.name, model, status: 'completed', url: it.url, fileName: it.fileName, bytes: it.bytes, mimeType: it.mimeType, source, createdAt: nowIso(), note: '', retryCount: 0 });
              }
            });
            // 渠道返回的张数比预期少时，多余的 pending 记录标记失败，避免一直转圈
            for (let i = items.length; i < pending.length; i++) {
              updateGeneration(pending[i].id, { status: 'failed', note: '', error: '渠道只返回了 ' + items.length + ' 张图片' });
            }
            return;
          }
          const e = lastErr;
          const friendly = e && (e.message === 'fetch failed' || (e.message && e.message.includes('aborted')))
            ? ('无法连接渠道 ' + channelSnapshot.baseUrl + '，请检查 Base URL 是否正确、网络是否通、Key 是否有效')
            : ((e && e.message) || '生成失败');
          const retried = isTransportError(e) && !e.doNotRetry; // 渠道 HTTP 错误原样记录，不加“重试 N 次后仍失败”前缀——它根本没有被重试过。
          const errText = retried
            ? ('重试 1 次后仍失败：' + friendly)
            : friendly;
          pending.forEach(p => updateGeneration(p.id, { status: 'failed', note: '', error: errText }));
        })();
        return sendJson(res, 200, { ok: true, type, generations: pending.map(g => ({ ...g, fileName: undefined })) });
      }
      // DELETE /api/generations/:id（删除一条记录及文件）
      if (method === 'DELETE' && pathname.startsWith('/api/generations/')) {
        const id = pathname.slice('/api/generations/'.length);
        const idx = generations.findIndex(g => g.id === id);
        if (idx < 0) return sendJson(res, 404, { ok: false, error: '记录不存在' });
        const g = generations[idx];
        if (g.fileName) { try { fs.unlinkSync(path.join(MEDIA_DIR, g.fileName)); } catch {} }
        generations.splice(idx, 1); saveJson('generations.json', generations);
        return sendJson(res, 200, { ok: true });
      }
      // ---- 管理员登录 ----
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = JSON.parse(await readBody(req) || '{}');
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (username !== auth.username || hashPassword(password, auth.salt) !== auth.hash) {
          return sendJson(res, 401, { ok: false, error: '账号或密码不正确' });
        }
        const token = createSession(username);
        return sendJson(res, 200, { ok: true, token, username, mustChangePassword: !!auth.mustChangePassword });
      }
      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const s = authFromReq(req);
        if (!s) return sendJson(res, 401, { ok: false, error: '未登录，请先登录后台' });
        const body = JSON.parse(await readBody(req) || '{}');
        const current = String(body.currentPassword || '');
        const next = String(body.newPassword || '');
        if (hashPassword(current, auth.salt) !== auth.hash) return sendJson(res, 400, { ok: false, error: '当前密码不正确' });
        if (next.length < 6) return sendJson(res, 400, { ok: false, error: '新密码至少 6 位' });
        const salt = crypto.randomBytes(16).toString('hex');
        auth = { ...auth, salt, hash: hashPassword(next, salt), mustChangePassword: false };
        saveJson('auth.json', auth);
        sessions.clear();
        return sendJson(res, 200, { ok: true, message: '密码已修改，请用新密码重新登录' });
      }
      if (method === 'GET' && pathname === '/api/auth/status') {
        const s = authFromReq(req);
        return sendJson(res, 200, { ok: true, loggedIn: !!s, username: s ? s.username : '', mustChangePassword: !!auth.mustChangePassword });
      }
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const h = req.headers.authorization || '';
        const m = h.match(/^Bearer\s+(.+)$/);
        if (m) sessions.delete(m[1]);
        return sendJson(res, 200, { ok: true });
      }
      // ---- 后台渠道管理（全部要登录，且首次登录改完密码后才能用） ----
      if (pathname.startsWith('/api/admin/')) {
        if (method === 'GET' && pathname === '/api/admin/channels') {
          if (!requireAdmin(req, res)) return;
          return sendJson(res, 200, { ok: true, channels: channels.map(publicChannel) });
        }
        if (method === 'POST' && pathname === '/api/admin/channels') {
          if (!requireAdmin(req, res)) return;
          const body = JSON.parse(await readBody(req) || '{}');
          if (!String(body.name || '').trim() || !cleanBaseUrl(body.baseUrl) || !String(body.apiKey || '').trim()) {
            return sendJson(res, 400, { ok: false, error: '名称、Base URL、API Key 都要填' });
          }
          const caps = Array.isArray(body.capabilities) ? body.capabilities.filter(x => x === 'image' || x === 'video') : [];
          if (!caps.length) return sendJson(res, 400, { ok: false, error: '至少选一种能力：生图或生视频' });
          if (caps.includes('image') && !String(body.imageModel || '').trim()) return sendJson(res, 400, { ok: false, error: '请先点“获取模型列表”，从下拉框里选一个生图模型' });
          const modelErr = await validateModelsAgainstChannel(cleanBaseUrl(body.baseUrl), String(body.apiKey).trim(), String(body.imageModel || '').trim(), String(body.videoModel || '').trim());
          if (modelErr) return sendJson(res, 400, { ok: false, error: modelErr });
          const c = { id: newId(), name: String(body.name).trim(), baseUrl: cleanBaseUrl(body.baseUrl), apiKey: String(body.apiKey).trim(), imageModel: String(body.imageModel || '').trim(), videoModel: String(body.videoModel || '').trim(), capabilities: caps, enabled: body.enabled !== false, isDefault: !!body.isDefault, createdAt: nowIso() };
          if (c.isDefault) channels.forEach(x => { x.isDefault = false; });
          channels.push(c); saveJson('channels.json', channels);
          return sendJson(res, 200, { ok: true, channel: publicChannel(c) });
        }
        if ((method === 'PUT' || method === 'DELETE') && pathname.startsWith('/api/admin/channels/')) {
          if (!requireAdmin(req, res)) return;
          const id = pathname.slice('/api/admin/channels/'.length).split('/')[0];
          const idx = channels.findIndex(x => x.id === id);
          if (idx < 0) return sendJson(res, 404, { ok: false, error: '渠道不存在' });
          if (method === 'DELETE') {
            channels.splice(idx, 1); saveJson('channels.json', channels);
            return sendJson(res, 200, { ok: true });
          }
          const body = JSON.parse(await readBody(req) || '{}');
          const c = channels[idx];
          if (body.name !== undefined) c.name = String(body.name).trim() || c.name;
          if (body.baseUrl !== undefined) c.baseUrl = cleanBaseUrl(body.baseUrl) || c.baseUrl;
          if (body.apiKey !== undefined && String(body.apiKey).trim() && !String(body.apiKey).startsWith('********')) c.apiKey = String(body.apiKey).trim();
          if (body.imageModel !== undefined) c.imageModel = String(body.imageModel).trim();
          if (body.videoModel !== undefined) c.videoModel = String(body.videoModel).trim();
          if (Array.isArray(body.capabilities)) c.capabilities = body.capabilities.filter(x => x === 'image' || x === 'video');
          if (body.enabled !== undefined) c.enabled = !!body.enabled;
          if (body.isDefault) { channels.forEach(x => { x.isDefault = false; }); c.isDefault = true; }
          // 改了模型时同样校验：模型必须在渠道 /models 返回的列表里
          if (body.imageModel !== undefined || body.videoModel !== undefined || body.baseUrl !== undefined || (body.apiKey !== undefined && String(body.apiKey).trim() && !String(body.apiKey).startsWith('********'))) {
            const modelErr = await validateModelsAgainstChannel(c.baseUrl, c.apiKey, c.imageModel, c.videoModel);
            if (modelErr) return sendJson(res, 400, { ok: false, error: modelErr });
          }
          saveJson('channels.json', channels);
          return sendJson(res, 200, { ok: true, channel: publicChannel(c) });
        }
        if (method === 'POST' && pathname === '/api/admin/models') {
          // 取模型列表（供渠道表单的下拉框用）：传 channelId 用已保存的 Key，
          // 传 baseUrl+apiKey 则用表单里刚填的 Key（不保存，只用来拉一次 /models）。
          // 模型只能从这里返回的列表里选，不能手填。
          if (!requireAdmin(req, res)) return;
          const body = JSON.parse(await readBody(req) || '{}');
          let baseUrl = '', apiKey = '';
          if (body.channelId) {
            const c = channels.find(x => x.id === body.channelId);
            if (!c) return sendJson(res, 404, { ok: false, error: '渠道不存在' });
            baseUrl = c.baseUrl; apiKey = c.apiKey;
          } else {
            baseUrl = cleanBaseUrl(body.baseUrl);
            apiKey = String(body.apiKey || '').trim();
            if (!baseUrl || !apiKey) return sendJson(res, 400, { ok: false, error: '请先填 Base URL 和 API Key' });
          }
          try {
            const r = await fetchTimeout(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey } }, 15000);
            const { json, text } = await readJsonResponse(r);
            if (!r.ok) return sendJson(res, 200, { ok: false, error: channelErrorText(r.status, (json && (json.error && json.error.message)) || text) });
            const models = ((json && json.data) || []).map(m => (typeof m === 'string' ? m : m.id || '')).filter(Boolean);
            return sendJson(res, 200, { ok: true, models: models.slice(0, 50), total: models.length });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: '连接失败：' + e.message });
          }
        }
        if (method === 'POST' && pathname.startsWith('/api/admin/channels/') && pathname.endsWith('/test')) {
          if (!requireAdmin(req, res)) return;
          const id = pathname.slice('/api/admin/channels/'.length, -'/test'.length).replace(/\/$/, '');
          const c = channels.find(x => x.id === id);
          if (!c) return sendJson(res, 404, { ok: false, error: '渠道不存在' });
          try {
            const r = await fetchTimeout(c.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + c.apiKey } }, 15000);
            const { json, text } = await readJsonResponse(r);
            if (!r.ok) return sendJson(res, 200, { ok: false, error: channelErrorText(r.status, (json && (json.error && json.error.message)) || text) });
            const models = (json && json.data) || [];
            return sendJson(res, 200, { ok: true, models: models.slice(0, 20).map(m => m.id || m), total: models.length });
          } catch (e) {
            return sendJson(res, 200, { ok: false, error: '连接失败：' + e.message });
          }
        }
        return sendJson(res, 404, { ok: false, error: '未知后台接口：' + pathname });
      }
      return sendJson(res, 404, { ok: false, error: '未知接口：' + pathname });
    }

    // ---- 静态文件 ----
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const safe = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    let full = path.join(PUBLIC_DIR, safe);
    if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full)) full = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('AI 生图/生视频已启动 http://' + HOST + ':' + PORT + '/  渠道：' + channels.length + ' 个，生成记录：' + generations.length + ' 条');
});
