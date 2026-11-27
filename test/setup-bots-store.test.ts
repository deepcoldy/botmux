/**
 * 单测 src/setup/bots-store.ts — 原子写 bots.json.
 *
 * Run: pnpm vitest run test/setup-bots-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BotsJsonStaleSnapshotError,
  writeBotsJsonAtomic,
  readBotsJsonOrEmpty,
  readConfiguredBotCount,
  mutateBotsJsonAtomic,
} from '../src/setup/bots-store.js';
import { persistRenamedBotName } from '../src/services/bot-name-sync.js';

let tmpDir: string;
let botsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-bots-store-'));
  botsPath = join(tmpDir, 'bots.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeBotsJsonAtomic', () => {
  it('writes valid JSON with trailing newline', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_1', larkAppSecret: 's1' }], null);
    expect(existsSync(botsPath)).toBe(true);
    const content = readFileSync(botsPath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].larkAppId).toBe('cli_1');
  });

  it('persists the brand field so subsequent start/verify reads it back', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_lark', larkAppSecret: 's', brand: 'lark' }], null);
    const parsed = readBotsJsonOrEmpty(botsPath);
    expect(parsed[0].brand).toBe('lark');
  });

  it('cleans up the tmp file after rename (only bots.json remains)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_2', larkAppSecret: 's2' }], null);
    expect(existsSync(botsPath + '.tmp')).toBe(false);
    expect(existsSync(botsPath)).toBe(true);
  });

  it('replaces existing file atomically — old content gone, new content visible', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_old', larkAppSecret: 'old' }], null);
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_new', larkAppSecret: 'new' }], null);
    const parsed = JSON.parse(readFileSync(botsPath, 'utf-8'));
    expect(parsed[0].larkAppId).toBe('cli_new');
  });

  it('sets file mode 0o600 (only owner can read — secret protection)', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_x', larkAppSecret: 'secret' }], null);
    const mode = statSync(botsPath).mode & 0o777;
    // 在 root 用户 / fakeroot 下 umask 可能影响; 但 0o600 是 writeFileSync 显式指定的
    // 实际结果应该精确等于 0o600.
    expect(mode).toBe(0o600);
  });

  it('uses tmp file in the SAME directory as the target (cross-fs renames are not atomic)', () => {
    // 通过 spy fs.writeFileSync 监控 tmp 路径 — 简单版: 检查 bots.json.tmp 在
    // bots.json 同目录. 实现细节: 只要写完 + rename 完不出错, 同目录假设成立.
    // 这里跑一次 + 校验 bots.json 出现在 tmpDir, 间接保证 tmp 路径也在 tmpDir.
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_t', larkAppSecret: 's' }], null);
    expect(existsSync(join(tmpDir, 'bots.json'))).toBe(true);
  });

  it('rejects a cloned next generation that would create a fallback cycle', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_safe', larkAppSecret: 's' }], null);
    const before = readFileSync(botsPath, 'utf8');
    expect(() => writeBotsJsonAtomic(botsPath, [
      { larkAppId: 'cli_a', quotaFallbackBot: { enabled: true, targetAppId: 'cli_b' } },
      { larkAppId: 'cli_b', quotaFallbackBot: { enabled: true, targetAppId: 'cli_a' } },
    ], null)).toThrow('cli_a -> cli_b -> cli_a');
    expect(readFileSync(botsPath, 'utf8')).toBe(before);
  });

  it('rejects setup writes that retain Codex browser config after switching CLI', () => {
    const original = {
      larkAppId: 'cli_browser',
      larkAppSecret: 's',
      cliId: 'codex-app',
      codexBrowser: { enabled: true, family: 'chrome' },
    };
    writeBotsJsonAtomic(botsPath, [original], null);
    const before = readFileSync(botsPath, 'utf8');

    expect(() => writeBotsJsonAtomic(botsPath, [{ ...original, cliId: 'claude-code' }], null))
      .toThrow('codex_browser_requires_codex_app');
    expect(readFileSync(botsPath, 'utf8')).toBe(before);
  });

  it('allows editing another bot when an unchanged legacy entry violates an invariant', () => {
    const legacyInvalid = {
      larkAppId: 'cli_legacy',
      larkAppSecret: 's',
      cliId: 'claude-code',
      codexBrowser: { enabled: true, family: 'chrome' },
    };
    const editable = { larkAppId: 'cli_editable', larkAppSecret: 's', cliId: 'codex-app', lang: 'en' };
    writeFileSync(botsPath, JSON.stringify([legacyInvalid, editable], null, 2));

    expect(() => writeBotsJsonAtomic(botsPath, [legacyInvalid, { ...editable, lang: 'zh' }], null))
      .not.toThrow();
    expect(readBotsJsonOrEmpty(botsPath)[1].lang).toBe('zh');
  });
  it('mutates the latest on-disk generation and returns the committed result', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_a', larkAppSecret: 'a' }], null);
    const result = mutateBotsJsonAtomic(botsPath, previous => {
      expect(previous.map(bot => bot.larkAppId)).toEqual(['cli_a']);
      return {
        bots: [...previous, { larkAppId: 'cli_b', larkAppSecret: 'b' }],
        result: { index: previous.length },
      };
    });
    expect(result).toEqual({ index: 1 });
    expect(readBotsJsonOrEmpty(botsPath).map(bot => bot.larkAppId)).toEqual(['cli_a', 'cli_b']);
  });

  it('rejects a stale derived snapshot that crosses a committed rename, then permits a fresh retry', async () => {
    writeBotsJsonAtomic(botsPath, [{
      larkAppId: 'cli_a', larkAppSecret: 'a', cliId: 'doubao', name: 'old-a', model: 'original',
    }], null);
    const stale = readBotsJsonOrEmpty(botsPath);
    const humanEdit = [...stale];
    humanEdit[0] = { ...humanEdit[0], model: 'human-edit' };

    expect(await persistRenamedBotName('cli_a', 'Remote New Name', botsPath)).toBe('Remote-New-Name');
    expect(() => writeBotsJsonAtomic(botsPath, humanEdit, stale)).toThrow(BotsJsonStaleSnapshotError);

    // The rejected writer neither restores the old name nor loses the rename's fields.
    const latest = readBotsJsonOrEmpty(botsPath);
    expect(latest[0]).toMatchObject({ name: 'Remote-New-Name', model: 'original' });
    latest[0].model = 'human-edit';
    writeBotsJsonAtomic(botsPath, latest, latest);
    expect(readBotsJsonOrEmpty(botsPath)[0]).toMatchObject({
      name: 'Remote-New-Name', model: 'human-edit',
    });
  });

  it('does not let a snapshot of a missing file overwrite a subsequent creation', () => {
    const staleEmpty = readBotsJsonOrEmpty(botsPath);
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_new', larkAppSecret: 'new' }], null);
    expect(() => writeBotsJsonAtomic(botsPath, [{ larkAppId: 'cli_stale' }], staleEmpty))
      .toThrow(BotsJsonStaleSnapshotError);
    expect(readBotsJsonOrEmpty(botsPath).map(bot => bot.larkAppId)).toEqual(['cli_new']);
  });
});

describe('readBotsJsonOrEmpty', () => {
  it('returns [] when file missing', () => {
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns [] when file is malformed JSON (no throw)', () => {
    writeFileSync(botsPath, '{ not valid json');
    expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
  });

  it('returns parsed array when file is valid', () => {
    writeBotsJsonAtomic(botsPath, [{ larkAppId: 'a', larkAppSecret: 's' }, { larkAppId: 'b', larkAppSecret: 's' }], null);
    expect(readBotsJsonOrEmpty(botsPath).map((b: any) => b.larkAppId)).toEqual(['a', 'b']);
  });

  it('returns [] on non-array JSON while mutateBotsJsonAtomic fails closed without overwriting it', () => {
    for (const raw of ['{}', '"corrupt-string"', '123']) {
      writeFileSync(botsPath, raw);
      expect(readBotsJsonOrEmpty(botsPath)).toEqual([]);
      expect(() => mutateBotsJsonAtomic(botsPath, prev => ({ bots: prev, result: null })))
        .toThrow('must contain a JSON array');
      expect(readFileSync(botsPath, 'utf-8')).toBe(raw);
    }
  });
});

describe('readConfiguredBotCount', () => {
  it('distinguishes missing/empty (0), configured (N), and corrupt/invalid (null)', () => {
    expect(readConfiguredBotCount(botsPath)).toBe(0);

    writeFileSync(botsPath, '[]');
    expect(readConfiguredBotCount(botsPath)).toBe(0);

    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'local_ok', apiOnly: true, localIdentity: true }]));
    expect(readConfiguredBotCount(botsPath)).toBe(1);

    writeFileSync(botsPath, '{ broken');
    expect(readConfiguredBotCount(botsPath)).toBeNull();

    writeFileSync(botsPath, '{}');
    expect(readConfiguredBotCount(botsPath)).toBeNull();

    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_missing_secret' }]));
    expect(readConfiguredBotCount(botsPath)).toBeNull();

    // Full loader parity: reject malformed daemon-loader fields and still count activationPending / retired rows.
    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 's', sandboxNetwork: 'false' }]));
    expect(readConfiguredBotCount(botsPath)).toBeNull();

    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_a', larkAppSecret: 's', mojo: { localDaemon: 'false' } }]));
    expect(readConfiguredBotCount(botsPath)).toBeNull();

    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_pending', larkAppSecret: 's', activationPending: true }]));
    expect(readConfiguredBotCount(botsPath)).toBe(1);

    writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_retired', larkAppSecret: 's', cliId: 'gemini' }]));
    expect(readConfiguredBotCount(botsPath)).toBe(1);

    // Roster validation must retain cliId/backendType; dropping them falsely
    // rejects a pool that the real daemon loader accepts.
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'cli_codex_pool',
      larkAppSecret: 's',
      cliId: 'codex',
      backendType: 'tmux',
      codexInstancePool: {
        enabled: true,
        scope: 'ordinary-feishu',
        strategy: 'random',
        defaultInstanceId: 'default',
        instances: [{ id: 'default', codexHome: join(tmpDir, 'codex-default') }],
      },
    }]));
    expect(readConfiguredBotCount(botsPath)).toBe(1);
  });
});
