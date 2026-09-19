import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  FrozenCommandError,
  executeFrozenCommand,
  frozenCommandUsage,
  frozenCommandResultText,
  listFrozenCommandSnapshots,
  lookupFrozenCommand,
  isTransientDataMcpFailure,
  normalizeFrozenCommandName,
  renderFrozenCommandSql,
  shouldFallbackFrozenCommand,
  userFacingFrozenCommandError,
} from '../src/services/frozen-command.js';

const dirs: string[] = [];

function fixture(yaml: string): { root: string; definition: ReturnType<typeof definitionAt> } {
  const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), yaml);
  return { root, definition: definitionAt(root) };
}

function definitionAt(root: string) {
  const result = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
  if (result.kind !== 'found') throw new Error(`fixture failed: ${result.kind}`);
  return result.snapshot.definition;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = `
schemaVersion: 1
name: 泰国上账
description: 查询泰国最近 N 天的上账金额
timezone: Asia/Bangkok
params:
  - name: days
    label: 天数
    type: integer
    min: 1
    max: 90
    default: 7
sql: |-
  SELECT sum(amount) FROM bills
  WHERE country = 'TH' AND dt >= today() - {{days}}
  LIMIT 100
output:
  prefix: "查询结果：\\n"
  maxChars: 20000
onError: fallback_llm
`;

describe('Frozen Commands definition and positional UX', () => {
  it('accepts a Chinese command name and normalizes NFKC safely', () => {
    expect(normalizeFrozenCommandName('/泰国上账')).toBe('泰国上账');
    expect(normalizeFrozenCommandName('/ＴＥＳＴ')).toBe('test');
    expect(normalizeFrozenCommandName('../泰国上账')).toBeUndefined();
  });

  it('renders the documented positional parameter and default', () => {
    const { definition } = fixture(BASE);
    expect(frozenCommandUsage(definition)).toBe('/泰国上账 [天数]');
    expect(renderFrozenCommandSql({ definition, rawArgs: '' }).sql).toContain('today() - 7');
    expect(renderFrozenCommandSql({ definition, rawArgs: '30' }).sql).toContain('today() - 30');
  });

  it('rejects range explosions before Data MCP is called', () => {
    const { definition } = fixture(BASE);
    expect(() => renderFrozenCommandSql({ definition, rawArgs: '99999' }))
      .toThrowError(/1～90/);
  });

  it('does not expose SQL when listing commands', () => {
    const { root } = fixture(BASE);
    const listed = listFrozenCommandSnapshots(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.command).toBe('泰国上账');
    expect(listed[0]?.snapshot?.definition.description).toContain('泰国');
  });

  it('redacts SQL-bearing fields from Data MCP results before replying', () => {
    const displayed = frozenCommandResultText({
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', sql: 'SELECT secret FROM t', data: [{ amount: 12 }] }),
      }],
    });
    expect(displayed).not.toContain('SELECT secret');
    expect(displayed).toContain('"amount": 12');
    expect(displayed).toContain('[已隐藏]');
  });

  it('executes validate and run in one sessionless context with identical SQL bytes', async () => {
    const { root, definition } = fixture(BASE);
    const home = join(root, 'home');
    const source = join(root, 'data-mcp-plugin');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-data-mcp',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'data-mcp' },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'data'],
      env: { BOTMUX_SESSION_ID: 'forged-session', BOTMUX_EXECUTION_ID: 'forged-execution' },
    }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
    installLocalPlugin(source);

    const result = await executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'] },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_turn',
      dataDir: join(home, '.botmux', 'data'),
    });

    expect(result.renderedSql).toContain('today() - 30');
    expect(result.text).toContain('"amount": 12');
    expect(result.text).not.toContain('SELECT sum');
  });

  it('fails closed before opening Data MCP when the triggering identity is absent', async () => {
    const { root, definition } = fixture(BASE);
    await expect(executeFrozenCommand({
      definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'] },
      trustedCaller: undefined,
      turnId: 'schedule:ownerless',
      dataDir: join(root, 'data'),
    })).rejects.toMatchObject({ code: 'untrusted_caller' });
  });

  it('only permits model fallback for explicitly transient failures', () => {
    const { definition } = fixture(BASE);
    expect(shouldFallbackFrozenCommand(
      definition,
      new FrozenCommandError('data_mcp_unavailable', 'down', undefined, true),
    )).toBe(true);
    expect(shouldFallbackFrozenCommand(
      definition,
      new FrozenCommandError('untrusted_caller', 'denied'),
    )).toBe(false);
    expect(isTransientDataMcpFailure('connection closed by peer')).toBe(true);
    expect(isTransientDataMcpFailure('Unknown identifier amount after schema migration')).toBe(true);
    expect(isTransientDataMcpFailure('memory limit exceeded')).toBe(false);
    expect(isTransientDataMcpFailure('sql_guard rejected non-select statement')).toBe(false);
    expect(userFacingFrozenCommandError(
      new FrozenCommandError('data_mcp_validate_failed', 'bad near SELECT secret FROM t'),
    )).not.toContain('SELECT secret');
  });

  it('rejects a command definition symlink instead of escaping the role directory', () => {
    const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(root);
    mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
    const outside = join(root, 'outside.yaml');
    writeFileSync(outside, BASE);
    symlinkSync(outside, join(root, '.botmux', 'commands', '泰国上账.yaml'));
    const result = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.error.code).toBe('definition_file_invalid');
  });
});
