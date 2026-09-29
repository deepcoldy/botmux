import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCommandExecutorArgv,
  commandExecutorBinaryDigest,
  isPluginToolCommandExecutor,
  listCommandExecutorAuthoringSchemas,
  loadCommandExecutorRegistry,
  pluginVersionAtLeast,
  runProcessCommandExecutor,
} from '../src/services/command-executors.js';
import {
  executeFrozenCommand,
  assertFrozenCommandExecutorContract,
  isProcessExecutionFailureCode,
  lookupFrozenCommand,
} from '../src/services/frozen-command.js';

const roots: string[] = [];

function setup(output = 'flat'): {
  root: string;
  script: string;
  registry: string;
  commandRoot: string;
} {
  const lexicalRoot = join(tmpdir(), `botmux-executor-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(lexicalRoot, { recursive: true });
  const root = realpathSync(lexicalRoot);
  roots.push(root);
  const script = join(root, 'executor.mjs');
  writeFileSync(script, output === 'rows'
    ? `console.log(JSON.stringify({ rows: [{ city: process.argv.at(-1), safe: 1, secret: 'hidden' }] }));\n`
    : `console.log(JSON.stringify({ value: process.argv.at(-1), secret: 'hidden' }));\n`);
  const registry = join(root, 'command-executors.yaml');
  writeFileSync(registry, `
schemaVersion: 2
executors:
  - id: test.echo
    kind: script
    executable:
      realpath: ${JSON.stringify(resolve(process.execPath))}
    fixedArgs: [${JSON.stringify(script)}]
    scriptArtifacts: [${JSON.stringify(script)}]
    arguments:
      value:
        flag: --value
        type: string
        required: true
        maxLength: 50
        pattern: "^[A-Za-z ]+$"
        accepts: [param, "context:caller.open_id"]
    policy:
      schedulable: true
      allowHandoff: false
      handoffIncludesInput: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
${output === 'rows'
    ? '      container: rows\n      exposeRowFields: [city, safe]'
    : '      exposeFields: [value]'}
`);
  const commandRoot = join(root, 'repo');
  mkdirSync(join(commandRoot, '.botmux', 'commands'), { recursive: true });
  writeFileSync(join(commandRoot, '.botmux', 'commands', '回显.yaml'), `
schemaVersion: 2
name: 回显
description: 回显测试
params:
  - name: word
    type: string
    maxLength: 50
    pattern: "^[A-Za-z ]+$"
steps:
  - id: main
    executor: test.echo
    input:
      value: "{{word}}"
    renderer: builtin.table
output:
  format: text
`);
  return { root, script, registry, commandRoot };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generic frozen-command executors', () => {
  it('loads a generic plugin-tool registration and keeps private routing out of the authoring schema', () => {
    const fixture = setup();
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: fixture-plugin
    tool: render_report
    minimumVersion: 1.2.3
    arguments:
      report:
        type: string
        required: true
        maxLength: 100
        accepts: [literal]
    output:
      exposeFields: [report]
    policy:
      schedulable: true
      allowHandoff: false
      timeoutMs: 5000
`);
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const executor = loadCommandExecutorRegistry().executors.get('test.plugin.readonly')!;
    expect(isPluginToolCommandExecutor(executor)).toBe(true);
    expect(listCommandExecutorAuthoringSchemas()).toEqual([{
      id: 'test.plugin.readonly',
      arguments: [{
        name: 'report',
        type: 'string',
        required: true,
        accepts: ['literal'],
        maxLength: 100,
      }],
    }]);
    expect(JSON.stringify(listCommandExecutorAuthoringSchemas())).not.toContain('fixture-plugin');
    expect(pluginVersionAtLeast('1.2.3', '1.2.3')).toBe(true);
    expect(pluginVersionAtLeast('1.3.0', '1.2.3')).toBe(true);
    expect(pluginVersionAtLeast('1.2.3-beta.1', '1.2.3')).toBe(false);
  });

  it('loads the documented Data MCP registry example in both languages', () => {
    const fixture = setup();
    for (const locale of ['zh', 'en']) {
      const documentation = readFileSync(resolve(`docs-site/docs/${locale}/frozen-commands.md`), 'utf8');
      const example = /```yaml\n(schemaVersion: 2\nexecutors:\n  - id: data\.query\.readonly[\s\S]*?)\n\nrenderers:/u.exec(documentation)?.[1];
      if (!example) throw new Error(`missing Data MCP registry example in ${locale} documentation`);
      writeFileSync(fixture.registry, example);
      expect(loadCommandExecutorRegistry(fixture.registry).executors.get('data.query.readonly'))
        .toMatchObject({
          kind: 'plugin-tool',
          arguments: { sql: { accepts: ['literal'], maxLength: 100_000 } },
        });
    }
  });

  it('allows large plugin literals without widening dynamic or process arguments', () => {
    const fixture = setup();
    const pluginRegistry = (maxLength: number, accepts: string) => `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: fixture-plugin
    tool: render_report
    minimumVersion: 1.0.0
    arguments:
      report:
        type: string
        required: true
        maxLength: ${maxLength}
        accepts: ${accepts}
    output:
      exposeFields: [report]
    policy:
      timeoutMs: 5000
`;

    writeFileSync(fixture.registry, pluginRegistry(200_000, '[literal]'));
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.plugin.readonly')!;
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const definition = structuredClone(lookup.snapshot.definition);
    definition.steps[0]!.executor = executor.id;
    definition.params = [];
    definition.steps[0]!.input = { report: 'x'.repeat(200_000) };
    expect(() => assertFrozenCommandExecutorContract(definition, executor)).not.toThrow();
    definition.steps[0]!.input.report = 'x'.repeat(200_001);
    expect(() => assertFrozenCommandExecutorContract(definition, executor)).toThrowError(/长度上限 200000/);

    writeFileSync(fixture.registry, pluginRegistry(200_001, '[literal]'));
    expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/1-200000/);

    for (const accepts of ['[param]', '[literal, param]', '["context:chat.id"]']) {
      writeFileSync(fixture.registry, pluginRegistry(10_001, accepts));
      expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/1-10000/);
    }

    const processFixture = setup();
    const processRegistry = readFileSync(processFixture.registry, 'utf8')
      .replace('maxLength: 50', 'maxLength: 10001')
      .replace('accepts: [param, "context:caller.open_id"]', 'accepts: [literal]');
    writeFileSync(processFixture.registry, processRegistry);
    expect(() => loadCommandExecutorRegistry(processFixture.registry)).toThrowError(/1-10000/);
  });

  it('rejects removed registry aliases and keeps conservative policy defaults', () => {
    const fixture = setup();
    writeFileSync(fixture.registry, `
schemaVersion: 2
aliases:
  builtin.legacy.readonly: test.plugin.json
executors:
  - id: test.plugin.json
    kind: plugin-tool
    plugin: fixture-plugin
    tool: read_report
    minimumVersion: 1.0.0
    arguments:
      report:
        type: string
        required: true
        maxLength: 100
        accepts: [literal]
    policy:
      timeoutMs: 5000
    output:
      container: rows
      exposeRowFields: [name, total]
`);
    expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/未知字段：aliases/);
    writeFileSync(fixture.registry, readFileSync(fixture.registry, 'utf8')
      .replace('aliases:\n  builtin.legacy.readonly: test.plugin.json\n', ''));
    const registry = loadCommandExecutorRegistry(fixture.registry);
    const executor = registry.executors.get('test.plugin.json')!;
    expect(executor).toMatchObject({
      kind: 'plugin-tool',
      output: { container: 'rows', exposeRowFields: ['name', 'total'] },
      policy: { schedulable: false, allowHandoff: false, handoffIncludesInput: false },
    });
  });

  it('rejects caller identity parameters from plugin-tool registrations', () => {
    const fixture = setup();
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: fixture-plugin
    tool: render_report
    minimumVersion: 1.0.0
    arguments:
      caller:
        type: string
        required: true
        maxLength: 100
        accepts: ["context:caller.open_id"]
    output:
      exposeFields: [result]
    policy:
      schedulable: true
      allowHandoff: false
      timeoutMs: 5000
`);
    expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/可信 _meta/);

    for (const identityName of [
      'open_id',
      'union_id',
      'user_id',
      'email',
      'phone_number',
      'caller_email',
      'sender_open_id',
      'actor_union_id',
      'principal_mobile',
    ]) {
      writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: fixture-plugin
    tool: render_report
    minimumVersion: 1.0.0
    arguments:
      ${identityName}:
        type: string
        required: false
        maxLength: 100
        accepts: [literal]
    output:
      exposeFields: [result]
    policy:
      timeoutMs: 5000
`);
      expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/可信 _meta/);
    }

    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.plugin.readonly
    kind: plugin-tool
    plugin: fixture-plugin
    tool: render_report
    minimumVersion: 1.0.0
    arguments:
      request_user_union_id:
        type: string
        required: true
        maxLength: 100
        accepts: [literal]
    output:
      exposeFields: [result]
    policy:
      schedulable: true
      allowHandoff: false
      timeoutMs: 5000
`);
    expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/可信 _meta/);
  });

  it('exposes only the model-safe authoring contract', () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const [schema] = listCommandExecutorAuthoringSchemas();
    expect(schema).toEqual({
      id: 'test.echo',
      arguments: [{
        name: 'value',
        type: 'string',
        required: true,
        accepts: ['param', 'context:caller.open_id'],
        pattern: '^[A-Za-z ]+$',
        maxLength: 50,
      }],
    });
    const serialized = JSON.stringify(schema);
    for (const secretField of ['realpath', 'fixedArgs', 'scriptArtifacts', 'sha256', fixture.script]) {
      expect(serialized).not.toContain(secretField);
    }
  });

  it('rejects every incompatible command-to-executor input contract before execution', () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const base = lookup.snapshot.definition;
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.echo')!;
    const clone = () => structuredClone(base);

    const unknown = clone();
    unknown.steps[0]!.input.other = 'literal';
    expect(() => assertFrozenCommandExecutorContract(unknown, executor)).toThrowError(/不接受 input/);

    const missing = clone();
    delete missing.steps[0]!.input.value;
    expect(() => assertFrozenCommandExecutorContract(missing, executor)).toThrowError(/缺少 required input/);

    const type = clone();
    type.params[0] = { name: 'word', type: 'integer', min: 1, max: 10 };
    expect(() => assertFrozenCommandExecutorContract(type, executor)).toThrowError(/类型应为 integer/);

    const source = clone();
    const literalOnly = structuredClone(executor);
    literalOnly.arguments.value!.accepts = ['literal'];
    expect(() => assertFrozenCommandExecutorContract(source, literalOnly)).toThrowError(/不接受 param 来源/);

    const contextSource = clone();
    contextSource.steps[0]!.input.value = '{{caller.open_id}}';
    const paramOnly = structuredClone(executor);
    paramOnly.arguments.value!.accepts = ['param'];
    expect(() => assertFrozenCommandExecutorContract(contextSource, paramOnly))
      .toThrowError(/不接受 context:caller\.open_id 来源/);

    const literalSource = clone();
    literalSource.steps[0]!.input.value = 'literal';
    expect(() => assertFrozenCommandExecutorContract(literalSource, executor))
      .toThrowError(/不接受 literal 来源/);

    const length = clone();
    length.params[0] = { name: 'word', type: 'string', maxLength: 100, pattern: '^[A-Za-z ]+$' };
    expect(() => assertFrozenCommandExecutorContract(length, executor)).toThrowError(/长度上限 100/);

    const pattern = clone();
    pattern.params[0] = { name: 'word', type: 'string', maxLength: 50, pattern: '^.+$' };
    expect(() => assertFrozenCommandExecutorContract(pattern, executor)).toThrowError(/pattern 必须与执行器一致/);

    const integerDefinition = clone();
    integerDefinition.steps[0]!.input.value = '{{days}}';
    integerDefinition.params = [{ name: 'days', type: 'integer', min: 1, max: 100 }];
    const integerExecutor = structuredClone(executor);
    integerExecutor.arguments.value = {
      type: 'integer', required: true, min: 1, max: 32, accepts: ['param'],
    };
    expect(() => assertFrozenCommandExecutorContract(integerDefinition, integerExecutor))
      .toThrowError(/范围 1-100 超出执行器 1-32/);

    const enumDefinition = clone();
    enumDefinition.steps[0]!.input.value = '{{mode}}';
    enumDefinition.params = [{ name: 'mode', type: 'enum', values: ['safe', 'unsafe'] }];
    const enumExecutor = structuredClone(executor);
    enumExecutor.arguments.value = {
      type: 'enum', required: true, values: ['safe'], accepts: ['param'],
    };
    expect(() => assertFrozenCommandExecutorContract(enumDefinition, enumExecutor))
      .toThrowError(/含执行器不接受的枚举值/);
  });

  it('constructs argv tokens without shell splitting and projects flat JSON fields', async () => {
    const fixture = setup();
    const registry = loadCommandExecutorRegistry(fixture.registry);
    const executor = registry.executors.get('test.echo')!;
    expect(buildCommandExecutorArgv(executor, {
      value: { value: 'hello world', source: 'param' },
    })).toEqual([...executor.fixedArgs, '--value', 'hello world']);
    const result = await runProcessCommandExecutor({
      executor,
      values: { value: { value: 'hello world', source: 'param' } },
      botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    });
    expect(result.projected).toEqual({ value: 'hello world' });
    expect(JSON.stringify(result.projected)).not.toContain('hidden');
  });

  it('rejects a source not admitted by the argument slot', () => {
    const fixture = setup();
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.echo')!;
    expect(() => buildCommandExecutorArgv(executor, {
      value: { value: 'hello', source: 'literal' },
    })).toThrowError(/不接受来源/);
  });

  it('projects collection rows field-by-field and never exposes the raw container objects', async () => {
    const fixture = setup('rows');
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.echo')!;
    const result = await runProcessCommandExecutor({
      executor,
      values: { value: { value: 'Shenzhen', source: 'param' } },
      botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    });
    expect(result.projected).toEqual({ rows: [{ city: 'Shenzhen', safe: 1 }] });
    expect(JSON.stringify(result.projected)).not.toContain('secret');
  });

  it('rejects an output contract that mixes flat and collection projections', () => {
    const fixture = setup();
    writeFileSync(
      fixture.registry,
      readFileSync(fixture.registry, 'utf8').replace(
        '      exposeFields: [value]',
        '      exposeFields: [value]\n      container: rows\n      exposeRowFields: [value]',
      ),
    );
    expect(() => loadCommandExecutorRegistry(fixture.registry))
      .toThrowError(/不能同时声明 exposeFields 和 container/);
  });

  it('projects nested fields without exposing their sibling values', async () => {
    const fixture = setup();
    writeFileSync(fixture.script, `console.log(JSON.stringify({ data: { user: { name: 'Visible', secret: 'hidden' } } }));\n`);
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.nested
    kind: script
    executable: { realpath: ${JSON.stringify(resolve(process.execPath))} }
    fixedArgs: [${JSON.stringify(fixture.script)}]
    scriptArtifacts: [${JSON.stringify(fixture.script)}]
    arguments: {}
    policy:
      schedulable: false
      allowHandoff: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
      exposeFields: [data.user.name]
`);
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.nested')!;
    const result = await runProcessCommandExecutor({
      executor,
      values: {},
      botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    });
    expect(result.projected).toEqual({ data: { user: { name: 'Visible' } } });
    expect(JSON.stringify(result.projected)).not.toContain('hidden');
  });

  it('requires lark-cli identity mode to be pinned to --as bot', () => {
    const fixture = setup();
    const fakeLarkCli = join(fixture.root, 'lark-cli');
    writeFileSync(fakeLarkCli, '#!/bin/sh\n');
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.lark
    kind: process
    executable: { realpath: ${JSON.stringify(fakeLarkCli)} }
    fixedArgs: [contact, search]
    arguments: {}
    policy:
      schedulable: false
      allowHandoff: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
      exposeFields: [name]
`);
    expect(() => loadCommandExecutorRegistry(fixture.registry)).toThrowError(/--as bot/);
  });

  it('runs lark-cli with the current bot credentials and an isolated empty HOME', async () => {
    const fixture = setup();
    const fakeLarkCli = join(fixture.root, 'lark-cli');
    writeFileSync(fakeLarkCli, `#!/bin/sh
if [ -n "$LARKSUITE_CLI_APP_SECRET" ]; then has_secret=true; else has_secret=false; fi
printf '{"app":"%s","home":"%s","has_secret":%s}\n' "$LARKSUITE_CLI_APP_ID" "$HOME" "$has_secret"
`);
    chmodSync(fakeLarkCli, 0o700);
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.lark
    kind: process
    executable: { realpath: ${JSON.stringify(fakeLarkCli)} }
    fixedArgs: [contact, search, --as, bot]
    arguments: {}
    policy:
      schedulable: false
      allowHandoff: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
      exposeFields: [app, home, has_secret]
`);
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.lark')!;
    const result = await runProcessCommandExecutor({
      executor,
      values: {},
      botConfig: { larkAppId: 'cli_current', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    });
    expect(result.projected).toMatchObject({ app: 'cli_current', has_secret: true });
    expect(result.projected.home).not.toBe(homedir());
    expect(existsSync(String(result.projected.home))).toBe(false);
    await expect(runProcessCommandExecutor({
      executor,
      values: {},
      botConfig: { larkAppId: 'cli_current', larkAppSecret: '' },
      workingDir: fixture.root,
    })).rejects.toThrowError(/凭证不可用/);
  });

  it('kills the executor process group when the timeout expires', async () => {
    const fixture = setup();
    const childPidFile = join(fixture.root, 'child.pid');
    writeFileSync(fixture.script, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
    // Leave enough time for the nested process to publish its PID on loaded CI
    // hosts while still proving that the detached process group is killed.
    writeFileSync(fixture.registry, readFileSync(fixture.registry, 'utf8').replace('timeoutMs: 5000', 'timeoutMs: 3000'));
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.echo')!;
    await expect(runProcessCommandExecutor({
      executor,
      values: { value: { value: 'hello', source: 'param' } },
      botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    })).rejects.toThrowError(/超时/);
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    let childAlive = true;
    for (let attempt = 0; attempt < 40 && childAlive; attempt += 1) {
      try { process.kill(childPid, 0); } catch { childAlive = false; }
      if (childAlive) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(childAlive).toBe(false);
  });

  it('detects third-party binary drift without changing the blocking executor revision', () => {
    const fixture = setup();
    const executable = join(fixture.root, 'tool-bin');
    writeFileSync(executable, 'version-one');
    writeFileSync(fixture.registry, `
schemaVersion: 2
executors:
  - id: test.binary
    kind: process
    executable: { realpath: ${JSON.stringify(executable)} }
    fixedArgs: [read]
    arguments: {}
    policy:
      schedulable: false
      allowHandoff: false
      timeoutMs: 5000
      maxOutputBytes: 65536
    output:
      exposeFields: [value]
`);
    const before = loadCommandExecutorRegistry(fixture.registry).executors.get('test.binary')!;
    const beforeDigest = commandExecutorBinaryDigest(before);
    writeFileSync(executable, 'version-two-longer');
    const after = loadCommandExecutorRegistry(fixture.registry).executors.get('test.binary')!;
    expect(after.revision).toBe(before.revision);
    expect(commandExecutorBinaryDigest(after)).not.toBe(beforeDigest);
  });

  it('fails closed in the execution path when a declared script artifact changes after registry load', async () => {
    const fixture = setup();
    const executor = loadCommandExecutorRegistry(fixture.registry).executors.get('test.echo')!;
    writeFileSync(fixture.script, `console.log(JSON.stringify({ value: 'changed' }));\n`);
    await expect(runProcessCommandExecutor({
      executor,
      values: { value: { value: 'hello', source: 'param' } },
      botConfig: { larkAppId: 'cli_test', larkAppSecret: 'secret' },
      workingDir: fixture.root,
    })).rejects.toThrowError(/脚本制品已变化/);
  });

  it('keeps pre-execution process gates outside output handoff rules', () => {
    for (const gateCode of [
      'executor_artifact_changed',
      'executor_argument_source_denied',
      'executor_argument_invalid',
      'executor_argument_required',
      'executor_identity_unavailable',
    ]) {
      expect(isProcessExecutionFailureCode(gateCode)).toBe(false);
    }
    for (const executionCode of [
      'executor_timeout',
      'executor_spawn_failed',
      'executor_non_zero_exit',
      'executor_output_limit',
      'executor_output_json',
      'executor_output_invalid',
    ]) {
      expect(isProcessExecutionFailureCode(executionCode)).toBe(true);
    }
  });

  it('executes a schema v2 process command and renders only projected output', async () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const result = await executeFrozenCommand({
      definition: lookup.snapshot.definition,
      rawArgs: 'hello',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: [], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_test',
        requestUserUnionId: 'on_test',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_test',
      dataDir: join(fixture.root, 'data'),
      workingDir: fixture.commandRoot,
    });
    expect(result.text).toBe('value：hello');
    expect(result.executorId).toBe('test.echo');
    expect(result.executorRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('executes the same process executor for a trusted schedule creator', async () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    const result = await executeFrozenCommand({
      definition: lookup.snapshot.definition,
      rawArgs: 'scheduled',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: [], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_creator',
        requestUserUnionId: 'on_creator',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
        source: 'schedule_creator',
        taskId: 'task_executor',
      },
      turnId: 'schedule:task_executor:test',
      dataDir: join(fixture.root, 'data'),
      workingDir: fixture.commandRoot,
      context: {
        caller: { open_id: 'ou_creator', union_id: 'on_creator' },
        chat: { id: 'oc_test', type: 'group' },
        message: { id: 'schedule:task_executor:test' },
      },
      audit: { source: 'schedule', taskId: 'task_executor' },
    });
    expect(result.text).toBe('value：scheduled');
  });

  it('rejects caller context that disagrees with the trusted caller identity', async () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    writeFileSync(join(fixture.commandRoot, '.botmux', 'commands', '回显.yaml'), `
schemaVersion: 2
name: 回显
description: 身份测试
steps:
  - id: main
    executor: test.echo
    input:
      value: "{{caller.open_id}}"
    renderer: builtin.table
output:
  format: text
`);
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    await expect(executeFrozenCommand({
      definition: lookup.snapshot.definition,
      rawArgs: '',
      targetLarkAppId: 'cli_test',
      botConfig: { plugins: [], larkAppId: 'cli_test', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_real',
        requestUserUnionId: 'on_real',
        requestLarkAppId: 'cli_test',
        senderType: 'user',
      },
      turnId: 'om_identity',
      dataDir: join(fixture.root, 'data'),
      workingDir: fixture.commandRoot,
      context: { caller: { open_id: 'ou_forged', union_id: 'on_real' } },
    })).rejects.toThrowError(/身份与可信调用者不一致/);
  });

  it('rejects execution when the target Bot differs from the credential-bearing Bot', async () => {
    const fixture = setup();
    vi.stubEnv('BOTMUX_COMMAND_EXECUTORS_FILE', fixture.registry);
    const lookup = lookupFrozenCommand({ workingDir: fixture.commandRoot, command: '/回显' });
    if (lookup.kind !== 'found') throw new Error(`unexpected lookup: ${lookup.kind}`);
    await expect(executeFrozenCommand({
      definition: lookup.snapshot.definition,
      rawArgs: 'hello',
      targetLarkAppId: 'cli_target',
      botConfig: { plugins: [], larkAppId: 'cli_other', larkAppSecret: 'secret' },
      trustedCaller: {
        requestUserOpenId: 'ou_real',
        requestUserUnionId: 'on_real',
        requestLarkAppId: 'cli_target',
        senderType: 'user',
      },
      turnId: 'om_bot_identity',
      dataDir: join(fixture.root, 'data'),
      workingDir: fixture.commandRoot,
    })).rejects.toMatchObject({ code: 'executor_identity_mismatch' });
  });
});
