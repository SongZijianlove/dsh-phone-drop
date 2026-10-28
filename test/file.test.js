/**
 * Tests for `/file`, the route that hands a dropped image back to the phone.
 *
 * This is the only route in the plugin that reads a path built from a query
 * string, so most of this file is about the paths it must refuse. The rule is
 * "check against the listing, then re-check the resolved path", and both halves
 * get a test because either one alone is a hole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { startDropBox } from '../lib/server.js';

function pngBytes() {
  // 8-byte PNG signature: enough to prove byte-for-byte delivery
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

test('server: /file 原样送回文件字节，且带 nosniff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-file-'));
  const bytes = pngBytes();
  writeFileSync(join(dir, 'shot.png'), bytes);
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${box.port}/file?name=shot.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: /file 挡住 ../ 穿越', async () => {
  const base = mkdtempSync(join(tmpdir(), 'phone-drop-trav-'));
  const dir = join(base, 'drop');
  mkdirSync(dir);
  writeFileSync(join(base, 'secret.txt'), '不应被读到');
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1' });
  try {
    for (const name of ['../secret.txt', '..%2Fsecret.txt', `..${sep}secret.txt`, '..\\secret.txt']) {
      const res = await fetch(`http://127.0.0.1:${box.port}/file?name=${encodeURIComponent(name)}`);
      assert.equal(res.status, 404, `应当拒绝 ${name}`);
      const text = await res.text();
      assert.ok(!text.includes('不应被读到'), `泄露了：${name}`);
    }
  } finally {
    await box.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('server: /file 不存在的名字给 404 而不是 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-404-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${box.port}/file?name=nope.png`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).ok, false);
    const empty = await fetch(`http://127.0.0.1:${box.port}/file`);
    assert.equal(empty.status, 404);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: /api/list 带 dir，页面才能显示「存在哪」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-listdir-'));
  writeFileSync(join(dir, 'a.jpg'), Buffer.alloc(10));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1' });
  try {
    const body = await (await fetch(`http://127.0.0.1:${box.port}/api/list`)).json();
    assert.equal(body.dir, dir);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].name, 'a.jpg');
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: 口令保护 /file，不带着 k 拿不到图', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-keyfile-'));
  writeFileSync(join(dir, 'x.png'), pngBytes());
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', token: 'sekret' });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/file?name=x.png`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/file?name=x.png&k=sekret`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${box.port}/file?name=x.png&k=wrong`)).status, 401);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
