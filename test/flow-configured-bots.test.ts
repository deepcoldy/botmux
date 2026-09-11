/**
 * flow 的 bots.json 轻量读取（src/flow/configured-bots.ts）：只取 larkAppId / displayName / cliId，
 * 路径与跳过规则与 bot-registry 对齐，读不到返回 null。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listConfiguredBots, parseConfiguredBots } from '../src/flow/configured-bots.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'flow-configured-bots-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseConfiguredBots', () => {
  it('取身份三元组；displayName trim、cliId 缺省 claude-code；activation-* 中的条目与坏条目跳过', () => {
    const raw = JSON.stringify([
      { larkAppId: 'cli_a', larkAppSecret: 'x', displayName: '  A 号  ', cliId: 'codex' },
      { larkAppId: 'cli_b', larkAppSecret: 'x' },
      { larkAppId: 'cli_c', larkAppSecret: 'x', displayName: '', cliId: ' gemini ' },
      { larkAppId: 'cli_pending', larkAppSecret: 'x', activationPending: true },
      { larkAppId: 'cli_starting', larkAppSecret: 'x', activationStarting: { appId: 'cli_starting', jobId: 'j' } },
      { larkAppId: 'cli_committed', larkAppSecret: 'x', activationCommitted: {} },
      { larkAppId: 'cli_deactivating', larkAppSecret: 'x', activationDeactivating: {} },
      { larkAppSecret: 'no-id' },
      { larkAppId: 42 },
      null,
      'junk',
      [],
    ]);
    expect(parseConfiguredBots(raw)).toEqual([
      { larkAppId: 'cli_a', displayName: 'A 号', cliId: 'codex' },
      { larkAppId: 'cli_b', cliId: 'claude-code' },
      { larkAppId: 'cli_c', cliId: 'gemini' },
    ]);
  });

  it('JSON 坏 / 顶层不是数组 → null（不是空名单）', () => {
    expect(parseConfiguredBots('{not json')).toBeNull();
    expect(parseConfiguredBots('{"bots": []}')).toBeNull();
    expect(parseConfiguredBots('[]')).toEqual([]);
  });
});

describe('listConfiguredBots', () => {
  it('BOTS_CONFIG 指向的文件优先；文件不存在 → null', () => {
    const dir = tmp();
    const file = join(dir, 'fleet.json');
    writeFileSync(file, JSON.stringify([{ larkAppId: 'cli_x', larkAppSecret: 's', displayName: 'X', cliId: 'codex' }]));
    expect(listConfiguredBots({ BOTS_CONFIG: file })).toEqual([{ larkAppId: 'cli_x', displayName: 'X', cliId: 'codex' }]);
    expect(listConfiguredBots({ BOTS_CONFIG: join(dir, 'missing.json') })).toBeNull();
  });

  it('核心态（BOTMUX_CORE_ONLY=1）无视磁盘：只有 env 合成的那一个 bot，缺省 local_riff / codex-app', () => {
    const dir = tmp();
    const file = join(dir, 'fleet.json');
    writeFileSync(file, JSON.stringify([{ larkAppId: 'cli_ignored', larkAppSecret: 's' }]));
    expect(listConfiguredBots({ BOTMUX_CORE_ONLY: '1', BOTS_CONFIG: file, BOTMUX_API_ONLY_BOT: 'local_smoke', BOTMUX_CORE_CLI: 'claude-code' }))
      .toEqual([{ larkAppId: 'local_smoke', cliId: 'claude-code' }]);
    expect(listConfiguredBots({ BOTMUX_CORE_ONLY: '1' })).toEqual([{ larkAppId: 'local_riff', cliId: 'codex-app' }]);
  });
});
