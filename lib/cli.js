#!/usr/bin/env node
/**
 * `dsh-phone-drop` CLI: run the drop box without a DSH host.
 *
 * The plugin is the main path, but a bundle that can ONLY run inside DSH is
 * awkward to try. This entry starts the same server, prints the URLs to open on
 * the phone, and stays in the foreground until Ctrl+C.
 *
 * `--open` also opens the desktop QR page, which is the whole point of the QR
 * code: scan it once and the URL never has to be typed.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDropBox } from './server.js';
import { pageHtml } from './page.js';
import { qrAscii } from './qr.js';
import { SETTINGS_FILE, currentDir, expandPath, writeOverride } from './settings.js';
import { applyDecision, describe, dialogSupported, ensureFirstRun, needsSetup, showDialog } from './setup.js';

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`用法：dsh-phone-drop [选项]

  --port <n>      监听端口（默认 9800）
  --host <addr>   绑定地址（默认 0.0.0.0，即所有网卡）
  --dir <path>    接收目录（默认 ~/Pictures/dsh-phone-drop）
  --token <str>   访问口令，给地址加上 ?k= 才能用
  --title <str>   页面标题
  --open          启动后自动打开电脑上的二维码页面
  --no-qr         不在终端打印字符二维码
  --setup         打开设置窗口（选保存位置、桌面快捷方式、是否立刻打开）
  --no-setup      跳过首次设置窗口
`);
  process.exit(0);
}

/*
 * The settings window is offered once, before the server starts, so the folder
 * the user picks is the one the very first upload lands in. `--setup` forces it
 * back open; `--no-setup` and DSH_PHONE_DROP_NO_SETUP=1 suppress it for scripted
 * runs, and a non-interactive stdin (a cron job, a pipe) suppresses it too —
 * a modal dialog nobody is looking at is an indefinite hang.
 */
async function maybeSetup() {
  const asked = argv.includes('--setup');
  const refused = argv.includes('--no-setup') || process.env.DSH_PHONE_DROP_NO_SETUP === '1';
  if (refused) return;
  if (!asked && !needsSetup()) return;
  if (!dialogSupported()) {
    if (asked) process.stdout.write('（这个系统没有图形设置窗口，用 --dir 指定文件夹）\n');
    return;
  }

  const wanted = expandPath(flag('dir', ''));
  const decision = asked
    ? await showDialog({ dir: wanted === '' ? undefined : wanted })
    : (await ensureFirstRun({ dir: wanted === '' ? undefined : wanted })).decision;
  if (decision === undefined || decision.cancelled === true) {
    if (asked) process.stdout.write('（已取消，什么都没改）\n');
    return;
  }

  const applied = await applyDecision(decision);
  process.stdout.write(`\n${describe(applied)}\n`);
  if (applied.opened === true) {
    process.stdout.write('已经另开一个窗口在跑，这个窗口用不着了，可以关掉。\n');
    process.exit(0);
  }
}

await maybeSetup();

const port = Number(flag('port', 9800));
const host = String(flag('host', '0.0.0.0'));
const configured = expandPath(flag('dir', ''));
const fallbackDir = join(homedir(), 'Pictures', 'dsh-phone-drop');
const token = String(flag('token', ''));
const title = String(flag('title', '手机直传'));

const box = await startDropBox({
  dir: configured !== '' ? configured : fallbackDir,
  port: Number.isFinite(port) ? port : 9800,
  host,
  token,
  title,
  settingsFile: SETTINGS_FILE,
  html: pageHtml({ title }),
  /*
   * `--dir` is this run's default, not a permanent decision. Writing it into the
   * override file made a one-off `--dir ./收图` outlive the process and hijack
   * every later start, including the plugin's own default. The override now
   * belongs solely to `setdir` / the desktop page, where the user is explicitly
   * choosing a folder.
   */
  dirNow: () => currentDir(configured, fallbackDir),
  setDir: (wanted) => writeOverride(wanted),
  log: (line) => process.stdout.write(`${line}\n`),
});

process.stdout.write(`\n手机和电脑连同一个 Wi-Fi，打开：\n`);
for (const url of box.phoneUrls()) process.stdout.write(`  ${url}\n`);
if (box.urls.length === 0) process.stdout.write('  （没找到局域网地址，先连上 Wi-Fi）\n');

const deskUrl = `http://127.0.0.1:${box.port}/qr`;
process.stdout.write(`\n不想在手机上输网址：电脑上打开 ${deskUrl}\n`);
if (!argv.includes('--no-qr') && box.phoneUrls().length > 0) {
  process.stdout.write(`\n或者直接扫这个：\n\n${qrAscii(box.phoneUrls()[0], { margin: 2 })}\n`);
}
process.stdout.write(`\n收到的文件：${box.dir}\n按 Ctrl+C 停止。\n`);

if (argv.includes('--open')) {
  const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', deskUrl] : [deskUrl];
  try {
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    process.stdout.write(`（自动打开失败，手动打开 ${deskUrl}）\n`);
  }
}

const stop = async () => {
  await box.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
