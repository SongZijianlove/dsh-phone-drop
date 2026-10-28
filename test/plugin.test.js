/**
 * Tests for the host entry: does `apply()` actually do what a Cordis plugin is
 * supposed to do?
 *
 * The host contract is narrow but easy to get subtly wrong — a route that never
 * gets disposed leaks a port, a tool that is registered without an effect never
 * goes away when the row is disabled. So the fake context below is deliberately
 * strict: `effect` has to be used, the returned disposer has to be honoured, and
 * `inject` has to be given the service list the plugin actually needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, name as pluginName } from '../lib/index.js';
import { startDropBox } from '../lib/server.js';

/**
 * A minimal stand-in for the host context.
 *
 * `dispose()` runs every registered effect in reverse order, which is what the
 * real loader does — that is how the test proves the listener really closes.
 */
function fakeContext() {
  const disposers = [];
  const registered = [];
  const logs = [];
  const injected = [];

  const ctx = {
    logger: {
      info: (line) => logs.push(String(line)),
      warn: (line) => logs.push(String(line)),
      error: (line) => logs.push(String(line)),
    },
    effect(fn, label) {
      assert.equal(typeof fn, 'function', 'effect 需要一个函数');
      assert.equal(typeof label, 'string', 'effect 需要 label');
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    inject(services, fn) {
      assert.ok(Array.isArray(services) && services.length > 0, 'inject 需要服务名数组');
      injected.push(...services);
      const child = { ...ctx };
      if (services.includes('tools')) {
        child.tools = {
          register(definition) {
            registered.push(definition);
            return () => registered.splice(registered.indexOf(definition), 1);
          },
        };
      }
      return fn(child);
    },
  };

  return {
    ctx,
    registered,
    logs,
    injected,
    async dispose() {
      for (const d of disposers.reverse()) await d();
    },
  };
}

/** Wait until the drop box answers, or give up — the listener starts async. */
async function waitForHealth(port, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`服务没在 ${ms}ms 内起来`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('apply: 模块导出了宿主认识的插件名', () => {
  assert.equal(pluginName, 'phone-drop');
  assert.equal(typeof apply, 'function');
});

test('apply: 起服务、注册 phone_drop 工具、dispose 后端口释放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-plugin-'));
  const f = fakeContext();
  try {
    apply(f.ctx, { port: 0, host: '127.0.0.1', dir, token: '', title: '测试标题' });

    // 端口是 0（系统分配），等 apply 完成异步启动后从日志里拿不到端口，
    // 所以这里换成固定端口跑一遍真实断言。
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(f.registered.some((d) => d.name === 'phone_drop'), '应注册 phone_drop 工具');
    const tool = f.registered.find((d) => d.name === 'phone_drop');
    assert.equal(tool.parameters.required[0], 'action');
    assert.deepEqual(tool.parameters.properties.action.enum, ['url', 'qr', 'recent', 'setdir']);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
  } finally {
    await f.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: 固定端口时服务真的在监听，工具能报出地址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-plugin2-'));
  const f = fakeContext();
  const port = 19801;
  try {
    apply(f.ctx, { port, host: '127.0.0.1', dir, token: '', title: '手机直传' });
    const health = await waitForHealth(port);
    assert.equal(health.ok, true);
    assert.equal(health.dir, dir);

    const tool = f.registered.find((d) => d.name === 'phone_drop');
    const value = await tool.execute({ action: 'url' });
    assert.equal(value.running, true);
    assert.equal(value.dir, dir);
    assert.ok(Array.isArray(value.urls));

    // 「最近收到」在没有文件时是空数组，不该抛错
    const recent = await tool.execute({ action: 'recent' });
    assert.deepEqual(recent.files, []);

    const text = tool.output.render({ action: 'url' }, value)[0].text;
    assert.match(text, /手机和电脑连同一个 Wi-Fi/);
  } finally {
    await f.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: dispose 之后服务确实停了，端口不再接受连接', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-plugin3-'));
  const f = fakeContext();
  const port = 19802;
  try {
    apply(f.ctx, { port, host: '127.0.0.1', dir, token: '', title: '手机直传' });
    await waitForHealth(port);
    await f.dispose();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`), '停掉之后不该还能连');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: enabled: false 时什么都不做', async () => {
  const f = fakeContext();
  apply(f.ctx, { enabled: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.registered.length, 0, '不应注册工具');
  assert.ok(f.logs.some((l) => l.includes('disabled')), '应记一条 disabled 日志');
});

test('apply: 口令配置会传给服务（带口令时工具地址带 ?k=）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-plugin4-'));
  const f = fakeContext();
  const port = 19803;
  try {
    apply(f.ctx, { port, host: '127.0.0.1', dir, token: 'sekret', title: '手机直传' });
    await waitForHealth(port);
    const tool = f.registered.find((d) => d.name === 'phone_drop');
    const value = await tool.execute({ action: 'url' });
    assert.ok(value.urls.length > 0, '应该有可打开的地址');
    for (const url of value.urls) assert.match(url, /k=sekret/);
  } finally {
    await f.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server: /scan.js 每次请求都重读文件，升级后不会继续发旧字节', async () => {
  // 这一条是被真事逼出来的：pnpm add 把修复版换到磁盘后，宿主里那个进程
  // 还在把启动时读进内存的旧 scanner 发给手机，文件 mtime 却说已经修好了。
  const dir = mkdtempSync(join(tmpdir(), 'phone-drop-scanjs-'));
  const box = await startDropBox({ dir, port: 0, host: '127.0.0.1', html: '<h1>ok</h1>' });
  const scanPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scan.js');
  const original = readFileSync(scanPath, 'utf8');
  try {
    const first = await (await fetch(`http://127.0.0.1:${box.port}/scan.js`)).text();
    assert.ok(first.includes('export function scanDocument'), '应该发到扫描模块');
    writeFileSync(scanPath, `${original}\n// hot-swap marker\n`);
    const second = await (await fetch(`http://127.0.0.1:${box.port}/scan.js`)).text();
    assert.ok(second.includes('hot-swap marker'), '新文件内容必须立刻生效，否则宿主里跑的是旧扫描器');
  } finally {
    writeFileSync(scanPath, original);
    await box.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
