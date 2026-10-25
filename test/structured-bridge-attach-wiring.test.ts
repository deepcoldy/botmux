/**
 * Cursor attach baselines in worker.ts (codexBridgeAttach / cursorBridgeAttach).
 *
 * The worker cannot be imported without starting its IPC loop, and the attach
 * flow lives in its module closure. The baseline algorithm itself is covered
 * behaviourally in cursor-transcript.test.ts; per-CLI bridge parameters are
 * covered in structured-bridge-spec.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

/** Body of a top-level `function name(` up to the next top-level declaration. */
function topLevelFunction(name: string): string {
  const syncStart = source.indexOf(`\nfunction ${name}(`);
  const asyncStart = source.indexOf(`\nasync function ${name}(`);
  const start = syncStart >= 0 ? syncStart : asyncStart;
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = /\n(?:export )?(?:async )?(?:function|type|interface|class|const|let) /g;
  next.lastIndex = start + 1;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(start, end);
}

/** Source slice of the brace-balanced block opened at `anchor` (e.g. `if (x) {`). */
function bracedBlockFrom(anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `worker.ts 里找不到 ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`unbalanced block at ${anchor}`);
}

describe('cursor attach baseline is footer-aware', () => {
  // 源码结构护栏(K3)：cursor-agent 每轮在 transcript 尾部追加 turn_ended footer，下一轮先截掉它再从
  // 原位置重写。attach 基线若停在 footer 之后（EOF / stat size / baselineJsonlCursor），attach 后第一轮
  // 的 user 行会被切成残片、指纹归因失败，这一轮的回复就发不出去（#2009，7b4c83ed47）。
  // codexBridgeAttach 在 worker 闭包里没有 seam，只能在源码里核对 cursor 的两条基线
  // （adopt 的 skip-tail、零注入 resume 的 baseline-existing）都取自 baselineCursorTranscript 快照。
  it('both cursor baselines (adopt skip-tail and zero-prompt resume) come from the footer-aware snapshot', () => {
    const attach = topLevelFunction('codexBridgeAttach');
    expect(attach).toMatch(/baselineCursorTranscript\([^)]*skipTail:\s*true/);
    expect(attach.match(/baselineCursorTranscript\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Adopt reaches the skip-tail branch only through cursorBridgeAttach's mode mapping.
    expect(topLevelFunction('cursorBridgeAttach')).toContain("'baseline-existing-skip-tail'");
  });
});

// 源码结构护栏(K3)：无头 RPC 首轮在远程 viewer 起来之前就在 app-server 上执行、不经过 writeInput，
// spawn 时的 attach 是唯一能从 rollout 第 0 字节绑定该会话的边界；漏绑会导致首轮 user/turn_started
// 不进队列，drainEmittable 弹不出队头，回复永久卡 pending。三处接线都在 worker 闭包里，没有行为
// seam，只能在源码里钉住 spawn 绑定、deferral 释放后即时 drain、TRAE final 直接 emit 的存在与顺序。
describe('fresh TRAE RPC bridge attachment', () => {
  it('binds the app-server thread when no persisted CLI session id exists yet', () => {
    const spawn = topLevelFunction('spawnCli');
    expect(spawn).toContain('cliSessionId: effectiveCliSessionId ?? opts.rpcThreadId');
  });

  it('captures the RPC thread before spawn and drains after releasing a fast terminal', () => {
    expect(source).toContain('const rpcThreadIdAtSpawn = rpcDecision.engaged ? remoteThreadId : undefined');
    expect(source).toContain('rpcThreadId: rpcThreadIdAtSpawn');
    const deferral = bracedBlockFrom('if (deferredFreshRpcTurn) {');
    const release = deferral.indexOf('releaseRpcTurnTerminalDeferral(');
    const drain = deferral.indexOf('codexBridgeDrainAndMaybeEmit({ signalIdle: false })');
    expect(release).toBeGreaterThan(-1);
    expect(drain, 'drain 必须在本轮终态延迟释放之后').toBeGreaterThan(release);
  });

  it('emits a structured final without waiting for TUI ready detection', () => {
    const ingest = topLevelFunction('codexBridgeIngest');
    expect(ingest).toContain(
      "if (structuredBridgeIs('traex') && hasAssistantFinal) emitReadyCodexTurns()",
    );
  });
});
