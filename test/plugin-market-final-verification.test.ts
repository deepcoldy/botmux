import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import ts from 'typescript';
import { createHostPluginMarket, createPluginMarket, PluginMarketError } from '../src/dashboard/plugin-market.js';
import * as registry from '../src/services/plugin-registry-store.js';
import * as guards from '../src/core/plugins/mutation-guard.js';
import * as installer from '../src/core/plugins/install.js';
import * as services from '../src/core/plugins/service-manager.js';
import * as materializer from '../src/core/plugins/materializer.js';
import * as paths from '../src/core/plugins/paths.js';
import * as globalConfig from '../src/global-config.js';
import { normalizePluginIdList } from '../src/core/plugins/ids.js';
import { assertPluginBindingTransition, enabledPluginDependents } from '../src/core/plugins/dependencies.js';
import { resolveEffectivePluginIds, updateBotPluginOverride } from '../src/core/plugins/effective.js';
import { resolveDashboardIdentity } from '../src/dashboard/request-identity.js';
import { ControlCsrfTokens, guardControlRequest } from '../src/dashboard/control-csrf.js';

const io = vi.hoisted(() => ({
  async: async (..._args: any[]): Promise<any> => { throw new Error('Unexpected subprocess'); },
  sync: (..._args: any[]): any => { throw new Error('Unexpected synchronous subprocess'); },
}));
vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
}));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    execFile: Object.assign(() => { throw new Error('Unexpected callback subprocess'); }, {
      [promisify.custom]: (...args: any[]) => io.async(...args),
    }),
    execFileSync: (...args: any[]) => io.sync(...args),
    spawn: () => { throw new Error('Unexpected spawn'); },
    spawnSync: () => { throw new Error('Unexpected spawnSync'); },
  };
});
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  const fenced = {
    ...actual, homedir: () => process.env.HOME!,
  };
  return { ...fenced, default: fenced };
});

