import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  FrozenCommandError,
  assertFrozenCommandExecutorContract,
  executeFrozenCommand,
  frozenCommandExecutorRevision,
  frozenCommandUsage,
  isTransientPluginToolFailure,
  listFrozenCommandSnapshots,
  lookupFrozenCommand,
  normalizeFrozenCommandArguments,
  normalizeFrozenCommandName,
  parseNaturalLanguageFrozenCommandInvocation,
  parseScheduledFrozenCommandInvocation,
  resolveFrozenCommandOutput,
  sanitizeFrozenCommandMarkdown,
  userFacingFrozenCommandError,
} from '../src/services/frozen-command.js';

const dirs: string[] = [];

const BASE = `
schemaVersion: 2
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
steps:
  - id: main
    executor: test.plugin.readonly
    input:
      sql: |-
        SELECT sum(amount) FROM bills
        WHERE country = 'TH' AND dt >= today() - {{days}}
        LIMIT 100
    renderer: builtin.table
output:
  format: markdown
`;

function writeRegistry(root: string, extra = ''): string {
  const registry = join(root, 'command-executors.yaml');
  writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.1.0
    arguments:
      sql:
        type: string
        required: true
        maxLength: 10000
        accepts: [literal]
    output:
      container: rows
      exposeRowFields: [amount]
      labelsFrom: columns
      totalRowsField: row_count
      auditFields: [query_id]
      errorField: error_code
    policy:
      schedulable: true
      allowHandoff: true
      handoffIncludesInput: false
      timeoutMs: 120000
${extra}`);
  vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
  return registry;
}

function fixture(yaml = BASE): { root: string; definition: NonNullable<ReturnType<typeof definitionAt>> } {
  const root = join(tmpdir(), `botmux-frozen-${process.pid}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), yaml);
  writeRegistry(root);
  const definition = definitionAt(root);
  if (!definition) throw new Error('fixture definition is invalid');
  return { root, definition };
}

function definitionAt(root: string) {
  const result = lookupFrozenCommand({ workingDir: root, command: '/泰国上账' });
  return result.kind === 'found' ? result.snapshot.definition : undefined;
}

function installFixturePlugin(root: string, pluginId: string, mode: string, version = '1.0.0'): string {
  const home = join(root, 'home');
  const source = join(root, `${pluginId}-plugin`);
  mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: `@botmux-ai/plugin-${pluginId}`,
    version,
    type: 'module',
    keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id: pluginId },
  }));
  writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
    transport: 'stdio',
    command: [process.execPath, resolve('test/fixtures/plugin-mcp-server.mjs'), mode],
  }));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SESSION_DATA_DIR', join(home, '.botmux', 'data'));
  installLocalPlugin(source);
  return home;
}

