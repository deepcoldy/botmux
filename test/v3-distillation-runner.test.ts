import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readLinuxBootIdentity,
  readProcessStartIdentity,
} from '../src/core/session-marker.js';

import {
  V3DistillationRunnerError,
  buildV3DistillationModelPrompt,
  buildV3DistillationSystemPrompt,
  runV3DistillationModel,
  sweepAbandonedV3DistillationScratch,
  type V3DistillationStructuredInvocation,
} from '../src/workflows/v3/distillation-runner.js';
import type { V3DistillationModelFieldV1 } from '../src/workflows/v3/distillation-compiler.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';

const roots: string[] = [];
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-api-key';
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
});

function fixture(): { root: string; scratchParent: string } {
  const root = mkdtempSync(join(tmpdir(), 'v3-distill-runner-test-'));
  roots.push(root);
  const scratchParent = join(root, 'scratch');
  mkdirSync(scratchParent, { recursive: true });
  return { root, scratchParent };
}

function bot(cliId: BotSnapshot['cliId'] = 'claude-code'): BotSnapshot {
  return {
    larkAppId: 'cli_test_distiller',
    cliId,
    model: 'test-model',
    workingDir: '/private/project-that-must-not-be-exposed',
  };
}

const FIELDS: V3DistillationModelFieldV1[] = [{
  ref: 'field-001',
  path: '/dagTemplate/nodes/0/goal',
  category: 'goal',
  nodeOrdinal: 1,
  text: 'Create report for Alpha',
}];

function response(candidate: Record<string, unknown> = {
  path: FIELDS[0]!.path,
  literal: 'Alpha',
  occurrence: 0,
  type: 'string',
}): string {
  return JSON.stringify({
    structured_output: { schemaVersion: 1, candidates: [candidate] },
  });
}

