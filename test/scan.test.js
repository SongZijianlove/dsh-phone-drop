/**
 * Tests for the pieces that are worth proving without a browser: the multipart
 * parser (a hand-rolled boundary scan is exactly the kind of code that quietly
 * eats a byte), the scanner math, and the filename rules that keep a hostile
 * upload inside its directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { parseMultipart, startDropBox } from '../lib/server.js';
import { toGray, adaptiveThreshold, despeckle, paperBox, grayEnhance, scanDocument } from '../lib/scan.js';

/* ---------- multipart ---------- */

function multipart(parts, boundary = 'X-BOUNDARY') {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${p.filename}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${p.mime}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

test('multipart: 单个文件原样取出', () => {
  const { body, contentType } = multipart([{ filename: 'a.png', mime: 'image/png', data: Buffer.from([1, 2, 3, 4]) }]);
  const files = parseMultipart(body, contentType);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'a.png');
  assert.equal(files[0].mime, 'image/png');
  assert.deepEqual([...files[0].data], [1, 2, 3, 4]);
});

test('multipart: 两个文件不会互相吃掉字节', () => {
  const one = Buffer.from('AAAA');
  const two = Buffer.from('BBBBBBBB');
  const { body, contentType } = multipart([
    { filename: '1.jpg', mime: 'image/jpeg', data: one },
    { filename: '2.jpg', mime: 'image/jpeg', data: two },
  ]);
  const files = parseMultipart(body, contentType);
  assert.equal(files.length, 2);
  assert.deepEqual([...files[0].data], [...one]);
  assert.deepEqual([...files[1].data], [...two]);
});

test('multipart: 二进制里出现 CRLF 也不截断', () => {
  const payload = Buffer.from([0x0d, 0x0a, 0x00, 0xff, 0x0d, 0x0a, 0x7f]);
  const { body, contentType } = multipart([{ filename: 'x.bin', mime: 'application/octet-stream', data: payload }]);
  const files = parseMultipart(body, contentType);
  assert.deepEqual([...files[0].data], [...payload]);
});

test('multipart: 没有 boundary 时返回空而不是抛错', () => {
  assert.deepEqual(parseMultipart(Buffer.from('hello'), 'text/plain'), []);
  assert.deepEqual(parseMultipart(Buffer.from('hello'), undefined), []);
});

/* ---------- scanner ---------- */

/**
 * 造一张「深色桌面上放一张纸，纸上写黑方块」的图。
 *
 * That is the shape of a real phone photo: the paper never fills the frame, so
 * the paper box has something to find. A tight crop of just the page is the
 * headline feature, and it only reproduces with a desk around the page.
 */
function photoOfPage(w, h, paper, ink) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 58;
    rgba[i + 1] = 42;
    rgba[i + 2] = 30;
    rgba[i + 3] = 255;
  }
  for (let y = paper.y; y < paper.y + paper.h; y++) {
    for (let x = paper.x; x < paper.x + paper.w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 243;
      rgba[o + 1] = 237;
      rgba[o + 2] = 220;
    }
  }
  for (let y = ink.y; y < ink.y + ink.h; y++) {
    for (let x = ink.x; x < ink.x + ink.w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 20;
    }
  }
  return rgba;
}

test('toGray: 纯白是 255，纯黑是 0', () => {
  const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
  assert.equal(Math.round(g[0]), 255);
  assert.equal(Math.round(g[1]), 0);
});

test('adaptiveThreshold: 墨块变黑、纸保持白', () => {
  const w = 120;
  const h = 120;
  const gray = toGray(photoOfPage(w, h, { x: 10, y: 10, w: 100, h: 100 }, { x: 40, y: 40, w: 40, h: 40 }));
  const bits = adaptiveThreshold(gray, w, h, 28, 12);
  assert.equal(bits[60 * w + 60], 0, '墨块中心应为黑');
  assert.equal(bits[12 * w + 12], 255, '角落的纸应为白');
});

test('adaptiveThreshold: 灯光不均（左暗右亮）时两边都能判对', () => {
  const w = 200;
  const h = 60;
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 纸的底色从 120 渐变到 255，模拟一侧阴影
      gray[y * w + x] = 120 + (135 * x) / w;
    }
  }
  // 两侧各写一个「墨块」，比当地底色暗 60
  for (let y = 20; y < 40; y++) {
    for (let x = 20; x < 40; x++) gray[y * w + x] -= 60;
    for (let x = 160; x < 180; x++) gray[y * w + x] -= 60;
  }
  const bits = adaptiveThreshold(gray, w, h, 24, 12);
  assert.equal(bits[30 * w + 30], 0, '阴影里的墨块也要判成黑');
  assert.equal(bits[30 * w + 170], 0, '亮处的墨块也要判成黑');
  assert.equal(bits[5 * w + 100], 255, '中间的空纸不能整片变黑');
});

