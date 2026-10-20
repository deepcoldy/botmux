import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSpecFor } from '../src/adapters/cli/registry.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function sliceBetween(start: string, end: string): string {
  const at = workerSource.indexOf(start);
  expect(at, `worker.ts 里找不到 ${start}`).toBeGreaterThanOrEqual(0);
  const until = workerSource.indexOf(end, at);
  expect(until, `worker.ts 里 ${start} 之后找不到 ${end}`).toBeGreaterThan(at);
  return workerSource.slice(at, until);
}

describe('TRAE structured-bridge drain', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'traex-bridge-drain-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A turn whose only agent text is deliberate-silence commentary, closed by task_complete. */
  function sentinelOnlyRollout(name: string): string {
    const path = join(dir, `${name}.jsonl`);
    const turnId = '00000000-0000-7000-8000-000000000010';
    const at = (s: number) => `2000-01-01T00:00:0${s}.000Z`;
    writeFileSync(path, [
      { timestamp: at(1), type: 'event_msg', payload: { type: 'user_message', message: 'do the work', images: [], local_images: [], text_elements: [] } },
      { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: '已回报。BOTMUX_NO_REPLY', phase: 'commentary', memory_citation: null } },
      { timestamp: at(3), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, completed_at: 946_684_803, duration_ms: 1_000 } },
    ].map(record => `${JSON.stringify(record)}\n`).join(''));
    return path;
  }

  it('closes the turn on task_complete and keeps adopt-mode text verbatim (no synthesised sentinel)', () => {
    const spec = bridgeSpecFor('traex')!;
    const adopt = spec.drain(sentinelOnlyRollout('adopt'), 0, { adoptMode: true, state: undefined });
    expect(adopt.events.at(-1)).toEqual(expect.objectContaining({ kind: 'assistant_final', text: '' }));
    const managed = spec.drain(sentinelOnlyRollout('managed'), 0, { adoptMode: false, state: undefined });
    expect(managed.events.at(-1)).toEqual(expect.objectContaining({ kind: 'assistant_final', text: 'BOTMUX_NO_REPLY' }));
  });
});

describe('TRAE worker guards without a behavioural seam', () => {
  // 源码结构护栏(K2)：engageCodexRpc 在 worker.ts 闭包里组装 RPC app-server（真正跑模型与 shell 工具的
  // 进程）的 env，没有行为 seam。CLAUDE.md「飞书 owner 身份边界」：owner 必须在可配置 env（per-bot env）
  // 合并之后由 applySessionOwnerEnv 注入并冻结，配置不能覆盖它；app secret 不得进入这个子进程。
  it('pins the RPC app-server owner after the per-bot env merge and never hands it the app secret', () => {
    const envSetup = sliceBetween('async function engageCodexRpc', 'new CodexRpcEngine({');
    const merged = envSetup.lastIndexOf('botInjectedEnv(');
    const owner = envSetup.indexOf('applySessionOwnerEnv(engineEnv');
    expect(merged).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(merged);
    expect(envSetup.indexOf('Object.assign(engineEnv', owner)).toBe(-1);
    expect(envSetup).not.toContain('BOTMUX_LARK_APP_SECRET');
  });

  // 源码结构护栏(K2)：TRAE 的 history.jsonl 是同一 TRAE_HOME 下所有 pane 共享的全局文件，sibling pane
  // 的同文本提交能让 worker 拿到 foreign session id。#748：把 bridge 绑到某个 rollout（并持久化 resume
  // 目标）之前，必须先用 pid-fd 所有权闸确认这个 id 属于本 pid，否则 resume 目标被污染、回复从别的会话
  // harvest。三个绑定点（rotation / initial attach / adopt poller）都在 worker.ts 闭包里没有行为 seam；
  // 闸背后的纯判定 traexHistorySidIsOwned 在 traex-transcript.test.ts 里有行为测试。
  it('runs the pid ownership gate before every TRAE session binding', () => {
    expect(sliceBetween('function traexHistorySidOwnedByCurrentPid', '\n}\n')).toContain('traexHistorySidIsOwned(');

    const notify = sliceBetween('function codexBridgeNotifyCliSessionId', 'function maybeFollowGrokSessionRotationViaPid');
    const rotation = notify.slice(notify.indexOf("if (structuredBridgeIs('traex'))"));
    const rotationGate = rotation.indexOf('traexHistorySidOwnedByCurrentPid(cliSessionId)');
    expect(rotationGate).toBeGreaterThan(-1);
    expect(rotationGate).toBeLessThan(rotation.indexOf('codexBridgeDetachFile('));

    const initialAttach = notify.lastIndexOf('resolveFileBridgePath(lastInitConfig?.cliId');
    expect(initialAttach).toBeGreaterThan(-1);
    const initialGate = notify.lastIndexOf('traexHistorySidOwnedByCurrentPid(cliSessionId)', initialAttach);
    expect(initialGate).toBeGreaterThan(rotationGate);

    expect(sliceBetween('const attachOk = ', 'if (path && attachOk)')).toContain('traexHistorySidOwnedByCurrentPid(sid)');
  });
});
