/**
 * dsh-phone-drop host entry.
 *
 * Mounts the drop box while the profile is up, and publishes its address as a
 * tool so the assistant can tell the user which URL to open on the phone
 * instead of them hunting for an IP in `ipconfig`.
 *
 * The server is started inside `ctx.effect`, so disabling the plugin row (or
 * shutting the host down) closes the listener instead of leaving a port open
 * behind a disposed plugin — the same discipline the built-in plugins use.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDropBox } from './server.js';
import { pageHtml } from './page.js';
import { qrAscii } from './qr.js';
import { SETTINGS_FILE, currentDir, expandPath, writeOverride } from './settings.js';

export const name = 'phone-drop';

const DEFAULTS = {
  enabled: true,
  port: 9800,
  host: '0.0.0.0',
  token: '',
  dir: '',
  title: '手机直传',
};

/** Fill in the derived defaults the schema cannot express (a path, a home). */
function resolveConfig(config) {
  const raw = config ?? {};
  const pick = (key) => (raw[key] === undefined ? DEFAULTS[key] : raw[key]);
  const dir = expandPath(pick('dir'));
  const port = Number(pick('port'));
  return {
    enabled: pick('enabled') !== false,
    port: Number.isFinite(port) && port >= 0 && port <= 65535 ? port : DEFAULTS.port,
    host: String(pick('host') || DEFAULTS.host),
    token: String(pick('token') || ''),
    title: String(pick('title') || DEFAULTS.title),
    dir: dir !== '' ? dir : join(homedir(), 'Pictures', 'dsh-phone-drop'),
  };
}

/**
 * Register the plugin against the host context.
 *
 * @param ctx host context
 * @param config profile override from the loader
 */