function successResult(total = 120) {
  return {
    referenceDate: '2026-09-29',
    text: `amount：${total}`,
    presentation: {
      schemaVersion: 1 as const,
      format: 'markdown' as const,
      fallbackText: `amount：${total}`,
      blocks: [{ type: 'markdown' as const, markdown: `amount：${total}` }],
    },
    truncated: false,
    executionId: 'exec-v2',
    projectedResult: { amount: total, row_count: 1 },
    businessResult: { rows: [{ amount: total }], totalRows: 1 },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Frozen Commands v2', () => {
  it('keeps SQL rendering and Data MCP query tools outside the host service', () => {
    const source = readFileSync(resolve('src/services/frozen-command.ts'), 'utf8');
    for (const forbidden of ['validate_sql_for_user', 'run_query_for_user', 'renderFrozenCommandSql', 'sqlString', 'contractVersion']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('parses only exact direct and scheduled invocation forms', () => {
    expect(parseNaturalLanguageFrozenCommandInvocation('运行 /泰国上账 30')).toEqual({ cmd: '/泰国上账', commandContent: '/泰国上账 30' });
    expect(parseNaturalLanguageFrozenCommandInvocation('run /report 7')).toEqual({ cmd: '/report', commandContent: '/report 7' });
    expect(parseNaturalLanguageFrozenCommandInvocation('示例：运行 /泰国上账 30')).toBeUndefined();
    expect(parseScheduledFrozenCommandInvocation('/泰国上账 30')).toEqual({ cmd: '/泰国上账', commandContent: '/泰国上账 30' });
    expect(parseScheduledFrozenCommandInvocation('，执行 /泰国上账 30')).toEqual({ cmd: '/泰国上账', commandContent: '/泰国上账 30' });
    expect(parseScheduledFrozenCommandInvocation('执行 /泰国上账 30，然后告诉我')).toBeUndefined();
  });

  it('normalizes names and positional arguments', () => {
    const { definition } = fixture();
    expect(normalizeFrozenCommandName('/泰国上账')).toBe('泰国上账');
    expect(normalizeFrozenCommandName('/ＴＥＳＴ')).toBe('test');
    expect(normalizeFrozenCommandName('../泰国上账')).toBeUndefined();
    expect(frozenCommandUsage(definition)).toBe('/泰国上账 [天数]');
    expect(normalizeFrozenCommandArguments({ definition, rawArgs: '' }).args[0]?.value).toBe('7');
    expect(() => normalizeFrozenCommandArguments({ definition, rawArgs: '999' })).toThrowError(/1～90/);
  });

  it('uses steps[] and keeps executor input opaque', () => {
    const { definition } = fixture(BASE.replace(/sql: \|-\n[\s\S]*?LIMIT 100/u, 'queryTemplate: "opaque {{days}}"'));
    expect(definition.steps).toEqual([expect.objectContaining({
      id: 'main',
      executor: 'test.plugin.readonly',
      input: { queryTemplate: 'opaque {{days}}' },
      renderer: 'builtin.table',
      required: false,
    })]);
  });

  it('loads the documented command example in both languages', () => {
    for (const locale of ['zh', 'en']) {
      const documentation = readFileSync(resolve(`docs-site/docs/${locale}/frozen-commands.md`), 'utf8');
      const blocks = [...documentation.matchAll(/```yaml\n([\s\S]*?)\n```/gu)].map(match => match[1]!);
      const yaml = blocks.find(block => block.includes('\nsteps:') && block.includes('data.query.readonly'));
      if (!yaml) throw new Error(`missing command example in ${locale} documentation`);
      const name = /^name:\s*([^\n#]+)/mu.exec(yaml)?.[1]?.trim();
      if (!name) throw new Error(`missing command name in ${locale} documentation`);
      const root = join(tmpdir(), `botmux-frozen-doc-${locale}-${process.pid}-${Math.random().toString(36).slice(2)}`);
      dirs.push(root);
      mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
      writeFileSync(join(root, '.botmux', 'commands', `${name}.yaml`), yaml);
      writeFileSync(join(root, 'command-executors.yaml'), `
schemaVersion: 2
executors:
  - id: data.query.readonly
    kind: plugin-tool
    plugin: data-mcp
    tool: execute_frozen_query
    minimumVersion: 0.4.0
    arguments:
      sql: {type: string, required: true, maxLength: 100000, accepts: [literal]}
    output:
      container: rows
      exposeRowFields: [dt, 渠道, 注册数]
      labelsFrom: columns
      totalRowsField: row_count
      auditFields: [query_id]
      errorField: error_code
    policy: {schedulable: true, allowHandoff: false, timeoutMs: 120000}
`);
      vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', join(root, 'command-executors.yaml'));
      expect(lookupFrozenCommand({ workingDir: root, command: `/${name}` }).kind).toBe('found');
    }
  });

  it('rejects schema v1, multi-step batch-one definitions, and every removed field', () => {
    const variants = [
      BASE.replace('schemaVersion: 2', 'schemaVersion: 1'),
      BASE.replace('steps:\n', 'executor: test.plugin.readonly\nsteps:\n'),
      BASE.replace('steps:\n', 'input: {}\nsteps:\n'),
      BASE.replace('  format: markdown', '  format: table'),
      BASE.replace('  format: markdown', '  format: auto'),
      BASE.replace('  format: markdown', '  format: markdown\n  text: legacy'),
      BASE.replace('  format: markdown', '  format: markdown\n  prefix: legacy'),
      BASE.replace('  format: markdown', '  format: markdown\n  suffix: legacy'),
      BASE.replace('  format: markdown', '  format: markdown\n  else: legacy'),
      `${BASE}\nonError: fail\n`,
      BASE.replace('output:\n', `steps:\n  - id: second\n    executor: test.plugin.readonly\n    input: {sql: SELECT 1}\n    renderer: builtin.table\noutput:\n`),
    ];
    for (const [index, yaml] of variants.entries()) {
      const root = join(tmpdir(), `botmux-frozen-invalid-${process.pid}-${index}-${Math.random().toString(36).slice(2)}`);
      dirs.push(root);
      mkdirSync(join(root, '.botmux', 'commands'), { recursive: true });
      writeFileSync(join(root, '.botmux', 'commands', '泰国上账.yaml'), yaml);
      expect(lookupFrozenCommand({ workingDir: root, command: '/泰国上账' }).kind, String(index)).toBe('invalid');
    }
  });

  it('requires exactly one rule action and a step-qualified q namespace', () => {
    const invalid = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{q.main.amount}} > 0"
      handoff: { prompt: 分析 }
      show: result`);
    const invalidRoot = join(tmpdir(), `botmux-frozen-rule-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(invalidRoot);
    mkdirSync(join(invalidRoot, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(invalidRoot, '.botmux', 'commands', '泰国上账.yaml'), invalid);
    expect(lookupFrozenCommand({ workingDir: invalidRoot, command: '/泰国上账' }).kind).toBe('invalid');

    const unqualified = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{q.amount}} > 0"
      show: result`);
    const unqualifiedRoot = join(tmpdir(), `botmux-frozen-namespace-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(unqualifiedRoot);
    mkdirSync(join(unqualifiedRoot, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(unqualifiedRoot, '.botmux', 'commands', '泰国上账.yaml'), unqualified);
    expect(lookupFrozenCommand({ workingDir: unqualifiedRoot, command: '/泰国上账' }).kind).toBe('invalid');

    const legacyRunRoot = join(tmpdir(), `botmux-frozen-run-namespace-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(legacyRunRoot);
    mkdirSync(join(legacyRunRoot, '.botmux', 'commands'), { recursive: true });
    writeFileSync(join(legacyRunRoot, '.botmux', 'commands', '泰国上账.yaml'), BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{run.error.code}} == 'failed'"
      show: result`));
    expect(lookupFrozenCommand({ workingDir: legacyRunRoot, command: '/泰国上账' }).kind).toBe('invalid');
  });

  it('evaluates ordered q.main, run.main, run.status, and cmd rules', () => {
    const yaml = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{run.status}} == 'ok' && {{run.main.status}} == 'ok' && {{q.main.amount}} > 100"
      handoff:
        prompt: "分析 {{cmd.name}}"
        maxRows: 1
    - show: result`);
    const { definition } = fixture(yaml);
    const output = resolveFrozenCommandOutput({ definition, rawArgs: '30', source: 'direct', result: successResult() });
    expect(output.kind).toBe('handoff');
    if (output.kind === 'handoff') {
      expect(output.prompt).toContain('[固化命令上下文]');
      expect(output.prompt).toContain('分析 泰国上账');
      expect(output.prompt).toContain('执行 ID：exec-v2');
    }
  });

  it('supports Unicode projected field names in rules', () => {
    const yaml = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{q.main.注册数}} > 100"
      show: { text: "注册数 {{q.main.注册数}}" }
    - show: result`);
    const { definition } = fixture(yaml);
    const result = successResult() as ReturnType<typeof successResult> & {
      businessResult: { rows: Array<Record<string, number>>; totalRows: number };
    };
    result.businessResult = { rows: [{ 注册数: 120 }], totalRows: 1 };
    const output = resolveFrozenCommandOutput({ definition, rawArgs: '30', source: 'direct', result });
    expect(output).toMatchObject({ kind: 'deliver', text: '注册数 120' });
  });

  it('keeps gates out of handoff and maps execution errors to fixed text', () => {
    const yaml = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - when: "{{run.status}} == 'error'"
      handoff: { prompt: 请分析 }
    - show: result`);
    const { definition } = fixture(yaml);
    const gate = new FrozenCommandError('untrusted_caller', 'denied');
    expect(() => resolveFrozenCommandOutput({ definition, rawArgs: '', source: 'direct', error: gate })).toThrow(gate);
    const failure = new FrozenCommandError('plugin_tool_unavailable', 'private raw error', undefined, true, true, 'exec-error');
    const output = resolveFrozenCommandOutput({ definition, rawArgs: '', source: 'direct', error: failure });
    expect(output).toMatchObject({ kind: 'handoff' });
    if (output.kind === 'handoff') {
      expect(output.prompt).toContain('plugin_tool_unavailable');
      expect(output.prompt).not.toContain('private raw error');
    }
  });

  it('rejects handoff when executor policy denies it', () => {
    const yaml = BASE.replace('  format: markdown', `  format: markdown
  rules:
    - handoff: { prompt: 分析 }`);
    const { root, definition } = fixture(yaml);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, readFileSync(registry, 'utf8').replace('allowHandoff: true', 'allowHandoff: false'));
    expect(() => assertFrozenCommandExecutorContract(definition)).toThrowError(/不允许把结果或失败交给模型/);
  });

  it('applies display policy outside code fences without corrupting Vega-Lite JSON', () => {
    const markdown = '链接：[点我](https://evil.example) @all\n```vega-lite\n{"label":"<10 >5","who":"@all"}\n```';
    const safe = sanitizeFrozenCommandMarkdown(markdown);
    expect(safe).toContain('链接：点我 ＠all');
    expect(safe).toContain('{"label":"<10 >5","who":"＠all"}');
    expect(() => sanitizeFrozenCommandMarkdown('<script>alert(1)</script>')).toThrowError(/原始 HTML/);
  });

  it('hashes both executor and renderer revisions', () => {
    const { root, definition } = fixture();
    const renderer = join(root, 'renderer.mjs');
    writeFileSync(renderer, 'process.stdin.pipe(process.stdout);\n');
    const rendererRealpath = realpathSync(renderer);
    const registry = join(root, 'command-executors.yaml');
    writeFileSync(registry, `${readFileSync(registry, 'utf8')}
renderers:
  - id: test.renderer
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(rendererRealpath)}]
    scriptArtifacts: [${JSON.stringify(rendererRealpath)}]
    policy: { timeoutMs: 5000, maxInputBytes: 65536, maxOutputBytes: 65536 }
`);
    definition.steps[0]!.renderer = 'test.renderer';
    const before = frozenCommandExecutorRevision(definition);
    writeFileSync(renderer, 'process.stdout.write("changed");\n');
    const after = frozenCommandExecutorRevision(definition);
    expect(after).not.toBe(before);
  });

  it('runs a registered renderer and falls back to builtin.table when it fails', async () => {
    const { root, definition } = fixture();
    const renderer = join(root, 'renderer.mjs');
    writeFileSync(renderer, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  process.stdout.write('custom-renderer:' + payload.rows[0].amount);
});
`);
    const rendererRealpath = realpathSync(renderer);
    writeRegistry(root, `
renderers:
  - id: test.renderer
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(rendererRealpath)}]
    scriptArtifacts: [${JSON.stringify(rendererRealpath)}]
    policy: { timeoutMs: 5000, maxInputBytes: 65536, maxOutputBytes: 65536 }
`);
    definition.steps[0]!.renderer = 'test.renderer';
    const home = installFixturePlugin(root, 'data-mcp', 'data', '0.1.0');
    const execute = () => executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test', requestLarkAppId: 'cli_test', senderType: 'user' as const,
      },
      turnId: 'om_turn', dataDir: join(home, '.botmux', 'data'), workingDir: root,
    });

    await expect(execute()).resolves.toMatchObject({ text: 'custom-renderer:12' });

    writeFileSync(renderer, 'process.exit(7);\n');
    const fallback = await execute();
    expect(fallback.text).toContain('amount');
    expect(fallback.text).toContain('12');
    expect(fallback.text).not.toContain('custom-renderer');
  });

  it('executes the raw Data MCP carrier with trusted identity and no SQL leakage', async () => {
    const { root, definition } = fixture();
    const home = installFixturePlugin(root, 'data-mcp', 'data', '0.1.0');
    const result = await executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test', requestLarkAppId: 'cli_test', senderType: 'user',
      },
      turnId: 'om_turn',
      dataDir: join(home, '.botmux', 'data'),
    });
    expect(result.text).toContain('12');
    expect(result.text).not.toContain('SELECT sum');
    expect(result.projectedResult).toEqual({ rows: [{ amount: 12 }], row_count: 1 });
  });

  it('connects an ordinary JSON MCP tool without host-specific code', async () => {
    const yaml = BASE
      .replace('test.plugin.readonly', 'test.json.readonly')
      .replace(/sql: \|-\n[\s\S]*?LIMIT 100/u, 'days: "{{days}}"');
    const { root, definition } = fixture(yaml);
    writeFileSync(join(root, 'command-executors.yaml'), `
schemaVersion: 2
executors:
  - id: test.json.readonly
    kind: plugin-tool
    plugin: json-report-plugin
    tool: read_report
    minimumVersion: 1.0.0
    arguments:
      days: { type: integer, required: true, min: 1, max: 90, accepts: [param] }
    output:
      container: rows
      exposeRowFields: [name, total]
    policy: { schedulable: true, allowHandoff: false, timeoutMs: 120000 }
`);
    const home = installFixturePlugin(root, 'json-report-plugin', 'json-report');
    const result = await executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['json-report-plugin'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test', requestLarkAppId: 'cli_test', senderType: 'user',
      },
      turnId: 'om_turn', dataDir: join(home, '.botmux', 'data'),
    });
    expect(result.projectedResult).toEqual({ rows: [{ name: 'report-30', total: 12 }] });
    expect(result.text).not.toContain('hidden');
  });

  it('uses a generic MCP text result as markdown in content mode', async () => {
    const { root, definition } = fixture();
    writeFileSync(join(root, 'command-executors.yaml'), `
schemaVersion: 2
executors:
  - id: test.content.readonly
    kind: plugin-tool
    plugin: content-plugin
    tool: echo
    minimumVersion: 1.0.0
    arguments: {}
    output: { content: markdown, maxContentBytes: 60000 }
    policy: { schedulable: true, allowHandoff: false, timeoutMs: 120000 }
`);
    definition.params = [];
    definition.steps[0] = {
      id: 'main', executor: 'test.content.readonly', input: {}, renderer: 'builtin.content', required: false,
    };
    const home = installFixturePlugin(root, 'content-plugin', 'content');
    const result = await executeFrozenCommand({
      definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['content-plugin'], larkAppId: 'cli_test', larkAppSecret: 'test-secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test', requestLarkAppId: 'cli_test', senderType: 'user',
      },
      turnId: 'om_turn', dataDir: join(home, '.botmux', 'data'), workingDir: root,
    });
    expect(result.text).toContain('content:echo:{}');
    expect(result.projectedResult).toEqual({});
  });

  it('maps plugin error fields to fixed host errors', async () => {
    const yaml = BASE.replace('SELECT sum(amount) FROM bills', "SELECT 'RETURN_VALIDATION_ERROR'");
    const { root, definition } = fixture(yaml);
    const home = installFixturePlugin(root, 'data-mcp', 'data', '0.1.0');
    await expect(executeFrozenCommand({
      definition,
      rawArgs: '30',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test', requestUserUnionId: 'on_test', requestLarkAppId: 'cli_test', senderType: 'user',
      },
      turnId: 'om_turn', dataDir: join(home, '.botmux', 'data'),
    })).rejects.toMatchObject({ code: 'plugin_tool_execution_failed', message: '插件工具执行失败。', executionFailure: true });
  });

  it('fails closed on absent identity and keeps public error text safe', async () => {
    const { root, definition } = fixture();
    await expect(executeFrozenCommand({
      definition, rawArgs: '', targetLarkAppId: 'cli_test',
      botConfig: { plugins: ['data-mcp'], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: undefined, turnId: 'ownerless', dataDir: join(root, 'data'),
    })).rejects.toMatchObject({ code: 'untrusted_caller' });
    expect(isTransientPluginToolFailure('connection closed by peer')).toBe(true);
    expect(isTransientPluginToolFailure('memory limit exceeded')).toBe(false);
    expect(userFacingFrozenCommandError(new FrozenCommandError('provider_validation_failed', 'private template')))
      .not.toContain('private template');
  });

  it('lists definitions without SQL and rejects symlink definitions', () => {
    const { root } = fixture();
    const listed = listFrozenCommandSnapshots(root);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed.map(item => item.command))).not.toContain('SELECT');

    const linkedRoot = join(tmpdir(), `botmux-frozen-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    dirs.push(linkedRoot);
    mkdirSync(join(linkedRoot, '.botmux', 'commands'), { recursive: true });
    const outside = join(linkedRoot, 'outside.yaml');
    writeFileSync(outside, BASE);
    symlinkSync(outside, join(linkedRoot, '.botmux', 'commands', '泰国上账.yaml'));
    const result = lookupFrozenCommand({ workingDir: linkedRoot, command: '/泰国上账' });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.error.code).toBe('definition_file_invalid');
  });
});
