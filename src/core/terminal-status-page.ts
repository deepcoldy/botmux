export type TerminalStatusKind =
  | 'starting'
  | 'closed'
  | 'not-found'
  | 'forbidden'
  | 'unavailable';

interface TerminalStatusCopy {
  code: string;
  title: string;
  detail: string;
  retry: boolean;
}

const STATUS_COPY: Record<TerminalStatusKind, TerminalStatusCopy> = {
  starting: {
    code: 'STARTING',
    title: '终端正在启动',
    detail: '正在恢复该会话的终端连接，页面会自动重试。',
    retry: true,
  },
  closed: {
    code: 'SESSION CLOSED',
    title: '该会话已关闭',
    detail: '会话已经结束，终端内容无法继续查看。',
    retry: false,
  },
  'not-found': {
    code: 'NOT FOUND',
    title: '找不到该会话',
    detail: '终端链接无效，或者对应会话已经被删除。',
    retry: false,
  },
  forbidden: {
    code: 'LINK EXPIRED',
    title: '终端链接已失效',
    detail: '请返回飞书，从该会话的最新卡片重新打开 Web 终端。',
    retry: false,
  },
  unavailable: {
    code: 'UNAVAILABLE',
    title: '终端暂不可用',
    detail: '会话仍然存在，但终端服务当前无法恢复。',
    retry: false,
  },
};

export function terminalStatusHtml(kind: TerminalStatusKind): string {
  const copy = STATUS_COPY[kind];
  const retryScript = copy.retry
    ? `<script>
const key='botmux-terminal-retry:'+location.pathname;
const count=Number(sessionStorage.getItem(key)||'0');
if(count<20){
  sessionStorage.setItem(key,String(count+1));
  setTimeout(()=>location.reload(),2000);
}else{
  document.getElementById('retry-note').textContent='启动时间较长，请稍后手动重试。';
}
</script>`
    : '';
  const retryAction = copy.retry
    ? '<button type="button" onclick="location.reload()">立即重试</button>'
    : '<button type="button" onclick="history.back()">返回上一页</button>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${copy.title} - Botmux Terminal</title>
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
.actions{display:flex;gap:12px;margin-top:28px}
button{min-height:40px;padding:0 18px;border:1px solid #c9cdd4;border-radius:6px;background:#fff;color:#1f2329;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
button:hover{border-color:#1456d9;color:#1456d9}
@media(prefers-color-scheme:dark){
  body{background:#171719;color:#f2f3f5}
  .brand{color:#4e83fd}.rule{background:#4e83fd}.code,p{color:#a6a7ab}
  button{background:#242426;color:#f2f3f5;border-color:#505052}
  button:hover{border-color:#4e83fd;color:#8babff}
}
</style>
</head>
<body>
<main>
  <div class="brand">BOTMUX TERMINAL</div>
  <div class="rule"></div>
  <div class="code">${copy.code}</div>
  <h1>${copy.title}</h1>
  <p id="retry-note">${copy.detail}</p>
  <div class="actions">${retryAction}</div>
</main>
${retryScript}
</body>
</html>`;
}
