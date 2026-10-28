/**
 * dsh-phone-drop server: the LAN drop box.
 *
 * Bind policy: 0.0.0.0 explicitly. This is the plugin's OWN listener, not the
 * Host webserver — that one refuses wildcard addresses on purpose because it
 * front-loads the whole RCE surface. Here the surface is four routes, no
 * session, no shell, and the phone has to be on the same link, so binding every
 * interface is what makes the thing work at all. When `token` is configured,
 * every route but `/health` requires it, so a coffee-shop Wi-Fi cannot post
 * files into the folder behind the user's back.
 *
 * Every request is answered with `cache-control: no-store`: the page is the
 * only HTML here and stale HTML after an upgrade is a support ticket.
 */
import { createServer, get } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { qrSvg } from './qr.js';
import { desktopPageHtml } from './desktop.js';

const MAX_BYTES = 64 * 1024 * 1024;

/**
 * The scanner module, served to the page as-is.
 *
 * The page imports this over HTTP rather than carrying its own copy of the
 * filters: one implementation, the same one the tests run, so the browser can
 * never drift from what `node --test` proved.
 *
 * It is read per request, not once at startup. Reading it once looked harmless
 * and was not: the bytes live in memory for the life of the process, so after
 * `pnpm add` swapped the file on disk the running server kept serving the old
 * scanner to every phone while the file's mtime said the fix had landed. A
 * 10 KB read per page load is nothing; a scanner that ignores its own upgrade
 * is a day lost.
 */
function readScanJs() {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'scan.js'), 'utf8');
}

/** Every non-internal IPv4 the phone could reach. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/** `-20261028-193012`, so twenty shots of the same page do not overwrite each other. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Strip what Windows refuses in a filename; keep everything else. */
function safeName(name) {
  const base = basename(String(name || 'drop')).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  return base || 'drop';
}

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function extOf(name, mime) {
  const e = extname(name).toLowerCase();
  if (e && e.length <= 6) return e;
  return MIME_EXT[mime] ?? '';
}

/**
 * Split a `multipart/form-data` body into its file parts.
 *
 * Hand-rolled on purpose: the alternative is a dependency for 40 lines of
 * buffer slicing, and this package's whole selling point is that it installs
 * with nothing behind it.
 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (m === null) return [];
  const boundary = Buffer.from(`--${(m[1] ?? m[2]).trim()}`);
  const files = [];
  let pos = 0;
  for (;;) {
    const start = buffer.indexOf(boundary, pos);
    if (start < 0) break;
    const headStart = start + boundary.length;
    const headEnd = buffer.indexOf('\r\n\r\n', headStart);
    if (headEnd < 0) break;
    const head = buffer.slice(headStart, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = buffer.indexOf(boundary, bodyStart);
    if (next < 0) break;
    const body = buffer.slice(bodyStart, Math.max(bodyStart, next - 2));
    pos = next;
    const fn = /filename="([^"]*)"/i.exec(head);
    if (fn === null || fn[1] === '') continue;
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
    files.push({ filename: fn[1], mime: ct === null ? 'application/octet-stream' : ct[1].trim(), data: body });
  }
  return files;
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/**
 * Mount the drop box.
 *
 * @param {object} opts
 * @param {string} opts.dir absolute directory received files land in
 * @param {number} opts.port 0 lets the OS pick, which the tool calls use
 * @param {string} [opts.host] bind address, defaults to every interface
 * @param {string} [opts.token] when set, every route but /health wants `?k=`
 * @param {string} [opts.html] the page to serve at / (phones)
 * @param {string} [opts.title] shown on the desktop QR page
 * @param {() => string} [opts.dirNow] live directory reader, for `setdir`
 * @param {(dir: string) => string} [opts.setDir] persists a new directory
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{port:number, host:string, dir:string, urls:string[], close:()=>Promise<void>}>}
 */
