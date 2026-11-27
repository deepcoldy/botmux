import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import type { CliAdapter, CliModelDetectionOptions } from '../src/adapters/cli/types.js';
import { createDispatchModelDetector } from '../src/cli/dispatch-model-probe.js';
import { detectClaudeModels } from '../src/adapters/cli/claude-model-catalog.js';

function adapter(detect: (options?: CliModelDetectionOptions) => Promise<readonly string[] | null>): CliAdapter {
  return { detectModels: detect } as CliAdapter;
}

const sourceEnv = {
  PATH: '/bin',
  BOTMUX_SESSION_ID: 'source-session',
  ANTHROPIC_BASE_URL: 'https://source-gateway.invalid',
  ANTHROPIC_AUTH_TOKEN: 'source-token',
  CLAUDE_CONFIG_DIR: '/source/profile',
};

function target(shape: Partial<BotConfig> = {}): BotConfig {
  return { larkAppId: 'cli_dispatch_target', cliId: 'claude-code', ...shape } as BotConfig;
}

describe('dispatch target model detector', () => {
  it('Claude wrapper 保持 fail-closed，且不调用原生 detector', async () => {
    const detect = vi.fn(async () => ['must-not-be-read']);
    const detector = createDispatchModelDetector({
      target: target({
        wrapperCli: 'aiden x claude',
        env: { ANTHROPIC_BASE_URL: 'https://target.invalid', ANTHROPIC_AUTH_TOKEN: 'target-token' },
      }),
      callerEnv: sourceEnv,
      adapter: adapter(detect),
    });
    await expect(detector()).resolves.toBeNull();
    expect(detect).not.toHaveBeenCalled();
  });

  it.each([
    ['目标使用默认官方身份', {}],
    ['目标只有 base，没有可信 token', { env: { ANTHROPIC_BASE_URL: 'https://target.invalid' } }],
  ])('%s 时不借用源会话身份', async (_name, shape) => {
    const detect = vi.fn(async () => ['source-model']);
    const detector = createDispatchModelDetector({
      target: target(shape), callerEnv: sourceEnv, adapter: adapter(detect),
    });
    await expect(detector()).resolves.toBeNull();
    expect(detect).not.toHaveBeenCalled();
  });

  it('显式目标 profile 可探测，但源 provider/data-root 不进入适配器', async () => {
    let seen: CliModelDetectionOptions | undefined;
    const detector = createDispatchModelDetector({
      target: target({ cliConfigDir: '/target/profile' }),
      callerEnv: sourceEnv,
      adapter: adapter(async options => {
        seen = options;
        return ['target-profile-model'];
      }),
    });
    await expect(detector()).resolves.toEqual(['target-profile-model']);
    expect(seen?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(seen?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(seen?.allowImplicitConfigRoot).toBe(true);
  });

  it('完整目标 overlay 只向目标端点发目标凭据，并禁止隐式宿主根', async () => {
    const calls: { url: string; authorization?: string; apiKey?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, authorization: headers.authorization, apiKey: headers['x-api-key'] });
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [{ id: 'target-model' }] }),
      } as Response;
    }) as unknown as typeof fetch;
    let seen: CliModelDetectionOptions | undefined;
    const detector = createDispatchModelDetector({
      target: target({ env: {
        ANTHROPIC_BASE_URL: 'https://target.example',
        ANTHROPIC_AUTH_TOKEN: 'target-token',
      } }),
      callerEnv: sourceEnv,
      adapter: adapter(options => {
        seen = options;
        return detectClaudeModels({ ...options, fetchImpl });
      }),
    });

    await expect(detector()).resolves.toEqual(['target-model']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://target.example/v1/models',
      authorization: 'Bearer target-token',
      apiKey: 'target-token',
    });
    expect(seen?.allowImplicitConfigRoot).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('source-token');
  });

  it('worker 会重定向目标数据根时，即使 overlay 完整也不从源会话探测', async () => {
    const detect = vi.fn(async () => ['must-not-be-read']);
    const detector = createDispatchModelDetector({
      target: target({ sandbox: true, env: {
        ANTHROPIC_BASE_URL: 'https://target.invalid', ANTHROPIC_AUTH_TOKEN: 'target-token',
      } }),
      callerEnv: sourceEnv,
      adapter: adapter(detect),
    });
    await expect(detector()).resolves.toBeNull();
    expect(detect).not.toHaveBeenCalled();
  });

  it('其他 CLI 保留原有 dispatch 环境透传', async () => {
    let seen: CliModelDetectionOptions | undefined;
    const detector = createDispatchModelDetector({
      target: target({ cliId: 'codex' }),
      callerEnv: { ...sourceEnv, CODEX_HOME: '/caller/codex' },
      adapter: adapter(async options => {
        seen = options;
        return ['codex-model'];
      }),
    });
    await expect(detector()).resolves.toEqual(['codex-model']);
    expect(seen?.env?.CODEX_HOME).toBe('/caller/codex');
  });
});
