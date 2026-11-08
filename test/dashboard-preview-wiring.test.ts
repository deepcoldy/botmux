import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

describe('central dashboard preview wiring', () => {
  // 源码结构护栏(K2)：预览代理把本机 dev server 端口暴露到已登录的同源路由上；端口号会被内核
  // 回收给下一个本机进程（P1-12），握手到登记之间还有最长 45s 的窗口（P1-1/P1-4）。判定逻辑的
  // 行为证据在 session-preview-ownership / -lifecycle / -close / -proxy 套件里，但中央 dashboard.ts
  // 是带模块副作用的巨型闭包、没有行为 seam：把 isTargetOwned 写成 `() => true`、去掉 onStaleTarget
  // 或 bindStream 的登记前复核，类型检查照样通过，却会静默开洞。这里只钉这几处接线存在且先于登记。
  it('re-checks port ownership on every hop and re-validates identity and target before registering a stream', () => {
    // 每一跳都走同一个带 owner 复核的解析入口
    expect(dashboardSource).toMatch(/createSessionPreviewProxy\(\{[\s\S]*?resolve:\s*resolveDashboardSessionPreview\b/);
    expect(dashboardSource).toMatch(/isTargetOwned:\s*\w+\s*=>\s*sessionPreviewTargetStillOwned\(/);
    expect(dashboardSource).toMatch(/onStaleTarget:[\s\S]{0,120}?invalidateStalePreviewTarget\(/);
    // 失效收口：断掉既有预览流 + 收回交互租约；daemon 生命周期事件也触发同一收口
    expect(dashboardSource).toContain('authSessionConnections.closeSessionStreams(sessionId)');
    expect(dashboardSource).toContain('previewInteraction.relockSession(sessionId)');
    expect(dashboardSource).toMatch(/previewTeardownForDaemonEvent\([\s\S]{0,120}?teardownSessionPreview\(/);
    // bindStream：身份存活与目标指纹复核都必须先于登记
    const bindStart = dashboardSource.indexOf('bindStream:');
    expect(bindStart).toBeGreaterThan(-1);
    const registerAt = dashboardSource.indexOf('authSessionConnections.register(', bindStart);
    expect(registerAt).toBeGreaterThan(bindStart);
    const beforeRegister = dashboardSource.slice(bindStart, registerAt);
    expect(beforeRegister).toContain('terminalAuthSessionLive(');
    expect(beforeRegister).toContain('resolveDashboardSessionPreview(');
    expect(beforeRegister).toContain('sameSessionPreviewTarget(');
  });
});
