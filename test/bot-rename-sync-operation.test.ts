import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createSerializedBotRenamer } from '../src/services/bot-name-sync.js';

// 非文本断言：执行真实 daemon 改名回调，注入无网络 transport 与可控本地写入；
// 验证运行时编排结果，不断言源码文本或代码行的排列。
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const begin = daemon.indexOf('  setBotRenamer(createSerializedBotRenamer(');
const end = daemon.indexOf('  // 机器人真·改头像', begin);
if (begin < 0 || end < 0) throw new Error('Cannot locate the daemon rename operation');
const operation = ts.transpileModule(daemon.slice(begin, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function fixture(overrides: Record<string, unknown> = {}) {
  const state = { botName: 'Old', config: { name: 'Old', displayName: undefined as string | undefined } };
  const calls: string[] = [];
  let rename!: (name: string) => Promise<any>;
  const bindings = {
    cfg: { larkAppId: 'cli_fixture', brand: 'feishu' },
    config: { session: { dataDir: 'unused-fixture-directory' } },
    createSerializedBotRenamer,
    setBotRenamer: (fn: typeof rename) => { rename = fn; },
    getBot: () => state,
    renameBotOnOpenPlatform: async (_appId: string, name: string) => {
      calls.push('remote');
      return { ok: true, name };
    },
    persistRenamedBotName: async (_appId: string, name: string) => {
      calls.push('persist');
      return name;
    },
    noteLocalBotProfileWrite: () => { calls.push('protect'); },
    findConfigField: () => ({}),
    applyConfigField: async () => { delete state.config.displayName; return { ok: true }; },
    refreshBotNameState: () => { calls.push('refresh'); },
    writeBotInfoFile: () => { calls.push('roster'); },
    ...overrides,
  };
  new Function(...Object.keys(bindings), operation)(...Object.values(bindings));
  return { rename, state, calls };
}

describe('daemon rename local synchronization', () => {
  it('protects the new profile before waiting for local persistence', async () => {
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({
      persistRenamedBotName: async (_appId: string, name: string) => {
        entered();
        await wait;
        return name;
      },
    });
    const result = f.rename('New');
    await ready;
    try {
      expect(f.state.botName).toBe('New');
      expect(f.calls).toEqual(['remote', 'protect']);
      expect(f.state.config.name).toBe('Old');
    } finally {
      release();
    }
    expect(await result).toEqual({ ok: true, name: 'New', displayName: null });
    expect(f.state.config.name).toBe('New');
  });

  it('preserves remote success when local persistence throws without exposing error content', async () => {
    const f = fixture({
      persistRenamedBotName: async () => { throw new Error('PRIVATE_CONFIG_SENTINEL'); },
    });
    const result = await f.rename('New');
    expect(result).toMatchObject({ ok: true, name: 'New', displayName: null });
    expect(typeof result.localSyncError).toBe('string');
    expect(result.localSyncError.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONFIG_SENTINEL');
    expect(f.state.config.name).toBe('Old');
    expect(f.state.botName).toBe('New');
    expect(f.calls.filter(call => call === 'remote')).toHaveLength(1);
  });

  it('returns the retained alias when local alias cleanup fails', async () => {
    const f = fixture({ applyConfigField: async () => ({ ok: false, reason: 'not_saved' }) });
    f.state.config.displayName = 'Existing alias';
    const result = await f.rename('New');
    expect(result).toMatchObject({ ok: true, name: 'New', displayName: 'Existing alias' });
    expect(result.localSyncError).toBeTruthy();
    expect(f.state.config.name).toBe('New');
    expect(f.calls).toEqual(['remote', 'protect', 'persist', 'refresh', 'roster']);
  });

  it('does not mistake a local refresh exception for a failed remote publish', async () => {
    const f = fixture({ refreshBotNameState: () => { throw new Error('refresh unavailable'); } });
    expect(await f.rename('New')).toMatchObject({ ok: true, name: 'New', localSyncError: expect.any(String) });
    expect(f.calls).toContain('roster');
  });

  it('does not mutate local state when remote publication fails', async () => {
    const failure = { ok: false, reason: 'no_session', message: 'fixture' };
    const f = fixture({ renameBotOnOpenPlatform: async () => failure });
    expect(await f.rename('New')).toBe(failure);
    expect(f.calls).toEqual([]);
    expect(f.state).toEqual({ botName: 'Old', config: { name: 'Old', displayName: undefined } });
  });
});
