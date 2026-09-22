import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  FrozenCommandError,
  executeFrozenCommand,
  evaluateFrozenCommandOutputCondition,
  frozenCommandUsage,
  frozenCommandResultText,
  listFrozenCommandSnapshots,
  lookupFrozenCommand,
  isTransientDataMcpFailure,
  normalizeFrozenCommandName,
  normalizeFrozenCommandArguments,
  renderFrozenCommandSql,
  resolveFrozenCommandScheduledOutput,
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
schemaVersion: 2
name: 泰国上账
description: 查询泰国最近 N 天的上账金额
executor: builtin.data-mcp.readonly
timezone: Asia/Bangkok
params:
  - name: days
    label: 天数
    type: integer
    min: 1
    max: 90
    default: 7
input:
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

  it('rejects legacy schemaVersion 1 command definitions', () => {
    const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(root);
    mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
    writeFileSync(
      join(root, '.botmux', 'commands', '泰国上账.yaml'),
      BASE.replace('schemaVersion: 2', 'schemaVersion: 1'),
    );
    const result = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.error.code).toBe('definition_version_unsupported');
      expect(result.error.message).toContain('仅支持 schemaVersion=2');
    }
  });

  it('renders the documented positional parameter and default', () => {
    const { definition } = fixture(BASE);
    expect(frozenCommandUsage(definition)).toBe('/泰国上账 [天数]');
    expect(renderFrozenCommandSql({ definition, rawArgs: '' }).sql).toContain('today() - 7');
    expect(renderFrozenCommandSql({ definition, rawArgs: '30' }).sql).toContain('today() - 30');
    expect(normalizeFrozenCommandArguments({ definition, rawArgs: '30' }).args).toEqual([
      { name: 'days', label: '天数', value: '30' },
    ]);
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

  it('renders only business rows from Data MCP results before replying', () => {
    const displayed = frozenCommandResultText({
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          query_id: 'q_internal',
          datasource: 'tchouse-c',
          sql: 'SELECT secret FROM t',
          columns: [{ name: 'amount', description: '金额', type: 'UInt64' }],
          rows: [{ amount: 12 }],
          execution_ms: 106,
          sql_account_binding: { account_bound: true },
          repair_chain_id: 'repair_internal',
          query_plan_execution_mode: 'single',
        }),
      }],
    });
    expect(displayed).toBe('12');
    expect(displayed).not.toContain('q_internal');
    expect(displayed).not.toContain('tchouse-c');
    expect(displayed).not.toContain('SELECT secret');
    expect(displayed).not.toContain('execution_ms');
    expect(displayed).not.toContain('account_bound');
    expect(displayed).not.toContain('repair_internal');
    expect(displayed).not.toContain('query_plan');
  });

  it('evaluates conditional output fail-closed and marks handoff truncation explicitly', () => {
    const conditional = BASE.replace(
      '  prefix: "查询结果：\\n"\n  maxChars: 20000',
      `  maxChars: 20000
  when: "{{q.max_drop}} > 0.2"
  handoff:
    prompt: "以下数据出现异常，请分析原因"
    data: "{{q.rows}}"
    maxRows: 1
  else:
    text: "今日正常，合计 {{q.total}}"`,
    );
    const { definition } = fixture(conditional);
    const result = {
      renderedSql: 'SELECT 1',
      referenceDate: '2026-09-21',
      text: '原始结果',
      truncated: false,
      businessResult: {
        rows: [
          { max_drop: 0.3, total: 120, country: 'TH' },
          { max_drop: 0.1, total: 80, country: 'SG' },
        ],
        totalRows: 2,
      },
    };
    expect(evaluateFrozenCommandOutputCondition(definition.output.when!, result)).toBe(true);
    const handoff = resolveFrozenCommandScheduledOutput(definition, result);
    expect(handoff.kind).toBe('handoff');
    if (handoff.kind === 'handoff') {
      expect(handoff.prompt).toContain('以下数据出现异常');
      expect(handoff.prompt).toContain('"country":"TH"');
      expect(handoff.prompt).not.toContain('"country":"SG"');
      expect(handoff.prompt).toContain('共 2 行，已截断为前 1 行');
    }
    const charLimited = resolveFrozenCommandScheduledOutput({
      ...definition,
      output: { ...definition.output, maxChars: 100 },
    }, {
      ...result,
      businessResult: {
        rows: [
          { max_drop: 0.3, total: 120, country: 'X'.repeat(500) },
          { max_drop: 0.1, total: 80, country: 'SG' },
        ],
        totalRows: 2,
      },
    });
    expect(charLimited.kind).toBe('handoff');
    if (charLimited.kind === 'handoff') {
      expect(charLimited.prompt).toContain('共 2 行，已截断为前 1 行');
      expect(charLimited.prompt).toContain('字符上限');
    }

    const normal = resolveFrozenCommandScheduledOutput(definition, {
      ...result,
      businessResult: { rows: [{ max_drop: 0.1, total: 120 }], totalRows: 1 },
    });
    expect(normal).toEqual({ kind: 'deliver', text: '今日正常，合计 120' });

    expect(() => resolveFrozenCommandScheduledOutput(definition, {
      ...result,
      businessResult: { rows: [{ total: 120 }], totalRows: 1 },
    })).toThrowError(/q\.max_drop/);
    expect(() => resolveFrozenCommandScheduledOutput(definition, {
      ...result,
      businessResult: undefined,
    })).toThrowError(/结果缺失或格式异常/);
    expect(() => evaluateFrozenCommandOutputCondition('not-an-expression', result))
      .toThrowError(/条件表达式/);
  });

  it('rejects incomplete conditional output definitions', () => {
    const partial = BASE.replace(
      '  maxChars: 20000',
      '  maxChars: 20000\n  when: "{{q.amount}} > 10"',
    );
    const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(root);
    mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), partial);
    const lookup = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
    expect(lookup.kind).toBe('invalid');
    if (lookup.kind === 'invalid') expect(lookup.error.code).toBe('definition_invalid_output');
  });

  it('uses column descriptions for multi-value rows and handles empty results', () => {
    expect(frozenCommandResultText({
      structuredContent: {
        columns: [
          { name: 'merchant_name', description: '商户' },
          { name: 'amount', description: '金额' },
        ],
        rows: [{ merchant_name: 'A', amount: 12 }],
      },
    })).toBe('商户：A；金额：12');
    expect(frozenCommandResultText({
      content: [{ type: 'text', text: JSON.stringify({ status: 'success', rows: [] }) }],
    })).toBe('查询完成，未找到符合条件的数据。');
    expect(frozenCommandResultText({
      content: [{ type: 'text', text: 'opaque internal response' }],
    })).toBe('查询已完成。');
    expect(frozenCommandResultText({
      content: [{ type: 'text', text: JSON.stringify({ query_id: 'q_internal', rows: { amount: 12 } }) }],
    })).toBe('查询已完成。');
    expect(frozenCommandResultText({
      structuredContent: { rows: ['query_id=q_secret'] },
    })).toBe('查询已完成。');
    expect(frozenCommandResultText({
      structuredContent: { rows: [{ result: { query_id: 'q_secret' } }] },
    })).toBe('查询已完成。');
    expect(frozenCommandResultText({
      structuredContent: { rows: [{}] },
    })).toBe('查询已完成。');
    expect(frozenCommandResultText({
      structuredContent: {
        rows: [
          { merchant: 'A', amount: 12 },
          { merchant: '<at id=all></at>B\r\n2. forged', amount: 20 },
        ],
      },
    })).toBe('1. merchant：A；amount：12\n2. merchant：[mention]B 2. forged；amount：20');
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
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
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
    expect(result.text).toContain('12');
    expect(result.text).not.toContain('amount');
    expect(result.text).not.toContain('SELECT sum');
  });

  it('fails closed before opening Data MCP when the triggering identity is absent', async () => {
    const { root, definition } = fixture(BASE);
    await expect(executeFrozenCommand({
      definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: undefined,
      turnId: 'schedule:ownerless',
      dataDir: join(root, 'data'),
    })).rejects.toMatchObject({ code: 'untrusted_caller' });
  });

  it('preserves a normal MCP business failure instead of masking it as query_plan_missing', async () => {
    const validationErrorDefinition = BASE.replace(
      'SELECT sum(amount) FROM bills',
      "SELECT 'RETURN_VALIDATION_ERROR'",
    );
    const { root, definition } = fixture(validationErrorDefinition);
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
    }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
    installLocalPlugin(source);

    await expect(executeFrozenCommand({
      definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_turn',
      dataDir: join(home, '.botmux', 'data'),
    })).rejects.toMatchObject({
      code: 'data_mcp_validate_failed',
      message: expect.stringContaining('query_plan_session_required'),
    });
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
    expect(userFacingFrozenCommandError(
      new FrozenCommandError('data_mcp_validate_failed', 'bad near SELECT secret FROM t'),
    )).not.toContain('data_mcp_validate_failed');
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