describe('runV3DistillationModel', () => {
  it('uses a bare no-tool structured invocation with a private minimal environment', async () => {
    const dirs = fixture();
    const managedPolicyRoot = join(dirs.root, 'managed-policy-empty');
    mkdirSync(managedPolicyRoot, { mode: 0o755 });
    let invocation: V3DistillationStructuredInvocation | undefined;
    const invokeStructuredModel = vi.fn(async (value: V3DistillationStructuredInvocation) => {
      invocation = value;
      expect(statSync(value.cwd).mode & 0o777).toBe(0o700);
      return response();
    });
    process.env.BOTMUX_PRIVATE_TEST_SENTINEL = 'must-not-pass';
    process.env.UNRELATED_SECRET = 'must-not-pass';
    try {
      const suggestion = await runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: {
          ANTHROPIC_API_KEY: 'provider-test-key',
          CLAUDE_CONFIG_DIR: '/provider-must-not-redirect-auth',
          BOTMUX_OTHER_SECRET: 'must-not-pass',
          RANDOM_SECRET: 'must-not-pass',
        },
        timeoutMs: 10_000,
      }, {
        invokeStructuredModel,
        adapterBin: process.execPath,
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        managedPolicyRoot,
      });

      expect(suggestion).toEqual({
        schemaVersion: 1,
        candidates: [{
          path: FIELDS[0]!.path,
          literal: 'Alpha',
          occurrence: 0,
          type: 'string',
        }],
      });
      expect(invokeStructuredModel).toHaveBeenCalledOnce();
      expect(invocation).toBeDefined();
      expect(invocation!.bin).toBe('/usr/bin/bwrap');
      const args = invocation!.args;
      expect(args).toContain('--unshare-pid');
      expect(args).toContain('--die-with-parent');
      expect(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3))
        .toEqual(['--bind', invocation!.cwd, invocation!.cwd]);
      expect(args.slice(args.indexOf('--tmpfs', args.indexOf('--tmpfs') + 1)))
        .toContain(managedPolicyRoot);
      expect(args).toContain('--bare');
      expect(args).toContain('--safe-mode');
      expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2))
        .toEqual(['--setting-sources', '']);
      expect(args).toContain('--disable-slash-commands');
      expect(args).toContain('--strict-mcp-config');
      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
      expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2))
        .toEqual(['--mcp-config', '{"mcpServers":{}}']);
      expect(invocation!.env.ANTHROPIC_API_KEY).toBe('provider-test-key');
      expect(invocation!.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(invocation!.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      expect(invocation!.env.BOTMUX_PRIVATE_TEST_SENTINEL).toBeUndefined();
      expect(invocation!.env.BOTMUX_OTHER_SECRET).toBeUndefined();
      expect(invocation!.env.UNRELATED_SECRET).toBeUndefined();
      expect(invocation!.env.RANDOM_SECRET).toBeUndefined();
      expect(invocation!.env.HOME).toBe(invocation!.cwd);
      expect(invocation!.env.CLAUDE_CONFIG_DIR).toBe(join(invocation!.cwd, '.claude'));
      expect(invocation!.env.PATH).toBe('/usr/bin:/bin');
      expect(invocation!.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      expect(invocation!.stdin).toContain('Create report for Alpha');
      expect(invocation!.stdin).not.toContain('/private/project-that-must-not-be-exposed');
      expect(existsSync(invocation!.cwd)).toBe(false);
    } finally {
      delete process.env.BOTMUX_PRIVATE_TEST_SENTINEL;
      delete process.env.UNRELATED_SECRET;
    }
  });

  it('fails closed for Anthropic bearer/OAuth auth that stock bare mode does not consume', async () => {
    const dirs = fixture();
    delete process.env.ANTHROPIC_API_KEY;
    const invokeStructuredModel = vi.fn(async () => response());

    for (const providerEnv of [
      { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth-token' },
      {
        ANTHROPIC_BASE_URL: 'https://provider.invalid',
        ANTHROPIC_AUTH_TOKEN: 'synthetic-bearer-token',
      },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel,
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
    expect(invokeStructuredModel).not.toHaveBeenCalled();
  });

  it('refuses endpoint-managed Claude policy before any classifier process can run', async () => {
    const dirs = fixture();
    const managedPolicyRoot = join(dirs.root, 'managed-policy');
    mkdirSync(managedPolicyRoot, { mode: 0o755 });
    writeFileSync(join(managedPolicyRoot, 'managed-settings.json'), JSON.stringify({
      env: { OTEL_LOG_USER_PROMPTS: '1' },
    }), { mode: 0o644 });
    const invokeStructuredModel = vi.fn(async () => response());

    await expect(runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      managedPolicyRoot,
      invokeStructuredModel,
    })).rejects.toMatchObject({ code: 'MANAGED_POLICY_UNSUPPORTED' });
    expect(invokeStructuredModel).not.toHaveBeenCalled();
  });

  it('freezes an absent endpoint-policy directory out of the child /etc view', async () => {
    const dirs = fixture();
    let invocation: V3DistillationStructuredInvocation | undefined;
    await runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async (value) => {
        invocation = value;
        return response();
      },
    });
    expect(invocation).toBeDefined();
    expect(invocation!.args).toContain('/etc');
    expect(invocation!.args).not.toContain('/etc/claude-code');
    const etcTmpfs = invocation!.args.findIndex((value, index, args) =>
      value === '/etc' && args[index - 1] === '--tmpfs');
    expect(etcTmpfs).toBeGreaterThan(0);
  });

  it('accepts the CLI result-string fallback but rejects model-controlled names', async () => {
    const dirs = fixture();
    const ok = await runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async () => JSON.stringify({
        result: JSON.stringify({ schemaVersion: 1, candidates: [{
          path: FIELDS[0]!.path,
          literal: 'Alpha',
          occurrence: 0,
          type: 'string',
        }] }),
      }),
    });
    expect(ok.candidates).toHaveLength(1);

    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async () => response({
        path: FIELDS[0]!.path,
        literal: 'Alpha',
        occurrence: 0,
        type: 'string',
        paramName: 'encoded_secret',
      }),
    })).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });

  it('rejects suggestions outside the minimized fields and always removes scratch', async () => {
    const dirs = fixture();
    let scratch = '';
    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async (input) => {
        scratch = input.cwd;
        return response({
          path: '/dagTemplate/nodes/9/goal',
          literal: 'other',
          occurrence: 0,
          type: 'string',
        });
      },
    })).rejects.toMatchObject<V3DistillationRunnerError>({
      code: 'MODEL_OUTPUT_INVALID',
      message: 'Workflow parameter distillation model runner failed (MODEL_OUTPUT_INVALID)',
    });
    expect(existsSync(scratch)).toBe(false);
  });

  it('fails closed on invocation failure and makes cleanup mandatory', async () => {
    const dirs = fixture();
    let scratch = '';
    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async (input) => {
        scratch = input.cwd;
        throw new Error('untrusted provider detail');
      },
    })).rejects.toMatchObject({
      code: 'MODEL_FAILED',
      message: 'Workflow parameter distillation model runner failed (MODEL_FAILED)',
    });
    expect(existsSync(scratch)).toBe(false);

    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async () => response(),
      removeScratch: async () => { throw new Error('simulated'); },
    })).rejects.toMatchObject({ code: 'SCRATCH_CLEANUP_FAILED' });
  });

  it('handles a stock-binary spawn error without an unhandled child error or scratch leak', async () => {
    const dirs = fixture();
    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: join(dirs.root, 'missing-claude-binary'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CLI' });
    expect(existsSync(dirs.scratchParent)).toBe(true);
    expect(statSync(dirs.scratchParent).isDirectory()).toBe(true);
    expect(readdirSync(dirs.scratchParent)).toEqual([]);
  });

  it('collapses the PID namespace before cleaning scratch', async () => {
    if (process.platform !== 'linux') return;
    const dirs = fixture();
    const executable = join(dirs.root, 'synthetic-model-runner.cjs');
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", 'distill-helper'], { stdio: 'ignore' });
writeFileSync(join(process.cwd(), 'helper.pid'), String(helper.pid));
process.on('SIGTERM', () => process.exit(1));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const startedAt = Date.now();
    const pending = runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      timeoutMs: 1_000,
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: executable,
    });
    const observed = pending.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let helperPid = 0;
    for (let attempt = 0; attempt < 80 && helperPid === 0; attempt++) {
      const scratch = readdirSync(dirs.scratchParent).find((name) => name.startsWith('botmux-v3-distill-'));
      if (scratch) {
        try { helperPid = Number(readFileSync(join(dirs.scratchParent, scratch, 'helper.pid'), 'utf8')); } catch { /* not written yet */ }
      }
      if (helperPid === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(helperPid).toBeGreaterThan(0);
    const result = await observed;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'MODEL_FAILED' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(() => process.kill(helperPid, 0)).toThrow();
    expect(readdirSync(dirs.scratchParent)).toEqual([]);
  });

  it('rejects unsupported platforms, CLIs, and malformed fields before invocation', async () => {
    const dirs = fixture();
    const invokeStructuredModel = vi.fn();
    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot() }, {
      scratchParent: dirs.scratchParent,
      platform: 'darwin',
      invokeStructuredModel,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(runV3DistillationModel({ fields: FIELDS, botSnapshot: bot('gemini') }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      invokeStructuredModel,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CLI' });
    await expect(runV3DistillationModel({
      fields: [{ ...FIELDS[0]!, path: '/unsafe/metadata' }],
      botSnapshot: bot(),
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      invokeStructuredModel,
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    expect(invokeStructuredModel).not.toHaveBeenCalled();
  });

  it('rejects custom executable overrides and isolates provider-family credentials', async () => {
    const dirs = fixture();
    const invokeStructuredModel = vi.fn(async (invocation: V3DistillationStructuredInvocation) => {
      expect(invocation.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(invocation.env.AWS_ACCESS_KEY_ID).toBe('test-bedrock-key');
      expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(invocation.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      return response();
    });
    await runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      providerEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_ACCESS_KEY_ID: 'test-bedrock-key',
        AWS_SECRET_ACCESS_KEY: 'test-bedrock-secret',
        AWS_REGION: 'us-test-1',
      },
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel,
    });
    expect(invokeStructuredModel).toHaveBeenCalledOnce();

    await expect(runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: { ...bot(), cliPathOverride: '/custom/launcher' },
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CLI' });
  });

  it('gives per-bot direct-provider routing precedence over daemon-global routing', async () => {
    const dirs = fixture();
    const previous = {
      selector: process.env.CLAUDE_CODE_USE_BEDROCK,
      awsKey: process.env.AWS_ACCESS_KEY_ID,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_ACCESS_KEY_ID = 'daemon-global-aws-key';
    process.env.ANTHROPIC_BASE_URL = 'https://global.invalid';
    process.env.ANTHROPIC_API_KEY = 'daemon-global-key';
    try {
      await runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: {
          ANTHROPIC_BASE_URL: 'https://bot-provider.invalid',
          ANTHROPIC_API_KEY: 'bot-provider-key',
        },
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: async (invocation) => {
          expect(invocation.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
          expect(invocation.env.AWS_ACCESS_KEY_ID).toBeUndefined();
          expect(invocation.env.ANTHROPIC_BASE_URL).toBe('https://bot-provider.invalid');
          expect(invocation.env.ANTHROPIC_API_KEY).toBe('bot-provider-key');
          return response();
        },
      });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('CLAUDE_CODE_USE_BEDROCK', previous.selector);
      restore('AWS_ACCESS_KEY_ID', previous.awsKey);
      restore('ANTHROPIC_BASE_URL', previous.baseUrl);
      restore('ANTHROPIC_API_KEY', previous.apiKey);
    }
  });

  it.each([
    {
      name: 'Bedrock endpoint',
      botEnv: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bot-bedrock.invalid',
        AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bot-bedrock-token',
        AWS_REGION: 'us-test-1',
      },
      globalEnv: {
        AWS_SHARED_CREDENTIALS_FILE: '/synthetic/global-aws-credentials',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'synthetic-global-container-token',
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://global-bedrock.invalid',
      },
      kept: 'ANTHROPIC_BEDROCK_BASE_URL',
    },
    {
      name: 'Foundry endpoint',
      botEnv: {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_BASE_URL: 'https://bot-foundry.invalid',
        ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-bot-foundry-key',
      },
      globalEnv: {
        AZURE_USERNAME: 'synthetic-global-user',
        AZURE_PASSWORD: 'synthetic-global-password',
        AZURE_MANAGED_IDENTITY_CLIENT_ID: 'synthetic-global-client',
      },
      kept: 'ANTHROPIC_FOUNDRY_BASE_URL',
    },
  ])('does not mix daemon credentials into a per-bot $name', async ({ botEnv, globalEnv, kept }) => {
    const dirs = fixture();
    const previous = Object.fromEntries(
      Object.keys(globalEnv).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, globalEnv);
    try {
      await runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: botEnv,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: async (invocation) => {
          expect(invocation.env[kept]).toBe(botEnv[kept as keyof typeof botEnv]);
          for (const key of Object.keys(globalEnv)) expect(invocation.env[key]).toBeUndefined();
          return response();
        },
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('fails loud for provider selectors without an audited isolated env contract', async () => {
    const dirs = fixture();
    for (const providerEnv of [
      { CLAUDE_CODE_USE_UNSUPPORTED_PROVIDER: '1', ANTHROPIC_UNSUPPORTED_WORKSPACE: 'synthetic-workspace' },
      { CLAUDE_CODE_UNSUPPORTED_HOST_AUTH_HINT: '1', ANTHROPIC_UNSUPPORTED_TOKEN: 'synthetic-token' },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
    await expect(runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      providerEnv: {
        CLAUDE_CODE_USE_BEDROCK: 'treu',
        ANTHROPIC_API_KEY: 'must-not-fall-back-to-anthropic',
      },
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: vi.fn(),
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
  });

  it('never combines a bot-owned transport with ambient or stored auth', async () => {
    const dirs = fixture();
    for (const transport of [
      { HTTPS_PROXY: 'http://bot-proxy.invalid' },
      { NO_PROXY: '*' },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: transport,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
    for (const invalidAuth of [
      { anthropic_api_key: 'synthetic-lowercase-key' },
      { ANTHROPIC_API_KEY: '' },
      { ANTHROPIC_API_KEY: '   ' },
      { ANTHROPIC_API_KEY: 'synthetic\0key' },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: {
          ANTHROPIC_BASE_URL: 'https://bot-provider.invalid',
          ...invalidAuth,
        },
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
    await expect(runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      providerEnv: {
        ANTHROPIC_BASE_URL: 'https://bot-provider.invalid',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Synthetic-Trace: 1',
      },
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: vi.fn(),
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });

    await expect(runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      providerEnv: {
        ANTHROPIC_API_KEY: 'synthetic-bot-key',
        ANTHROPIC_BASE_URL: '\0',
      },
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: vi.fn(),
    })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });

    const previous = {
      apiKey: process.env.ANTHROPIC_API_KEY,
      proxy: process.env.HTTPS_PROXY,
      noProxy: process.env.NO_PROXY,
      ca: process.env.NODE_EXTRA_CA_CERTS,
    };
    process.env.ANTHROPIC_API_KEY = 'synthetic-global-key';
    process.env.HTTPS_PROXY = 'http://global-proxy.invalid';
    process.env.NO_PROXY = 'global.internal.invalid';
    process.env.NODE_EXTRA_CA_CERTS = '/synthetic/global-ca.pem';
    try {
      await runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: {
          ANTHROPIC_API_KEY: 'synthetic-bot-key',
          HTTPS_PROXY: 'http://bot-proxy.invalid',
          NO_PROXY: 'bot.internal.invalid',
          NODE_EXTRA_CA_CERTS: '/synthetic/bot-ca.pem',
        },
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: async (invocation) => {
          expect(invocation.env.ANTHROPIC_API_KEY).toBe('synthetic-bot-key');
          expect(invocation.env.HTTPS_PROXY).toBe('http://bot-proxy.invalid');
          expect(invocation.env.NO_PROXY).toBe('bot.internal.invalid');
          expect(invocation.env.NODE_EXTRA_CA_CERTS).toBe('/synthetic/bot-ca.pem');
          return response();
        },
      });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('ANTHROPIC_API_KEY', previous.apiKey);
      restore('HTTPS_PROXY', previous.proxy);
      restore('NO_PROXY', previous.noProxy);
      restore('NODE_EXTRA_CA_CERTS', previous.ca);
    }
  });

  it('rejects profile and executable/file credential sources', async () => {
    const dirs = fixture();
    for (const providerEnv of [
      {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_PROFILE: 'synthetic-profile',
        AWS_CONFIG_FILE: '/synthetic/aws-config',
      },
      {
        CLAUDE_CODE_USE_VERTEX: '1',
        GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/external-account.json',
      },
      {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        AZURE_FEDERATED_TOKEN_FILE: '/synthetic/federated-token',
      },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
  });

  it('never ignores an unsupported bot credential hint and falls back to a daemon-global account', async () => {
    const dirs = fixture();
    const previous = {
      selector: process.env.CLAUDE_CODE_USE_BEDROCK,
      bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
      region: process.env.AWS_REGION,
    };
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'synthetic-global-token';
    process.env.AWS_REGION = 'us-test-1';
    try {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: { AWS_PROFILE: 'bot-owned-profile' },
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('CLAUDE_CODE_USE_BEDROCK', previous.selector);
      restore('AWS_BEARER_TOKEN_BEDROCK', previous.bearer);
      restore('AWS_REGION', previous.region);
    }
  });

  it('never falls back to daemon credentials for unsupported Anthropic identity or routing hints', async () => {
    const dirs = fixture();
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-global-key';
    const invokeStructuredModel = vi.fn(async () => response());
    try {
      for (const [key, value] of Object.entries({
        ANTHROPIC_UNSUPPORTED_IDENTITY_HINT: 'synthetic-identity',
        ANTHROPIC_UNSUPPORTED_ROUTING_HINT: '/synthetic/provider.sock',
        CLAUDE_CODE_UNSUPPORTED_HOST_AUTH_HINT: 'synthetic-host-auth',
        CLAUDE_CODE_UNSUPPORTED_CLIENT_CERT_HINT: '/synthetic/client-cert',
      })) {
        await expect(runV3DistillationModel({
          fields: FIELDS,
          botSnapshot: bot(),
          providerEnv: { [key]: value },
        }, {
          scratchParent: dirs.scratchParent,
          platform: 'linux',
          adapterBin: process.execPath,
          invokeStructuredModel,
        })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
      }
      expect(invokeStructuredModel).not.toHaveBeenCalled();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it('rejects unsupported ambient Anthropic identity and socket routing beside a direct key', async () => {
    const dirs = fixture();
    const invokeStructuredModel = vi.fn(async () => response());
    for (const [key, value] of Object.entries({
      ANTHROPIC_UNSUPPORTED_IDENTITY_HINT: 'synthetic-global-identity',
      ANTHROPIC_UNSUPPORTED_ROUTING_HINT: '/synthetic/global-provider.sock',
      CLAUDE_CODE_UNSUPPORTED_HOST_AUTH_HINT: 'synthetic-global-host-auth',
    })) {
      const previous = process.env[key];
      process.env[key] = value;
      try {
        await expect(runV3DistillationModel({
          fields: FIELDS,
          botSnapshot: bot(),
          providerEnv: {},
        }, {
          scratchParent: dirs.scratchParent,
          platform: 'linux',
          adapterBin: process.execPath,
          invokeStructuredModel,
        })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
    expect(invokeStructuredModel).not.toHaveBeenCalled();
  });

  it('uses a selected global cloud transport only with explicit direct credentials', async () => {
    const dirs = fixture();
    const previous = {
      selector: process.env.CLAUDE_CODE_USE_BEDROCK,
      credentials: process.env.AWS_BEARER_TOKEN_BEDROCK,
      region: process.env.AWS_REGION,
    };
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'synthetic-global-bedrock-token';
    process.env.AWS_REGION = 'us-test-1';
    try {
      await runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv: {},
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: async (invocation) => {
          expect(invocation.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
          expect(invocation.env.AWS_BEARER_TOKEN_BEDROCK).toBe('synthetic-global-bedrock-token');
          expect(invocation.env.AWS_REGION).toBe('us-test-1');
          return response();
        },
      });
    } finally {
      if (previous.selector === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = previous.selector;
      if (previous.credentials === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      else process.env.AWS_BEARER_TOKEN_BEDROCK = previous.credentials;
      if (previous.region === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = previous.region;
    }
  });

  it('rejects unsupported cloud token aliases instead of falling back to machine identity', async () => {
    const dirs = fixture();
    for (const providerEnv of [
      {
        CLAUDE_CODE_USE_VERTEX: '1',
        GOOGLE_API_KEY: 'synthetic-google-key',
        ANTHROPIC_UNSUPPORTED_VERTEX_AUTH: 'synthetic-vertex-token',
      },
      {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_UNSUPPORTED_BEDROCK_AUTH: 'synthetic-undocumented-token',
        AWS_REGION: 'us-test-1',
      },
      {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_UNSUPPORTED_FOUNDRY_AUTH: 'synthetic-undocumented-token',
        ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-resource',
      },
    ]) {
      await expect(runV3DistillationModel({
        fields: FIELDS,
        botSnapshot: bot(),
        providerEnv,
      }, {
        scratchParent: dirs.scratchParent,
        platform: 'linux',
        adapterBin: process.execPath,
        invokeStructuredModel: vi.fn(),
      })).rejects.toMatchObject({ code: 'INVALID_MODEL_INPUT' });
    }
  });

  it.each([
    {
      name: 'Bedrock',
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bedrock-token',
        AWS_REGION: 'us-test-1',
      },
      expected: ['CLAUDE_CODE_USE_BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
      absent: ['GOOGLE_API_KEY', 'AZURE_CLIENT_SECRET'],
    },
    {
      name: 'Foundry',
      env: {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-foundry-key',
        ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-resource',
      },
      expected: ['CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE'],
      absent: ['GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SECRET_ACCESS_KEY'],
    },
  ])('forwards only the $name provider family', async ({ env, expected, absent }) => {
    const dirs = fixture();
    await runV3DistillationModel({
      fields: FIELDS,
      botSnapshot: bot(),
      providerEnv: env,
    }, {
      scratchParent: dirs.scratchParent,
      platform: 'linux',
      adapterBin: process.execPath,
      invokeStructuredModel: async (invocation) => {
        for (const key of expected) expect(invocation.env[key]).toBe(env[key as keyof typeof env]);
        for (const key of absent) expect(invocation.env[key]).toBeUndefined();
        return response();
      },
    });
  });
});

describe('distillation model prompts', () => {
  it('makes the untrusted-data and host-authority boundary explicit', () => {
    const system = buildV3DistillationSystemPrompt();
    const prompt = buildV3DistillationModelPrompt({ schemaVersion: 1, fields: FIELDS });
    expect(system).toContain('You have no tools');
    expect(system).toContain('not a coding agent');
    expect(prompt).toContain('<untrusted_workflow_fields>');
    expect(prompt).toContain('host will assign generic parameter names');
  });
});

describe('sweepAbandonedV3DistillationScratch', () => {
  it('removes only old private owned distillation scratch directories', async () => {
    const dirs = fixture();
    const old = join(dirs.scratchParent, 'botmux-v3-distill-old123');
    const fresh = join(dirs.scratchParent, 'botmux-v3-distill-fresh123');
    const unrelated = join(dirs.scratchParent, 'unrelated');
    for (const path of [old, fresh, unrelated]) mkdirSync(path, { mode: 0o700 });
    const nowMs = Date.now();
    utimesSync(old, new Date(nowMs - 3_600_000), new Date(nowMs - 3_600_000));
    const removed = await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      nowMs,
      maxAgeMs: 31 * 60_000,
    });
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('kills an exact orphaned model process group before removing its scratch', async () => {
    if (process.platform !== 'linux') return;
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-orphan123');
    mkdirSync(scratch, { mode: 0o700 });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: scratch,
      detached: true,
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    let procStart: string | undefined;
    for (let attempt = 0; attempt < 20 && !procStart; attempt++) {
      procStart = readProcessStartIdentity(child.pid!);
      if (!procStart) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(procStart).toBeDefined();
    const bootId = readLinuxBootIdentity();
    expect(bootId).toBeDefined();
    writeFileSync(join(scratch, '.model-process.json'), `${JSON.stringify({
      schemaVersion: 2,
      isolation: 'bwrap-pid-namespace',
      bootId,
      ownerPid: 999_999_999,
      ownerProcStart: 'dead-owner',
      pid: child.pid,
      procStart,
      namespacePid: child.pid,
      namespaceProcStart: procStart,
    })}\n`, { mode: 0o600 });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(1);
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('orphan remained alive')), 2_000)),
    ]);
    expect(existsSync(scratch)).toBe(false);
  });

  it('never signals a PID/start-tick collision recorded by a previous boot', async () => {
    if (process.platform !== 'linux') return;
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-oldboot123');
    mkdirSync(scratch, { mode: 0o700 });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: scratch,
      detached: true,
      stdio: 'ignore',
    });
    expect(child.pid).toBeDefined();
    let procStart: string | undefined;
    for (let attempt = 0; attempt < 20 && !procStart; attempt++) {
      procStart = readProcessStartIdentity(child.pid!);
      if (!procStart) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(procStart).toBeDefined();
    const currentBootId = readLinuxBootIdentity();
    expect(currentBootId).toBeDefined();
    const staleBootId = `${currentBootId!.startsWith('0') ? '1' : '0'}${currentBootId!.slice(1)}`;
    writeFileSync(join(scratch, '.model-process.json'), `${JSON.stringify({
      schemaVersion: 2,
      isolation: 'bwrap-pid-namespace',
      bootId: staleBootId,
      ownerPid: process.pid,
      ownerProcStart: procStart,
      pid: child.pid,
      procStart,
      namespacePid: child.pid,
      namespaceProcStart: procStart,
    })}\n`, { mode: 0o600 });

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(1);
    expect(readProcessStartIdentity(child.pid!)).toBe(procStart);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(existsSync(scratch)).toBe(false);
  });

  it('never blind-kills or ages out a leaderless legacy process-group marker', async () => {
    if (process.platform !== 'linux') return;
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-legacy123');
    mkdirSync(scratch, { mode: 0o700 });
    writeFileSync(join(scratch, '.model-process.json'), `${JSON.stringify({
      schemaVersion: 1,
      ownerPid: 999_999_999,
      ownerProcStart: 'dead-owner',
      pid: 999_999_998,
      procStart: 'missing-legacy-leader',
    })}\n`, { mode: 0o600 });
    utimesSync(scratch, new Date(0), new Date(0));

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(0);
    expect(existsSync(scratch)).toBe(true);
  });

  it('retains corrupt ownership markers instead of treating them as markerless', async () => {
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-corrupt123');
    mkdirSync(scratch, { mode: 0o700 });
    writeFileSync(join(scratch, '.model-process.json'), '{not-json}\n', { mode: 0o600 });
    utimesSync(scratch, new Date(0), new Date(0));

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(0);
    expect(existsSync(scratch)).toBe(true);
  });

  it('ages out preparing-only scratch when the recorded owner is dead', async () => {
    const dirs = fixture();
    const old = join(dirs.scratchParent, 'botmux-v3-distill-preparing-dead');
    const live = join(dirs.scratchParent, 'botmux-v3-distill-preparing-live');
    mkdirSync(old, { mode: 0o700 });
    mkdirSync(live, { mode: 0o700 });
    const liveStart = readProcessStartIdentity(process.pid);
    expect(liveStart).toBeDefined();
    writeFileSync(join(old, '.model-preparing.json'), `${JSON.stringify({
      schemaVersion: 1,
      ownerPid: 999_999_999,
      ownerProcStart: 'dead-owner',
    })}\n`, { mode: 0o600 });
    writeFileSync(join(live, '.model-preparing.json'), `${JSON.stringify({
      schemaVersion: 1,
      ownerPid: process.pid,
      ownerProcStart: liveStart,
    })}\n`, { mode: 0o600 });
    const nowMs = Date.now();
    utimesSync(old, new Date(nowMs - 3 * 3_600_000), new Date(nowMs - 3 * 3_600_000));
    utimesSync(live, new Date(nowMs - 3 * 3_600_000), new Date(nowMs - 3 * 3_600_000));

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      nowMs,
      maxAgeMs: 31 * 60_000,
    })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('removes preparing-only scratch after a boot-id mismatch without waiting for age', async () => {
    if (process.platform !== 'linux') return;
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-preparing-boot');
    mkdirSync(scratch, { mode: 0o700 });
    const currentBootId = readLinuxBootIdentity();
    expect(currentBootId).toBeDefined();
    const staleBootId = `${currentBootId!.startsWith('0') ? '1' : '0'}${currentBootId!.slice(1)}`;
    writeFileSync(join(scratch, '.model-preparing.json'), `${JSON.stringify({
      schemaVersion: 1,
      ownerPid: process.pid,
      ownerProcStart: 'any-start',
      bootId: staleBootId,
    })}\n`, { mode: 0o600 });

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(1);
    expect(existsSync(scratch)).toBe(false);
  });

  it('retains corrupt preparing markers instead of aging them out', async () => {
    const dirs = fixture();
    const scratch = join(dirs.scratchParent, 'botmux-v3-distill-preparing-corrupt');
    mkdirSync(scratch, { mode: 0o700 });
    writeFileSync(join(scratch, '.model-preparing.json'), '{not-json}\n', { mode: 0o600 });
    utimesSync(scratch, new Date(0), new Date(0));

    expect(await sweepAbandonedV3DistillationScratch({
      scratchParent: dirs.scratchParent,
      maxAgeMs: 31 * 60_000,
    })).toBe(0);
    expect(existsSync(scratch)).toBe(true);
  });
});
