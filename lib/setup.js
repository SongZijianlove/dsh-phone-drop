/**
 * First-run setup: the little dialog that appears the first time this thing is
 * installed, and everything it has to do afterwards.
 *
 * Why a dialog at all: the plugin is usable with zero configuration, but three
 * decisions are much cheaper to make once, up front, than to discover later —
 * where the photos land, whether there is a desktop shortcut, and whether to
 * open it immediately. Making the user edit a JSON file to answer "where do my
 * photos go?" is the kind of thing that gets a tool uninstalled.
 *
 * Three rules shape the implementation:
 *
 *   1. The dialog never decides anything on its own. `lib/setup-dialog.ps1` is
 *      pure UI: it collects three answers and writes them as JSON. All the
 *      effects — folder, shortcut, launch — happen here, in JS, where they can
 *      be tested without a desktop session.
 *   2. Setup must never be able to break a transfer. Every failure path
 *      (no PowerShell, no GUI, crashed dialog, timeout) degrades to "keeps the
 *      built-in default and says so", because the alternative is an install that
 *      hangs on a machine nobody is looking at.
 *   3. "First run" is a persisted fact, not an inference. If the marker is
 *      missing because the user deleted it, showing the dialog again is the
 *      correct behaviour, not a bug.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandPath, readSettings, settingsPath, writeOverride } from './settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOG_SCRIPT = join(HERE, 'setup-dialog.ps1');

// Prefixed to every snippet so PowerShell 5.1 writes stdout as UTF-8 instead of
// the OEM code page (GBK on a Chinese Windows). Without this, a Chinese path
// that PowerShell echoes back arrives as `F:\??????` in Node, which reads the
// pipe as UTF-8. `decodeShellOutput` below is a second line of defense for the
// (rare) case where the prologue does not take effect.
const PS_PROLOGUE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

/** Default landing folder, identical to the one the plugin and CLI use. */
export function defaultDir() {
  return join(homedir(), 'Pictures', 'dsh-phone-drop');
}

/**
 * Has setup already happened?
 *
 * The marker is `setupAt` in the override file, not the file's existence: a user
 * who only ever ran `--dir` has the file but has never seen the dialog.
 */
export function needsSetup() {
  const settings = readSettings();
  return typeof settings?.setupAt !== 'string' || settings.setupAt === '';
}

/** True when this platform can actually show the dialog. */
export function dialogSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Normalize whatever the dialog wrote into a decision we can apply.
 *
 * The dialog is a child process that can be killed, so its output is treated as
 * untrusted input: a truncated or hand-edited file must degrade to "cancelled"
 * rather than throw halfway through applying a setup.
 *
 * @param {unknown} raw parsed JSON from the dialog
 * @returns {{cancelled: boolean, dir: string, shortcut: boolean, autoOpen: boolean}}
 */
export function normalizeDecision(raw) {
  // Only a plain object can be a decision. `JSON.parse("null")` returns `null`
  // without throwing, so a dialog that wrote a corrupted or empty file reaches
  // this point as `null`/a primitive instead of failing the parse above. None of
  // those are a real decision, so they mean "user never chose" — cancel.
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const invalid = raw === null || typeof raw !== 'object' || Array.isArray(raw);
  const cancelled = value.cancelled === true || invalid;
  const dir = expandPath(value.dir);
  return {
    cancelled,
    dir: cancelled || dir === '' ? defaultDir() : dir,
    // Only an explicit `false` disables these; a missing field keeps the
    // friendlier default, so an older dialog build still behaves sensibly.
    shortcut: value.shortcut !== false,
    autoOpen: value.autoOpen !== false,
  };
}

/**
 * Where the shortcut should go, given a desktop path.
 *
 * The name is fixed rather than configurable: a user who wants it elsewhere can
 * drag it elsewhere, and a configurable name is one more thing to get wrong.
 */
export function shortcutFile(desktopDir) {
  return join(desktopDir, '手机直传.lnk');
}

/**
 * Ask Windows for the real desktop path.
 *
 * `~/Desktop` is a guess that is wrong on any machine with a redirected or
 * OneDrive-backed profile, and this harness's own machine is exactly that. The
 * shell knows the answer; ask the shell.
 */
