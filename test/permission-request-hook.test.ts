/**
 * permission-request-hook.test.ts
 *
 * 终端权限确认桥：Claude 弹终端确认框（PermissionRequest）时，`botmux hook` 把它
 * 转成飞书「允许 / 拒绝」卡片；没拿到人工裁决的结局一律按拒绝回给模型，
 * 不再让会话静默挂在飞书侧看不见的确认框上。
 */

import { describe, it, expect } from 'vitest';
import { runHook } from '../src/cli.js';
import claudeCodeAdapter from '../src/core/ask-hook/claude-code.js';
import type { AskResult } from '../src/core/ask-types.js';

const dangerousRmPayload = {
  hook_event_name: 'PermissionRequest',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: {
    command: 'rm -f $SCRATCH_DIR/*.png',
    description: 'Delete scratch screenshots',
  },
  permission_suggestions: [],
};

const FULL_ENV: Record<string, string | undefined> = {
  BOTMUX_SESSION_ID: 'sess_perm_1',
  BOTMUX_CHAT_ID: 'oc_chatxxx',
  BOTMUX_LARK_APP_ID: 'cli_appxxx',
  BOTMUX_ROOT_MESSAGE_ID: 'om_rootxxx',
};

const noOrigin = () => undefined;

function answered(answers: string[][], comment: string | null = null): AskResult {
  return { kind: 'answered', answers, by: 'ou_user1', comment, timedOut: false };
}

async function run(
  result: AskResult | (() => Promise<AskResult>),
  env: Record<string, string | undefined> = FULL_ENV,
  cliId = 'claude-code',
): Promise<{ stdout: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const post = async (body: Record<string, unknown>): Promise<AskResult> => {
    bodies.push(body);
    return typeof result === 'function' ? result() : result;
  };
  const { stdout } = await runHook(dangerousRmPayload, env, post, cliId, async () => null, undefined, noOrigin);
  return { stdout, bodies };
}

function decisionOf(stdout: string): { behavior: string; message?: string } {
  const out = JSON.parse(stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
  return out.hookSpecificOutput.decision;
}

describe('claude adapter — parsePermissionRequest', () => {
  it('把 Bash 权限确认转成一问两选，正文带工具、说明和命令', () => {
    const parsed = claudeCodeAdapter.parsePermissionRequest!(dangerousRmPayload);
    expect(parsed).not.toBeNull();
    const [q] = parsed!.questions;
    expect(parsed!.questions).toHaveLength(1);
    expect(q!.multiSelect).toBe(false);
    expect(q!.options.map((o) => o.key)).toEqual(['allow', 'deny']);
    expect(q!.prompt).toContain('工具：Bash');
    expect(q!.prompt).toContain('说明：Delete scratch screenshots');
    expect(q!.prompt).toContain('命令：rm -f $SCRATCH_DIR/*.png');
  });

  it('超长命令被截断，保证卡片正文不被整段截掉', () => {
    const long = { ...dangerousRmPayload, tool_input: { command: `echo ${'x'.repeat(2000)}` } };
    const prompt = claudeCodeAdapter.parsePermissionRequest!(long)!.questions[0]!.prompt;
    expect(prompt.length).toBeLessThan(512);
    expect(prompt).toContain('…');
  });

  it('AskUserQuestion 的 PermissionRequest 不当成权限确认（仍走提问卡片）', () => {
    const askPayload = { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [] } };
    expect(claudeCodeAdapter.parsePermissionRequest!(askPayload)).toBeNull();
  });

  it('非 PermissionRequest 事件返回 null', () => {
    expect(claudeCodeAdapter.parsePermissionRequest!({ ...dangerousRmPayload, hook_event_name: 'PreToolUse' })).toBeNull();
    expect(claudeCodeAdapter.parsePermissionRequest!(null)).toBeNull();
  });
});

describe('runHook — PermissionRequest 裁决', () => {
  it('点「允许」→ allow directive（不带 message）', async () => {
    const { stdout, bodies } = await run(answered([['allow']]));
    expect(decisionOf(stdout)).toEqual({ behavior: 'allow' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.sessionId).toBe('sess_perm_1');
    expect(bodies[0]!.originKind).toBe('hook');
  });

  it('点「拒绝」→ deny，message 告诉模型别原样重试', async () => {
    const d = decisionOf((await run(answered([['deny']]))).stdout);
    expect(d.behavior).toBe('deny');
    expect(d.message).toMatch(/denied this operation/);
  });

  it('话题里直接回文字 → deny，并把原话带给模型', async () => {
    const d = decisionOf((await run(answered([[]], '换成字面路径再删'))).stdout);
    expect(d.behavior).toBe('deny');
    expect(d.message).toContain('换成字面路径再删');
  });

  it('超时 → deny，message 给出不需确认的改写建议', async () => {
    const d = decisionOf((await run({ kind: 'timedOut' })).stdout);
    expect(d.behavior).toBe('deny');
    expect(d.message).toMatch(/within 10 min/);
    expect(d.message).toContain('${VAR:?}');
  });

  it('卡片失效（invalidated）→ deny，而不是回落到终端确认框', async () => {
    const d = decisionOf((await run({ kind: 'invalidated' } as AskResult)).stdout);
    expect(d.behavior).toBe('deny');
  });

  it('daemon 返回不可重试错误 → deny', async () => {
    const d = decisionOf((await run(async () => { throw new Error('bad_body'); })).stdout);
    expect(d.behavior).toBe('deny');
    expect(d.message).toMatch(/could not deliver/);
  });

  it('默认等 10 分钟；BOTMUX_PERMISSION_TIMEOUT_MS 可覆盖但被钳在 hook 进程超时之内', async () => {
    expect((await run(answered([['allow']]))).bodies[0]!.timeoutMs).toBe(600_000);
    expect((await run(answered([['allow']]), { ...FULL_ENV, BOTMUX_PERMISSION_TIMEOUT_MS: '120000' })).bodies[0]!.timeoutMs).toBe(120_000);
    expect((await run(answered([['allow']]), { ...FULL_ENV, BOTMUX_PERMISSION_TIMEOUT_MS: '99999999' })).bodies[0]!.timeoutMs).toBe(840_000);
    // 24h 的提问超时覆盖不影响权限确认
    expect((await run(answered([['allow']]), { ...FULL_ENV, BOTMUX_ASK_TIMEOUT_MS: '86400000' })).bodies[0]!.timeoutMs).toBe(600_000);
  });

  it('非 botmux 会话（无 env、无 adopt 命中）→ 空输出，终端确认框照常', async () => {
    const { stdout, bodies } = await run(answered([['allow']]), {});
    expect(stdout).toBe('');
    expect(bodies).toHaveLength(0);
  });

  it('workflow 子 agent → 空输出（保持既有 passthrough 语义）', async () => {
    const { stdout, bodies } = await run(answered([['allow']]), { ...FULL_ENV, BOTMUX_WORKFLOW: '1' });
    expect(stdout).toBe('');
    expect(bodies).toHaveLength(0);
  });

  it('未实现 parsePermissionRequest 的 adapter（codex）→ 空输出，不发卡片', async () => {
    const { stdout, bodies } = await run(answered([['allow']]), FULL_ENV, 'codex');
    expect(stdout).toBe('');
    expect(bodies).toHaveLength(0);
  });
});
