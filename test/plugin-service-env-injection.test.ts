import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import {
  resolvePluginServiceSpec,
  serviceUrls,
  startPluginServices,
} from '../src/core/plugins/service-manager.js';
import { loadPluginServiceDefinition } from '../src/core/plugins/runtime.js';
import {
  pluginCardActionTokenPath,
  pluginMaterializedPath,
  pluginPrivateDir,
  pluginRegistryPath,
  pluginServiceStatePath,
  pluginWebhookTokenPath,
} from '../src/core/plugins/paths.js';
import { materializePlugin } from '../src/core/plugins/materializer.js';
import { resolveBotmuxBin } from '../src/core/botmux-wrapper.js';
import { resolveRunningPluginServiceTarget } from '../src/core/plugins/webhooks/service-target.js';
import {
  getOrCreatePluginCardActionToken,
  readPluginWebhookToken,
} from '../src/core/plugins/card-actions/auth.js';
import { pluginServiceName } from '../src/core/plugins/supervisor-store.js';
import * as supervisorClient from '../src/core/plugins/supervisor-client.js';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';

vi.mock('../src/core/plugins/supervisor-client.js', () => ({
  readPluginProcesses: vi.fn(),
  changePluginService: vi.fn(),
}));

function writePluginSource(root: string, opts: {
  id: string;
  port?: number;
  pm2Env?: Record<string, string>;
  webhooks?: unknown;
  urlsFn?: string;
}): void {
  mkdirSync(join(root, 'dist', 'service'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: `botmux-plugin-${opts.id}`,
    version: '1.0.0',
    keywords: ['botmux-plugin'],
    botmux: {
      schemaVersion: 1,
      id: opts.id,
      service: { mode: 'manual' },
    },
  }, null, 2));
  writeFileSync(join(root, 'dist', 'service', 'server.js'), 'setInterval(() => {}, 60000);\n');
  const portLine = opts.port !== undefined ? `port: ${opts.port},` : '';
  const urlsLine = opts.urlsFn ? `urls: ${opts.urlsFn},` : '';
  writeFileSync(join(root, 'dist', 'service', 'index.js'), `export default {
    mode: 'manual',
    ${portLine}
    pm2: { script: './service/server.js', env: ${JSON.stringify(opts.pm2Env ?? {})} },
    ${urlsLine}
  };\n`);
  if (opts.webhooks !== undefined) {
    mkdirSync(join(root, 'dist', 'webhooks'), { recursive: true });
    writeFileSync(join(root, 'dist', 'webhooks', 'index.json'), JSON.stringify(opts.webhooks, null, 2));
  }
}

