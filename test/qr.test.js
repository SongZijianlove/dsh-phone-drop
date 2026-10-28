/**
 * Tests for the QR encoder and the two new surfaces it feeds: `/qr.svg` and the
 * desktop page.
 *
 * The encoder is vendored third-party code. Testing it is still worth it —
 * vendoring is exactly the moment when "it worked upstream" stops being an
 * argument, because the slice that got copied is not the slice that was tested.
 * These assertions cover structure (finder patterns, quiet zone, size) rather
 * than pixel equality; scannability is proven separately by rendering to PNG
 * and decoding with a real decoder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { qrAscii, qrMatrix, qrSvg } from '../lib/qr.js';
import { startDropBox } from '../lib/server.js';

test('qrMatrix: 尺寸随内容增长，且是方形布尔矩阵', () => {
  const small = qrMatrix('http://a.b');
  const big = qrMatrix('http://10.214.93.71:9800/?k=' + 'x'.repeat(120));
  assert.equal(small.modules.length, small.size);
  assert.ok(small.size >= 21 && small.size <= 177, `版本非法：${small.size}`);
  assert.equal(small.size % 4, 1, '二维码边长必须是 4v+17');
  assert.ok(big.size >= small.size, '内容更长不该更小');
  for (const row of small.modules) {
    assert.equal(row.length, small.size);
    for (const bit of row) assert.equal(typeof bit, 'boolean');
  }
});

test('qrMatrix: 三个定位图案在正确的角上', () => {
  // 定位图案外圈是 7 个连续黑模块。这个断言能抓到「矩阵整体偏移/翻转」这一类
  // 错位错误 —— 那种错误肉眼几乎看不出来，但相机扫不出来。
  const { size, modules } = qrMatrix('http://10.214.93.71:9800/');
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const border = x === 0 || x === 6 || y === 0 || y === 6;
        const inner = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        const want = border || inner;
        if (modules[oy + y][ox + x] !== want) return false;
      }
    }
    return true;
  };
  assert.ok(finder(0, 0), '左上角应是定位图案');
  assert.ok(finder(size - 7, 0), '右上角应是定位图案');
  assert.ok(finder(0, size - 7), '左下角应是定位图案');
});

test('qrSvg: 静区、viewBox 和路径都对得上', () => {
  const { size, markup } = qrSvg('http://10.214.93.71:9800/', { size: 240, margin: 4 });
  assert.match(markup, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(markup, /width="240" height="240"/);
  assert.ok(markup.includes(`viewBox="0 0 ${size} ${size}"`), 'viewBox 应含静区');
  // 每个黑模块一个 `h1v1h-1z` 子路径
  const cells = (markup.match(/h1v1h-1z/g) ?? []).length;
  assert.ok(cells > 100, `黑模块太少：${cells}`);
  assert.ok(markup.includes('fill="#0b1733"'), '默认深色应是指定的深蓝');
});

test('qrSvg: 同样的输入给出同样的输出（没有随机掩码）', () => {
  const a = qrSvg('http://10.214.93.71:9800/?k=abc').markup;
  const b = qrSvg('http://10.214.93.71:9800/?k=abc').markup;
  assert.equal(a, b);
});

test('qrMatrix: 纠错等级越高版本越大或相等', () => {
  const text = 'http://10.214.93.71:9800/?k=Zx9QwErTy';
  const l = qrMatrix(text, { ecl: 'L' }).size;
  const h = qrMatrix(text, { ecl: 'H' }).size;
  assert.ok(h >= l, `H(${h}) 不该比 L(${l}) 小`);
});

test('qrAscii: 行数是模块数的一半（半块字符上下拼）', () => {
  const art = qrAscii('http://10.214.93.71:9800/', { margin: 2 });
  const lines = art.split('\n');
  const { size } = qrMatrix('http://10.214.93.71:9800/');
  const total = size + 4;
  assert.equal(lines.length, Math.ceil(total / 2));
  assert.ok(lines.every((l) => l.length === total), '每行宽度应一致');
  assert.ok(/[█▀▄]/.test(art), '应该有实心字符');
});

test('server: /qr.svg 返回一张二维码，/qr 返回电脑端页面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-qr-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', title: '手机直传' });
  try {
    const svg = await fetch(`http://127.0.0.1:${box.port}/qr.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(await svg.text(), /<svg /);

    const page = await fetch(`http://127.0.0.1:${box.port}/qr`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /手机扫下面这个码/);
    assert.match(html, /<svg /, '二维码应该直接画进页面，不依赖脚本');
    assert.ok(html.includes(dir), '应显示当前存放目录');
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: /manifest.webmanifest 让手机能装到桌面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-manifest-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', title: '手机直传' });
  try {
    const res = await fetch(`http://127.0.0.1:${box.port}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.short_name, '手机直传');
    assert.equal(json.display, 'standalone');
    assert.ok(Array.isArray(json.icons) && json.icons.length > 0);

    const icon = await fetch(`http://127.0.0.1:${box.port}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type') ?? '', /image\/svg\+xml/);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
