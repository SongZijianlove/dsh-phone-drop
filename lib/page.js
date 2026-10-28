/**
 * dsh-phone-drop page: the mobile UI shell.
 *
 * The markup and the styling live here; the scanning math does not. It is a
 * separate module (`scan.js`) served to the page as-is, so the browser and the
 * tests run the exact same code — a second copy of an adaptive-threshold loop
 * is a copy that will disagree with the first one within two releases.
 */

/**
 * @param {{title: string}} opts
 *   The token is deliberately NOT a parameter: it is read from `location.search`
 *   on the phone, so it never gets baked into HTML that could be cached or left
 *   in a browser history.
 */
export function pageHtml(opts) {
  const title = String(opts.title ?? '手机直传').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1733">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="./icon.svg">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>${title}</title>
<style>
:root{--navy:#0b1733;--gold:#c5a468;--cream:#e6d3a3;--ink:#e8eefc;--mute:#8fa3c8}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100vh;background:radial-gradient(120% 80% at 50% 0%,#152a52 0%,var(--navy) 60%,#060d1d 100%);color:var(--ink);
 font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:18px 14px 40px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:20px;letter-spacing:.06em;color:var(--cream);font-weight:600}
.sub{color:var(--mute);font-size:13px;margin-top:-6px}
.card{background:#101d3a;border:1px solid #c5a46833;border-radius:16px;padding:14px}
.row{display:flex;gap:10px}
label.pick{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-height:96px;border:2px dashed #c5a46855;
 border-radius:14px;color:var(--cream);font-size:16px;cursor:pointer;background:#0d1830;text-align:center;line-height:1.35}
label.pick:active{background:#14244a}
input[type=file]{display:none}
button{width:100%;min-height:52px;border:0;border-radius:14px;font-size:17px;font-weight:600;letter-spacing:.06em;
 background:linear-gradient(180deg,#d8b979,#b8944f);color:#20180a;margin-top:12px;font-family:inherit}
button:disabled{opacity:.45}
button.ghost{background:transparent;border:1px solid #c5a46844;color:#b9c8e6;font-weight:500;font-size:15px;min-height:44px}
.switch{display:flex;align-items:center;gap:10px;margin-top:14px;padding:11px 12px;border:1px solid #c5a46833;
 border-radius:12px;background:#0d1830;cursor:pointer;font-size:15px;color:var(--cream)}
.switch input{position:absolute;opacity:0;pointer-events:none}
.switch .box{flex:none;width:44px;height:26px;border-radius:999px;background:#22304d;position:relative;transition:background .16s}
.switch .box::after{content:"";position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;
 background:#7c8db0;transition:transform .16s,background .16s}
.switch input:checked + .box{background:#b8944f55}
.switch input:checked + .box::after{transform:translateX(18px);background:var(--cream)}
.switch .txt{line-height:1.35}
.switch .txt small{display:block;color:var(--mute);font-size:12px;margin-top:2px}
.opts{display:none}
.opts.on{display:block}
.chips{display:flex;gap:8px;margin-top:12px}
.chip{flex:1;min-height:42px;margin:0;font-size:14px;font-weight:500;border-radius:11px;background:#0d1830;color:#9fb2d4;
 border:1px solid #c5a46833;letter-spacing:0}
.chip.on{background:#1c3057;color:var(--cream);border-color:#c5a46899}
.sliders{margin-top:12px;display:flex;flex-direction:column;gap:10px}
.sl{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--mute)}
.sl input{flex:1;accent-color:#c5a468}
.sl b{color:var(--cream);font-weight:600;min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
#stage{margin-top:12px;border-radius:12px;overflow:hidden;background:#08101f;display:none;position:relative}
#stage.on{display:block}
#cv{display:block;width:100%;height:auto}
#badge{position:absolute;left:8px;top:8px;background:#0b1733cc;border:1px solid #c5a46855;color:var(--cream);
 font-size:11px;letter-spacing:.1em;padding:2px 8px;border-radius:999px}
#log{font-size:14px;color:#9fb2d4;white-space:pre-wrap;word-break:break-all;min-height:1.6em;margin-top:8px}
.ok{color:#7ee0a8}.err{color:#ff9b9b}
ul{list-style:none;margin:8px 0 0;padding:0;font-size:14px;color:#9fb2d4}
li{padding:8px 0;border-bottom:1px solid #ffffff10;display:flex;justify-content:space-between;gap:10px;align-items:center}
li span:first-child{word-break:break-all}
li span:last-child{color:#6f83a8;flex:none}
.thumb{flex:none;width:52px;height:52px;border-radius:8px;object-fit:cover;background:#0d1830;border:1px solid #c5a46833}
.thumb.none{display:flex;align-items:center;justify-content:center;font-size:11px;color:#6f83a8}
.dirline{font-size:12px;color:#6f83a8;margin-top:10px;word-break:break-all}
.dirline code{color:var(--cream)}
.hint{font-size:12px;color:#6f83a8;margin-top:8px;line-height:1.5}
</style></head><body>
<h1>${title}</h1>
<div class="sub">局域网直连 · 不经过隧道 · 手机一拍，电脑就有</div>

<div class="card">
  <div class="row">
    <label class="pick" for="cam">📷<br>拍照</label>
    <label class="pick" for="gal">🖼<br>相册 / 文件</label>
  </div>
  <input id="cam" type="file" accept="image/*" capture="environment">
  <input id="gal" type="file" accept="image/*" multiple>

  <label class="switch">
    <input id="scanon" type="checkbox">
    <span class="box"></span>
    <span class="txt">文档模式<small>自动裁掉背景、转成黑白扫描件</small></span>
  </label>

  <div id="stage"><span id="badge">原图</span><canvas id="cv"></canvas></div>

  <div class="opts" id="opts">
    <div class="chips">
      <button class="chip on" data-mode="bw">黑白扫描</button>
      <button class="chip" data-mode="gray">灰度增强</button>
      <button class="chip" data-mode="color">原图</button>
    </div>

    <div class="sliders">
      <div class="sl"><span>墨色</span><input id="thr" type="range" min="0" max="40" value="12"><b id="thrv">12</b></div>
      <div class="sl"><span>细节</span><input id="win" type="range" min="8" max="64" value="28"><b id="winv">28</b></div>
    </div>
  </div>

  <button id="rot" class="ghost">↻ 旋转 90°</button>
  <button id="go" disabled>上传图片</button>
  <div id="log"></div>
  <div class="hint" id="hint">默认原样上传，不裁不转。想要扫描件就把上面的「文档模式」打开。</div>
</div>

<div class="card">
  <h1 style="font-size:15px">已经传过来的</h1>
  <ul id="list"><li><span>读取中…</span></li></ul>
  <button class="ghost" id="refresh">刷新列表</button>
  <div class="dirline" id="dirline"></div>
</div>

<script type="module">
import { toGray, grayEnhance, scanDocument } from './scan.js';

/*
 * 口令从地址里读，不写进页面：页面本身可能被缓存或被人回头翻历史记录，
 * 而 ?k= 是用户自己带进来的，只有他知道。
 */
const KEY = new URLSearchParams(location.search).get('k') ?? '';
const withKey = (url) => (KEY === '' ? url : url + (url.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(KEY));

const $ = (id) => document.getElementById(id);
const cam = $('cam'), gal = $('gal'), cv = $('cv'), stage = $('stage'), badge = $('badge');
const go = $('go'), log = $('log'), list = $('list');
const thr = $('thr'), win = $('win'), thrv = $('thrv'), winv = $('winv');
const scanon = $('scanon'), opts = $('opts'), hint = $('hint');
const ctx = cv.getContext('2d', { willReadFrequently: true });

/** 长边上限：再大手机内存吃不住，2000px 的文件名照样看得清 */
const MAX_EDGE = 2000;

let current = null;   // { img, rotation, name }
let pending = [];     // 多选时排在后面的文件
let mode = 'bw';
let useScan = false;  // 「文档模式」开关：默认关，原样上传

function say(text, cls) { log.className = cls || ''; log.textContent = text; }
function kb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

/** 按旋转角把图铺到画布，长边缩到 MAX_EDGE 以内。 */
function drawRotated(img, rotation) {
  const swap = rotation % 180 !== 0;
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.max(w, h) > MAX_EDGE ? MAX_EDGE / Math.max(w, h) : 1;
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  cv.width = swap ? dh : dw;
  cv.height = swap ? dw : dh;
  ctx.save();
  if (rotation === 90) { ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); }
  else if (rotation === 180) { ctx.translate(cv.width, cv.height); ctx.rotate(Math.PI); }
  else if (rotation === 270) { ctx.translate(0, cv.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img, 0, 0, dw, dh);
  ctx.restore();
}

function render() {
  if (!current) return;
  drawRotated(current.img, current.rotation);
  stage.classList.add('on');

  // 文档模式关掉时，画布上就是原图（只按需缩放/旋转），不做任何像素处理
  if (!useScan) {
    badge.textContent = '原图';
    return;
  }
  if (mode === 'color') { badge.textContent = '原图'; return; }

  const w = cv.width, h = cv.height;
  const frame = ctx.getImageData(0, 0, w, h);
  const gray = toGray(frame.data);

  if (mode === 'gray') {
    ctx.putImageData(new ImageData(grayEnhance(gray, w, h), w, h), 0, 0);
    badge.textContent = '灰度增强';
    return;
  }

  const scan = scanDocument(gray, w, h, { c: Number(thr.value), winSize: Number(win.value) });
  cv.width = scan.width;
  cv.height = scan.height;
  ctx.putImageData(new ImageData(scan.data, scan.width, scan.height), 0, 0);
  badge.textContent = '黑白扫描';
}

function toBlob() {
  return new Promise((resolve) => {
    // 原图直传时保留原始字节，别再压一次
    if (!useScan) {
      if (current && current.file && current.file.type) {
        resolve(current.file);
        return;
      }
      cv.toBlob((b) => resolve(b), 'image/jpeg', 0.95);
      return;
    }
    if (mode === 'bw') cv.toBlob((b) => resolve(b), 'image/png');
    else cv.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
  });
}

function updateGoLabel() {
  go.textContent = useScan ? '上传扫描件' : '上传图片';
}

function pick(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    current = { img, rotation: 0, name: file.name || (useScan ? 'scan' : 'photo'), file };
    render();
    go.disabled = false;
    updateGoLabel();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    say('这张图读不出来，换一张试试。', 'err');
  };
  img.src = url;
}

scanon.addEventListener('change', () => {
  useScan = scanon.checked;
  opts.classList.toggle('on', useScan);
  hint.textContent = useScan
    ? '扫描在这台手机上完成：先去色，再按局部平均做自适应二值化，最后自动裁掉四周空白。拍歪了点「旋转」，想要字更实就把「墨色」调大一点。'
    : '默认原样上传，不裁不转。想要扫描件就把上面的「文档模式」打开。';
  if (current) { current.rotation = current.rotation || 0; render(); }
  updateGoLabel();
});

cam.addEventListener('change', () => { if (cam.files && cam.files[0]) pick(cam.files[0]); });
gal.addEventListener('change', () => {
  if (!gal.files || gal.files.length === 0) return;
  pending = [...gal.files].slice(1);
  pick(gal.files[0]);
});

document.querySelectorAll('.chip').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    mode = b.dataset.mode;
    render();
  });
});
thr.addEventListener('input', () => { thrv.textContent = thr.value; if (mode === 'bw') render(); });
win.addEventListener('input', () => { winv.textContent = win.value; if (mode === 'bw') render(); });
$('rot').addEventListener('click', () => {
  if (!current) return;
  current.rotation = ((current.rotation || 0) + 90) % 360;
  render();
});

const EXT_OF = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/bmp': '.bmp', 'image/avif': '.avif' };

async function upload(blob, name) {
  const t0 = performance.now();
  const fd = new FormData();
  // 原图直传时 blob 就是手机的原始文件，扩展名跟着 MIME 走，别把 heic 改名成 jpg
  const ext = EXT_OF[blob.type] ?? (/\.[a-z0-9]{2,5}$/i.exec(String(name))?.[0] ?? '.jpg');
  fd.append('file', blob, String(name).replace(/\.[^.]+$/, '') + ext);
  const res = await fetch(withKey('/upload'), { method: 'POST', body: fd });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return { ms: Math.round(performance.now() - t0), saved: body.saved };
}

go.addEventListener('click', async () => {
  if (!current) return;
  go.disabled = true;
  try {
    const blob = await toBlob();
    const out = await upload(blob, current.name);
    say('已存到电脑：' + out.saved.map((s) => s.name).join('、') + '\\n' + kb(blob.size) + '，用时 ' + out.ms + ' ms', 'ok');
    current = null;
    cam.value = ''; gal.value = '';
    stage.classList.remove('on');
    go.disabled = true;
    updateGoLabel();
    if (pending.length > 0) pick(pending.shift());
    load();
  } catch (error) {
    say('上传失败：' + error.message, 'err');
    go.disabled = false;
  }
});

async function load() {
  try {
    const body = await (await fetch(withKey('/api/list'))).json();
    list.innerHTML = '';
    const dirline = $('dirline');
    if (dirline) dirline.innerHTML = '存在电脑的：<code>' + escapeHtml(body.dir ?? '') + '</code>';
    if (body.files.length === 0) { list.innerHTML = '<li><span>还没有文件</span></li>'; return; }
    for (const it of body.files) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = it.name;
      const right = document.createElement('span');
      right.textContent = kb(it.size);
      // 缩略图只在明确是图片时出，别的类型给个占位，免得一排碎图
      if (/\\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(it.name)) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.loading = 'lazy';
        img.alt = '';
        img.src = withKey('/file?name=' + encodeURIComponent(it.name));
        li.append(img, left, right);
      } else {
        li.append(left, right);
      }
      list.append(li);
    }
  } catch {
    list.innerHTML = '<li><span>读取失败</span></li>';
  }
}

/** Escape for innerHTML: filenames come from the filesystem, not from us. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
$('refresh').addEventListener('click', load);
load();
</script></body></html>`;
}