describe('plugin service host env injection, webhooks port/token, and liveness resolution', () => {
  let home: string;
  let dataDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-env-inject-'));
    dataDir = join(home, 'custom-data');
    mkdirSync(dataDir, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
    vi.stubEnv('BOTMUX_NO_CLAIM', '1');
    vi.mocked(supervisorClient.readPluginProcesses).mockReset().mockReturnValue([]);
    vi.mocked(supervisorClient.changePluginService).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('injects BOTMUX_DATA_DIR, BOTMUX_BIN, and isolated webhook/callback tokens, prevents spoofing, and persists processStart', async () => {
    const src = join(home, 'src-webhook');
    writePluginSource(src, {
      id: 'env-webhook',
      port: 44123,
      pm2Env: {
        BOTMUX_DATA_DIR: '/forged/data',
        BOTMUX_BIN: '/forged/bin/botmux',
        BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'forged-token',
        BOTMUX_PLUGIN_WEBHOOK_TOKEN: 'forged-webhook-token',
        PORT: '9999',
        CUSTOM_VAR: 'keep-me',
      },
      webhooks: { schemaVersion: 1, routes: [{ path: '/events' }] },
      urlsFn: `({ host, port, env }) => ({ openUrl: 'http://' + host + ':' + port + '/?hasToken=' + Boolean(env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN || env.BOTMUX_PLUGIN_WEBHOOK_TOKEN) + '&data=' + Boolean(env.BOTMUX_DATA_DIR) })`,
    });

    const { record } = installLocalPlugin(src);
    materializePlugin('env-webhook');
    const definition = (await loadPluginServiceDefinition(record))!;

    // Public urls() sees BOTMUX_DATA_DIR/BOTMUX_BIN but NEVER sees forged or real tokens
    const urls = serviceUrls(record, definition);
    expect(urls.port).toBe(44123);
    expect(urls.openUrl).toContain('hasToken=false');
    expect(urls.openUrl).toContain('data=true');

    const spec = resolvePluginServiceSpec(record, definition);
    expect(spec.external.env).toMatchObject({
      BOTMUX_PLUGIN_ID: 'env-webhook',
      BOTMUX_DATA_DIR: dataDir,
      BOTMUX_BIN: join(home, '.botmux', 'bin', process.platform === 'win32' ? 'botmux.cmd' : 'botmux'),
      SESSION_DATA_DIR: dataDir,
      PORT: '44123',
      CUSTOM_VAR: 'keep-me',
    });
    const cardToken = spec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN;
    const webhookToken = spec.external.env.BOTMUX_PLUGIN_WEBHOOK_TOKEN;
    expect(cardToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(webhookToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cardToken).not.toBe('forged-token');
    expect(webhookToken).not.toBe('forged-webhook-token');
    expect(webhookToken).not.toBe(cardToken);
    expect(readPluginWebhookToken('env-webhook')).toBe(webhookToken);

    for (const tokPath of [pluginCardActionTokenPath('env-webhook'), pluginWebhookTokenPath('env-webhook')]) {
      const stat = lstatSync(tokPath);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    }

    vi.mocked(supervisorClient.readPluginProcesses)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{
        name: pluginServiceName('env-webhook'),
        pid: 43210,
        processStart: 'boot-1:999',
        status: 'online',
      }]);

    const reports = await startPluginServices(['env-webhook']);
    expect(reports[0].action).toBe('started');
    const savedState = JSON.parse(readFileSync(pluginServiceStatePath('env-webhook'), 'utf8'));
    expect(savedState).toMatchObject({
      status: 'online',
      pid: 43210,
      processStart: 'boot-1:999',
      port: 44123,
    });

    for (const secret of [cardToken, webhookToken]) {
      expect(JSON.stringify(reports)).not.toContain(secret);
      expect(readFileSync(pluginRegistryPath(), 'utf8')).not.toContain(secret);
      expect(readFileSync(pluginMaterializedPath('env-webhook'), 'utf8')).not.toContain(secret);
      expect(readFileSync(pluginServiceStatePath('env-webhook'), 'utf8')).not.toContain(secret);
    }
  });

  it('rejects a webhooks-only plugin without a fixed top-level port (even if pm2.env.PORT is set)', async () => {
    const srcNoPort = join(home, 'src-no-port');
    writePluginSource(srcNoPort, {
      id: 'webhook-no-port',
      webhooks: { schemaVersion: 1, routes: [{ path: '/events' }] },
    });
    installLocalPlugin(srcNoPort);
    const reports1 = await startPluginServices(['webhook-no-port']);
    expect(reports1).toEqual([expect.objectContaining({
      pluginId: 'webhook-no-port',
      action: 'failed',
      warning: 'plugin_webhooks_fixed_port_required:webhook-no-port',
    })]);

    const srcEnvPortOnly = join(home, 'src-pm2-port-only');
    writePluginSource(srcEnvPortOnly, {
      id: 'webhook-pm2-port-only',
      pm2Env: { PORT: '44123' },
      webhooks: { schemaVersion: 1, routes: [{ path: '/events' }] },
    });
    installLocalPlugin(srcEnvPortOnly);
    const reports2 = await startPluginServices(['webhook-pm2-port-only']);
    expect(reports2).toEqual([expect.objectContaining({
      pluginId: 'webhook-pm2-port-only',
      action: 'failed',
      warning: 'plugin_webhooks_fixed_port_required:webhook-pm2-port-only',
    })]);
    expect(supervisorClient.changePluginService).not.toHaveBeenCalled();
  });

  it('allocates loopback token for port-bearing HTTP services (top-level or pm2.env.PORT) and strips forged tokens when portless/invalid', async () => {
    const httpSrc = join(home, 'src-http-only');
    writePluginSource(httpSrc, {
      id: 'http-only',
      port: 44124,
      pm2Env: { BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'forged-http', BOTMUX_PLUGIN_WEBHOOK_TOKEN: 'forged-wh' },
    });
    const { record: httpRecord } = installLocalPlugin(httpSrc);
    const httpDef = (await loadPluginServiceDefinition(httpRecord))!;
    const httpSpec = resolvePluginServiceSpec(httpRecord, httpDef);
    expect(httpSpec.external.env.PORT).toBe('44124');
    expect(httpSpec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(httpSpec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN).not.toBe('forged-http');
    expect(httpSpec.external.env.BOTMUX_PLUGIN_WEBHOOK_TOKEN).toBeUndefined();

    // Non-webhook HTTP service declaring valid string pm2.env.PORT without top-level port
    const envPortSrc = join(home, 'src-env-port');
    writePluginSource(envPortSrc, {
      id: 'env-port-http',
      pm2Env: { PORT: '44126', BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'forged-pm2-port' },
    });
    const { record: envPortRecord } = installLocalPlugin(envPortSrc);
    const envPortDef = (await loadPluginServiceDefinition(envPortRecord))!;
    expect(serviceUrls(envPortRecord, envPortDef).port).toBe(44126);
    const envPortSpec = resolvePluginServiceSpec(envPortRecord, envPortDef);
    expect(envPortSpec.external.env.PORT).toBe('44126');
    expect(envPortSpec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(envPortSpec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN).not.toBe('forged-pm2-port');

    // Invalid pm2.env.PORT strings and portless services get no token
    for (const [idx, badPort] of ['8080abc', '70000', '0', ''].entries()) {
      const badSrc = join(home, `src-bad-port-${idx}`);
      writePluginSource(badSrc, {
        id: `bad-port-${idx}`,
        pm2Env: {
          ...(badPort ? { PORT: badPort } : {}),
          BOTMUX_PLUGIN_CARD_ACTION_TOKEN: 'forged-worker',
          BOTMUX_PLUGIN_WEBHOOK_TOKEN: 'forged-wh',
        },
      });
      const { record } = installLocalPlugin(badSrc);
      const def = (await loadPluginServiceDefinition(record))!;
      expect(serviceUrls(record, def).port).toBeUndefined();
      const spec = resolvePluginServiceSpec(record, def);
      expect(spec.external.env.BOTMUX_PLUGIN_CARD_ACTION_TOKEN).toBeUndefined();
      expect(spec.external.env.BOTMUX_PLUGIN_WEBHOOK_TOKEN).toBeUndefined();
      expect(spec.external.env.BOTMUX_DATA_DIR).toBe(dataDir);
    }
  });

  it('resolves BOTMUX_DATA_DIR via .data-dir breadcrumb and default ~/.botmux/data when SESSION_DATA_DIR is unset', async () => {
    vi.stubEnv('SESSION_DATA_DIR', '');
    const breadcrumbDir = join(home, 'bread-data');
    mkdirSync(breadcrumbDir, { recursive: true });
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.data-dir'), `${breadcrumbDir}\n`);

    const src = join(home, 'src-bread');
    writePluginSource(src, { id: 'bread-plugin', port: 44125 });
    const { record } = installLocalPlugin(src);
    const def = (await loadPluginServiceDefinition(record))!;
    expect(resolvePluginServiceSpec(record, def).external.env.BOTMUX_DATA_DIR).toBe(breadcrumbDir);

    rmSync(join(home, '.botmux', '.data-dir'));
    expect(resolvePluginServiceSpec(record, def).external.env.BOTMUX_DATA_DIR).toBe(join(home, '.botmux', 'data'));
  });

  it.skipIf(!existsSync(resolve('dist/cli.js')))('creates a missing botmux wrapper even when dataDir does not exist yet without overwriting existing wrapper', async () => {
    const freshDataDir = join(home, 'nonexistent-data-dir');
    vi.stubEnv('SESSION_DATA_DIR', freshDataDir);
    const src = join(home, 'src-wrapper');
    writePluginSource(src, { id: 'wrapper-test', port: 44127 });
    installLocalPlugin(src);

    // Suppressed when BOTMUX_NO_CLAIM=1
    await startPluginServices(['wrapper-test']);
    expect(existsSync(resolveBotmuxBin())).toBe(false);

    // Unset BOTMUX_NO_CLAIM -> materializes missing wrapper even though freshDataDir didn't exist
    delete process.env.BOTMUX_NO_CLAIM;
    await startPluginServices(['wrapper-test']);
    const wrapperPath = resolveBotmuxBin();
    expect(existsSync(wrapperPath)).toBe(true);
    expect(readFileSync(wrapperPath, 'utf8')).toContain('dist/cli.js');

    // Never overwrites an already-existing wrapper
    const sentinel = '#!/bin/sh\n# existing-wrapper-sentinel\n';
    writeFileSync(wrapperPath, sentinel, { mode: 0o755 });
    await startPluginServices(['wrapper-test']);
    expect(readFileSync(wrapperPath, 'utf8')).toBe(sentinel);
  });

  it('resolves BOTMUX_BIN safely across wrapper override, standalone binary, core-only, and Windows', () => {
    expect(resolveBotmuxBin({
      env: { HOME: home, BOTMUX_WRAPPER_BIN: '/opt/candidate/bin' },
      platform: 'linux',
      standalone: true,
      execPath: '/usr/local/bin/botmux',
    })).toBe('/opt/candidate/bin/botmux');

    expect(resolveBotmuxBin({
      env: { HOME: home },
      platform: 'linux',
      standalone: true,
      execPath: '/usr/local/bin/botmux',
    })).toBe('/usr/local/bin/botmux');

    expect(resolveBotmuxBin({
      env: { HOME: home },
      platform: 'linux',
      standalone: true,
      execPath: '/$bunfs/root/botmux',
    })).toBe(join(home, '.botmux', 'bin', 'botmux'));
    expect(resolveBotmuxBin({
      env: { HOME: home },
      platform: 'linux',
      standalone: true,
      execPath: '/opt/botmux (deleted)',
    })).toBe(join(home, '.botmux', 'bin', 'botmux'));

    expect(resolveBotmuxBin({
      env: { HOME: home, BOTMUX_CORE_ONLY: '1', SESSION_DATA_DIR: '/srv/core' },
      platform: 'linux',
      standalone: false,
    })).toBe('/srv/core/bin/botmux');

    expect(resolveBotmuxBin({
      env: { HOME: home },
      platform: 'win32',
      standalone: false,
    })).toBe(join(home, '.botmux', 'bin', 'botmux.cmd'));
  });

  it('fences BOTMUX_WRAPPER_BIN, BOTMUX_BIN, and BOTMUX_DATA_DIR in fenceHomeRootedEnv', () => {
    const env: NodeJS.ProcessEnv = {
      BOTMUX_WRAPPER_BIN: '/live/.botmux/bin',
      BOTMUX_BIN: '/live/.botmux/bin/botmux',
      BOTMUX_DATA_DIR: '/live/.botmux/data',
      KEEP_ME: '1',
    };
    fenceHomeRootedEnv(home, env);
    expect(env.BOTMUX_WRAPPER_BIN).toBeUndefined();
    expect(env.BOTMUX_BIN).toBeUndefined();
    expect(env.BOTMUX_DATA_DIR).toBeUndefined();
    expect(env.KEEP_ME).toBe('1');
  });

  it('enforces full fail-closed matrix in resolveRunningPluginServiceTarget (supervisor, port drift/collision, PID/processStart, and real on-disk tokens)', () => {
    mkdirSync(join(home, '.botmux', 'plugins', 'live-svc'), { recursive: true });
    const token = getOrCreatePluginCardActionToken('live-svc');

    const baseState = {
      pluginId: 'live-svc',
      updatedAt: new Date().toISOString(),
      status: 'online',
      pid: 424242,
      processStart: 'boot-1',
      port: 44199,
    };
    const makeDesiredSpec = (id: string, env: Record<string, string>) => ({
      running: true,
      spec: {
        name: pluginServiceName(id),
        appId: '',
        botIndex: -1,
        logBaseName: id,
        external: { command: 'node', args: [], cwd: '/', env, autorestart: true, configHash: 'abc' },
      },
    });

    // 1. Valid supervisor state succeeds and returns pid + processStart
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => baseState,
      hasSupervisorFiles: () => true,
      readDesired: () => ({
        revision: 'r1',
        target: 'live-svc',
        services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) },
      }),
      readProcesses: () => [{ name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', configHash: 'abc', status: 'online' }],
      forbiddenPorts: () => new Set([3999, 18888]),
    })).toEqual({ ok: true, host: '127.0.0.1', port: 44199, token, pid: 999, processStart: 'boot-2' });

    // 1b. A stale 'unknown' service.json (transient /proc hiccup persisted by a
    // status query) must not block recovery: supervisor mode trusts desired +
    // the LIVE verified process, not the cached projection.
    const recoveredDesired = {
      revision: 'r1',
      target: 'live-svc',
      services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) },
    };
    const verifiedProc = [{ name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', configHash: 'abc', status: 'online' }];
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => ({ ...baseState, status: 'unknown' }),
      hasSupervisorFiles: () => true,
      readDesired: () => recoveredDesired,
      readProcesses: () => verifiedProc,
    })).toEqual({ ok: true, host: '127.0.0.1', port: 44199, token, pid: 999, processStart: 'boot-2' });

    // 1c. But if the live process is still unverified (unknown), it stays 503
    // even when desired/port are otherwise valid.
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => ({ ...baseState, status: 'unknown' }),
      hasSupervisorFiles: () => true,
      readDesired: () => recoveredDesired,
      readProcesses: () => [{ name: pluginServiceName('live-svc'), pid: 999, status: 'unknown' }],
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });

    // 1d. The desired port (not the stale cache) is authoritative in supervisor mode.
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => ({ ...baseState, status: 'unknown', port: 55555 }),
      hasSupervisorFiles: () => true,
      readDesired: () => recoveredDesired,
      readProcesses: () => verifiedProc,
    })).toEqual({ ok: true, host: '127.0.0.1', port: 44199, token, pid: 999, processStart: 'boot-2' });

    // 1e. configHash generation binding: an online proc running the OLD config
    // while desired already carries the NEW hash/port must fail closed, and so
    // must any missing hash (no undefined === undefined pass).
    for (const proc of [
      { name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', configHash: 'old-config', status: 'online' },
      { name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', status: 'online' },
    ]) {
      expect(resolveRunningPluginServiceTarget('live-svc', {
        readServiceState: () => ({ ...baseState, status: 'unknown' }),
        hasSupervisorFiles: () => true,
        readDesired: () => recoveredDesired,
        readProcesses: () => [proc],
      })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });
    }
    // A desired spec without a hash also fails closed even with a matching live proc.
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => baseState,
      hasSupervisorFiles: () => true,
      readDesired: () => ({
        revision: 'r1', target: 'live-svc',
        services: { 'live-svc': { running: true, spec: { name: pluginServiceName('live-svc'), external: { env: { PORT: '44199' } } } } },
      }),
      readProcesses: () => verifiedProc,
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });

    // 2. serviceState validation failures
    for (const badState of [
      undefined,
      { ...baseState, pluginId: 'other' },
      { ...baseState, status: 'stopped' },
      { ...baseState, port: 0 },
    ]) {
      expect(resolveRunningPluginServiceTarget('live-svc', {
        readServiceState: () => badState,
        hasSupervisorFiles: () => false,
      })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });
    }

    // 3. Supervisor fail-closed cases: missing desired, running=false, missing PORT, port collision, missing/dead/no-processStart proc, corrupt supervisor.
    //    Port drift between desired and the stale service.json cache is NOT a
    //    failure anymore: desired + live verified proc are authoritative (case 1d).
    //    Procs carry the matching 'abc' hash unless the case itself targets proc evidence.
    const okProc = { name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', configHash: 'abc', status: 'online' };
    const supCases = [
      { desired: { revision: 'r1', target: 'live-svc', services: {} }, procs: [okProc] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': { ...makeDesiredSpec('live-svc', { PORT: '44199' }), running: false } } }, procs: [okProc] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', {}) } }, procs: [okProc] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }), 'other-svc': makeDesiredSpec('other-svc', { PORT: '44199' }) } }, procs: [okProc] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) } }, procs: [] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) } }, procs: [{ name: pluginServiceName('live-svc'), pid: 999, processStart: 'boot-2', configHash: 'abc', status: 'stopped' }] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) } }, procs: [{ name: pluginServiceName('live-svc'), pid: 0, processStart: 'boot-2', configHash: 'abc', status: 'online' }] },
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) } }, procs: [{ name: pluginServiceName('live-svc'), pid: 999, configHash: 'abc', status: 'online' }] },
      // A live pid whose birth identity could not be verified projects as
      // 'unknown' (pid retained, no processStart): the proxy must fail 503.
      { desired: { revision: 'r1', target: 'live-svc', services: { 'live-svc': makeDesiredSpec('live-svc', { PORT: '44199' }) } }, procs: [{ name: pluginServiceName('live-svc'), pid: 999, status: 'unknown' }] },
    ];
    for (const c of supCases) {
      expect(resolveRunningPluginServiceTarget('live-svc', {
        readServiceState: () => baseState,
        hasSupervisorFiles: () => true,
        readDesired: () => c.desired,
        readProcesses: () => c.procs,
        isPidAlive: () => true,
      })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });
    }
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => baseState,
      hasSupervisorFiles: () => true,
      readDesired: () => { throw new Error('corrupt'); },
      isPidAlive: () => true,
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });

    // 4. Non-supervisor fail-closed cases: forbidden port, missing pid, missing processStart, dead PID, zombie PID, recycled PID
    expect(resolveRunningPluginServiceTarget('live-svc', {
      readServiceState: () => baseState,
      hasSupervisorFiles: () => false,
      isPidAlive: () => true,
      isZombie: () => false,
      readProcessStart: () => 'boot-1',
      forbiddenPorts: () => new Set([44199]),
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });

    for (const nonSupBad of [
      { state: { ...baseState, pid: undefined }, alive: true, zombie: false, start: 'boot-1' },
      { state: { ...baseState, pid: 0 }, alive: true, zombie: false, start: 'boot-1' },
      { state: { ...baseState, processStart: undefined }, alive: true, zombie: false, start: 'boot-1' },
      { state: baseState, alive: false, zombie: false, start: 'boot-1' },
      { state: baseState, alive: true, zombie: true, start: 'boot-1' },
      { state: baseState, alive: true, zombie: false, start: 'boot-OTHER' },
    ]) {
      expect(resolveRunningPluginServiceTarget('live-svc', {
        readServiceState: () => nonSupBad.state,
        hasSupervisorFiles: () => false,
        isPidAlive: () => nonSupBad.alive,
        isZombie: () => nonSupBad.zombie,
        readProcessStart: () => nonSupBad.start,
      })).toEqual({ ok: false, status: 503, error: 'plugin_service_unavailable' });
    }

    // 5. Real on-disk missing, corrupt, and symlinked token files fail closed WITHOUT minting a token file
    const missingTokenPath = pluginCardActionTokenPath('missing-token-svc');
    expect(existsSync(missingTokenPath)).toBe(false);
    expect(resolveRunningPluginServiceTarget('missing-token-svc', {
      readServiceState: () => ({ ...baseState, pluginId: 'missing-token-svc' }),
      hasSupervisorFiles: () => false,
      isPidAlive: () => true,
      isZombie: () => false,
      readProcessStart: () => 'boot-1',
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_token_unavailable' });
    expect(existsSync(missingTokenPath)).toBe(false);

    const badTokenPath = pluginCardActionTokenPath('bad-token-svc');
    mkdirSync(pluginPrivateDir('bad-token-svc'), { recursive: true, mode: 0o700 });
    for (const badContent of ['', '   \n', 'too-short', 'invalid!chars'.padEnd(43, 'a')]) {
      writeFileSync(badTokenPath, badContent, { mode: 0o600 });
      expect(resolveRunningPluginServiceTarget('bad-token-svc', {
        readServiceState: () => ({ ...baseState, pluginId: 'bad-token-svc' }),
        hasSupervisorFiles: () => false,
        isPidAlive: () => true,
        isZombie: () => false,
        readProcessStart: () => 'boot-1',
      })).toEqual({ ok: false, status: 503, error: 'plugin_service_token_unavailable' });
    }

    const symlinkTokenPath = pluginCardActionTokenPath('symlink-token-svc');
    mkdirSync(pluginPrivateDir('symlink-token-svc'), { recursive: true, mode: 0o700 });
    const externalToken = join(home, 'external-loopback.token');
    writeFileSync(externalToken, `${token}\n`, { mode: 0o600 });
    symlinkSync(externalToken, symlinkTokenPath);
    expect(resolveRunningPluginServiceTarget('symlink-token-svc', {
      readServiceState: () => ({ ...baseState, pluginId: 'symlink-token-svc' }),
      hasSupervisorFiles: () => false,
      isPidAlive: () => true,
      isZombie: () => false,
      readProcessStart: () => 'boot-1',
    })).toEqual({ ok: false, status: 503, error: 'plugin_service_token_unavailable' });
  });
});