export function startDropBox(opts) {
  const baseDir = opts.dir;
  mkdirSync(baseDir, { recursive: true });

  /**
   * The directory in force for this request.
   *
   * Resolved per request rather than captured once: `setdir` is supposed to
   * move the very next photo, and asking the caller each time is the cheapest
   * way to guarantee that (the caller caches the file read for a second).
   */
  const dirNow = () => {
    try {
      const live = opts.dirNow?.() ?? baseDir;
      return live === '' ? baseDir : live;
    } catch {
      return baseDir;
    }
  };

  const log = opts.log ?? (() => {});
  const token = typeof opts.token === 'string' && opts.token !== '' ? opts.token : undefined;

  /** Constant-time token check; also accepts the `x-drop-key` header. */
  const allowed = (url, req) => {
    if (token === undefined) return true;
    const given = url.searchParams.get('k') ?? req.headers['x-drop-key'];
    if (typeof given !== 'string' || given === '') return false;
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(token).digest();
    return timingSafeEqual(a, b);
  };

  const save = (originalName, mime, buf) => {
    const dir = dirNow();
    mkdirSync(dir, { recursive: true });
    const ext = extOf(originalName, mime);
    const stem = basename(safeName(originalName), extname(originalName)) || 'drop';
    let full = join(dir, `${stem}${stamp()}${ext}`);
    let n = 1;
    while (existsSync(full)) full = join(dir, `${stem}${stamp()}-${n++}${ext}`);
    writeFileSync(full, buf);
    return full;
  };

  const list = (limit = 12) => {
    const dir = dirNow();
    try {
      return readdirSync(dir)
        .filter((f) => !f.startsWith('.'))
        .map((f) => {
          const st = statSync(join(dir, f));
          return { name: f, size: st.size, at: st.mtimeMs };
        })
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    } catch {
      return [];
    }
  };

  /**
   * Send one file from the receiving directory.
   *
   * The name comes from the client, so it is checked against the directory
   * listing instead of being sanitized: `..%2f` and friends simply never match
   * a real entry, and the resolved path is re-checked to be inside `dir` before
   * a single byte is read.
   */
  const sendFile = (res, name) => {
    const dir = dirNow();
    let real;
    try {
      real = normalize(join(dir, String(name ?? '')));
    } catch {
      real = '';
    }
    const inside = real !== '' && (real === dir || real.startsWith(dir.endsWith(sep) ? dir : dir + sep));
    if (!inside || !existsSync(real) || !statSync(real).isFile()) {
      json(res, 404, { ok: false, error: '没有这个文件' });
      return;
    }
    const ext = extname(real).toLowerCase();
    const type =
      Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': statSync(real).size,
      'cache-control': 'private, max-age=60',
      // Never let a dropped file execute as a document in the browsing context.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.end(readFileSync(real));
  };

  /** The phone URL for this listener, with the key when one is configured. */
  const phoneUrls = (port) => {
    const list = lanAddresses();
    const base = list.length > 0 ? list : ['127.0.0.1'];
    return base.map((ip) => {
      const bare = `http://${ip}:${port}`;
      return token === undefined ? bare : `${bare}/?k=${encodeURIComponent(token)}`;
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, dir: dirNow(), ips: lanAddresses(), port: actualPort });
      return;
    }

    if (!allowed(url, req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('需要访问口令：请在电脑上的地址后面带上 ?k=口令');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(opts.html ?? '<!doctype html><meta charset=utf-8><h1>dsh-phone-drop</h1><p>没有配置页面。</p>');
      return;
    }

    /*
     * The desktop side. Phones scan a QR code; the person holding the phone is
     * looking at this browser window, so the QR lives here and nowhere else.
     * It is reachable from the machine itself and from the LAN, exactly like
     * every other route, and it carries the same interface as the phone page.
     */
    if (req.method === 'GET' && url.pathname === '/qr') {
      const urls = phoneUrls(actualPort);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        desktopPageHtml({
          title: opts.title ?? '手机直传',
          dir: dirNow(),
          urls,
          port: actualPort,
          settingsFile: opts.settingsFile,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/qr.svg') {
      const target = url.searchParams.get('u') ?? phoneUrls(actualPort)[0] ?? `http://127.0.0.1:${actualPort}`;
      const svg = qrSvg(target, { size: Number(url.searchParams.get('size') ?? 320), margin: 4 });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(svg.markup);
      return;
    }

    // Lets the phone install the page as an app: scan once, then it has an icon.
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const start = token === undefined ? './' : `./?k=${encodeURIComponent(token)}`;
      res.writeHead(200, {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          name: opts.title ?? '手机直传',
          short_name: '手机直传',
          start_url: start,
          scope: './',
          display: 'standalone',
          background_color: '#0b1733',
          theme_color: '#0b1733',
          icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">` +
          `<rect width="192" height="192" rx="42" fill="#0b1733"/>` +
          `<rect x="44" y="62" width="104" height="76" rx="12" fill="none" stroke="#c5a468" stroke-width="8"/>` +
          `<circle cx="96" cy="100" r="18" fill="#c5a468"/>` +
          `<rect x="78" y="46" width="36" height="16" rx="6" fill="#c5a468"/>` +
          `</svg>`,
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/scan.js') {
      let body;
      try {
        body = readScanJs();
      } catch (error) {
        json(res, 500, { ok: false, error: `scanner unavailable: ${error.message}` });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/list') {
      json(res, 200, { ok: true, dir: dirNow(), files: list() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/file') {
      sendFile(res, url.searchParams.get('name'));
      return;
    }

    /*
     * Move the receiving folder without touching the profile.
     *
     * Loopback only: the phone may look at this folder's contents, but the
     * folder is the user's choice, made at the machine. A phone on the same Wi-Fi
     * is not allowed to redirect where future photos land.
     */
    if (req.method === 'POST' && url.pathname === '/api/dir') {
      const loopback =
        req.socket.remoteAddress === '127.0.0.1' ||
        req.socket.remoteAddress === '::1' ||
        req.socket.remoteAddress === '::ffff:127.0.0.1';
      if (!loopback) {
        json(res, 403, { ok: false, error: '只能在电脑上改接收目录' });
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let wanted = '';
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          wanted = (req.headers['content-type'] ?? '').includes('application/json')
            ? String(JSON.parse(raw)?.dir ?? '')
            : String(new URLSearchParams(raw).get('dir') ?? '');
        } catch {
          wanted = '';
        }
        if (opts.setDir === undefined) {
          json(res, 501, { ok: false, error: '这个运行方式不支持改目录，请用 --dir 启动' });
          return;
        }
        try {
          const now = opts.setDir(wanted);
          log(`接收目录已改为 ${now}`);
          json(res, 200, { ok: true, dir: now });
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      });
      req.on('error', () => {});
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_BYTES) {
          aborted = true;
          json(res, 413, { ok: false, error: `文件太大（上限 ${Math.round(MAX_BYTES / 1048576)} MB）` });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const files = parseMultipart(Buffer.concat(chunks), req.headers['content-type']);
          if (files.length === 0) {
            json(res, 400, { ok: false, error: '没收到文件' });
            return;
          }
          const saved = files.map((it) => {
            const full = save(it.filename, it.mime, it.data);
            log(`收到 ${basename(full)}（${Math.round(it.data.length / 1024)} KB，来自 ${req.socket.remoteAddress ?? '?'}）`);
            return { name: basename(full), size: it.data.length, path: full };
          });
          json(res, 200, { ok: true, saved, dir: dirNow() });
        } catch (error) {
          log(`上传出错：${error?.stack ?? error}`);
          json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      });
      req.on('error', () => {});
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('not found');
  });

  let actualPort = opts.port ?? 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr !== null ? addr.port : actualPort;
      const bindHost = typeof addr === 'object' && addr !== null ? addr.address : (opts.host ?? '0.0.0.0');
      const urls = lanAddresses().map((ip) => `http://${ip}:${actualPort}`);
      log(`服务已启动，监听 ${bindHost}:${actualPort}，保存到 ${baseDir}`);
      resolve({
        port: actualPort,
        host: bindHost,
        get dir() {
          return dirNow();
        },
        urls,
        /** Everything a phone could open, `?k=` included. */
        phoneUrls: () => phoneUrls(actualPort),
        health: () =>
          new Promise((done) => {
            const req = get(`http://127.0.0.1:${actualPort}/health`, (res) => {
              res.resume();
              done(res.statusCode === 200);
            });
            req.on('error', () => done(false));
            req.setTimeout(2000, () => {
              req.destroy();
              done(false);
            });
          }),
        // Drop idle keep-alive sockets first: Node's `close()` waits for them,
        // and a half-open probe connection would otherwise keep the port bound
        // long after the plugin is gone (that is how 9800 outlived a reload).
        close: () =>
          new Promise((done) => {
            server.closeIdleConnections?.();
            server.close(() => done());
          }),
      });
    });
    server.keepAliveTimeout = 5000;
  });
}
