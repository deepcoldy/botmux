import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import {
  assertFrozenCommandSchedulable,
  executeFrozenCommand,
  frozenCommandExecutorRevision,
  lookupFrozenCommand,
  resolveFrozenCommandOutput,
} from '../src/services/frozen-command.js';
import { frozenCommandSpecHash } from '../src/services/frozen-command-lifecycle.js';

const roots: string[] = [];

function root(): string {
  const value = join(tmpdir(), `botmux-frozen-multi-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(value, '.botmux', 'commands'), { recursive: true });
  roots.push(value);
  return value;
}

function runner(path: string): string {
  writeFileSync(path, `
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode, id, expected = '0'] = process.argv.slice(2);
if (mode === 'barrier') {
  writeFileSync(join(process.cwd(), '.started-' + id), '1');
  const deadline = Date.now() + 1500;
  while (readdirSync(process.cwd()).filter(name => name.startsWith('.started-')).length < Number(expected)) {
    if (Date.now() >= deadline) process.exit(9);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1000));
if (mode === 'fail-late') {
  await new Promise(resolve => setTimeout(resolve, 150));
  process.exit(7);
}
if (mode === 'fail-after-starts') {
  writeFileSync(join(process.cwd(), '.started-' + id), '1');
  const deadline = Date.now() + 1500;
  while (readdirSync(process.cwd()).filter(name => name.startsWith('.started-')).length < Number(expected)) {
    if (Date.now() >= deadline) process.exit(9);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.exit(7);
}
if (mode === 'block') {
  writeFileSync(join(process.cwd(), '.started-' + id), '1');
  process.on('SIGTERM', () => {
    writeFileSync(join(process.cwd(), '.cancelled-' + id), '1');
    process.exit(0);
  });
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (mode === 'tracked') {
  const marker = join(process.cwd(), '.running-' + id);
  writeFileSync(marker, '1');
  if (readdirSync(process.cwd()).filter(name => name.startsWith('.running-')).length > 3) {
    writeFileSync(join(process.cwd(), '.over-limit'), '1');
  }
  await new Promise(resolve => setTimeout(resolve, 180));
  if (existsSync(marker)) unlinkSync(marker);
}
if (mode === 'mark') writeFileSync(join(process.cwd(), '.started-' + id), '1');
if (mode === 'fail') process.exit(7);
console.log(JSON.stringify({ rows: [{ step: id, value: id + '-private' }], row_count: 1 }));
`);
  return realpathSync(path);
}

function registryYaml(script: string, modes: Record<string, string>, policies: Record<string, { schedulable: boolean; allowHandoff: boolean }>): string {
  const entries = Object.keys(modes).map(id => `
  - id: test.${id}
    kind: script
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(script)}, ${JSON.stringify(modes[id])}, ${JSON.stringify(id)}, ${JSON.stringify(String(Object.keys(modes).length))}]
    scriptArtifacts: [${JSON.stringify(script)}]
    arguments: {}
    output:
      container: rows
      exposeRowFields: [step, value]
      totalRowsField: row_count
    policy:
      schedulable: ${policies[id]!.schedulable}
      allowHandoff: ${policies[id]!.allowHandoff}
      handoffIncludesInput: false
      timeoutMs: 2000
      maxOutputBytes: 65536`).join('');
  return `schemaVersion: 2\nexecutors:${entries}\n`;
}

function commandYaml(required = false, rules = ''): string {
  return `
schemaVersion: 2
name: 经营早报
description: 多步骤测试
params: []
steps:
  - { id: a, executor: test.a, input: {}, renderer: builtin.table }
  - { id: b, executor: test.b, input: {}, renderer: builtin.table, required: ${required} }
  - { id: c, executor: test.c, input: {}, renderer: builtin.table }
output:
  format: markdown${rules ? `\n  rules:\n${rules}` : ''}
`;
}

function setup(input: {
  modes?: Record<string, string>;
  policies?: Record<string, { schedulable: boolean; allowHandoff: boolean }>;
  required?: boolean;
  rules?: string;
} = {}) {
  const dir = root();
  const script = runner(join(dir, 'runner.mjs'));
  const modes = input.modes ?? { a: 'barrier', b: 'barrier', c: 'barrier' };
  const policies = input.policies ?? {
    a: { schedulable: true, allowHandoff: true },
    b: { schedulable: true, allowHandoff: false },
    c: { schedulable: true, allowHandoff: true },
  };
  const registry = join(dir, 'command-executors.yaml');
  writeFileSync(registry, registryYaml(script, modes, policies));
  writeFileSync(join(dir, '.botmux', 'commands', '经营早报.yaml'), commandYaml(input.required, input.rules));
  vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
  const lookup = lookupFrozenCommand({ workingDir: dir, command: '/经营早报' });
  if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
  return { dir, script, registry, definition: lookup.snapshot.definition };
}

function execute(dir: string, definition: ReturnType<typeof setup>['definition'], expectedExecutorRevision?: string) {
  return executeFrozenCommand({
    definition,
    rawArgs: '',
    targetLarkAppId: 'cli_test',
    botConfig: { plugins: [], larkAppId: 'cli_test', larkAppSecret: 'secret' },
    trustedCaller: {
      requestUserOpenId: 'ou_test',
      requestUserUnionId: 'on_test',
      requestLarkAppId: 'cli_test',
      senderType: 'user',
    },
    turnId: 'om_test',
    dataDir: join(dir, 'data'),
    workingDir: dir,
    expectedExecutorRevision,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Frozen Commands v2 multi-step execution', () => {
  it('runs independent steps in parallel, preserves order, and audits every step under one execution id', async () => {
    const fixture = setup();
    const logs: Array<Record<string, unknown>> = [];
    vi.spyOn(logger, 'info').mockImplementation((_message, context) => {
      if (context && typeof context === 'object') logs.push(context as Record<string, unknown>);
    });
    const result = await execute(fixture.dir, fixture.definition);
    expect(result.steps?.map(step => [step.id, step.status])).toEqual([['a', 'ok'], ['b', 'ok'], ['c', 'ok']]);
    expect(result.text).not.toContain('### a');
    expect(result.text).toBe(result.steps?.map(step => step.text).join('\n\n'));
    for (const id of ['a', 'b', 'c']) expect(existsSync(join(fixture.dir, `.started-${id}`))).toBe(true);
    const audits = logs.filter(row => row.event === 'frozen_command_execution');
    expect(audits.map(row => row.step_id)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(new Set(audits.map(row => row.execution_id))).toEqual(new Set([result.executionId]));
  });

  it('enforces one total deadline in addition to each executor deadline', async () => {
    const fixture = setup({ modes: { a: 'slow', b: 'slow', c: 'slow' } });
    const startedAt = Date.now();
    const result = await executeFrozenCommand({
      definition: fixture.definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: [], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_test',
      dataDir: join(fixture.dir, 'data'),
      workingDir: fixture.dir,
      timeoutMs: 150,
    });
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(result.steps?.map(step => [step.status, step.error?.code])).toEqual([
      ['error', 'executor_timeout'],
      ['error', 'executor_timeout'],
      ['error', 'executor_timeout'],
    ]);
  });

  it('keeps optional execution failures inline and exposes aggregate and per-step run status', async () => {
    const rules = `    - when: "{{q.b.row_count}} == 0"\n      show: { text: "must not match" }\n    - when: "{{run.status}} == 'error' && {{run.b.status}} == 'error'"\n      show: { text: "b failed: {{run.b.error.code}}" }\n    - show: result`;
    const fixture = setup({ modes: { a: 'ok', b: 'fail', c: 'ok' }, rules });
    const result = await execute(fixture.dir, fixture.definition);
    expect(result.steps?.map(step => step.status)).toEqual(['ok', 'error', 'ok']);
    expect(result.text).toContain('该部分暂时无法获取');
    expect(result.text).not.toContain('test.b');
    expect(result.text).not.toContain('退出码');
    expect(resolveFrozenCommandOutput({
      definition: fixture.definition,
      rawArgs: '',
      source: 'direct',
      result,
    })).toMatchObject({ kind: 'deliver', text: 'b failed: executor\\_non\\_zero\\_exit' });
  });

  it('derives one plain-text message after assembling all step outputs', async () => {
    const fixture = setup();
    fixture.definition.output.format = 'text';
    const result = await execute(fixture.dir, fixture.definition);
    expect(result.text).toContain('a');
    expect(result.text).toContain('b');
    expect(result.text).toContain('c');
    expect(result.text).not.toContain('###');
    expect(result.presentation.format).toBe('text');
  });

  it('fails the whole command for required or gate failures and cancels running siblings', async () => {
    const required = setup({ modes: { a: 'block', b: 'fail-after-starts', c: 'block' }, required: true });
    const startedAt = Date.now();
    let requiredFailure: unknown;
    try {
      await execute(required.dir, required.definition);
    } catch (error) {
      requiredFailure = error;
    }
    expect(requiredFailure).toMatchObject({ code: 'executor_non_zero_exit', executionFailure: true });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(requiredFailure).toMatchObject({
      stepResults: expect.arrayContaining([
        expect.objectContaining({ id: 'a', error: expect.objectContaining({ code: 'executor_cancelled' }) }),
        expect.objectContaining({ id: 'c', error: expect.objectContaining({ code: 'executor_cancelled' }) }),
      ]),
    });

    const gate = setup({ modes: { a: 'ok', b: 'ok', c: 'ok' } });
    const approvedRevision = frozenCommandExecutorRevision(gate.definition);
    writeFileSync(gate.script, `${readFileSync(gate.script, 'utf8')}\n// drift\n`);
    await expect(execute(gate.dir, gate.definition, approvedRevision)).rejects.toMatchObject({
      code: 'executor_revision_changed',
      executionFailure: false,
    });
  });

  it('keeps successful step errors empty when another required step fails', async () => {
    const rules = `    - when: "{{run.status}} == 'error'"\n      handoff:\n        prompt: "a={{run.a.error.code}} b={{run.b.error.code}} c={{run.c.error.code}}"\n    - show: result`;
    const policies = {
      a: { schedulable: true, allowHandoff: true },
      b: { schedulable: true, allowHandoff: true },
      c: { schedulable: true, allowHandoff: true },
    };
    const fixture = setup({ modes: { a: 'ok', b: 'fail-late', c: 'ok' }, policies, required: true, rules });
    let failure: unknown;
    try {
      await execute(fixture.dir, fixture.definition);
    } catch (error) {
      failure = error;
    }
    const output = resolveFrozenCommandOutput({
      definition: fixture.definition,
      rawArgs: '',
      source: 'direct',
      error: failure,
    });
    expect(output.kind).toBe('handoff');
    if (output.kind === 'handoff') {
      expect(output.prompt).toContain('a="" b="executor_non_zero_exit" c=""');
    }
  });

  it('cancels queued steps and emits one audit row for every step after a required failure', async () => {
    const dir = root();
    const script = runner(join(dir, 'runner.mjs'));
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const modes = { a: 'block', b: 'fail', c: 'block', d: 'mark', e: 'mark' };
    const policies = Object.fromEntries(ids.map(id => [id, { schedulable: true, allowHandoff: false }]));
    const registry = join(dir, 'command-executors.yaml');
    writeFileSync(registry, registryYaml(script, modes, policies));
    writeFileSync(join(dir, '.botmux', 'commands', '经营早报.yaml'), `
schemaVersion: 2
name: 经营早报
description: 排队取消测试
params: []
steps:
${ids.map(id => `  - { id: ${id}, executor: test.${id}, input: {}, renderer: builtin.table${id === 'b' ? ', required: true' : ''} }`).join('\n')}
output: { format: markdown }
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const lookup = lookupFrozenCommand({ workingDir: dir, command: '/经营早报' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const audits: Array<Record<string, unknown>> = [];
    vi.spyOn(logger, 'warn').mockImplementation((_message, context) => {
      if (context && typeof context === 'object') audits.push(context as Record<string, unknown>);
    });
    let failure: unknown;
    try {
      await execute(dir, lookup.snapshot.definition);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'executor_non_zero_exit',
      stepResults: expect.arrayContaining([
        expect.objectContaining({ id: 'd', error: expect.objectContaining({ code: 'execution_cancelled' }) }),
        expect.objectContaining({ id: 'e', error: expect.objectContaining({ code: 'execution_cancelled' }) }),
      ]),
    });
    expect(existsSync(join(dir, '.started-d'))).toBe(false);
    expect(existsSync(join(dir, '.started-e'))).toBe(false);
    expect(new Set(audits.filter(row => row.event === 'frozen_command_execution').map(row => row.step_id))).toEqual(new Set(ids));
  });

  it('limits one command to three concurrently running steps', async () => {
    const dir = root();
    const script = runner(join(dir, 'runner.mjs'));
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const modes = Object.fromEntries(ids.map(id => [id, 'tracked']));
    const policies = Object.fromEntries(ids.map(id => [id, { schedulable: true, allowHandoff: false }]));
    const registry = join(dir, 'command-executors.yaml');
    writeFileSync(registry, registryYaml(script, modes, policies));
    writeFileSync(join(dir, '.botmux', 'commands', '经营早报.yaml'), `
schemaVersion: 2
name: 经营早报
description: 并发上限测试
params: []
steps:
${ids.map(id => `  - { id: ${id}, executor: test.${id}, input: {}, renderer: builtin.table }`).join('\n')}
output: { format: markdown }
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const lookup = lookupFrozenCommand({ workingDir: dir, command: '/经营早报' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const result = await execute(dir, lookup.snapshot.definition);
    expect(result.steps?.map(step => step.id)).toEqual(ids);
    expect(existsSync(join(dir, '.over-limit'))).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('.running-'))).toEqual([]);
  });

  it('rejects the reserved status step id and removed cmd.executor namespace', () => {
    const fixture = setup();
    const commandPath = join(fixture.dir, '.botmux', 'commands', '经营早报.yaml');
    writeFileSync(commandPath, commandYaml().replace('id: a', 'id: status'));
    expect(lookupFrozenCommand({ workingDir: fixture.dir, command: '/经营早报' })).toMatchObject({
      kind: 'invalid',
      error: { code: 'definition_invalid_steps' },
    });
    writeFileSync(commandPath, commandYaml(false, `    - when: "{{cmd.executor}} == 'test.a'"\n      show: result`));
    expect(lookupFrozenCommand({ workingDir: fixture.dir, command: '/经营早报' })).toMatchObject({
      kind: 'invalid',
      error: { code: 'definition_invalid_output' },
    });
  });

  it('intersects scheduling and handoff policies without leaking denied-step data', async () => {
    const policies = {
      a: { schedulable: true, allowHandoff: true },
      b: { schedulable: false, allowHandoff: false },
      c: { schedulable: true, allowHandoff: true },
    };
    const rules = `    - when: "{{run.c.status}} == 'error'"\n      handoff: { prompt: "summarize", maxRows: 10 }\n    - show: result`;
    const fixture = setup({ modes: { a: 'ok', b: 'ok', c: 'fail' }, policies, rules });
    expect(() => assertFrozenCommandSchedulable(fixture.definition)).toThrowError(/步骤 b/);
    const result = await execute(fixture.dir, fixture.definition);
    const output = resolveFrozenCommandOutput({ definition: fixture.definition, rawArgs: '', source: 'direct', result });
    expect(output.kind).toBe('handoff');
    if (output.kind === 'handoff') {
      expect(output.prompt).toContain('a-private');
      expect(output.prompt).not.toContain('b-private');
      expect(output.prompt).not.toContain('c-private');
    }
  });

  it('includes every executor and renderer revision in the approval digest', () => {
    const fixture = setup();
    const before = frozenCommandExecutorRevision(fixture.definition);
    const specBefore = frozenCommandSpecHash({
      filePath: '',
      realpath: '',
      raw: '',
      definition: fixture.definition,
    });
    fixture.definition.steps[2]!.executor = 'test.a';
    expect(frozenCommandExecutorRevision(fixture.definition)).not.toBe(before);
    expect(frozenCommandSpecHash({
      filePath: '',
      realpath: '',
      raw: '',
      definition: fixture.definition,
    })).not.toBe(specBefore);
  });

  it('loads and runs the guide section 12 three-step morning report shape', async () => {
    const dir = root();
    const script = runner(join(dir, 'guide-executor.mjs'));
    const rendererPath = join(dir, 'trend-chart.mjs');
    writeFileSync(rendererPath, `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
console.log(String.fromCharCode(96).repeat(3) + 'vega-lite');
console.log(JSON.stringify({ data: { values: payload.rows }, mark: 'line' }));
console.log(String.fromCharCode(96).repeat(3));
`);
    const renderer = realpathSync(rendererPath);
    const registry = join(dir, 'command-executors.yaml');
    const registryText = `
schemaVersion: 2
executors:
  - id: data.query.reg
    kind: process
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(script)}, ok, reg, "3"]
    arguments:
      sql: { flag: --sql, type: string, required: true, maxLength: 10000, accepts: [literal] }
    output: { container: rows, exposeRowFields: [step, value], totalRowsField: row_count }
    policy: { schedulable: true, allowHandoff: false, timeoutMs: 2000, maxOutputBytes: 65536 }
  - id: data.query.top
    kind: process
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(script)}, ok, top, "3"]
    arguments:
      sql: { flag: --sql, type: string, required: true, maxLength: 10000, accepts: [literal] }
    output: { container: rows, exposeRowFields: [step, value], totalRowsField: row_count }
    policy: { schedulable: true, allowHandoff: false, timeoutMs: 2000, maxOutputBytes: 65536 }
  - id: lark.calendar-agenda
    kind: process
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(script)}, ok, calendar, "3"]
    arguments:
      date: { flag: --date, type: string, required: true, pattern: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$", accepts: [context:today] }
    output: { container: rows, exposeRowFields: [step, value], totalRowsField: row_count }
    policy: { schedulable: true, allowHandoff: false, timeoutMs: 2000, maxOutputBytes: 65536 }
renderers:
  - id: risk.trend-chart
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(renderer)}]
    scriptArtifacts: [${JSON.stringify(renderer)}]
    policy: { timeoutMs: 2000, maxInputBytes: 1048576, maxOutputBytes: 60000 }
`;
    writeFileSync(registry, registryText);
    writeFileSync(join(dir, '.botmux', 'commands', '经营早报.yaml'), `
schemaVersion: 2
name: 经营早报
description: 注册趋势 + 金额 Top10 + 今日日程
params:
  - { name: days, label: 天数, type: integer, min: 1, max: 90, default: 7 }
steps:
  - id: reg
    executor: data.query.reg
    input: { sql: "SELECT dt, count() AS 注册数 … {{days}} …" }
    renderer: risk.trend-chart
  - id: top
    executor: data.query.top
    input: { sql: "SELECT 商户, 金额 … ORDER BY 金额 DESC LIMIT 10" }
    renderer: builtin.table
  - id: cal
    executor: lark.calendar-agenda
    input: { date: "{{today}}" }
    renderer: builtin.table
output:
  format: markdown
  rules:
    - when: "{{q.reg.row_count}} == 0"
      show: { text: "近 {{cmd.args.days}} 天无数据" }
    - show: result
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', registry);
    const lookup = lookupFrozenCommand({ workingDir: dir, command: '/经营早报' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    expect(() => assertFrozenCommandSchedulable(lookup.snapshot.definition)).not.toThrow();
    const result = await execute(dir, lookup.snapshot.definition);
    expect(result.steps?.map(step => step.id)).toEqual(['reg', 'top', 'cal']);
    expect(result.text).toContain('```vega-lite');
    expect(result.text).not.toContain('### reg');
    expect(result.text).toBe(result.steps?.map(step => step.text).join('\n\n'));

    const failedRegistry = join(dir, 'command-executors-reg-failed.yaml');
    writeFileSync(failedRegistry, registryText.replace(
      `fixedArgs: [${JSON.stringify(script)}, ok, reg, "3"]`,
      `fixedArgs: [${JSON.stringify(script)}, fail, reg, "3"]`,
    ));
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', failedRegistry);
    const failedRegResult = await execute(dir, lookup.snapshot.definition);
    expect(failedRegResult.steps?.map(step => [step.id, step.status])).toEqual([
      ['reg', 'error'],
      ['top', 'ok'],
      ['cal', 'ok'],
    ]);
    expect(failedRegResult.text).toContain('该部分暂时无法获取');
    expect(() => resolveFrozenCommandOutput({
      definition: lookup.snapshot.definition,
      rawArgs: '',
      source: 'direct',
      result: failedRegResult,
    })).not.toThrow();
  });
});