export function apply(ctx, config) {
  const options = resolveConfig(config);
  if (!options.enabled) {
    ctx.logger?.info?.('dsh-phone-drop: disabled by config');
    return;
  }

  /** Filled in once the listener is up; read lazily by the tool. */
  let live;
  /** Last bind failure code, so the watch below can retry an EADDRINUSE once. */
  let lastStartError;
  /** Owned by the LAN drop box effect: its log and its teardown flag. */
  let stopped = true;
  const log = (line) => {
    ctx.logger?.info?.(`dsh-phone-drop: ${line}`);
  };

  function boot() {
    void (async () => {
      try {
        const started = await startDropBox({
          dir: options.dir,
          port: options.port,
          host: options.host,
          token: options.token,
          title: options.title,
          settingsFile: SETTINGS_FILE,
          html: pageHtml({ title: options.title }),
          dirNow: () => currentDir(options.dir, options.dir),
          setDir: (wanted) => writeOverride(wanted),
          log,
        });
        if (stopped) {
          await started.close();
          return;
        }
        live = started;
        lastStartError = undefined;
        for (const url of started.phoneUrls()) log(`手机请打开 ${url}`);
        if (started.urls.length === 0) log('没找到局域网 IPv4，等连上 Wi-Fi 再试');
      } catch (error) {
        lastStartError = error?.code;
        log(`启动失败：${error?.code ?? ''} ${error?.message ?? error}`);
      }
    })();
  }

  ctx.effect(() => {
    stopped = false;
    boot();

    return async () => {
      stopped = true;
      const box = live;
      live = undefined;
      lastStartError = undefined;
      if (box !== undefined) {
        await box.close();
        log('服务已停止');
      }
    };
  }, 'dsh-phone-drop: LAN drop box');

  // The loader can re-run this plugin many times as the profile is edited, and
  // a reload that arrives before the previous listener finished binding is
  // enough to lose the port for good. Watch the listener and say so loudly,
  // and retry a bind that failed only because the old socket had not let go.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const box = live;
      if (box === undefined) {
        const lost = lastStartError;
        if (lost !== undefined && lost === 'EADDRINUSE') {
          lastStartError = undefined;
          log(`端口 ${options.port} 上次被占用，重试一次`);
          boot();
        }
        return;
      }
      box.health?.().then(
        (ok) => {
          if (!ok) log(`端口 ${box.port} 上的监听已经不响应了`);
        },
        () => log(`端口 ${box.port} 上的监听已经不响应了`),
      );
    }, 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-phone-drop: liveness watch');

  // The browser half needs the QR page address, and it must not guess: the box
  // may be bound elsewhere, may have failed to bind, or may be disabled. One
  // small endpoint answers exactly that, and only to this machine — the answer
  // is a loopback URL, useless to anyone arriving over the network.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const onLoopback = (req) => {
        const from = req.socket?.remoteAddress ?? '';
        return from === '127.0.0.1' || from === '::1' || from === '::ffff:127.0.0.1';
      };
      return webCtx.webServer.register({
        kind: 'exact',
        path: '/api/phone-drop/info',
        handler: (req, res) => {
          const send = (status, body) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify(body));
          };
          if (!onLoopback(req)) {
            send(403, { error: 'forbidden: loopback-only' });
            return;
          }
          if (req.method !== 'GET') {
            send(405, { error: `method not allowed: ${req.method}` });
            return;
          }
          const box = live;
          if (box === undefined) {
            send(200, { running: false, dir: options.dir });
            return;
          }
          send(200, {
            running: true,
            dir: box.dir,
            port: box.port,
            deskUrl: `http://127.0.0.1:${box.port}/qr`,
          });
        },
      });
    }, 'dsh-phone-drop: info route');
  });

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      const dispose = toolsCtx.tools.register({
        name: 'phone_drop',
        description:
          '手机直传（dsh-phone-drop）：告诉用户现在该在手机上打开哪个地址/扫哪个二维码，把手机拍的照片、扫描件传进电脑；也能列出刚到的最新文件、改存放文件夹。第一次用或用户问「手机怎么传图给我」时调用它。',
        timeoutMs: 15_000,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['url', 'qr', 'recent', 'setdir'],
              description:
                'url = 手机上要打开的地址；qr = 电脑上该打开的二维码页面（手机扫一扫直接进）；recent = 最近收到的文件；setdir = 换存放文件夹。',
            },
            dir: {
              type: 'string',
              description: 'setdir 时用：新的存放文件夹绝对路径，支持 ~ 开头。',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              running: { type: 'boolean', description: '服务是否在监听。' },
              dir: { type: 'string', description: '接收文件的目录。' },
              urls: { type: 'array', items: { type: 'string' }, description: '手机上可打开的地址。' },
              deskUrl: { type: 'string', description: '电脑上打开就能看到二维码的地址。' },
              qr: { type: 'string', description: '二维码的终端字符画，可直接贴进对话。' },
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    size: { type: 'number' },
                  },
                  required: ['name', 'size'],
                  additionalProperties: false,
                },
                description: 'recent 动作返回的文件列表。',
              },
            },
            required: ['running', 'dir'],
            additionalProperties: false,
          },
          render(_args, value) {
            const lines = [];
            if (value.running !== true) {
              lines.push('手机直传服务没有起来（插件未启用或端口被占用）。');
            } else {
              lines.push('手机和电脑连同一个 Wi-Fi，手机上打开：');
              for (const url of value.urls ?? []) lines.push(`- ${url}`);
              if (typeof value.deskUrl === 'string' && value.deskUrl !== '') {
                lines.push('', `不想在手机上输网址：电脑上打开 ${value.deskUrl} ，用手机扫屏幕上的二维码。`);
              }
              if (typeof value.qr === 'string' && value.qr !== '') {
                lines.push('', '也可以直接扫这段（在等宽字体里显示成二维码）：', '', value.qr);
              }
              lines.push('', `收到的文件在这里：${value.dir}`);
            }
            if (Array.isArray(value.files) && value.files.length > 0) {
              lines.push('', '最近收到：');
              for (const f of value.files) lines.push(`- ${f.name}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const action = ['url', 'qr', 'recent', 'setdir'].includes(args?.action) ? args.action : 'url';

          if (action === 'setdir') {
            const wanted = String(args?.dir ?? '').trim();
            if (wanted === '') throw new Error('setdir 需要 dir 参数（新的存放文件夹）');
            const now = writeOverride(wanted);
            log(`接收目录已改为 ${now}`);
            return { running: live !== undefined, dir: now, urls: [], files: [] };
          }

          const box = live;
          if (box === undefined) {
            return { running: false, dir: options.dir, urls: [], files: [] };
          }
          const urls = box.phoneUrls();
          const deskUrl = `http://127.0.0.1:${box.port}/qr`;
          const files =
            action === 'recent'
              ? await fetch(`http://127.0.0.1:${box.port}/api/list`)
                  .then((r) => r.json())
                  .then((j) => (j.files ?? []).map((f) => ({ name: f.name, size: f.size })))
                  .catch(() => [])
              : [];
          const qr = action === 'qr' && urls.length > 0 ? qrAscii(urls[0], { margin: 2 }) : '';
          return { running: true, dir: box.dir, urls, deskUrl, qr, files };
        },
      });
      return () => dispose();
    }, 'dsh-phone-drop: phone_drop tool');
  });
}
