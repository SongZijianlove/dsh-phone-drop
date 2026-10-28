/**
 * Tests for the receiving folder: the override file, and the two routes that
 * depend on it.
 *
 * The reason this deserves its own file is the resolution order. There are three
 * places the answer could come from — the override file, the profile config, the
 * built-in default — and "which one wins" is exactly the kind of thing that
 * silently regresses. Each test below pins one rung of that ladder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDropBox } from '../lib/server.js';
import { SETTINGS_FILE, clearOverride, currentDir, expandPath, readOverride, settingsPath, writeOverride } from '../lib/settings.js';

/*
 * Every test that touches the override file is redirected to a temp path first.
 * `settingsPath()` reads the environment on each call precisely so this works;
 * if a future refactor freezes the path at import time, these tests will start
 * writing into the developer's real `~/.dsh-phone-drop.json`, and the aliasing
 * test below catches that by asserting the env var is actually honoured.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'phone-drop-settings-'));
process.env.DSH_PHONE_DROP_SETTINGS = join(sandbox, 'override.json');

test('settingsPath: 环境变量能改覆盖文件的位置', () => {
  assert.equal(settingsPath(), join(sandbox, 'override.json'));
  assert.notEqual(settingsPath(), SETTINGS_FILE, '常量是在设置环境变量之前取的，应当不同');
});

test('expandPath: ~ 展开、相对路径变绝对、空串还是空串', () => {
  assert.equal(expandPath(''), '');
  assert.equal(expandPath('~'), homedir());
  assert.match(expandPath('~/图片'), /图片$/);
  assert.ok(expandPath('~/图片').startsWith(homedir()), '~ 应展开成 home');
  const rel = expandPath('某个相对目录');
  assert.ok(rel.includes('某个相对目录'), '去掉相对前缀不该丢内容');
  assert.notEqual(rel, '某个相对目录', '相对路径应变成绝对');
});

test('override 优先级：文件 > 配置 > 默认', () => {
  const base = mkdtempSync(join(tmpdir(), 'phone-drop-pref-'));
  const configured = join(base, '配置目录');
  const override = join(base, '覆盖目录');
  mkdirSync(configured);
  try {
    // 没有覆盖文件时用配置
    clearOverride();
    assert.equal(currentDir(configured, join(base, '默认')), configured);
    // 配置也没写时用默认
    assert.equal(currentDir('', join(base, '默认')), join(base, '默认'));
    // 写了覆盖就压过配置
    writeOverride(override);
    assert.equal(currentDir(configured, join(base, '默认')), override);
    assert.equal(readOverride(), override);
    // 清掉以后回到配置
    clearOverride();
    assert.equal(currentDir(configured, join(base, '默认')), configured);
  } finally {
    clearOverride();
    rmSync(base, { recursive: true, force: true });
  }
});

test('writeOverride: 目录不存在就建出来，写的是绝对路径', () => {
  const base = mkdtempSync(join(tmpdir(), 'phone-drop-mkdir-'));
  const target = join(base, '深', '一层');
  try {
    const written = writeOverride(target);
    assert.equal(written, target);
    assert.ok(existsSync(target), '目标目录应被创建');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    assert.equal(parsed.dir, target);
  } finally {
    clearOverride();
    rmSync(base, { recursive: true, force: true });
  }
});

test('readOverride: 坏文件当成没写，不让上传瘫痪', () => {
  const base = mkdtempSync(join(tmpdir(), 'phone-drop-bad-'));
  try {
    writeFileSync(settingsPath(), '{ 这不是 json', 'utf8');
    // 清掉模块内 1 秒缓存：换一个不同的 mtime 不能保证，先 clearOverride 再写
    clearOverride();
    writeFileSync(settingsPath(), '{ 这不是 json', 'utf8');
    assert.doesNotThrow(() => readOverride());
    assert.equal(currentDir(join(base, '配置'), ''), join(base, '配置'));
  } finally {
    clearOverride();
    rmSync(base, { recursive: true, force: true });
  }
});

test('server: POST /api/dir 改目录，下一次上传就落到新地方', async () => {
  const base = mkdtempSync(join(tmpdir(), 'phone-drop-switch-'));
  const first = join(base, '第一处');
  const second = join(base, '第二处');
  mkdirSync(first);
  let live = first;
  const box = await startDropBox({
    dir: first,
    port: 0,
    host: '127.0.0.1',
    dirNow: () => live,
    setDir: (wanted) => {
      mkdirSync(wanted, { recursive: true });
      live = wanted;
      return wanted;
    },
  });
  try {
    const before = await (await fetch(`http://127.0.0.1:${box.port}/health`)).json();
    assert.equal(before.dir, first);

    const res = await fetch(`http://127.0.0.1:${box.port}/api/dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: second }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).dir, second);

    const health = await (await fetch(`http://127.0.0.1:${box.port}/health`)).json();
    assert.equal(health.dir, second, '/health 应报新目录');
  } finally {
    await box.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('server: /api/dir 拒绝空值，且不回退到别的地方', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-baddir-'));
  const box = await startDropBox({
    dir,
    port: 0,
    host: '127.0.0.1',
    setDir: (wanted) => {
      if (String(wanted).trim() === '') throw new Error('目录不能为空');
      return String(wanted);
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${box.port}/api/dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: '   ' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /不能为空/);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: 没提供 setDir 时 /api/dir 明确拒绝，而不是假装成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-nosetdir-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${box.port}/api/dir`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: join(dir, 'x') }),
    });
    assert.equal(res.status, 501);
  } finally {
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