test('despeckle: 孤立黑点被清掉，成片的墨留住', () => {
  const w = 20;
  const h = 20;
  const bits = new Uint8ClampedArray(w * h).fill(255);
  bits[5 * w + 5] = 0;                       // 孤立点
  for (let y = 10; y < 14; y++) {
    for (let x = 10; x < 14; x++) bits[y * w + x] = 0;   // 4×4 墨块
  }
  const out = despeckle(bits, w, h);
  assert.equal(out[5 * w + 5], 255, '孤立点应被清成白');
  assert.equal(out[11 * w + 11], 0, '墨块内部应保持黑');
});

/** 灰度平面：深色桌面 + 中间一块亮纸面。 */
function grayOfDesk(w, h, paper, desk = 45, page = 237) {
  const gray = new Float32Array(w * h).fill(desk);
  for (let y = paper.y; y < paper.y + paper.h; y++) {
    for (let x = paper.x; x < paper.x + paper.w; x++) gray[y * w + x] = page;
  }
  return gray;
}

test('paperBox: 框住亮纸面，不是框住整幅桌面', () => {
  const w = 100;
  const h = 100;
  const box = paperBox(grayOfDesk(w, h, { x: 20, y: 20, w: 60, h: 60 }), w, h);
  assert.ok(box !== null, '应当找到纸面');
  assert.ok(box.x >= 19 && box.x <= 21, `左边界应贴着纸面，实际 ${box.x}`);
  assert.ok(box.y >= 19 && box.y <= 21, `上边界应贴着纸面，实际 ${box.y}`);
  assert.ok(box.x + box.w <= 81 && box.x + box.w >= 79, `右边界应贴着纸面，实际 ${box.x + box.w}`);
  assert.ok(box.x > 5 && box.x < 60, '不能把整幅桌面都算进纸面');
});

test('paperBox: 深色桌面上的纸也能裁（二值图会失败的形状）', () => {
  // 桌面 45、纸 237：自适应阈值后桌面也是白的，旧实现因此返回 null。
  // 这一条钉住「必须读灰度、不能读二值图」。
  const w = 400;
  const h = 500;
  const paper = { x: 60, y: 70, w: 280, h: 360 };
  const gray = grayOfDesk(w, h, paper);
  const box = paperBox(gray, w, h);
  assert.ok(box !== null, '深色桌面上的纸必须找得到');
  assert.ok(Math.abs(box.w - paper.w) < paper.w * 0.1, `宽度应贴近纸面 ${paper.w}，实际 ${box.w}`);
  assert.ok(Math.abs(box.h - paper.h) < paper.h * 0.1, `高度应贴近纸面 ${paper.h}，实际 ${box.h}`);
});

test('paperBox: 走神的高光不会把框拉到画幅边缘', () => {
  const w = 200;
  const h = 200;
  const gray = grayOfDesk(w, h, { x: 50, y: 50, w: 100, h: 100 });
  // 右上角一小块反光（占 2% 面积）
  for (let y = 0; y < 20; y++) for (let x = 180; x < 200; x++) gray[y * w + x] = 250;
  const box = paperBox(gray, w, h);
  assert.ok(box !== null, '应当找到纸面');
  assert.ok(box.x + box.w <= 152, `右边界不能被反光拉走，实际 ${box.x + box.w}`);
});

test('paperBox: 全黑返回 null（不裁）', () => {
  const gray = new Float32Array(100 * 100).fill(20);
  assert.equal(paperBox(gray, 100, 100), null);
});

test('paperBox: 纸面几乎铺满时也不裁', () => {
  const gray = new Float32Array(100 * 100).fill(240);
  assert.equal(paperBox(gray, 100, 100), null);
});

test('grayEnhance: 输出的是合法 RGBA，且 alpha 全 255', () => {
  const w = 8;
  const h = 8;
  const gray = new Float32Array(w * h).map((_, i) => (i * 4) % 256);
  const out = grayEnhance(gray, w, h);
  assert.equal(out.length, w * h * 4);
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
});

