// Injected at document start into every main-frame page, but it only exposes
// anything on the bundled status page (file://). The dashboard is HTTP content
// and gets nothing; the native handler re-checks the origin as well.
(() => {
  if (location.protocol !== 'file:') return;
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (!handlers || !handlers.botmux) return;
  const call = (method, ...params) => handlers.botmux.postMessage({ method, params });
  window.botmuxDesktop = Object.freeze({
    getOverview: () => call('getOverview'),
    start: () => call('start'),
    restart: () => call('restart'),
    takeover: () => call('takeover'),
    checkUpdate: () => call('checkUpdate'),
    applyUpdate: () => call('applyUpdate'),
    retryDashboard: () => call('retryDashboard'),
    listLogTargets: () => call('listLogTargets'),
    tailLogs: targetId => call('tailLogs', targetId),
    openLogsDir: () => call('openLogsDir'),
    openBotmuxHome: () => call('openBotmuxHome'),
    getLoginItem: () => call('getLoginItem'),
    setLoginItem: enabled => call('setLoginItem', Boolean(enabled)),
  });
})();
