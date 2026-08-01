export interface SessionTerminalLocation {
  protocol: string;
  origin: string;
  hostname: string;
}

function currentLocation(): SessionTerminalLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

export function sessionTerminalHref(s: any, loc: SessionTerminalLocation | null = currentLocation()): string | null {
  // riff：只读入口对齐飞书卡片语义 —— 「Web终端=日志页」走本地 worker 端口的
  // 只读日志视图，而不是 riffAccessUrl。riffAccessUrl 是 AIO Sandbox 的**可写**
  // capability（bearer URL，见 riff-backend.ts:hashUrlForLog「the unique subdomain
  // IS the write capability」），只能经鉴权的 /write-link（🔑「操作链接=AIO」）下发。
  // 若在此短路返回它，只读图标会打开可写沙箱、且匿名只读面板也会拿到写能力 ——
  // 故这里一律走 webPort 分支，让读/写入口与卡片侧一一对应。
  if (!s?.webPort || !loc) return null;
  // On the central HTTPS machine domain, terminals must go through the same
  // origin `/s/<session>` reverse proxy. Exposing a raw port would produce a
  // dead link because the platform only proxies 443.
  if (loc.protocol === 'https:') {
    return s.proxyPort ? `${loc.origin}/s/${encodeURIComponent(s.sessionId)}` : null;
  }
  const port = s.proxyPort ?? s.webPort;
  const suffix = s.proxyPort ? `/s/${encodeURIComponent(s.sessionId)}` : '';
  return `http://${loc.hostname}:${port}${suffix}`;
}