function desktopDir() {
  // Ask for the path as base64 of UTF-16LE, not as text. PowerShell 5.1 writes
  // its stdout in the OEM code page (GBK here), and Node reads it as UTF-8, so a
  // Chinese path like F:\新建文件夹 comes back as F:\??????. Base64 is pure
  // ASCII and survives any code page; decode it here to get the real string back.
  return runPowerShell(
    "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([Environment]::GetFolderPath('Desktop')))",
    { timeoutMs: 20_000 },
  ).then((out) => Buffer.from(out.trim(), 'base64').toString('utf16le'));
}

/**
 * Encode a script as a `-EncodedCommand` payload (base64 of UTF-16LE).
 *
 * Windows PowerShell 5.1 does not reliably round-trip non-ASCII characters in a
 * plain `-Command` argument on every code page, so the only way to hand it a
 * script that is guaranteed to contain the exact Chinese path the user chose is
 * to pass the bytes base64-encoded.
 */
export function toEncodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Decode a PowerShell stdout/stderr buffer.
 *
 * The child writes in its console output encoding (OEM/GBK on a Chinese
 * Windows), not UTF-8. Decode as UTF-8 first; when that yields replacement
 * characters the bytes were almost certainly GBK, so decode again as GB18030.
 * `gb18030` is part of the WHATWG Encoding Standard and available in Node's
 * bundled ICU.
 */
