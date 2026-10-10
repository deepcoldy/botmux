import { getDefaultLocale, t, type Locale } from '../i18n/index.js';

export type TerminalStatusKind =
  | 'starting'
  | 'closed'
  | 'not-found'
  | 'forbidden'
  | 'unavailable';

interface TerminalStatusCopy {
  code: string;
  titleKey: string;
  detailKey: string;
}

const STATUS_COPY: Record<TerminalStatusKind, TerminalStatusCopy> = {
  starting: {
    code: 'STARTING',
    titleKey: 'terminal.status.starting.title',
    detailKey: 'terminal.status.starting.detail',
  },
  closed: {
    code: 'SESSION CLOSED',
    titleKey: 'terminal.status.closed.title',
    detailKey: 'terminal.status.closed.detail',
  },
  'not-found': {
    code: 'NOT FOUND',
    titleKey: 'terminal.status.not_found.title',
    detailKey: 'terminal.status.not_found.detail',
  },
  forbidden: {
    code: 'LINK EXPIRED',
    titleKey: 'terminal.status.forbidden.title',
    detailKey: 'terminal.status.forbidden.detail',
  },
  unavailable: {
    code: 'UNAVAILABLE',
    titleKey: 'terminal.status.unavailable.title',
    detailKey: 'terminal.status.unavailable.detail',
  },
};

export function terminalStatusHtml(kind: TerminalStatusKind, requestedLocale?: Locale): string {
  const definition = STATUS_COPY[kind];
  const locale = requestedLocale ?? getDefaultLocale();
  const title = t(definition.titleKey, undefined, locale);
  const detail = t(definition.detailKey, undefined, locale);

  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} - Botmux Terminal</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#1f2329}
main{width:min(520px,calc(100% - 40px));padding:40px 0}
.brand{font-size:13px;font-weight:700;color:#1456d9;letter-spacing:0}
.rule{width:44px;height:3px;margin:18px 0 28px;background:#1456d9}
.code{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#646a73}
h1{margin:8px 0 12px;font-size:30px;line-height:1.25;letter-spacing:0}
p{margin:0;color:#646a73;font-size:15px;line-height:1.7}
@media(prefers-color-scheme:dark){
  body{background:#171719;color:#f2f3f5}
  .brand{color:#4e83fd}.rule{background:#4e83fd}.code,p{color:#a6a7ab}
}
</style>
</head>
<body>
<main>
  <div class="brand">BOTMUX TERMINAL</div>
  <div class="rule"></div>
  <div class="code">${definition.code}</div>
  <h1>${title}</h1>
  <p>${detail}</p>
</main>
</body>
</html>`;
}
