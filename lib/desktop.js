/**
 * The desktop side: one big QR code.
 *
 * Typing `http://10.214.93.71:9800/?k=Zx9Q` on a phone is the tax this plugin
 * exists to remove, so the computer shows a code and the phone's own camera app
 * does the rest. This page is meant for the browser on the PC — it is the same
 * listener, just a different route.
 *
 * Everything is inline: no fonts, no scripts, no images fetched from anywhere,
 * so it renders identically on a machine that has never been online.
 */
import { qrSvg } from './qr.js';

/** Escape for HTML text and attributes; the inputs here are paths and titles. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * @param {object} opts
 * @param {string} opts.title plugin title
 * @param {string} opts.dir the folder photos currently land in
 * @param {string[]} opts.urls phone URLs, most useful first
 * @param {number} opts.port listening port
 * @param {string} [opts.settingsFile] where the folder override is persisted
 */
export function desktopPageHtml(opts) {
  const title = esc(opts.title ?? '手机直传');
  const dir = esc(opts.dir);
  const urls = Array.isArray(opts.urls) ? opts.urls : [];
  const primary = urls[0] ?? '';
  const others = urls.slice(1);

  /*
   * The QR is drawn server-side, not by a script in the page: it means the page
   * works with JavaScript disabled, and the encoder has exactly one
   * implementation that the tests can call directly.
   */
  const qr = primary === '' ? null : qrSvg(primary, { size: 360, margin: 3 });

  const altList =
    others.length === 0
      ? ''
      : `<ul class="alt">${others.map((u) => `<li><code>${esc(u)}</code></li>`).join('')}</ul>`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1733">
<title>${title} · 扫码直传</title>
<style>
:root{--navy:#0b1733;--gold:#c5a468;--cream:#e6d3a3;--ink:#e8eefc;--mute:#8fa3c8}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(120% 80% at 50% 0%,#152a52 0%,var(--navy) 60%,#060d1d 100%);
 color:var(--ink);font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
 display:flex;align-items:center;justify-content:center;padding:32px 18px}
main{width:100%;max-width:760px}
h1{margin:0 0 6px;font-size:26px;letter-spacing:.08em;color:var(--cream);font-weight:600}
.sub{color:var(--mute);font-size:14px;margin-bottom:22px}
.grid{display:flex;gap:24px;align-items:center;flex-wrap:wrap;background:#101d3a;border:1px solid #c5a46833;border-radius:20px;padding:22px}
.qr{flex:none;background:#fff;padding:10px;border-radius:14px;line-height:0;box-shadow:0 8px 22px #0006}
.qr svg{display:block;width:100%;height:auto;max-width:300px}
.side{flex:1;min-width:240px}
.label{font-size:12px;letter-spacing:.16em;color:#6f83a8;text-transform:uppercase}
.url{margin:6px 0 16px;font-size:15px;color:var(--cream);word-break:break-all;font-family:ui-monospace,Consolas,monospace;
 background:#0d1830;border:1px solid #c5a46833;border-radius:10px;padding:10px 12px}
.steps{font-size:14px;color:#9fb2d4;margin:0;padding-left:20px}
.steps li{margin:6px 0}
.dir{font-size:13px;color:#8fa3c8;margin-top:18px}
.dir code{color:var(--cream);word-break:break-all}
.alt{margin:10px 0 0;padding-left:18px;font-size:12px;color:#6f83a8}
.alt code{word-break:break-all}
.tip{margin-top:18px;font-size:12px;color:#6f83a8;line-height:1.7}
.tip b{color:#9fb2d4;font-weight:600}
</style></head><body>
<main>
  <h1>${title}</h1>
  <div class="sub">手机扫下面这个码，直接打开传图页面。不用输网址。</div>
  <div class="grid">
    <div class="qr">${qr === null ? '<p style="color:#333;padding:20px">没找到局域网地址</p>' : qr.markup}</div>
    <div class="side">
      <div class="label">手机地址</div>
      <div class="url" id="url">${esc(primary === '' ? '（先让电脑连上 Wi-Fi）' : primary)}</div>
      <ol class="steps">
        <li>用手机的<b>相机</b>或<b>扫一扫</b>对着这个二维码</li>
        <li>点跳出来的链接，进入传图页</li>
        <li>拍照或选图，点上传</li>
      </ol>
      <div class="dir">照片存在：<code>${dir}</code></div>
      ${altList}
    </div>
  </div>
  <div class="tip">
    <b>电脑和手机必须连同一个 Wi-Fi。</b>打不开的话检查手机是不是开了流量或代理。
    ${opts.settingsFile === undefined ? '' : `<br>想换存放文件夹：改 <code>${esc(opts.settingsFile)}</code> 里的 <code>dir</code>，下一次上传就生效。`}
    <br>这个页面本身可以收藏，以后直接从收藏夹打开。
  </div>
</main>
</body></html>`;
}
