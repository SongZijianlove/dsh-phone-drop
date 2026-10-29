/**
 * `postinstall`: the first-run dialog, at the moment the package lands.
 *
 * This is the "第一次下载" hook. npm runs it in whichever shell started the
 * install, which on Windows may be a GUI-installed Node with no console — so the
 * dialog is a separate process with `windowsHide`, and every path here ends in
 * `process.exit(0)`. An install that fails because a convenience window
 * misbehaved would be a much worse bug than one without a window.
 *
 * It is skipped entirely when the install is not the user's own:
 *   - `DSH_PHONE_DROP_NO_SETUP=1` (scripts, CI, image builds)
 *   - not a global install and `DSH_PHONE_DROP_FORCE_SETUP` not set: a package
 *     installed as someone else's dependency must never open a modal window.
 *     npm pipes the postinstall stdout, so `isTTY` is useless here — the
 *     reliable signal is `npm_config_global === 'true'`.
 *   - setup already ran (`setupAt` present in the settings file)
 *
 * Everything it can decide is decided in `lib/setup.js`; this file only wires it
 * to the lifecycle event and prints the outcome.
 */
import { applyDecision, describe, dialogSupported, needsSetup, showDialog } from './setup.js';

const quiet = process.env.DSH_PHONE_DROP_NO_SETUP === '1';
const forced = process.env.DSH_PHONE_DROP_FORCE_SETUP === '1';
// `npm install -g` is the moment this tool is adopted by a person; `npm install
// some-dep-that-uses-this` is not. npm sets this to the string "true".
const globalInstall = process.env.npm_config_global === 'true';

async function main() {
  if (quiet) return;
  if (!dialogSupported()) return;
  if (!needsSetup()) {
    process.stdout.write('dsh-phone-drop: 已经设置过了，跳过首次设置窗口。\n');
    return;
  }
  if (!globalInstall && !forced) {
    // A dependency install or a piped shell: record nothing, say nothing, stay
    // out of the way.
    return;
  }

  process.stdout.write('dsh-phone-drop: 第一次安装，正在打开设置窗口…\n');
  const decision = await showDialog();
  if (decision.cancelled === true) {
    process.stdout.write('dsh-phone-drop: 已跳过。以后随时运行 `dsh-phone-drop --setup` 再设置。\n');
    return;
  }
  const applied = await applyDecision(decision);
  process.stdout.write(`${describe(applied)}\n`);
  if (applied.opened === true) {
    process.stdout.write('dsh-phone-drop: 已经另开一个窗口在跑，那个窗口就是服务本体。\n');
  }
}

main()
  .catch((error) => {
    process.stdout.write(`dsh-phone-drop: 首次设置没做成（${error?.message ?? error}），不影响使用。\n`);
    process.stdout.write('dsh-phone-drop: 想再试就运行 `dsh-phone-drop --setup`。\n');
  })
  .finally(() => process.exit(0));
