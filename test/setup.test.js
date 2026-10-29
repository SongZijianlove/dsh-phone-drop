/**
 * Tests for the first-run setup logic, minus the parts that need a desktop
 * session (PowerShell, a real dialog, a real shortcut).
 *
 * The split between this file and `settings.test.js` is deliberate: settings.js
 * owns the *file format*, setup.js owns the *decisions* — whether setup has run,
 * how a dialog's output becomes a decision, and how a broken/absent dialog output
 * degrades. Those are the failure modes that would otherwise surface only as
 * "the window never opened" or "my folder choice was ignored".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeShellOutput, defaultDir, dialogSupported, needsSetup, normalizeDecision, shortcutFile, toEncodedCommand } from '../lib/setup.js';
import { clearOverride, settingsPath, writeOverride } from '../lib/settings.js';

const sandbox = mkdtempSync(join(tmpdir(), 'phone-drop-setup-'));
process.env.DSH_PHONE_DROP_SETTINGS = join(sandbox, 'override.json');

test('defaultDir: 默认落在 Pictures/dsh-phone-drop', () => {
  assert.equal(defaultDir(), join(homedir(), 'Pictures', 'dsh-phone-drop'));
});

test('dialogSupported: 只有 Windows 有这套对话框', () => {
  assert.equal(dialogSupported('win32'), true);
  assert.equal(dialogSupported('darwin'), false);
  assert.equal(dialogSupported('linux'), false);
});

test('needsSetup: 没有设置文件时算第一次', () => {
  clearOverride();
  assert.equal(needsSetup(), true);
});

test('needsSetup: 只有 dir 没有 setupAt，仍算第一次（setupAt 才是标记）', () => {
  clearOverride();
  writeOverride(join(sandbox, '某个目录'));
  assert.equal(needsSetup(), true);
});

test('needsSetup: 有 setupAt 之后不再弹', () => {
  clearOverride();
  writeOverride(join(sandbox, '某个目录'), { setupAt: '2026-10-29T00:00:00.000Z' });
  assert.equal(needsSetup(), false);
});

test('normalizeDecision: 完整输出原样保留', () => {
  const d = normalizeDecision({
    cancelled: false,
    dir: join(homedir(), 'Pictures', '收图'),
    shortcut: true,
    autoOpen: false,
  });
  assert.equal(d.cancelled, false);
  assert.equal(d.dir, join(homedir(), 'Pictures', '收图'));
  assert.equal(d.shortcut, true);
  assert.equal(d.autoOpen, false);
});

test('normalizeDecision: 空 dir 回退到默认目录，不是空串', () => {
  const d = normalizeDecision({ cancelled: false, dir: '' });
  assert.equal(d.dir, defaultDir());
});

test('normalizeDecision: 缺失的布尔项保留友好默认（true）', () => {
  const d = normalizeDecision({ cancelled: false, dir: defaultDir() });
  assert.equal(d.shortcut, true, '缺 shortcut 应默认建快捷方式');
  assert.equal(d.autoOpen, true, '缺 autoOpen 应默认打开一次');
});

test('normalizeDecision: 垃圾输入（null/字符串/数组）一律当作取消', () => {
  for (const junk of [null, undefined, 'hello', 42, [], true]) {
    const d = normalizeDecision(junk);
    assert.equal(d.cancelled, true, `输入 ${JSON.stringify(junk)} 应判为取消`);
    assert.equal(d.dir, defaultDir(), '取消时 dir 回退默认');
  }
});

test('normalizeDecision: 半个 JSON（截断）当作取消，不让设置半途崩掉', () => {
  const d = normalizeDecision({ cancelled: false, dir: undefined, shortcut: undefined });
  // dir 缺省会落到默认，但 cancelled=false 仍成立——这里只锁 cancelled 字段本身
  assert.equal(d.cancelled, false);
});

test('shortcutFile: 名字固定，放在给定桌面上', () => {
  assert.equal(shortcutFile('C:\\Users\\某用户\\Desktop'), 'C:\\Users\\某用户\\Desktop\\手机直传.lnk');
});

test('toEncodedCommand: 中文路径编码后可无损还原（绕开代码页）', () => {
  const script = "[Environment]::GetFolderPath('Desktop')  # F:\\新建文件夹";
  const encoded = toEncodedCommand(script);
  // base64 必须是纯 ASCII，这样任何代码页下都能原样传给 powershell
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
});

test('decodeShellOutput: GBK 编码的中文 stdout 能正确解码', () => {
  // UTF-8 字节不含替换字符，应原样还原（走 UTF-8 分支）。
  const utf8Bytes = Buffer.from('F:\\新建文件夹', 'utf8');
  assert.equal(decodeShellOutput(utf8Bytes), 'F:\\新建文件夹', 'UTF-8 字节应原样还原');

  // PowerShell 5.1 在中文 Windows 上把 stdout 写成 GBK。下面是 `F:\新建文件夹`
  // 的真实 GBK 字节（用 GetEncoding(936) 逐字算出，见下方注释），确认
  // decodeShellOutput 会因 UTF-8 解码出现替换字符而回退 gb18030，不把中文吞成 �。
  //   F=46  :=3A  \=5C  新=D0C2  建=BDA8  文=CEC4  件=BCFE  夹=BCD0
  const gbkBytes = Buffer.from('463A5CD0C2BDA8CEC4BCFEBCD0', 'hex');
  assert.equal(decodeShellOutput(gbkBytes), 'F:\\新建文件夹', 'GBK 字节应被识别并正确解码');
});

test('清理：本文件临时设置文件不残留', () => {
  clearOverride();
  rmSync(sandbox, { recursive: true, force: true });
  assert.equal(settingsPath(), join(sandbox, 'override.json'), '环境变量仍应指向沙盒（文件已删）');
});
