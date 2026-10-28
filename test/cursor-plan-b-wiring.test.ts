import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-level wiring for plan B (#932) ON TOP of #2009's footer-aware drain
// and baseline. #2009 already guarantees attach never needs to wait on an
// unclassifiable tail (baselineCursorTranscript decides deterministically for
// every EOF shape; only a missing file keeps the identity pending, which the
// generic poller resolves), so the remaining plan-B wiring is: ordinary spawn
// activation, the busy-tick attribution-lease refresh (argv first turn +
// type-ahead successors, hard cap), the scratch-sandbox suppression, and
// in-binding chat rotation / observer correction.

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('cursor plan B worker wiring (on #2009)', () => {
  // 源码结构护栏(K3)：cursor 的「忘 botmux send 自动补发」兜底链路埋在
  // worker.ts 的闭包里（timer tick / codexBridgeFallbackActive / spawnCli /
  // notify 分支 / 观察者回调），没有可导出的行为入口；真机回归（第 2 轮起
  // footer 截断归因静默、argv 首轮 20s 被剪、scratch 下读不到 mirror 却静
  // 默开兜底）在纯单测里不可达。这里钉住四处必须同时成立的源码不变量
  // （忙时刷租约+硬上限、scratch 闸门的三处读写、spawn 链接链、in-binding
  // 轮转重绑），任一环节被未来重构误删即红，与 #2009 的 attach-wiring
  // K3 护栏同形态。
  it('poller refreshes queued leases while busy (non-adopt) with a hard since-mark cap', () => {
    const tickStart = source.indexOf("if (structuredBridgeIs('cursor')) {", source.indexOf('function codexBridgeStartTimer'));
    const tickBody = source.slice(tickStart, source.indexOf("if (isPromptReady) emitReadyCodexTurns();", tickStart));
    // Refreshes EVERY queued head (argv confirmed first turn + successors).
    expect(tickBody).toContain('codexBridgeQueue.refreshUnstartedHeadAttributionLease(Date.now(), CURSOR_BUSY_REFRESH_MAX_MS)');
    // Only while the CLI is busy and not in adopt mode.
    expect(tickBody).toContain('!isPromptReady && !lastInitConfig?.adoptMode');
    expect(source).toContain('const CURSOR_BUSY_REFRESH_MAX_MS = 120_000;');
  });

  // 源码结构护栏(K3)：兜底链路埋在 worker.ts 闭包无行为入口，钉住源码不变量（理由见 describe 上方总注）。
  it('codexBridgeFallbackActive suppresses cursor under the scratch COW sandbox for non-adopt spawns', () => {
    const body = functionSlice('codexBridgeFallbackActive', 'isExistingAppServerSharedBridge');
    expect(body).toContain("lastInitConfig?.cliId === 'cursor'");
    expect(body).toContain("lastInitConfig?.adoptMode !== true");
    expect(body).toContain("lastResolvedSandboxMode === 'scratch'");
  });

  // 源码结构护栏(K3)：兜底链路埋在 worker.ts 闭包无行为入口，钉住源码不变量（理由见 describe 上方总注）。
  it('spawnCli retains the resolved sandbox mode; stopCodexBridge clears it', () => {
    expect(source).toContain('lastResolvedSandboxMode = sandboxMode;');
    const stopBody = functionSlice('stopCodexBridge', 'retainSecondaryPathIfStillReferenced');
    expect(stopBody).toContain('lastResolvedSandboxMode = undefined;');
  });

  // 源码结构护栏(K3)：兜底链路埋在 worker.ts 闭包无行为入口，钉住源码不变量（理由见 describe 上方总注）。
  it('spawn bridge chain keys off fallbackActive alone (zeroPromptOnly spec field is gone)', () => {
    expect(source).toContain('spawnBridge && codexBridgeFallbackActive()');
    expect(source).not.toContain('spawnBridge.zeroPromptOnly');
  });

  // 源码结构护栏(K3)：兜底链路埋在 worker.ts 闭包无行为入口，钉住源码不变量（理由见 describe 上方总注）。
  it('a re-reported DIFFERENT cursor chat while bound drains and re-attaches (rotation / observer correction)', () => {
    const start = source.indexOf('function codexBridgeNotifyCliSessionId');
    const body = source.slice(start, start + 10000);
    const cursorBound = body.slice(body.indexOf("if (structuredBridgeIs('cursor')) {", body.indexOf('if (codexBridgeRolloutPath)')));
    // Same chat → no-op; different chat → drain retired, detach, re-attach.
    expect(cursorBound).toContain('currentChat.toLowerCase() === cliSessionId.toLowerCase()');
    expect(cursorBound).toContain('codexBridgeDetachFile()');
    expect(cursorBound).toContain('Cursor pre-rotation bridge drain failed');
    // 非 adopt 的不同 chat 重绑必须 fresh-empty（在盘字节是当前 live turn，
    // baseline 越过会让该轮永不起始）；adopt 仍走 cursorBridgeAttach。
    expect(cursorBound).toContain("if (lastInitConfig?.adoptMode) cursorBridgeAttach(next, cursorLateAttachMode(next));");
    expect(cursorBound).toContain("else codexBridgeAttach(next, 'fresh-empty');");
  });

  // 源码结构护栏(K3)：replyDelivery=transcript 的 resolved-sandbox 复核埋在
  // spawnCli 巨型闭包里无导出行为入口（与零注入权威门同形），钉住「解析后沙箱
  // 不支持转写 → 冻结值降级 send + warn」必须存在，否则 BOTMUX_SANDBOX=scratch
  // 机器开关下 cursor 会系统提示改口不 send 而采集关闭 = 整轮静默。
  it('spawnCli re-validates the frozen replyDelivery=transcript against the resolved sandbox mode and degrades to send', () => {
    const start = source.indexOf('function spawnCli');
    expect(start).toBeGreaterThanOrEqual(0);
    const spawnBody = source.slice(start, start + 60000);
    const anchor = 'lastResolvedSandboxMode = sandboxMode;';
    const predicate = 'supportsTranscriptReplyDeliveryForBot(cfg.cliId, { sandbox: sandboxMode })';
    const predAt = spawnBody.indexOf(predicate);
    expect(predAt).toBeGreaterThan(spawnBody.indexOf(anchor));
    // 切片从 if 条件行起（predicate 在跨行 && 的第二行），到其后的 scratch 平台
    // throw 止：只切 gate 块本身，避免命中 spawnCli 别处的同名字符串。
    const gateStart = spawnBody.lastIndexOf("if (cfg.replyDelivery === 'transcript'", predAt);
    expect(gateStart).toBeGreaterThanOrEqual(0);
    const gate = spawnBody.slice(gateStart, spawnBody.indexOf('scratchRequested && process.platform', predAt));
    expect(gate).toContain("cfg.replyDelivery = 'send';");
    expect(gate).toContain('warnedTranscriptDeliveryDegraded');
    // 降级必须带 transcript 前提，不能误伤 send。
    expect(gate).toContain("cfg.replyDelivery === 'transcript'");
    // 重启/替换 spawn 传的是 {...lastInitConfig} 浅克隆：同会话的存储配置也必须
    // 翻成 send，否则 replyDeliveryMode() 在整个代次里仍是 transcript。
    expect(gate).toContain('lastInitConfig.sessionId === cfg.sessionId');
    expect(gate).toContain("lastInitConfig.replyDelivery = 'send';");
  });

  // 源码结构护栏(K3)：兜底链路埋在 worker.ts 闭包无行为入口，钉住源码不变量（理由见 describe 上方总注）。
  it('the observed chatId binds the bridge in EVERY mode (the default-mode no-op comment is gone)', () => {
    const start = source.indexOf('function observeCursorCliSessionId');
    const end = source.indexOf('function observeAntigravityCliSessionId', start);
    const body = source.slice(start, end);
    expect(body).toContain('codexBridgeNotifyCliSessionId(chatId)');
    expect(body).not.toContain('No-op in default mode');
  });
});