const SOURCE = fileURLToPath(new URL('..', import.meta.url));
const entry = {
  id: 'sample', package: '@test/plugin-sample', displayName: 'Sample',
  description: 'Fixture', repo: 'https://example.com/sample',
  categories: ['mcp'], compatibility: { botmux: '>=3.56.0' },
};
const manifest = {
  name: entry.package, version: '1.2.3', keywords: ['botmux-plugin'],
  botmux: { schemaVersion: 1, id: entry.id },
};
const bytes = Buffer.from('isolated final verification archive');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
let home = '';
let sequence = 0;
const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function localPackage(pkg: any = manifest, marker = pkg.version) {
  const path = join(home, `package-${sequence++}`);
  fs.mkdirSync(join(path, 'dist'), { recursive: true });
  fs.writeFileSync(join(path, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(join(path, 'dist/marker'), marker);
  return path;
}
function installInitial(version = '1.2.3') {
  return installer.installLocalPlugin(localPackage({ ...manifest, version }, 'initial')).record;
}
function request() {
  const record = registry.getInstalledPlugin('sample')!;
  return {
    id: record.id, packageName: record.packageName, version: record.version,
    expectedState: guards.pluginRecordHash(record), confirm: true,
  };
}
function marker() { return fs.readFileSync(join(paths.pluginRuntimeDir('sample'), 'marker'), 'utf8'); }
function bots(): any[] { return JSON.parse(fs.readFileSync(join(home, 'bots.json'), 'utf8')); }
function enabled() {
  globalConfig.invalidateGlobalConfigCache();
  return !!globalConfig.readGlobalConfig().plugins?.includes('sample')
    || bots().some(bot => bot.plugins?.includes('sample'));
}
function humanEnable(scope: string) {
  if (scope === 'global') {
    const config = globalConfig.readGlobalConfig();
    fs.writeFileSync(globalConfig.globalConfigPath(), JSON.stringify({ ...config, plugins: ['sample'] }));
  } else {
    fs.writeFileSync(join(home, 'bots.json'), JSON.stringify([{ larkAppId: 'fixture-bot', plugins: ['sample'] }]));
  }
}

// Execute AST-selected production functions with fenced dependencies, never CLI/dashboard startup.
// This follows the repository worker-function-harness pattern; assertions are about behavior.
function parsed(file: string) {
  let code = fs.readFileSync(join(SOURCE, file), 'utf8');
  const mutation = JSON.parse(process.env.FINAL_MARKET_SOURCE_MUTATION || 'null');
  if (mutation && file.endsWith(mutation.file)) {
    if (!code.includes(mutation.from)) throw new Error('Missing AST mutation target');
    code = code.replace(mutation.from, mutation.to);
  }
  return ts.createSourceFile(file, code,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(source: ts.SourceFile, name: string) {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing function: ${name}`);
  return node.getText(source);
}
function branch(source: ts.SourceFile, literal: string) {
  let found: ts.IfStatement | undefined;
  const contains = (node: ts.Node): boolean => ts.isStringLiteral(node) && node.text === literal
    || (ts.forEachChild(node, contains) ?? false);
  function visit(node: ts.Node) {
    if (!found && ts.isIfStatement(node) && contains(node.expression)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing branch: ${literal}`);
  return found.getText(source);
}
function compile(code: string, scope: Record<string, any>, name: string): any {
  const source = ts.createSourceFile('fixture.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const transformed = ts.transform(source, [context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return context.factory.updateCallExpression(node, context.factory.createIdentifier('loadModule'), undefined, node.arguments);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  const text = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  const output = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${output}; return ${name}; }`)(proxy);
}

function cliHarness(hooks: {
  service?: () => Promise<unknown>; skills?: () => Promise<unknown>;
  bindings?: () => void; remove?: typeof registry.removeInstalledPlugin;
  rm?: typeof fs.rmSync; rename?: typeof fs.renameSync;
} = {}) {
  const source = parsed('src/cli.ts');
  const command = ts.createSourceFile('cmdPlugin.ts', declaration(source, 'cmdPlugin'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls = { service: vi.fn(hooks.service ?? (async () => [])), skills: vi.fn(hooks.skills ?? (async () => {})) };
  const scope: Record<string, any> = {
    ...globalConfig, normalizePluginIdList, resolveEffectivePluginIds, updateBotPluginOverride,
    enabledPluginDependents, ...fs,
    rmSync: hooks.rm ?? fs.rmSync,
    BOTS_JSON_FILE: join(home, 'bots.json'), loadBotsJson: bots,
    writeBotsAtomic: (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data)),
    parseBotSelection: () => 0,
    requirePluginId: (id: string) => id,
    assertPluginInstalled: (id: string) => { if (!registry.getInstalledPlugin(id)) throw new Error(`plugin_not_installed:${id}`); },
    assertPluginBindingTransitionForCli: (id: string, on: boolean, current: string[]) =>
      assertPluginBindingTransition(id, on, current, scope.pluginRegistryCache),
    removePluginSkillRegistryEntries: calls.skills,
    printPluginServiceRunningError: () => false, printPluginServiceDeleteError: () => false,
    pluginRegistryCache: registry.readPluginRegistry(),
    process: { pid: process.pid, exitCode: 0, exit: () => { throw new Error('Unexpected process.exit'); } },
    console: { log: vi.fn(), error: vi.fn() },
    loadModule: async (name: string) => {
      if (name.endsWith('/service-manager.js')) return { ...services, deletePluginServicesOrThrowUnlocked: calls.service };
      if (name.endsWith('/materializer.js')) return materializer;
      if (name.endsWith('/mutation-guard.js')) return guards;
      if (name.endsWith('/plugin-registry-store.js')) return { ...registry, removeInstalledPlugin: hooks.remove ?? registry.removeInstalledPlugin };
      if (name.endsWith('/paths.js')) return paths;
      if (name.endsWith('/global-config.js')) return globalConfig;
      if (name.endsWith('/install.js')) return installer;
      if (name.endsWith('/init.js')) return { resolveOfficialPluginPackageSpec: (spec: string) => spec };
      if (name === 'node:fs') return { ...fs, renameSync: hooks.rename ?? fs.renameSync };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  for (const name of ['findArgValue', 'addPluginId', 'removePluginId', 'updateGlobalPluginBinding',
    'updateBotPluginBinding', 'removePluginBindingsEverywhere']) {
    scope[name] = compile(declaration(source, name), scope, name);
  }
  if (hooks.bindings) scope.removePluginBindingsEverywhere = hooks.bindings;
  const invoke = compile(`async function invoke(args) {
    const sub = args[0];
    ${branch(command, 'install-verified')}
    ${branch(command, 'install')}
    ${branch(command, 'enable')}
    ${branch(command, 'uninstall')}
  }`, scope, 'invoke');
  scope.cmdPlugin = invoke;
  return { invoke, calls, scope };
}

function hostFixture(options: {
  beforeCli?: (args: string[]) => Promise<void>;
  cli?: ReturnType<typeof cliHarness>;
  pack?: () => Promise<void>;
  npm?: (prefix: string, args: string[]) => void;
} = {}) {
  const cli = options.cli ?? cliHarness();
  const calls: Array<{ command: string; args: string[] }> = [];
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [entry] })));
  io.async = async (command, args: string[]) => {
    calls.push({ command, args });
    if (command === 'npm' && args[0] === 'view') return {
      stdout: JSON.stringify({ version: manifest.version, 'dist.integrity': integrity }), stderr: '',
    };
    if (command === 'npm' && args[0] === 'pack') {
      await options.pack?.();
      fs.writeFileSync(join(args[args.indexOf('--pack-destination') + 1], 'fixture.tgz'), bytes);
      return { stdout: JSON.stringify([{ filename: 'fixture.tgz' }]), stderr: '' };
    }
    if (command === 'tar') return { stdout: JSON.stringify(manifest), stderr: '' };
    const at = args.indexOf('plugin');
    if (at < 0) throw new Error(`Unexpected subprocess: ${command}`);
    await options.beforeCli?.(args.slice(at + 1));
    await cli.invoke(args.slice(at + 1));
    return { stdout: '', stderr: '' };
  };
  io.sync = (command, args: string[]) => {
    if (command !== 'npm' || args[0] !== 'install') throw new Error(`Unexpected synchronous subprocess: ${command}`);
    calls.push({ command, args });
    const prefix = args[args.indexOf('--prefix') + 1];
    if (options.npm) options.npm(prefix, args);
    else stageNpm(prefix);
    return Buffer.from('');
  };
  return { market: createHostPluginMarket(enabled), calls, cli };
}
function stageNpm(prefix: string, pkg: any = manifest) {
  const path = join(prefix, 'node_modules', entry.package);
  fs.mkdirSync(join(path, 'dist'), { recursive: true });
  fs.writeFileSync(join(path, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(join(path, 'dist/marker'), 'market');
}
function routeHarness(market: ReturnType<typeof createHostPluginMarket>) {
  const source = parsed('src/dashboard.ts');
  let activeToken = 'original';
  const identity = () => resolveDashboardIdentity({
    legacyCookie: 'original', activeToken, roleHeader: undefined, actorHeader: undefined,
    scopesHeader: undefined, platformMachineId: null, platformActorScope: id => id,
    legacyAuthSessionId: token => `session:${token}`, h5: null,
  });
  const originalIdentity = identity()!;
  const tokens = new ControlCsrfTokens();
  const csrf = tokens.mint(originalIdentity.authSessionId);
  const scope: Record<string, any> = {
    pluginMarket: market, PluginMarketError, guardControlRequest, createHash,
    controlCsrfTokens: tokens, dashboardRequestIdentity: identity,
    currentDashboardToken: () => activeToken,
    DashboardJsonBodyTooLargeError: class extends Error {},
    jsonRes: (_res: unknown, status: number, body: unknown) => ({ status, body }),
    enforceControlCsrf: (req: any) => guardControlRequest({
      headers: req.headers, authSessionId: originalIdentity.authSessionId, tokens,
    }).ok,
  };
  scope.readJsonBody = compile(declaration(source, 'readJsonBody'), scope, 'readJsonBody');
  const invoke = compile(`async function invoke(req, res, url, legacyAuthed, requestIdentity) {
    ${branch(source, '/api/plugins/market')}
  }`, scope, 'invoke');
  const stream = new PassThrough();
  Object.assign(stream, { method: 'POST', headers: {
    host: '127.0.0.1:9876', origin: 'http://127.0.0.1:9876', 'x-botmux-csrf': csrf,
  } });
  return {
    stream,
    call: () => invoke(stream, {}, new URL('http://127.0.0.1:9876/api/plugins/market/uninstall'), true, originalIdentity),
    rotate: () => {
      activeToken = 'rotated';
      fs.writeFileSync(join(home, '.botmux/.dashboard-token'), activeToken);
    },
    revoke: () => tokens.revokeAuthSession(originalIdentity.authSessionId),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'plugin-market-acceptance-'));
  for (const [key, value] of Object.entries({
    HOME: home, USERPROFILE: home, SESSION_DATA_DIR: join(home, 'data'),
    BOTMUX_GLOBAL_CONFIG_FILE: join(home, '.botmux/config.json'),
    BOTS_CONFIG: join(home, 'bots.json'), PM2_HOME: join(home, 'pm2'),
    PLUGIN_PM2_HOME: join(home, 'plugin-pm2'),
  })) vi.stubEnv(key, value);
  globalConfig.invalidateGlobalConfigCache();
  fs.writeFileSync(join(home, 'bots.json'), JSON.stringify([{ larkAppId: 'fixture-bot' }]));
  fs.mkdirSync(join(home, '.botmux'), { recursive: true });
  fs.writeFileSync(join(home, '.botmux/.dashboard-token'), 'original');
  io.async = async () => { throw new Error('Unexpected subprocess'); };
  io.sync = () => { throw new Error('Unexpected synchronous subprocess'); };
  expect(paths.pluginRegistryPath()).toBe(join(home, '.botmux/plugins-registry.json'));
  expect(globalConfig.globalConfigPath()).toBe(join(home, '.botmux/config.json'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalConfig.invalidateGlobalConfigCache();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

// 非文本断言：源码只作为 AST 执行夹具隔离 CLI/HTTP 启动副作用，断言真实锁、文件状态和返回结果，不匹配实现文本。
describe('final plugin mutation acceptance', () => {
  it.each(['different package', 'same package'])('INSTALL-RACE: replacement at handoff survives (%s)', async kind => {
    const entered = gate(), release = gate();
    const f = hostFixture({ beforeCli: async () => { entered.resolve(); await release.promise; } });
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.install(plan.nonce, true, 'owner').catch(error => error);
    await entered.promise;
    try {
      installer.installLocalPlugin(localPackage({
        ...manifest, name: kind === 'same package' ? entry.package : '@human/replacement', version: '9.0.0',
      }, 'human'));
    } finally { release.resolve(); }
    expect(await running).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')?.version).toBe('9.0.0');
    expect(marker()).toBe('human');
  });

  it('INSTALL-STAGING: replacement at npm completion survives locked commit', async () => {
    installInitial('1.0.0');
    const f = hostFixture({ npm: prefix => {
      installer.installLocalPlugin(localPackage({ ...manifest, version: '9.0.0' }, 'human'));
      stageNpm(prefix);
    } });
    const plan = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow(/confirmation_superseded/);
    expect(marker()).toBe('human');
  });

  it.each(['id', 'name', 'version'])('STAGED-IDENTITY: changed %s never creates unconfirmed state', async field => {
    const pkg = field === 'id' ? { ...manifest, botmux: { schemaVersion: 1, id: 'unexpected' } }
      : { ...manifest, [field]: field === 'name' ? '@unexpected/package' : '9.0.0' };
    const f = hostFixture({ npm: prefix => stageNpm(prefix, pkg) });
    const plan = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
    expect(registry.listInstalledPlugins()).toHaveLength(0);
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
    expect(fs.existsSync(paths.pluginHome('unexpected'))).toBe(false);
  });

  it('ARCHIVE-HANDOFF: bytes changed after host validation never reach npm install', async () => {
    const f = hostFixture({ beforeCli: async args => {
      fs.writeFileSync(args[1].slice(5), Buffer.from('changed after validation'));
    } });
    const plan = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow();
    expect(f.calls.filter(call => call.command === 'npm' && call.args[0] === 'install')).toHaveLength(0);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
  });

  it('SCRIPTS: guarded npm staging disables scripts and produces the confirmed runtime', async () => {
    const f = hostFixture({ npm: (prefix, args) => {
      if (!args.includes('--ignore-scripts')) {
        fs.writeFileSync(join(home, 'script-side-effect'), 'unapproved script');
        throw new Error('Scripts were not disabled');
      }
      stageNpm(prefix);
    } });
    const plan = await f.market.prepare('sample', 'owner');
    await expect(f.market.install(plan.nonce, true, 'owner')).resolves.toMatchObject({ version: '1.2.3' });
    expect(marker()).toBe('market');
    expect(fs.existsSync(join(home, 'script-side-effect'))).toBe(false);
  });

  it('PROVENANCE: a confirmed install records the pinned registry package, not the deleted archive', async () => {
    const f = hostFixture();
    const plan = await f.market.prepare('sample', 'owner');
    await f.market.install(plan.nonce, true, 'owner');
    const record = registry.getInstalledPlugin('sample')!;
    expect(record.source).toEqual({ type: 'npm', spec: `${entry.package}@${manifest.version}` });
    expect(record.integrity).toBe(plan.integrity);
  });

  it('AUTHORITY-INSTALL: token rotated during download blocks commit and releases busy state', async () => {
    const entered = gate(), release = gate();
    const f = hostFixture({ pack: async () => { entered.resolve(); await release.promise; } });
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.install(plan.nonce, true, 'owner', tokenDigest('original')).catch(error => error);
    await entered.promise;
    fs.writeFileSync(join(home, '.botmux/.dashboard-token'), 'rotated');
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    const next = await f.market.prepare('sample', 'new-owner');
    await expect(f.market.install(next.nonce, true, 'new-owner', tokenDigest('rotated'))).resolves.toHaveProperty('id', 'sample');
  });

  it('STALE-PLAN: older confirmation cannot downgrade a newer completed operation', async () => {
    let version = '1.2.3';
    const market = createPluginMarket({
      fetchCatalog: async () => ({ schemaVersion: 1, plugins: [entry] }),
      metadata: async () => ({ version, integrity }), installed: registry.getInstalledPlugin,
      revision: () => guards.pluginRegistryRevision(),
      now: Date.now, assertStopped: () => {}, isEnabled: enabled,
      install: async plan => { installer.installLocalPlugin(localPackage({ ...manifest, version: plan.version }), { guard: plan }); },
      uninstall: async guard => { registry.removeInstalledPlugin(guard.id); },
    });
    const older = await market.prepare('sample', 'owner');
    version = '2.0.0';
    const newer = await market.prepare('sample', 'owner');
    await market.install(newer.nonce, true, 'owner');
    await expect(market.install(older.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    expect(registry.getInstalledPlugin('sample')?.version).toBe('2.0.0');
  });

  it.each(['same market', 'another market'])('STALE-EMPTY-SLOT: %s uninstall supersedes an earlier empty-slot confirmation', async actor => {
    const f = hostFixture();
    const oldPlan = await f.market.prepare('sample', 'owner');
    expect(oldPlan.expectedState).toBeNull();
    installInitial();
    await (actor === 'same market' ? f.market : createHostPluginMarket(enabled)).uninstall(request());
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
    const outcome = await f.market.install(oldPlan.nonce, true, 'owner').catch(error => error);
    console.log('STALE-EMPTY-SLOT evidence', JSON.stringify({
      actor,
      preparedState: oldPlan.expectedState,
      result: outcome instanceof Error ? { status: outcome.status, error: outcome.message } : outcome,
      registry: registry.getInstalledPlugin('sample'),
      runtimeExists: fs.existsSync(paths.pluginRuntimeDir('sample')),
      runtimeMarker: fs.existsSync(paths.pluginRuntimeDir('sample')) ? marker() : null,
    }));
    expect(outcome).toMatchObject({ status: 409 });
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
  });

  it('CROSS-MARKET: a later completed install supersedes another instance waiting at handoff', async () => {
    const entered = gate(), release = gate();
    let installs = 0;
    const f = hostFixture({ beforeCli: async args => {
      if (args[0] === 'install-verified' && ++installs === 1) { entered.resolve(); await release.promise; }
    } });
    const second = createHostPluginMarket(enabled);
    const firstPlan = await f.market.prepare('sample', 'owner');
    const secondPlan = await second.prepare('sample', 'owner');
    const running = f.market.install(firstPlan.nonce, true, 'owner').catch(error => error);
    await entered.promise;
    try { await second.install(secondPlan.nonce, true, 'owner'); }
    finally { release.resolve(); }
    const completed = registry.getInstalledPlugin('sample');
    expect(await running).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')).toEqual(completed);
    expect(marker()).toBe('market');
  });

  it('LOCKED-ABA: install/remove after dispatch is rejected by the real locked installer', async () => {
    const entered = gate(), release = gate();
    const f = hostFixture({ beforeCli: async args => {
      if (args[0] === 'install-verified') { entered.resolve(); await release.promise; }
    } });
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.install(plan.nonce, true, 'owner').catch(error => error);
    await entered.promise;
    try {
      installInitial();
      await createHostPluginMarket(enabled).uninstall(request());
      expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    } finally { release.resolve(); }
    expect(await running).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
  });

  it('MIXED-SNAPSHOT: a fresh revision cannot authorize replacement of a stale record snapshot', () => {
    installInitial('1.0.0');
    const previous = registry.getInstalledPlugin('sample');
    installer.installLocalPlugin(localPackage({ ...manifest, version: '9.0.0' }, 'human'));
    const guard = {
      id: 'sample', packageName: entry.package, version: '1.2.3',
      expectedState: guards.pluginRecordHash(previous),
      expectedRevision: guards.pluginRegistryRevision(),
    };
    expect(() => installer.installLocalPlugin(localPackage(), { guard })).toThrow();
    expect(marker()).toBe('human');
    expect(registry.getInstalledPlugin('sample')?.version).toBe('9.0.0');
  });

  it('BUSY-RETRY: pending uninstall blocks another operation then releases on failure', async () => {
    installInitial();
    const entered = gate(), release = gate();
    let fail = true;
    const f = hostFixture({ cli: cliHarness({ service: async () => {
      entered.resolve(); await release.promise;
      if (fail) throw new Error('temporary-cleanup-failure');
    } }) });
    const confirmed = request();
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.uninstall(confirmed).catch(error => error);
    await entered.promise;
    try {
      await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
      await expect(f.market.uninstall(confirmed)).rejects.toMatchObject({ status: 409 });
      expect(f.cli.calls.service).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await running; }
    expect(await running).toBeInstanceOf(Error);
    fail = false;
    await f.market.uninstall(confirmed);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
  });

  it('SERVICE-START: desired service start during download blocks replacement at commit', async () => {
    const pkg = localPackage({ ...manifest, botmux: { ...manifest.botmux, service: { mode: 'manual' } } }, 'service-initial');
    fs.mkdirSync(join(pkg, 'dist/service'), { recursive: true });
    fs.writeFileSync(join(pkg, 'dist/service/index.js'), 'throw new Error("Must never execute");\n');
    installer.installLocalPlugin(pkg);
    const entered = gate(), release = gate();
    const f = hostFixture({ pack: async () => { entered.resolve(); await release.promise; } });
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.install(plan.nonce, true, 'owner').catch(error => error);
    await entered.promise;
    const desired = join(home, '.botmux/plugin-supervisor/desired.json');
    fs.mkdirSync(dirname(desired), { recursive: true });
    fs.writeFileSync(desired, JSON.stringify({
      revision: 'human-start', target: 'sample',
      services: { sample: { running: true, spec: { name: 'botmux-plugin-sample', external: { command: '/never-executed' } } } },
    }));
    release.resolve();
    expect(await running).toMatchObject({ code: 'plugin_service_running' });
    expect(marker()).toBe('service-initial');
  });

  it('STALE-PREPARE: replacement while metadata waits rejects before installer dispatch', async () => {
    const entered = gate(), release = gate();
    const dispatch = vi.fn(async () => {});
    const market = createPluginMarket({
      fetchCatalog: async () => ({ schemaVersion: 1, plugins: [entry] }),
      metadata: async () => { entered.resolve(); await release.promise; return { version: '1.2.3', integrity }; },
      installed: registry.getInstalledPlugin, now: Date.now, assertStopped: () => {},
      revision: () => guards.pluginRegistryRevision(),
      isEnabled: enabled, install: dispatch, uninstall: async () => {},
    });
    const pending = market.prepare('sample', 'owner');
    await entered.promise;
    installInitial('9.0.0');
    release.resolve();
    const plan = await pending;
    await expect(market.install(plan.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(registry.getInstalledPlugin('sample')?.version).toBe('9.0.0');
  });

  it('EXPIRY: controllable clock expires a confirmation without dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const f = hostFixture();
    const plan = await f.market.prepare('sample', 'owner');
    vi.setSystemTime(plan.expiresAt);
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    expect(f.calls.some(call => call.args.includes('pack'))).toBe(false);
  });

  it('UNINSTALL-HANDOFF: same-version replacement rejects before any cleanup', async () => {
    installInitial();
    const entered = gate(), release = gate();
    const f = hostFixture({ beforeCli: async () => { entered.resolve(); await release.promise; } });
    const running = f.market.uninstall(request()).catch(error => error);
    await entered.promise;
    installer.installLocalPlugin(localPackage(manifest, 'replacement'));
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(f.cli.calls.service).not.toHaveBeenCalled();
    expect(marker()).toBe('replacement');
  });

  it.each(['global', 'bot'])('SCOPE-SERVICE: human %s enable during service cleanup stops before dematerialization', async scope => {
    installInitial();
    materializer.materializePlugin('sample');
    const entered = gate(), release = gate();
    const cli = cliHarness({ service: async () => { entered.resolve(); await release.promise; } });
    const f = hostFixture({ cli });
    const snapshot = registry.getInstalledPlugin('sample');
    const running = f.market.uninstall(request()).catch(error => error);
    await entered.promise;
    humanEnable(scope);
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')).toEqual(snapshot);
    expect(enabled()).toBe(true);
    expect(marker()).toBe('initial');
    expect(materializer.readMaterializedPlugin('sample')).toBeDefined();
    expect(cli.calls.skills).not.toHaveBeenCalled();
  });

  it.each(['global', 'bot'])('SCOPE-SKILLS: human %s enable during skill cleanup preserves runtime and bindings', async scope => {
    installInitial();
    const entered = gate(), release = gate();
    const f = hostFixture({ cli: cliHarness({ skills: async () => { entered.resolve(); await release.promise; } }) });
    const running = f.market.uninstall(request()).catch(error => error);
    await entered.promise;
    humanEnable(scope);
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(enabled()).toBe(true);
    expect(marker()).toBe('initial');
    expect(registry.getInstalledPlugin('sample')).toBeDefined();
  });

  it.each(['global', 'bot'])('SCOPE-SERIALIZATION: queued %s enable cannot resurrect an uninstalled target', async scope => {
    installInitial();
    const entered = gate(), release = gate();
    const cli = cliHarness({ service: async () => { entered.resolve(); await release.promise; } });
    const f = hostFixture({ cli });
    const running = f.market.uninstall(request()).catch(error => error);
    await entered.promise;
    let settled = false;
    const enabling = cli.invoke(['enable', 'sample', ...(scope === 'bot' ? ['--bot', 'all'] : [])])
      .catch((error: Error) => error).finally(() => { settled = true; });
    try {
      // A bounded observation window lets the real filesystem lock reach contention.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(enabled()).toBe(false);
    } finally { release.resolve(); await Promise.all([running, enabling]); }
    expect(await running).toBeUndefined();
    expect(await enabling).toBeInstanceOf(Error);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
    expect(enabled()).toBe(false);
  });

  it('SCOPE-INSTALL: enabling during staging survives a permitted update', async () => {
    installInitial('1.0.0');
    const entered = gate(), release = gate();
    const f = hostFixture({ pack: async () => { entered.resolve(); await release.promise; } });
    const plan = await f.market.prepare('sample', 'owner');
    const running = f.market.install(plan.nonce, true, 'owner');
    await entered.promise;
    await f.cli.invoke(['enable', 'sample', '--bot', 'all']);
    release.resolve();
    await running;
    expect(enabled()).toBe(true);
    expect(marker()).toBe('market');
  });

  it.each(['service', 'skills', 'bindings', 'rename', 'registry'])('PARTIAL-BINDINGS / CLEANUP: %s failure is retryable from a fresh market', async phase => {
    installInitial();
    const snapshot = registry.getInstalledPlugin('sample');
    let fail = true;
    const check = () => { if (fail) throw new Error(`EACCES:${phase}`); };
    const hooks: Parameters<typeof cliHarness>[0] = {};
    if (phase === 'service') hooks.service = async () => { check(); };
    if (phase === 'skills') hooks.skills = async () => {
      fs.writeFileSync(join(home, 'earlier-cleanup-done'), 'yes');
      check();
    };
    if (phase === 'bindings') hooks.bindings = () => {
      globalConfig.mergeDashboardConfig({ pinnedPlugins: [] });
      check();
    };
    if (phase === 'rename') hooks.rename = ((...args: Parameters<typeof fs.renameSync>) => { check(); return fs.renameSync(...args); }) as typeof fs.renameSync;
    if (phase === 'registry') hooks.remove = id => { check(); return registry.removeInstalledPlugin(id); };
    const f = hostFixture({ cli: cliHarness(hooks) });
    const confirmed = request();
    await expect(f.market.uninstall(confirmed)).rejects.toThrow(`EACCES:${phase}`);
    expect(registry.getInstalledPlugin('sample')).toEqual(snapshot);
    expect(marker()).toBe('initial');
    expect(fs.readdirSync(paths.pluginsHome()).some(name => name.includes('.removed-'))).toBe(false);
    fail = false;
    await expect(createHostPluginMarket(enabled).uninstall(confirmed)).resolves.toBeUndefined();
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
  });

  it.each(['local', 'npm'])('RETIRED-CLEANUP: %s reinstall retries final rm failure without risking the new home', async source => {
    installInitial();
    const cli = cliHarness({ rm: ((path: fs.PathLike, options: fs.RmOptions) => {
      if (String(path).includes('.removed-')) throw new Error('EACCES:retired');
      return fs.rmSync(path, options);
    }) as typeof fs.rmSync });
    const f = hostFixture({ cli });
    const confirmed = request();
    await f.market.uninstall(confirmed);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
    expect(fs.existsSync(paths.pluginHome('sample'))).toBe(false);
    const retired = fs.readdirSync(paths.pluginsHome()).filter(name => name.includes('.removed-'));
    expect(retired).toHaveLength(1);
    if (source === 'local') installInitial('9.0.0');
    else {
      const plan = await f.market.prepare('sample', 'owner');
      await f.market.install(plan.nonce, true, 'owner');
    }
    await expect(f.market.uninstall(confirmed)).rejects.toMatchObject({ status: 409 });
    expect(marker()).toBe(source === 'local' ? 'initial' : 'market');
    expect(fs.existsSync(join(paths.pluginsHome(), retired[0]))).toBe(false);
    expect(cli.scope.console.error).toHaveBeenCalled();
  });

  it.each(['missing', 'present'])('RETIRED-CLEANUP: preserves recovery homes while the original registry record exists (runtime=%s)', runtime => {
    installInitial();
    const retired = `${paths.pluginHome('sample')}.removed-123-456`;
    if (runtime === 'missing') fs.renameSync(paths.pluginHome('sample'), retired);
    else fs.cpSync(paths.pluginHome('sample'), retired, { recursive: true });
    installInitial('9.0.0');
    expect(fs.readFileSync(join(retired, 'dist/marker'), 'utf8')).toBe('initial');
    expect(registry.getInstalledPlugin('sample')?.version).toBe('9.0.0');
  });

  it('RETIRED-CLEANUP: only exact unregistered directories are collected', () => {
    const root = paths.pluginsHome();
    fs.mkdirSync(root, { recursive: true });
    const preserved = ['other.removed-123-456', 'sample.removed-123-bad',
      'sample.removed-123-456-extra', 'sample.removed-123-456.removed-789-123'];
    const collision = 'sample.removed-123-456';
    installer.installLocalPlugin(localPackage({
      ...manifest, botmux: { ...manifest.botmux, id: collision },
    }, 'other-plugin'));
    for (const name of preserved) fs.mkdirSync(join(root, name));
    const external = localPackage();
    fs.symlinkSync(external, join(root, 'sample.removed-123-457'), 'dir');
    fs.writeFileSync(join(root, 'sample.removed-123-458'), 'not a directory');
    fs.mkdirSync(join(root, 'sample.removed-123-459'));
    installInitial();
    for (const name of preserved) expect(fs.existsSync(join(root, name))).toBe(true);
    expect(fs.readFileSync(join(paths.pluginRuntimeDir(collision), 'marker'), 'utf8')).toBe('other-plugin');
    expect(fs.lstatSync(join(root, 'sample.removed-123-457')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(external, 'dist/marker'))).toBe(true);
    expect(fs.readFileSync(join(root, 'sample.removed-123-458'), 'utf8')).toBe('not a directory');
    expect(fs.existsSync(join(root, 'sample.removed-123-459'))).toBe(false);
  });

  it.each([false, true])('RETIRED-CLEANUP: a symlinked local source inside a retired home remains usable (link=%s)', link => {
    fs.mkdirSync(paths.pluginsHome(), { recursive: true });
    registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
    const retired = `${paths.pluginHome('sample')}.removed-123-456`;
    fs.renameSync(localPackage(), retired);
    const alias = join(home, 'source-alias');
    fs.symlinkSync(retired, alias, 'dir');
    installer.installLocalPlugin(alias, { link });
    expect(marker()).toBe(manifest.version);
    expect(fs.existsSync(retired)).toBe(true);
    expect(fs.lstatSync(paths.pluginRuntimeDir('sample')).isSymbolicLink()).toBe(link);
  });

  it('RETIRED-CLEANUP: one inaccessible retired home does not prevent reinstall or other cleanup', () => {
    fs.mkdirSync(paths.pluginsHome(), { recursive: true });
    registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
    const denied = `${paths.pluginHome('sample')}.removed-123-456`;
    const removable = `${paths.pluginHome('sample')}.removed-123-457`;
    fs.mkdirSync(denied);
    fs.mkdirSync(removable);
    const deniedPath = fs.realpathSync(denied);
    const original = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === deniedPath) throw new Error('EACCES:retired');
      return original(path, options);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installInitial();
    expect(marker()).toBe('initial');
    expect(fs.existsSync(denied)).toBe(true);
    expect(fs.existsSync(removable)).toBe(false);
    expect(warning).toHaveBeenCalled();
  });

  it('RETIRED-CLEANUP: rejected confirmation does not collect retired data', () => {
    fs.mkdirSync(paths.pluginsHome(), { recursive: true });
    registry.writePluginRegistry({ schemaVersion: 1, plugins: {} });
    const retired = `${paths.pluginHome('sample')}.removed-123-456`;
    fs.mkdirSync(retired);
    expect(() => installer.installLocalPlugin(localPackage(), { guard: {
      id: 'sample', packageName: entry.package, version: manifest.version,
      expectedState: '0'.repeat(64), expectedRevision: guards.pluginRegistryRevision(),
    } })).toThrow(/confirmation_superseded/);
    expect(fs.existsSync(retired)).toBe(true);
    expect(registry.getInstalledPlugin('sample')).toBeUndefined();
  });

  it('ROLLBACK: install registry failure restores runtime and a fresh confirmation can retry', async () => {
    installInitial('1.0.0');
    const snapshot = registry.getInstalledPlugin('sample');
    const f = hostFixture();
    const plan = await f.market.prepare('sample', 'owner');
    vi.spyOn(registry, 'upsertInstalledPlugin').mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toThrow('ENOSPC');
    expect(registry.getInstalledPlugin('sample')).toEqual(snapshot);
    expect(marker()).toBe('initial');
    await expect(f.market.install(plan.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    const next = await f.market.prepare('sample', 'owner');
    await f.market.install(next.nonce, true, 'owner');
    expect(marker()).toBe('market');
  });

  it('AUTHORITY-UNINSTALL: rotation while cleanup waits preserves installed state', async () => {
    installInitial();
    const entered = gate(), release = gate();
    const f = hostFixture({ cli: cliHarness({ service: async () => { entered.resolve(); await release.promise; } }) });
    const running = f.market.uninstall(request(), tokenDigest('original')).catch(error => error);
    await entered.promise;
    fs.writeFileSync(join(home, '.botmux/.dashboard-token'), 'rotated');
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(marker()).toBe('initial');
  });

  it.each(['rotate', 'revoke'] as const)('BODY-REVOCATION: %s while request body waits prevents dispatch', async action => {
    installInitial();
    const f = hostFixture();
    const route = routeHarness(f.market);
    const pending = route.call();
    route[action]();
    route.stream.end(JSON.stringify(request()));
    expect((await pending).status).toBe(403);
    expect(f.cli.calls.service).not.toHaveBeenCalled();
    expect(marker()).toBe('initial');
  });

  it('BODY-LIMIT: an oversized market request is rejected without dispatching', async () => {
    installInitial();
    const f = hostFixture();
    const route = routeHarness(f.market);
    const pending = route.call();
    route.stream.end(JSON.stringify({ ...request(), padding: 'x'.repeat(40_000) }));
    expect((await pending).status).toBe(413);
    expect(f.cli.calls.service).not.toHaveBeenCalled();
    expect(marker()).toBe('initial');
  });
});