test('scanDocument: 端到端裁到纸面（不是整幅桌面）', () => {
  const w = 400;
  const h = 500;
  const paper = { x: 60, y: 70, w: 280, h: 360 };
  const ink = { x: 110, y: 140, w: 160, h: 180 };
  const gray = toGray(photoOfPage(w, h, paper, ink));
  const scan = scanDocument(gray, w, h, { c: 12, winSize: 28 });
  assert.ok(scan.width < w, `应比原图窄，实际 ${scan.width} vs ${w}`);
  assert.ok(scan.height < h, `应比原图矮，实际 ${scan.height} vs ${h}`);
  assert.ok(scan.width >= ink.w, '墨块不能裁掉');
  assert.ok(Math.abs(scan.width - paper.w) < paper.w * 0.15, `宽度应贴近纸面 ${paper.w}，实际 ${scan.width}`);
  assert.ok(Math.abs(scan.height - paper.h) < paper.h * 0.15, `高度应贴近纸面 ${paper.h}，实际 ${scan.height}`);
  assert.equal(scan.data.length, scan.width * scan.height * 4);
});

test('scanDocument: 大块纯黑不会被自适应阈值掏空', () => {
  // 自适应阈值的经典陷阱：窗口整片黑时局部均值等于自身，中心被判成白，
  // 于是实心黑方块变成「空心砖」。INK_FLOOR 就是用来堵这个洞的。
  const w = 300;
  const h = 300;
  const paper = { x: 30, y: 30, w: 240, h: 240 };
  const ink = { x: 100, y: 100, w: 100, h: 100 };
  const gray = toGray(photoOfPage(w, h, paper, ink));
  const scan = scanDocument(gray, w, h, { c: 12, winSize: 28, crop: false });
  const cx = ink.x + Math.round(ink.w / 2);
  const cy = ink.y + Math.round(ink.h / 2);
  let dark = 0;
  let n = 0;
  for (let y = cy - 8; y <= cy + 8; y++) {
    for (let x = cx - 8; x <= cx + 8; x++) {
      n++;
      if (scan.data[(y * w + x) * 4] === 0) dark++;
    }
  }
  assert.ok(dark / n >= 0.95, `黑块中心应几乎全黑，实际 ${Math.round((dark / n) * 100)}%`);
});

test('scanDocument: crop:false 时不裁', () => {
  const w = 60;
  const h = 60;
  const gray = toGray(photoOfPage(w, h, { x: 8, y: 8, w: 44, h: 44 }, { x: 20, y: 20, w: 20, h: 20 }));
  const scan = scanDocument(gray, w, h, { crop: false });
  assert.equal(scan.width, w);
  assert.equal(scan.height, h);
});

/* ---------- server ---------- */

test('server: 上传落地、文件名清掉非法字符、重复名不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', html: '<h1>ok</h1>' });
  try {
    const post = async (filename) => {
      const { body, contentType } = multipart([{ filename, mime: 'image/png', data: Buffer.from('PNGDATA') }]);
      const res = await fetch(`http://127.0.0.1:${box.port}/upload`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
      return { status: res.status, json: await res.json() };
    };

    const first = await post('../../evil*name?.png');
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    const saved = readdirSync(dir);
    assert.equal(saved.length, 1);
    assert.ok(!saved[0].includes('..'), '不能带出路径');
    assert.ok(!/[*?]/.test(saved[0]), '非法字符要清掉');
    assert.match(saved[0], /\.png$/);

    const second = await post('evil*name?.png');
    assert.equal(second.status, 200);
    assert.equal(readdirSync(dir).length, 2, '同名两次要存成两个文件');
    assert.notEqual(readdirSync(dir)[0], readdirSync(dir)[1]);
    for (const f of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, f), 'utf8'), 'PNGDATA');
    }
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: 口令保护除 /health 外的路由', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-token-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', token: 'sekret', html: '<h1>ok</h1>' });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/?k=wrong`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/?k=sekret`)).status, 200);
    const viaHeader = await fetch(`http://127.0.0.1:${box.port}/api/list`, { headers: { 'x-drop-key': 'sekret' } });
    assert.equal(viaHeader.status, 200);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: 未知路由 404，列表按新到旧', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-list-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', html: '<h1>ok</h1>' });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/nope`)).status, 404);
    const { body, contentType } = multipart([{ filename: 'one.png', mime: 'image/png', data: Buffer.from('X') }]);
    await fetch(`http://127.0.0.1:${box.port}/upload`, { method: 'POST', headers: { 'content-type': contentType }, body });
    const listed = await (await fetch(`http://127.0.0.1:${box.port}/api/list`)).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.files.length, 1);
    assert.match(listed.files[0].name, /^one.*\.png$/);
    assert.equal(listed.files[0].size, 1);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
