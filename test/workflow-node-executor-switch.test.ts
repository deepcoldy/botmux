/**
 * The experimental switch `workflow.nodeExecutor` (design 2026-11-03 D1,
 * §15.5): Dashboard 全局设置 writes it next to `workflow.enabled`; only the
 * non-default value ever reaches config.json, and the live policy consulted at
 * authorization is absent while it is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  globalConfigPath,
  mergeGlobalConfig,
  readGlobalConfig,
  workflowNodeExecutorMode,
} from '../src/global-config.js';
import { applySettingsWrite, type SettingsWriteApplierDeps } from '../src/dashboard/settings-write-applier.js';
import { liveV3NodeExecutorPolicy } from '../src/im/lark/v3-bot-eligibility.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wf-switch-'));
  vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(home, 'config.json'));
  vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** The applier against the REAL global config file. */
function realDeps(): SettingsWriteApplierDeps {
  return {
    readGlobalConfig,
    mergeGlobalConfig,
    resolveDashboardSettings: () => ({}) as any,
  } as unknown as SettingsWriteApplierDeps;
}

function onDisk(): Record<string, unknown> {
  const path = globalConfigPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
}

describe('workflow.nodeExecutor switch', () => {
  it('defaults to ephemeral with nothing on disk', () => {
    expect(workflowNodeExecutorMode()).toBe('ephemeral');
    expect(onDisk()).toEqual({});
  });

  it('turning it on stores only that key; turning it off removes it again', async () => {
    expect(await applySettingsWrite({ workflow: { nodeExecutor: 'bot' } }, realDeps())).toMatchObject({ ok: true });
    expect(onDisk()).toEqual({ workflow: { nodeExecutor: 'bot' } });
    expect(workflowNodeExecutorMode()).toBe('bot');

    expect(await applySettingsWrite({ workflow: { nodeExecutor: 'ephemeral' } }, realDeps())).toMatchObject({ ok: true });
    expect(onDisk()).toEqual({});
    expect(workflowNodeExecutorMode()).toBe('ephemeral');
  });

  it('is independent of workflow.enabled in both directions', async () => {
    await applySettingsWrite({ workflow: { enabled: true } }, realDeps());
    await applySettingsWrite({ workflow: { nodeExecutor: 'bot' } }, realDeps());
    expect(onDisk()).toEqual({ workflow: { enabled: true, nodeExecutor: 'bot' } });
    await applySettingsWrite({ workflow: { enabled: false } }, realDeps());
    expect(onDisk()).toEqual({ workflow: { enabled: false, nodeExecutor: 'bot' } });
    await applySettingsWrite({ workflow: { nodeExecutor: 'ephemeral' } }, realDeps());
    expect(onDisk()).toEqual({ workflow: { enabled: false } });
  });

  it('rejects an unknown executor without writing', async () => {
    expect(await applySettingsWrite({ workflow: { nodeExecutor: 'worker' } }, realDeps()))
      .toEqual({ ok: false, error: 'invalid_workflow_nodeExecutor' });
    expect(await applySettingsWrite({ workflow: {} }, realDeps()))
      .toEqual({ ok: false, error: 'invalid_workflow_enabled' });
    expect(onDisk()).toEqual({});
  });

  it('a hand-edited non-bot value reads as the default and is not carried into later writes', async () => {
    mergeGlobalConfig({ workflow: { nodeExecutor: 'worker' as any } });
    expect(workflowNodeExecutorMode()).toBe('ephemeral');
    expect(readGlobalConfig().workflow).toBeUndefined();
    await applySettingsWrite({ workflow: { enabled: true } }, realDeps());
    expect(onDisk()).toEqual({ workflow: { enabled: true } });
  });

  it('authorization entry points get no policy while the switch is off', () => {
    const bots = [{ larkAppId: 'cli_main', cliId: 'claude-code' }] as any[];
    expect(liveV3NodeExecutorPolicy(bots)).toBeUndefined();
    mergeGlobalConfig({ workflow: { nodeExecutor: 'bot' } });
    expect(liveV3NodeExecutorPolicy(bots)).toMatchObject({ switchMode: 'bot' });
  });
});
