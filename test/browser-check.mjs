/**
 * Drives the real page in a real browser and checks that the scanner actually
 * produces a black-and-white document.
 *
 * Everything else in this package is provable from Node. The page is not: the
 * canvas pipeline only exists in a browser, and "it type-checks" has never been
 * the same thing as "the button works". So this launches headless Edge, opens
 * the page the phone would open, feeds it a synthetic photo of a page shot at
 * an angle under uneven light, clicks the scanner, and reads the pixels back.
 *
 * Run: node test/browser-check.mjs [port] [live-url]
 *   With `live-url` it drives whatever is already running (the phone's actual
 *   address) instead of spawning a throwaway one — that is the only way to
 *   prove the bytes installed in the host are the fixed ones.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDropBox } from '../lib/server.js';
import { pageHtml } from '../lib/page.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = Number(process.argv[2] ?? 19820);
const cdpPort = Number(process.env.BROWSER_CHECK_CDP ?? 19821);
const liveUrl = process.argv[3];

const dir = liveUrl === undefined ? mkdtempSync(join(tmpdir(), 'phone-drop-browser-')) : null;
const userData = mkdtempSync(join(tmpdir(), 'phone-drop-edge-'));
const box = dir === null
  ? null
  : await startDropBox({ dir, port, host: '127.0.0.1', html: pageHtml({ title: '手机直传' }) });
const target = `${liveUrl ?? `http://127.0.0.1:${port}/`}`;
const before = liveUrl === undefined ? 0 : (await (await fetch(`${liveUrl.replace(/\/$/, '')}/api/list`)).json()).files.length;

const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${userData}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=420,900',
  target,
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 20_000);
  });
}

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page !== undefined) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error('CDP 连不上'));
        });
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        };
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('浏览器没起来');
}

/** Evaluate in the page and return the JSON value. */
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面里抛错了：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result.value;
}

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}`);
};

try {
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');

  // 等模块脚本装好：页面把 import 的常量挂在 canvas 方法上不好探，改用 title + 默认状态
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate(`document.getElementById('go') !== null && document.getElementById('cv') !== null`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check('页面结构加载完成', ready === true);

  // 页面脚本有没有报错
  const mod = await evaluate(`import('./scan.js').then((m) => Object.keys(m)).catch((e) => 'ERR: ' + e.message)`);
  check('scan.js 被页面加载并可解析', Array.isArray(mod) && mod.includes('scanDocument'), JSON.stringify(mod).slice(0, 120));

  // 造一张「彩色照片里的纸」：米黄纸底 + 黑字块 + 左上阴影 + 传感器噪点 + 四周深色桌面
  const rendered = await evaluate(`(async () => {
    const W = 900, H = 1200;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    // 桌面（深色木纹）
    x.fillStyle = '#3a2a1e';
    x.fillRect(0, 0, W, H);
    // 纸张：稍微歪一点，占画面大部分
    x.save();
    x.translate(W / 2, H / 2);
    x.rotate(0.04);
    x.fillStyle = '#f3eddc';
    x.fillRect(-W * 0.42, -H * 0.44, W * 0.84, H * 0.88);
    // 字：三行黑条 + 一个粗标题
    x.fillStyle = '#1b1b1b';
    x.fillRect(-W * 0.3, -H * 0.34, W * 0.5, 34);
    for (let r = 0; r < 12; r++) {
      const y = -H * 0.22 + r * 46;
      x.fillRect(-W * 0.3, y, W * 0.5, 12);
    }
    // 一个实心黑方块（自适应阈值的经典陷阱：大块纯黑中心会被判成白）
    x.fillRect(W * 0.12, H * 0.18, 120, 120);
    x.restore();
    // 左上角打一片阴影
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, 'rgba(0,0,0,0.42)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0.05)');
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    // 噪点
    const img = x.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 26;
      img.data[i] += n; img.data[i+1] += n; img.data[i+2] += n;
    }
    x.putImageData(img, 0, 0);

    // 把这张「照片」塞进页面，走真实的 pick → render 路径
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'page.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('gal');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    // 等 render 跑完
    for (let i = 0; i < 60; i++) {
      if (document.getElementById('stage').classList.contains('on')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    const cv = document.getElementById('cv');
    return { w: cv.width, h: cv.height, stageOn: document.getElementById('stage').classList.contains('on') };
  })()`);
  check('选图后画布已渲染', rendered.w > 0 && rendered.h > 0, `${rendered.w}×${rendered.h}`);

  // 默认必须是「原图直传」：不裁、不转、不二值化
  const asIs = await evaluate(`(async () => {
    const cv = document.getElementById('cv');
    let black = 0, white = 0, mid = 0;
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    // 有没有被二值化：真正的判据是「还剩多少种颜色」，而不是某个亮度区间的占比
    const shades = new Set();
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i];
      shades.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      if (v < 40) black++; else if (v > 215) white++; else mid++;
    }
    const total = black + white + mid;
    return {
      w: cv.width, h: cv.height,
      midPct: +(mid / total * 100).toFixed(1),
      shades: shades.size,
      badge: document.getElementById('badge').textContent,
      goText: document.getElementById('go').textContent,
      scanChecked: document.getElementById('scanon').checked,
      optsVisible: getComputedStyle(document.getElementById('opts')).display !== 'none',
    };
  })()`);
  check('默认不勾文档模式', asIs.scanChecked === false, `checkbox=${asIs.scanChecked}`);
  check('默认不裁边（画布=原图尺寸）', asIs.w === 900 && asIs.h === 1200, `${asIs.w}×${asIs.h}`);
  check('默认没有被二值化（颜色种类仍很多）', asIs.shades > 500, `颜色 ${asIs.shades} 种 / 中间调 ${asIs.midPct}%`);
  check('默认角标是「原图」', asIs.badge === '原图', `badge=${asIs.badge}`);
  check('默认按钮写「上传图片」', asIs.goText === '上传图片', `text=${asIs.goText}`);
  check('文档模式关闭时参数面板隐藏', asIs.optsVisible === false);

  // 勾上文档模式，才应该出现「裁边 + 黑白」
  const stats = await evaluate(`(async () => {
    const on = document.getElementById('scanon');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));

    const cv = document.getElementById('cv');
    const cx = cv.getContext('2d');
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let black = 0, white = 0, mid = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i];
      if (v < 40) black++;
      else if (v > 215) white++;
      else mid++;
    }
    const total = black + white + mid;
    // 实心黑块有没有被掏空：把黑mask腐蚀 6px，还剩下的就只可能是实心块，
    // 字条只有 12px 高，一腐蚀就没了。用积分图，避免 O(w*h*169)。
    const W2 = cv.width, H2 = cv.height;
    const sat = new Int32Array((W2 + 1) * (H2 + 1));
    for (let y = 0; y < H2; y++) {
      let run = 0;
      for (let x = 0; x < W2; x++) {
        if (px[(y * W2 + x) * 4] < 40) run++;
        sat[(y + 1) * (W2 + 1) + (x + 1)] = sat[y * (W2 + 1) + (x + 1)] + run;
      }
    }
    const R = 6, S = 2 * R + 1;
    let solid = 0;
    for (let y = R; y < H2 - R; y++) {
      for (let x = R; x < W2 - R; x++) {
        const a = sat[(y - R) * (W2 + 1) + (x - R)];
        const b = sat[(y - R) * (W2 + 1) + (x + R + 1)];
        const c = sat[(y + R + 1) * (W2 + 1) + (x - R)];
        const d = sat[(y + R + 1) * (W2 + 1) + (x + R + 1)];
        if (d - b - c + a === S * S) solid++;
      }
    }
    return {
      w: cv.width, h: cv.height,
      blackPct: +(black / total * 100).toFixed(1),
      whitePct: +(white / total * 100).toFixed(1),
      midPct: +(mid / total * 100).toFixed(1),
      badge: document.getElementById('badge').textContent,
      goEnabled: !document.getElementById('go').disabled,
      goText: document.getElementById('go').textContent,
      optsVisible: getComputedStyle(document.getElementById('opts')).display !== 'none',
      solidCore: solid,
      sourceW: 900, sourceH: 1200,
    };
  })()`);

  check('勾上文档模式后才裁边', stats.w < stats.sourceW * 0.95 && stats.h < stats.sourceH * 0.95, `${stats.w}×${stats.h}（原图 ${stats.sourceW}×${stats.sourceH}）`);
  check('勾上后输出是黑白两色（中间调几乎没有）', stats.midPct < 12, `黑 ${stats.blackPct}% / 白 ${stats.whitePct}% / 中间 ${stats.midPct}%`);
  check('墨点确实存在（不是整页全白）', stats.blackPct > 0.4 && stats.blackPct < 45, `黑 ${stats.blackPct}%`);
  check('实心黑块没有被掏空', stats.solidCore >= 200, `腐蚀 6px 后仍有 ${stats.solidCore} 个像素是实心黑`);
  check('角标显示「黑白扫描」', stats.badge === '黑白扫描');
  check('勾上后参数面板出现', stats.optsVisible === true);
  check('勾上后按钮写「上传扫描件」', stats.goText === '上传扫描件', `text=${stats.goText}`);
  check('上传按钮已启用', stats.goEnabled === true);

  // 灰度档也要能切
  const grayMode = await evaluate(`(async () => {
    document.querySelector('[data-mode="gray"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const cv = document.getElementById('cv');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const colors = new Set();
    for (let i = 0; i < px.length; i += 4) colors.add(px[i]);
    const badge = document.getElementById('badge').textContent;
    const w = cv.width, h = cv.height;
    // 切回黑白，后面的上传要用扫描件
    document.querySelector('[data-mode="bw"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return { badge, distinct: colors.size, w, h, backBadge: document.getElementById('badge').textContent };
  })()`);
  check('灰度档能切且是连续调', grayMode.badge === '灰度增强' && grayMode.distinct > 100, `badge=${grayMode.badge} 灰阶数=${grayMode.distinct}`);
  check('切回黑白档正常', grayMode.backBadge === '黑白扫描', `badge=${grayMode.backBadge}`);

  // 真的点一次上传，看文件有没有落进目录
  const uploaded = await evaluate(`(async () => {
    document.getElementById('go').click();
    for (let i = 0; i < 80; i++) {
      const t = document.getElementById('log').textContent;
      if (t.includes('已存到电脑') || t.includes('失败')) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'TIMEOUT: ' + document.getElementById('log').textContent;
  })()`);
  check('点击上传成功', /已存到电脑/.test(uploaded), String(uploaded).slice(0, 120));

  const listing = await (await fetch(`${liveUrl?.replace(/\/$/, '') ?? `http://127.0.0.1:${port}`}/api/list`)).json();
  check('文件真的落进了目录', listing.files.length === before + 1, `${before} → ${listing.files.length}`);

  // 上传后 stage 收起、按钮禁用：再点 chip 不应该报错也不该画出半张图
  const afterUpload = await evaluate(`(async () => {
    document.querySelector('[data-mode="gray"]').click();
    await new Promise((r) => setTimeout(r, 200));
    return { goDisabled: document.getElementById('go').disabled, stageOn: document.getElementById('stage').classList.contains('on') };
  })()`);
  check('上传后按钮禁用、画布已收起', afterUpload.goDisabled === true && afterUpload.stageOn === false, JSON.stringify(afterUpload));

  // 关掉文档模式后，上传的必须是手机上的原始字节，不能被重新压一遍
  const rawUpload = await evaluate(`(async () => {
    const off = document.getElementById('scanon');
    off.checked = false;
    off.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 200));

    const W = 240, H = 160;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const grad = x.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#204080');
    grad.addColorStop(1, '#d08020');
    x.fillStyle = grad;
    x.fillRect(0, 0, W, H);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'raw.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('gal');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    for (let i = 0; i < 60; i++) {
      if (document.getElementById('stage').classList.contains('on')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    const cv = document.getElementById('cv');
    const before = { cvW: cv.width, cvH: cv.height, srcSize: file.size, badge: document.getElementById('badge').textContent };
    document.getElementById('go').click();
    for (let i = 0; i < 80; i++) {
      const t = document.getElementById('log').textContent;
      if (t.includes('已存到电脑') || t.includes('失败')) return { ...before, log: t };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ...before, log: 'TIMEOUT' };
  })()`);
  check('关掉文档模式后画布恢复原尺寸', rawUpload.cvW === 240 && rawUpload.cvH === 160, `${rawUpload.cvW}×${rawUpload.cvH}`);
  check('关掉后角标是「原图」', rawUpload.badge === '原图', `badge=${rawUpload.badge}`);
  const rawListing = await (await fetch(`${liveUrl?.replace(/\/$/, '') ?? `http://127.0.0.1:${port}`}/api/list`)).json();
  const rawSaved = rawListing.files.find((f) => f.name.startsWith('raw-'));
  check('原图直传保留了原始字节（大小一致）', rawSaved !== undefined && rawSaved.size === rawUpload.srcSize, rawSaved === undefined ? '没找到文件' : `${rawSaved.size} vs 原始 ${rawUpload.srcSize}`);
} catch (error) {
  check('浏览器检查未抛异常', false, error.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  browser.kill();
  await box?.close();
  await new Promise((r) => setTimeout(r, 400));
  for (const d of [dir, userData]) {
    if (d === null) continue;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 文件可能还被占用 */ }
  }
}

function previousLog() { return true; }
function uploadLog() { return false; }

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const c of failed) console.log(`  - ${c.label}  ${c.detail}`);
  process.exit(1);
}
