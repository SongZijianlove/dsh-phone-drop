/**
 * dsh-phone-drop browser half.
 *
 * One entry at the sidebar foot. Clicking it asks the Host half for the live
 * QR page address and opens that in a new tab, so the phone side is one click
 * away instead of a URL the person has to remember or retype.
 *
 * The address is asked for rather than assumed: the drop box may be bound to a
 * configured port, may have failed to bind, or may be disabled, and the button
 * has to say which of those happened instead of opening a dead tab.
 */
window.__ModuleLoader__.load({
  id: 'dsh-phone-drop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace this plugin owns. */
    const NS = 'dsh-phone-drop';
    /** The sidebar-foot seat this entry occupies. */
    const SLOT = 'sidebar.footer.action';
    /** Document-relative on purpose: the GUI is served with `<base href="./">`. */
    const INFO_URL = 'api/phone-drop/info';
    /** Marks this plugin's injected stylesheet so it can be replaced cleanly. */
    const STYLE_KEY = 'dsh-phone-drop/entry.css';

    const zh = {
      'entry.label': '手机直传',
      'entry.hint': '手机扫二维码，把照片和扫描件传进电脑',
      'entry.offline': '手机直传服务没在跑：插件未启用，或 9800 端口被占用了。',
      'entry.blocked': '浏览器拦住了新标签页，允许弹窗后再点一次。',
      'entry.opening': '正在打开二维码…',
    };
    const en = {
      'entry.label': 'Phone drop',
      'entry.hint': 'Scan a QR code to send photos from your phone',
      'entry.offline': 'The phone drop server is not running: plugin disabled, or port 9800 is taken.',
      'entry.blocked': 'The browser blocked the new tab. Allow pop-ups and try again.',
      'entry.opening': 'Opening the QR page…',
    };

    const css = `
.dsh-phone-drop-entry{appearance:none;box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-secondary,inherit);background:transparent;border:0;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 8px;min-width:0;transition:background-color .14s,color .14s}
.dsh-phone-drop-entry:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit)}
.dsh-phone-drop-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}
.dsh-phone-drop-entry[data-busy=true]{opacity:.6;cursor:progress}
.dsh-phone-drop-entry[data-wide=false]{justify-content:center;padding:6px}
.dsh-phone-drop-entry[data-wide=true]{width:100%}
.dsh-phone-drop-entry-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-phone-drop-entry-glyph{flex:none;display:block}
`.trim();

    /** The sidebar-foot trigger: a phone with an inbound arrow. */
    function PhoneGlyph({ size }) {
      return h(
        'svg',
        {
          className: 'dsh-phone-drop-entry-glyph',
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 4.3, y: 1.4, width: 7.4, height: 13.2, rx: 1.7 }),
        h('path', { d: 'M7 3.3h2' }),
        h('path', { d: 'M8 6.4v4.3' }),
        h('path', { d: 'M6.2 8.9 8 10.7l1.8-1.8' }),
      );
    }

    /**
     * Sidebar-foot entry.
     * @param props - the seat share (`wide`) plus this entry's injected face (`t`).
     * @returns the trigger button.
     */
    function PhoneDropEntry({ wide, t }) {
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');

      const open = React.useCallback(async () => {
        setBusy(true);
        setNotice('');
        try {
          const response = await fetch(INFO_URL, { headers: { accept: 'application/json' } });
          const info = response.ok ? await response.json() : undefined;
          if (info === undefined || info.running !== true || typeof info.deskUrl !== 'string') {
            setNotice(t('entry.offline'));
            return;
          }
          const opened = window.open(info.deskUrl, '_blank', 'noopener');
          if (opened === null) setNotice(t('entry.blocked'));
        } catch {
          setNotice(t('entry.offline'));
        } finally {
          setBusy(false);
        }
      }, [t]);

      const title = notice !== '' ? `${t('entry.hint')} — ${notice}` : t('entry.hint');

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-phone-drop-entry',
          'data-wide': wide === true ? 'true' : 'false',
          'data-busy': busy ? 'true' : 'false',
          'aria-busy': busy ? 'true' : 'false',
          title,
          'aria-label': t('entry.label'),
          onClick: open,
        },
        h(PhoneGlyph, { size: wide === true ? 16 : 18 }),
        wide === true ? h('span', { className: 'dsh-phone-drop-entry-label' }, t('entry.label')) : null,
        notice !== ''
          ? h('span', { role: 'status', style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' } }, notice)
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en });
          } catch {
            return () => {};
          }
        }, 'dsh-phone-drop: dictionaries');

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-phone-drop';
          tag.dataset.pluginCss = STYLE_KEY;
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'dsh-phone-drop: entry styles');

        ctx.slots.inject(SLOT, () => {
          const t = ctx.locale.bind(NS);
          return ctx.slots.register(
            {
              name: SLOT,
              id: 'phone-drop',
              order: 40,
              locale: NS,
              label: () => t('entry.label'),
            },
            PhoneDropEntry,
          );
        });
      },
    };
  },
});
