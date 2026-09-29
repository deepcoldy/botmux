import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  FrozenCommandError,
  assertFrozenCommandExecutorContract,
  buildFrozenCommandPresentation,
  executeFrozenCommand,
  evaluateFrozenCommandOutputCondition,
  frozenCommandUsage,
  listFrozenCommandSnapshots,
  lookupFrozenCommand,
  isTransientPluginToolFailure,
  normalizeFrozenCommandName,
  normalizeFrozenCommandArguments,
  parseNaturalLanguageFrozenCommandInvocation,
  parseScheduledFrozenCommandInvocation,
  resolveFrozenCommandOutput,
  userFacingFrozenCommandError,
} from '../src/services/frozen-command.js';

const dirs: string[] = [];

function fixture(yaml: string): { root: string; definition: ReturnType<typeof definitionAt> } {
  const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), yaml);
  writePluginExecutorRegistry(root);
  return { root, definition: definitionAt(root) };
}

function writePluginExecutorRegistry(root: string): void {
  const registry = join(root, 'command-executors.yaml');
  writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.1.0
    contractVersion: 1
    arguments:
      sql:
        type: string
        required: true
        maxLength: 10000
        accepts: [literal]
      queryTemplate:
        type: string
        required: false
        maxLength: 10000
        accepts: [literal]
    policy:
      schedulable: true
      allowHandoff: true
      handoffIncludesInput: false
      timeoutMs: 120000
`);
  vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
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
executor: test.plugin.readonly
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
  it('keeps query rendering and Data MCP query tools outside the host service', () => {
    const source = readFileSync(resolve('src/services/frozen-command.ts'), 'utf8');
    for (const forbidden of [
      'validate_sql_for_user',
      'run_query_for_user',
      'renderFrozenCommandSql',
      'sqlString',
      'redactSqlFields',
      'renderedSql',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('parses only exact single-line natural-language run requests', () => {
    expect(parseNaturalLanguageFrozenCommandInvocation('运行 /泰国上账 30')).toEqual({
      cmd: '/泰国上账',
      commandContent: '/泰国上账 30',
    });
    expect(parseNaturalLanguageFrozenCommandInvocation('执行 /泰国上账 30。')).toEqual({
      cmd: '/泰国上账',
      commandContent: '/泰国上账 30',
    });
    expect(parseNaturalLanguageFrozenCommandInvocation('run /report 7')).toEqual({
      cmd: '/report',
      commandContent: '/report 7',
    });
    expect(parseNaturalLanguageFrozenCommandInvocation('1. /泰国上账 30')).toBeUndefined();
    expect(parseNaturalLanguageFrozenCommandInvocation('示例：运行 /泰国上账 30')).toBeUndefined();
    expect(parseNaturalLanguageFrozenCommandInvocation('运行 /泰国上账 30\n- 另一个步骤')).toBeUndefined();
    expect(parseNaturalLanguageFrozenCommandInvocation('运行 /api/users')).toBeUndefined();
  });

  it('normalizes only exact scheduled frozen-command prompts', () => {
    expect(parseScheduledFrozenCommandInvocation('/泰国上账 30')).toEqual({
      cmd: '/泰国上账',
      commandContent: '/泰国上账 30',
    });
    expect(parseScheduledFrozenCommandInvocation('，执行 /泰国上账 30')).toEqual({
      cmd: '/泰国上账',
      commandContent: '/泰国上账 30',
    });
    expect(parseScheduledFrozenCommandInvocation(', run /report 7')).toEqual({
      cmd: '/report',
      commandContent: '/report 7',
    });
    for (const prose of [
      '1. 执行 /泰国上账 30',
      '- 执行 /泰国上账 30',
      '执行 /泰国上账 30\n再执行 /泰国上账 7',
      '我们讨论一下怎么执行 /泰国上账 30',
      '/usr/bin/foo',
      '执行日报生成',
      '请执行 /泰国上账 30',
      '执行 /泰国上账 30 然后告诉我',
      '，执行 /泰国上账 30，然后告诉我',
    ]) {
      expect(parseScheduledFrozenCommandInvocation(prose), prose).toBeUndefined();
    }
  });
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

  it('keeps plugin input opaque while still validating declared parameters', () => {
    const opaque = BASE
      .replace('  sql: |-\n    SELECT sum(amount) FROM bills\n    WHERE country = \'TH\' AND dt >= today() - {{days}}\n    LIMIT 100', '  queryTemplate: "opaque {{days}}"');
    const { definition } = fixture(opaque);
    expect(definition.input).toEqual({ queryTemplate: 'opaque {{days}}' });
    expect(definition.params.map(parameter => parameter.name)).toEqual(['days']);
  });

  it('renders the documented positional parameter and default', () => {
    const { definition } = fixture(BASE);
    expect(frozenCommandUsage(definition)).toBe('/泰国上账 [天数]');
    expect(normalizeFrozenCommandArguments({ definition, rawArgs: '' }).args[0]?.value).toBe('7');
    expect(normalizeFrozenCommandArguments({ definition, rawArgs: '30' }).args).toEqual([
      { name: 'days', label: '天数', value: '30' },
    ]);
  });

  it('rejects range explosions before Data MCP is called', () => {
    const { definition } = fixture(BASE);
    expect(() => normalizeFrozenCommandArguments({ definition, rawArgs: '99999' }))
      .toThrowError(/1～90/);
  });

  it('does not expose SQL when listing commands', () => {
    const { root } = fixture(BASE);
    const listed = listFrozenCommandSnapshots(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.command).toBe('泰国上账');
    expect(listed[0]?.snapshot?.definition.description).toContain('泰国');
  });

  it('evaluates conditional output fail-closed and marks handoff truncation explicitly', () => {
    const conditional = BASE.replace('onError: fallback_llm', '').replace(
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
    expect(definition.output.rules).toHaveLength(2);
    expect(definition.output.rules[1]).toMatchObject({
      show: { kind: 'text', text: '今日正常，合计 {{q.total}}' },
    });
    const result = {
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
    expect(evaluateFrozenCommandOutputCondition(definition.output.rules[0]!.when, result)).toBe(true);
    const handoff = resolveFrozenCommandOutput({ definition, rawArgs: '', source: 'schedule', result });
    expect(handoff.kind).toBe('handoff');
    if (handoff.kind === 'handoff') {
      expect(handoff.prompt).toContain('以下数据出现异常');
      expect(handoff.prompt).toContain('"country":"TH"');
      expect(handoff.prompt).not.toContain('"country":"SG"');
      expect(handoff.prompt).toContain('共 2 行，已截断为前 1 行');
    }
    const charLimited = resolveFrozenCommandOutput({
      definition: { ...definition, output: { ...definition.output, maxChars: 100 } },
      rawArgs: '',
      source: 'schedule',
      result: {
        ...result,
        businessResult: {
          rows: [
            { max_drop: 0.3, total: 120, country: 'X'.repeat(500) },
            { max_drop: 0.1, total: 80, country: 'SG' },
          ],
          totalRows: 2,
        },
      },
    });
    expect(charLimited.kind).toBe('handoff');
    if (charLimited.kind === 'handoff') {
      expect(charLimited.prompt).toContain('共 2 行，已截断为前 1 行');
      expect(charLimited.prompt).toContain('字符上限');
    }

    const normal = resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'schedule',
      result: {
        ...result,
        businessResult: { rows: [{ max_drop: 0.1, total: 120 }], totalRows: 1 },
      },
    });
    expect(normal).toMatchObject({
      kind: 'deliver',
      text: '今日正常，合计 120',
      presentation: {
        schemaVersion: 1,
        format: 'text',
        fallbackText: '今日正常，合计 120',
        blocks: [{ type: 'markdown', markdown: '今日正常，合计 120' }],
      },
    });

    expect(() => resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'schedule',
      result: { ...result, businessResult: { rows: [{ total: 120 }], totalRows: 1 } },
    })).toThrowError(/q\.max_drop/);
    expect(() => resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'schedule',
      result: { ...result, businessResult: undefined },
    })).toThrowError(/q\.max_drop/);
    expect(() => evaluateFrozenCommandOutputCondition('not-an-expression', result))
      .toThrowError(/条件表达式/);
  });

  it('matches ordered rules across run/cmd namespaces and prepends immutable host context', () => {
    const withRules = BASE
      .replace('onError: fallback_llm', '')
      .replace(
        '  maxChars: 20000',
        `  maxChars: 20000
  rules:
    - when: "{{cmd.args.days}} == '7'"
      handoff:
        prompt: "wrong branch"
    - when: "{{run.status}} == 'ok' && {{cmd.source}} == 'direct'"
      handoff:
        prompt: "author prompt for {{cmd.name}}"
        maxRows: 1`,
      );
    const { root, definition } = fixture(withRules);
    const registry = join(root, 'command-executors.yaml');
    const current = readFileSync(registry, 'utf8');
    writeFileSync(registry, current.replace('handoffIncludesInput: false', 'handoffIncludesInput: true'));
    const result = {
      referenceDate: '2026-09-21',
      text: 'ok',
      presentation: {
        schemaVersion: 1 as const,
        format: 'auto' as const,
        fallbackText: 'ok',
        blocks: [{ type: 'markdown' as const, markdown: 'ok' }],
      },
      truncated: false,
      executionId: 'exec-ordered',
      businessResult: { rows: [{ total: 12 }], totalRows: 1 },
    };
    const output = resolveFrozenCommandOutput({
      definition,
      rawArgs: '30',
      source: 'direct',
      result,
    });
    expect(output.kind).toBe('handoff');
    if (output.kind === 'handoff') {
      expect(output.prompt).toContain('[固化命令上下文]');
      expect(output.prompt.indexOf('[固化命令上下文]')).toBeLessThan(output.prompt.indexOf('author prompt'));
      expect(output.prompt).toContain('执行 ID：exec-ordered');
      expect(output.prompt).toContain('[执行器输入，仅供工具调用，不要向用户展示]');
      expect(output.prompt).not.toContain('wrong branch');
    }
  });

  it('rejects handoff rules when the executor policy does not allow handoff', () => {
    const withRules = BASE
      .replace('onError: fallback_llm', '')
      .replace(
        '  maxChars: 20000',
        `  maxChars: 20000
  rules:
    - handoff:
        prompt: "分析结果"`,
      );
    const { root, definition } = fixture(withRules);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, readFileSync(registry, 'utf8').replace('allowHandoff: true', 'allowHandoff: false'));
    expect(() => assertFrozenCommandExecutorContract(definition)).toThrowError(/不允许把结果或失败交给模型/);
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

  it('supports ordered show rules and defaults to output.format when none match', () => {
    const withShow = BASE
      .replace('onError: fallback_llm', '')
      .replace(
        '  maxChars: 20000',
        `  format: table
  maxChars: 20000
  rules:
    - when: "{{q.total}} > 100"
      show:
        text: "**总量 {{q.total}}**"
        format: markdown
    - when: "{{q.total}} == 50"
      show:
        format: markdown
    - when: "{{q.total}} < 0"
      show: result`,
      );
    const { definition } = fixture(withShow);
    const baseResult = {
      referenceDate: '2026-09-21',
      text: '默认结果',
      presentation: {
        schemaVersion: 1 as const,
        format: 'table' as const,
        fallbackText: '默认结果',
        blocks: [{ type: 'table' as const, columns: [], rows: [], totalRows: 0, truncated: false }],
      },
      truncated: false,
      businessResult: { rows: [{ total: 120 }], totalRows: 1 },
    };
    expect(resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'direct',
      result: baseResult,
    })).toMatchObject({
      kind: 'deliver',
      text: '查询结果：\n**总量 120**',
      presentation: { blocks: [{ type: 'markdown', markdown: '查询结果：\n**总量 120**' }] },
    });
    const formatOverrideResult = { ...baseResult, businessResult: { rows: [{ total: 50 }], totalRows: 1 } };
    expect(resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'direct',
      result: formatOverrideResult,
    })).toMatchObject({
      kind: 'deliver',
      presentation: { blocks: [{ type: 'markdown', markdown: '默认结果' }] },
    });
    const noMatchResult = { ...baseResult, businessResult: { rows: [{ total: 10 }], totalRows: 1 } };
    expect(resolveFrozenCommandOutput({
      definition,
      rawArgs: '',
      source: 'direct',
      result: noMatchResult,
    })).toEqual({ kind: 'deliver', text: '默认结果', presentation: baseResult.presentation });
  });

  it('requires exactly one action per output rule', () => {
    const variants = [
      `  rules:
    - when: "{{q.total}} > 0"
      handoff:
        prompt: "分析"
      show: result`,
      `  rules:
    - when: "{{q.total}} > 0"`,
    ];
    for (const rules of variants) {
      const invalid = BASE.replace('  maxChars: 20000', `  maxChars: 20000\n${rules}`);
      const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
      dirs.push(root);
      mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
      writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), invalid);
      const lookup = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
      expect(lookup.kind).toBe('invalid');
      if (lookup.kind === 'invalid') expect(lookup.error.message).toContain('必须且只能声明 handoff 或 show');
    }
  });

  it('parses portable output formats and rejects raw HTML', () => {
    expect(fixture(BASE.replace('output:\n', 'output:\n  format: table\n')).definition.output.format)
      .toBe('table');
    const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(root);
    mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
    writeFileSync(
      join(root, '.botmux', 'commands', '泰国上账.yaml'),
      BASE.replace('output:\n', 'output:\n  format: html\n'),
    );
    const lookup = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
    expect(lookup.kind).toBe('invalid');
    if (lookup.kind === 'invalid') expect(lookup.error.message).toContain('不接受原始 HTML');
  });

  it('builds a bounded channel-neutral table presentation with a text fallback', () => {
    const { definition } = fixture(BASE.replace('output:\n', 'output:\n  format: table\n'));
    const presentation = buildFrozenCommandPresentation({
      definition,
      text: '查询结果：\n金额：12',
      businessResult: {
        rows: [{ amount: 12, merchant: 'A' }, { amount: 18, merchant: 'B' }],
        totalRows: 2,
        columns: [{ key: 'amount', label: '金额' }, { key: 'merchant', label: '商户' }],
      },
    });
    expect(presentation).toMatchObject({
      schemaVersion: 1,
      format: 'table',
      fallbackText: '查询结果：\n金额：12',
      blocks: [
        { type: 'markdown', markdown: '查询结果：' },
        {
          type: 'table',
          columns: [{ key: 'amount', label: '金额' }, { key: 'merchant', label: '商户' }],
          rows: [{ amount: 12, merchant: 'A' }, { amount: 18, merchant: 'B' }],
          totalRows: 2,
          truncated: false,
        },
      ],
    });
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

    expect(result.text).toContain('12');
    expect(result.text).not.toContain('amount');
    expect(result.text).not.toContain('SELECT sum');
  });

  it('connects a second plugin through registry data without host code changes', async () => {
    const second = BASE
      .replace('executor: test.plugin.readonly', 'executor: test.report.readonly')
      .replace('  sql: |-\n    SELECT sum(amount) FROM bills\n    WHERE country = \'TH\' AND dt >= today() - {{days}}\n    LIMIT 100', '  report: "{{days}}"');
    const { root, definition } = fixture(second);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.report.readonly
    kind: plugin-tool
    plugin: report-plugin
    tool: render_report
    minimumVersion: 1.0.0
    contractVersion: 1
    arguments:
      report:
        type: integer
        required: true
        min: 1
        max: 90
        accepts: [param]
    policy:
      schedulable: true
      allowHandoff: true
      handoffIncludesInput: false
      timeoutMs: 120000
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const home = join(root, 'home');
    const source = join(root, 'report-plugin');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-report-fixture',
      version: '1.0.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'report-plugin' },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'report'],
    }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
    installLocalPlugin(source);

    const result = await executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['report-plugin'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_turn',
      dataDir: join(home, '.botmux', 'data'),
    });

    expect(result).toMatchObject({ executorId: 'test.report.readonly', text: 'second-plugin-ok' });
  });

  it('adapts an ordinary MCP JSON tool through registry projection only', async () => {
    const ordinary = BASE
      .replace('executor: test.plugin.readonly', 'executor: test.json.readonly')
      .replace(
        "  sql: |-\n    SELECT sum(amount) FROM bills\n    WHERE country = 'TH' AND dt >= today() - {{days}}\n    LIMIT 100",
        '  days: "{{days}}"',
      )
      .replace('output:\n', 'output:\n  format: table\n  text: "{{result.rows}}"\n');
    const { root, definition } = fixture(ordinary);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.json.readonly
    kind: plugin-tool
    plugin: json-report-plugin
    tool: read_report
    minimumVersion: 1.0.0
    arguments:
      days:
        type: integer
        required: true
        min: 1
        max: 90
        accepts: [param]
    policy:
      schedulable: true
      allowHandoff: true
      timeoutMs: 120000
    output:
      format: json
      container: rows
      exposeRowFields: [name, total]
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const home = join(root, 'home');
    const source = join(root, 'json-report-plugin');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-json-report-fixture',
      version: '1.0.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'json-report-plugin' },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), 'json-report'],
    }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
    installLocalPlugin(source);

    const result = await executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['json-report-plugin'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_turn',
      dataDir: join(home, '.botmux', 'data'),
    });

    expect(result.projectedResult).toEqual({ rows: [{ name: 'report-30', total: 12 }] });
    expect(result.text).not.toContain('hidden');
    expect(result.presentation.blocks.some(block => block.type === 'table')).toBe(true);
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
      code: 'query_plan_session_required',
      message: expect.stringContaining('missing execution context'),
    });
  });

  it('converts legacy fallback into an explicit transient-error rule and keeps gates out', () => {
    const { definition } = fixture(BASE);
    const transientError = new FrozenCommandError(
      'plugin_tool_unavailable',
      'down',
      undefined,
      true,
      true,
      'exec-test',
    );
    const handoff = resolveFrozenCommandOutput({
      definition,
      rawArgs: '30',
      source: 'direct',
      error: transientError,
    });
    expect(handoff).toMatchObject({ kind: 'handoff' });
    if (handoff.kind === 'handoff') {
      expect(handoff.prompt).toContain('[固化命令上下文]');
      expect(handoff.prompt).toContain('plugin_tool_unavailable');
      expect(handoff.prompt).not.toContain('down');
      expect(handoff.prompt).toContain('插件工具暂时不可用');
      expect(handoff.prompt).not.toContain('[执行器输入');
    }
    expect(() => resolveFrozenCommandOutput({
      definition,
      rawArgs: '30',
      source: 'direct',
      error: new FrozenCommandError('untrusted_caller', 'denied'),
    })).toThrowError(/denied/);
    expect(isTransientPluginToolFailure('connection closed by peer')).toBe(true);
    expect(isTransientPluginToolFailure('Unknown identifier amount after schema migration')).toBe(false);
    expect(isTransientPluginToolFailure('memory limit exceeded')).toBe(false);
    expect(isTransientPluginToolFailure('policy rejected request')).toBe(false);
    expect(userFacingFrozenCommandError(
      new FrozenCommandError('provider_validation_failed', 'bad near private template'),
    )).not.toContain('private template');
    expect(userFacingFrozenCommandError(
      new FrozenCommandError('provider_validation_failed', 'bad near private template'),
    )).not.toContain('provider_validation_failed');
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