export function decodeShellOutput(buf) {
  const utf8 = buf.toString('utf8');
  if (utf8.includes('\uFFFD')) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/**
 * Run a PowerShell snippet and resolve with its stdout.
 *
 * Rejects on timeout instead of hanging: every caller here is on the install
 * path, and an install that never returns is worse than one that reports an
 * error.
 */
function runPowerShell(script, { timeoutMs = 60_000, extraArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', toEncodedCommand(PS_PROLOGUE + script), ...extraArgs],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const outChunks = [];
    const errChunks = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell 超时（${timeoutMs} ms）`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = decodeShellOutput(Buffer.concat(outChunks));
      const err = decodeShellOutput(Buffer.concat(errChunks));
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() !== '' ? err.trim() : `PowerShell 退出码 ${code}`));
    });
  });
}

/**
 * Show the dialog and resolve with the user's decision.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent] skip the UI and accept the defaults — used by
 *   tests and by postinstall when there is no desktop session
 * @param {string} [opts.dir] pre-filled folder
 * @param {number} [opts.timeoutMs] how long to wait before giving up
 * @returns {Promise<{cancelled: boolean, dir: string, shortcut: boolean, autoOpen: boolean}>}
 */
export async function showDialog(opts = {}) {
  const silent = opts.silent === true;
  const fallback = normalizeDecision({
    cancelled: silent,
    dir: opts.dir ?? defaultDir(),
    shortcut: opts.shortcut,
    autoOpen: opts.autoOpen,
  });
  if (!dialogSupported()) return { ...fallback, cancelled: true };

  const outFile = join(
    process.env.TEMP ?? process.env.TMP ?? homedir(),
    `dsh-phone-drop-setup-${process.pid}-${Date.now()}.json`,
  );
  const desktop = await desktopDir().catch(() => '');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-STA',
    '-File',
    DIALOG_SCRIPT,
    '-OutFile',
    outFile,
    '-DefaultDir',
    fallback.dir,
    '-DefaultShortcut',
    String(fallback.shortcut),
    '-DefaultAutoOpen',
    String(fallback.autoOpen),
    '-ShortcutDir',
    desktop,
  ];
  if (silent) args.push('-Silent');

  await new Promise((resolve, reject) => {
    // windowsHide MUST be false here. With `windowsHide: true`, Node sets
    // STARTF_USESHOWWINDOW|SW_HIDE on the child, which PowerShell inherits, and
    // the WinForms dialog it then opens is created hidden (visible=False) — the
    // window exists, the user just can't see it. The console flash is a non-issue
    // because `-File` + a GUI dialog runs without a console window anyway.
    const child = spawn('powershell.exe', args, { windowsHide: false, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`设置窗口超时（${Math.round((opts.timeoutMs ?? 300_000) / 1000)} 秒）`));
    }, opts.timeoutMs ?? 300_000);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`设置窗口退出码 ${code}`));
    });
  }).catch(() => {});

  try {
    const raw = JSON.parse(readFileSync(outFile, 'utf8'));
    return normalizeDecision(raw);
  } catch {
    // No file means the dialog was closed with the X button, killed, or never
    // got far enough to write one. All three mean "user did not decide".
    return { ...fallback, cancelled: true };
  }
}

/**
 * Create the desktop shortcut.
 *
 * The target is `node.exe` plus the CLI script rather than a generated `.cmd`
 * shim: the install path routinely contains non-ASCII characters (`C:\Users\
 * 宋子健\...`), and a `.cmd` file would be decoded by cmd.exe in the OEM code
 * page, mangling exactly those characters. A `.lnk` stores its strings as
 * UTF-16, so it survives any path.
 *
 * @param {string} linkPath full path of the `.lnk`
 * @param {string} cliPath full path of `lib/cli.js`
 * @returns {Promise<string>} the path written
 */
export async function createShortcut(linkPath, cliPath) {
  const esc = (text) => String(text).replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut('${esc(linkPath)}')`,
    `$link.TargetPath = '${esc(process.execPath)}'`,
    `$link.Arguments = '"${cliPath.replace(/"/g, '\\"')}" --open'`,
    `$link.WorkingDirectory = '${esc(homedir())}'`,
    `$link.IconLocation = '${esc(process.execPath)},0'`,
    '$link.Description = "手机直传：扫二维码把手机照片传进电脑"',
    '$link.WindowStyle = 1',
    '$link.Save()',
    '[Console]::Out.Write($link.FullName)',
  ].join('; ');
  const written = await runPowerShell(script, { timeoutMs: 30_000 });
  return written.trim() === '' ? linkPath : written.trim();
}

/**
 * Start the drop box once, in its own console window.
 *
 * Not `spawn(detached)` directly: a detached child with ignored stdio has no
 * console to print the URLs into, and the URLs are the point. `cmd /c start`
 * gives it a real window that the user can also close to stop the server.
 */
export function openOnce(cliPath = join(HERE, 'cli.js')) {
  try {
    const child = spawn('cmd', ['/c', 'start', '""', process.execPath, `"${cliPath}"`, '--open'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a decision: folder first, then shortcut, then launch.
 *
 * Order matters. The folder write is the only step the plugin cannot work
 * without, so it happens before anything that can throw; the launch happens last
 * so a failed shortcut cannot leave a server running with no way to find it.
 *
 * @param {{cancelled: boolean, dir: string, shortcut: boolean, autoOpen: boolean}} decision
 * @param {object} [opts]
 * @param {boolean} [opts.writeMarker] record that setup ran
 * @returns {Promise<{dir: string, shortcut: string, opened: boolean, errors: string[]}>}
 */
export async function applyDecision(decision, opts = {}) {
  const errors = [];
  if (decision.cancelled === true) return { dir: '', shortcut: '', opened: false, errors };

  const dir = writeOverride(decision.dir, {
    setupAt: new Date().toISOString(),
    shortcut: decision.shortcut,
    autoOpen: decision.autoOpen,
  });

  let shortcut = '';
  if (decision.shortcut === true) {
    try {
      const desktop = await desktopDir();
      if (desktop === '') throw new Error('拿不到桌面路径');
      shortcut = await createShortcut(shortcutFile(desktop), join(HERE, 'cli.js'));
    } catch (error) {
      errors.push(`快捷方式没建成：${error?.message ?? error}`);
    }
  }

  const opened = decision.autoOpen === true ? openOnce() : false;
  return { dir, shortcut, opened, errors };
}

/**
 * The whole first-run story, in the order a user experiences it.
 *
 * @param {object} [opts] see `showDialog`
 * @returns {Promise<{ran: boolean, decision?: object, dir?: string, errors: string[]}>}
 */
export async function ensureFirstRun(opts = {}) {
  if (!needsSetup()) return { ran: false, errors: [] };
  if (!dialogSupported()) return { ran: false, errors: [] };

  const decision = await showDialog(opts);
  if (decision.cancelled === true) {
    return { ran: false, errors: [] };
  }
  const applied = await applyDecision(decision);
  return { ran: true, decision, dir: applied.dir, errors: applied.errors, shortcut: applied.shortcut, opened: applied.opened };
}

/** Format the applied settings for a terminal, so the user can see where it went. */
export function describe(applied) {
  const lines = [];
  if (applied.dir !== '') lines.push(`照片保存到：${applied.dir}`);
  if (applied.shortcut !== '') lines.push(`桌面快捷方式：${applied.shortcut}`);
  if (applied.opened === true) lines.push('已经打开一次二维码页面');
  for (const error of applied.errors ?? []) lines.push(`（${error}）`);
  lines.push(`设置文件：${settingsPath()}`);
  return lines.join('\n');
}
