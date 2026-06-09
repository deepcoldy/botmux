/**
 * cmd-hook.test.ts
 *
 * 测试 runHook 核心逻辑（依赖注入方式，不依赖真实 daemon / env / stdin）。
 * cmdHook 本身仅作薄包装（读 stdin + 调 runHook），不在本文件中直接测试。
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runHook } from '../src/cli.js';
import type { AskResult } from '../src/core/ask-types.js';

// ── Claude AskUserQuestion payload fixture ─────────────────────────────────────

const claudeAskPayload = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: '继续还是取消？',
        multiSelect: false,
        options: [{ label: '继续' }, { label: '取消' }],
      },
    ],
  },
};

// 非 askUserQuestion 的 Claude payload（PreToolUse）
const claudePreToolPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
};

// 完整的 botmux env
const FULL_ENV: Record<string, string | undefined> = {
  BOTMUX_SESSION_ID: 'sess_test_1',
  BOTMUX_CHAT_ID: 'oc_chatxxx',
  BOTMUX_LARK_APP_ID: 'cli_appxxx',
  BOTMUX_ROOT_MESSAGE_ID: 'om_rootxxx',
};

// 构造一个正常返回 answered 的 postAskFn stub
function makeAnsweredStub(answers: string[][]): () => Promise<AskResult> {
  return async () => ({
    kind: 'answered',
    answers: answers as ReadonlyArray<ReadonlyArray<string>>,
    by: 'ou_user1',
    comment: null,
    timedOut: false,
  });
}

// 构造一个抛出错误的 postAskFn stub
function makeThrowingStub(msg = 'daemon unreachable'): () => Promise<AskResult> {
  return async () => {
    throw Object.assign(new Error(msg), { exitCode: 3 });
  };
}

// ── 测试 ───────────────────────────────────────────────────────────────────────

describe('runHook', () => {
  describe('(a) Claude AskUserQuestion + answered stub → stdout 含答案', () => {
    it('formatAnswer 结果写入 stdout', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      expect(result.stdout).toBeTruthy();
      // 输出应为合法 JSON
      const directive = JSON.parse(result.stdout);
      // Claude directive 应包含 hookSpecificOutput
      expect(JSON.stringify(directive)).toContain('继续');
    });
  });

  describe('(a2) 自定义回复（comment）→ stdout 含自定义文字', () => {
    it('answered 含 comment + 空 answers → directive 用 comment 作答', async () => {
      const customStub = async (): Promise<AskResult> => ({
        kind: 'answered',
        answers: [[]],
        by: 'ou_user1',
        comment: '我想先灰度 10% 再全量',
        timedOut: false,
      });
      const result = await runHook(claudeAskPayload, FULL_ENV, customStub, 'claude-code');
      expect(result.stdout).toBeTruthy();
      const answers = JSON.parse(result.stdout).hookSpecificOutput.decision.updatedInput.answers as Record<string, string>;
      expect(answers['继续还是取消？']).toBe('我想先灰度 10% 再全量');
    });
  });

  describe('(b) postAskFn 抛错 → 输出 passthrough，不抛出', () => {
    it('任何 postAsk 错误均优雅放行', async () => {
      const stub = makeThrowingStub('daemon unreachable');
      // 不应抛出
      let result: Awaited<ReturnType<typeof runHook>>;
      expect(async () => {
        result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      }).not.toThrow();

      result = await runHook(claudeAskPayload, FULL_ENV, stub, 'claude-code');
      // 输出应为 passthrough directive（behavior=allow + 空 answers）
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });
  });

  describe('(c) 非 askUserQuestion payload → passthrough', () => {
    it('PreToolUse payload → parseQuestions 返回 null → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudePreToolPayload, FULL_ENV, stub, 'claude-code');
      // 应为 passthrough（stub 不应被调用）
      expect(result.stdout).toBe('');
    });
  });

  describe('env 缺失 → passthrough 放行', () => {
    // 注：runHook 第 5 参数是可选的 resolveAdoptRouteFn。
    // 这里传 null-returning stub，确保测试不依赖真实 daemon 环境，
    // 并且仍然覆盖 "adopt 也找不到 → passthrough" 的分支。
    const nullAdoptResolver = async () => null;

    it('BOTMUX_SESSION_ID 缺失 → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const env = { ...FULL_ENV, BOTMUX_SESSION_ID: undefined };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code', nullAdoptResolver);
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });

    it('BOTMUX_CHAT_ID 缺失 → passthrough', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const env = { ...FULL_ENV, BOTMUX_CHAT_ID: undefined };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code', nullAdoptResolver);
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });
  });

  describe('env 缺失 + adopt 路由命中 → 路由到 adopt 会话', () => {
    const adoptRoute = {
      sessionId: 's-adopt',
      chatId: 'c-adopt',
      larkAppId: 'a-adopt',
      rootMessageId: 'om_x',
    };

    it('adopt 命中 → postAskFn 收到 adopt 会话的 body', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const captureStub = async (body: Record<string, unknown>) => {
        capturedBody = body;
        return { kind: 'answered' as const, answers: [['yes']], by: 'ou_u', comment: null, timedOut: false };
      };
      const adoptResolver = async () => adoptRoute;
      // env 全缺失
      const env: Record<string, string | undefined> = {};
      const result = await runHook(claudeAskPayload, env, captureStub, 'claude-code', adoptResolver);
      // body 应使用 adopt 路由信息
      expect(capturedBody?.sessionId).toBe('s-adopt');
      expect(capturedBody?.larkAppId).toBe('a-adopt');
      expect(capturedBody?.chatId).toBe('c-adopt');
      expect(capturedBody?.rootMessageId).toBe('om_x');
      // 应输出答案 directive（非空）
      expect(result.stdout).toBeTruthy();
      const directive = JSON.parse(result.stdout);
      expect(JSON.stringify(directive)).toContain('yes');
    });

    it('adopt 命中 → stdout 含 answer directive', async () => {
      const captureStub = async (body: Record<string, unknown>) => {
        void body;
        return { kind: 'answered' as const, answers: [['yes']], by: 'ou_u', comment: null, timedOut: false };
      };
      const adoptResolver = async () => adoptRoute;
      const env: Record<string, string | undefined> = {};
      const result = await runHook(claudeAskPayload, env, captureStub, 'claude-code', adoptResolver);
      expect(result.stdout).toBeTruthy();
    });
  });

  describe('env 缺失 + adopt 路由返回 null → passthrough', () => {
    // Codex 钉桩：祖先里有非 adopt PID、daemon 全 404（resolver 返回 null）时，
    // 必须既不调用 postAsk、stdout 又为空——确保"真·非 botmux 会话"完全不受影响。
    it('adopt 未命中 → postAsk 不被调用 且 stdout === ""', async () => {
      const postAsk = vi.fn(makeAnsweredStub([['继续']]));
      const nullAdoptResolver = async () => null;
      const env: Record<string, string | undefined> = {};
      const result = await runHook(claudeAskPayload, env, postAsk, 'claude-code', nullAdoptResolver);
      expect(postAsk).not.toHaveBeenCalled();
      expect(result.stdout).toBe('');
    });
  });

  describe('BOTMUX_WORKFLOW=1 → passthrough（不弹 UI）', () => {
    it('workflow gate → passthrough', async () => {
      const stub = vi.fn(makeAnsweredStub([['继续']]));
      const env = { ...FULL_ENV, BOTMUX_WORKFLOW: '1' };
      const result = await runHook(claudeAskPayload, env, stub, 'claude-code');
      // stub 不应被调用
      expect(stub).not.toHaveBeenCalled();
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });
  });

  describe('未知 cliId → stdout 为空字符串', () => {
    it('getHookAdapter 返回 undefined → stdout=""', async () => {
      const stub = makeAnsweredStub([['继续']]);
      const result = await runHook(claudeAskPayload, FULL_ENV, stub, 'unknown-cli-xyz');
      expect(result.stdout).toBe('');
    });
  });

  describe('timedOut / invalidated → passthrough', () => {
    it('timedOut → passthrough', async () => {
      const timedOutStub = async (): Promise<AskResult> => ({
        kind: 'timedOut',
        selected: null,
        by: null,
        comment: null,
        timedOut: true,
      });
      const result = await runHook(claudeAskPayload, FULL_ENV, timedOutStub, 'claude-code');
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });

    it('invalidated → passthrough', async () => {
      const invalidatedStub = async (): Promise<AskResult> => ({
        kind: 'invalidated',
        reason: 'test_invalidated',
        selected: null,
        by: null,
        comment: null,
        timedOut: false,
      });
      const result = await runHook(claudeAskPayload, FULL_ENV, invalidatedStub, 'claude-code');
      // 回归（Codex P1.1）：放行 = 空 stdout，绝不输出 directive。直接断言空串，
      // 不与实现的 passthrough() 比较，避免实现回退时测试跟着移动。
      expect(result.stdout).toBe('');
    });
  });

  describe('BOTMUX_ASK_TIMEOUT_MS env', () => {
    it('有效正整数 → 覆盖默认 timeout 传给 postAskFn', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const captureStub = async (body: Record<string, unknown>): Promise<AskResult> => {
        capturedBody = body;
        return { kind: 'answered', answers: [['继续']], by: 'ou_u', comment: null, timedOut: false };
      };
      const env = { ...FULL_ENV, BOTMUX_ASK_TIMEOUT_MS: '7200000' };
      await runHook(claudeAskPayload, env, captureStub, 'claude-code');
      expect(capturedBody?.timeoutMs).toBe(7_200_000);
    });

    it('无效值 → 使用默认 3600000', async () => {
      let capturedBody: Record<string, unknown> | undefined;
      const captureStub = async (body: Record<string, unknown>): Promise<AskResult> => {
        capturedBody = body;
        return { kind: 'answered', answers: [['继续']], by: 'ou_u', comment: null, timedOut: false };
      };
      const env = { ...FULL_ENV, BOTMUX_ASK_TIMEOUT_MS: 'not_a_number' };
      await runHook(claudeAskPayload, env, captureStub, 'claude-code');
      expect(capturedBody?.timeoutMs).toBe(3_600_000);
    });
  });

  // 语义③（Codex 建议）：workflow subagent 里 `botmux ask` 必须被拒绝——审批走
  // humanGate/decision 进 event log，不能用 ad-hoc ask 绕过。cmdAsk 用 process.exit(2)
  // 拒绝，未导出、无法直接单测，这里用源码断言钉住该 gate，防被静默移除。
  describe('语义③：workflow 里 botmux ask 拒绝（源码 gate 守卫）', () => {
    it('cmdAsk 含 BOTMUX_WORKFLOW gate + exit 2 拒绝', () => {
      const src = readFileSync(
        new URL('../src/cli.ts', import.meta.url),
        'utf-8',
      );
      const cmdAskIdx = src.indexOf('async function cmdAsk(');
      expect(cmdAskIdx).toBeGreaterThanOrEqual(0);
      // gate 在 cmdAsk 函数体起始处
      const region = src.slice(cmdAskIdx, cmdAskIdx + 1500);
      expect(region).toContain("process.env.BOTMUX_WORKFLOW === '1'");
      expect(region).toContain('process.exit(2)');
      expect(region.toLowerCase()).toContain('refused');
    });
  });

  describe('workflow 里举手走 send 自身的 gate（attention 已并入 send，不再是独立命令）', () => {
    it('cmdAttention 已移除，send --attention 由 send 的 BOTMUX_WORKFLOW gate 覆盖', () => {
      const src = readFileSync(
        new URL('../src/cli.ts', import.meta.url),
        'utf-8',
      );
      // 旧的独立举手入口已删除——举手并入 `botmux send --attention`。
      expect(src.includes('async function cmdAttention(')).toBe(false);
      // send 顶部已有 workflow-subagent gate（subagent 里 send 直接 refused），
      // --attention 是 send 的一个 flag，因此天然被同一道 gate 覆盖。
      const cmdSendIdx = src.indexOf('async function cmdSend(');
      expect(cmdSendIdx).toBeGreaterThanOrEqual(0);
      const region = src.slice(cmdSendIdx, cmdSendIdx + 1500);
      expect(region).toContain("process.env.BOTMUX_WORKFLOW === '1'");
      expect(region).toContain('process.exit(2)');
    });
  });
});
