import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
const spawnSync = vi.fn();
const execSync = vi.fn();

vi.mock('node:child_process', () => ({ spawn, spawnSync, execSync }));

function makeChild(result: { stdout?: string; stderr?: string; code?: number; error?: Error; pid?: number }) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = result.pid ?? 12345;
  child.kill = vi.fn();
  setImmediate(() => {
    if (result.error) {
      child.emit('error', result.error);
      return;
    }
    if (result.stdout != null) child.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr != null) child.stderr.emit('data', Buffer.from(result.stderr));
    child.emit('close', result.code ?? 0);
  });
  return child;
}

function queueSpawn(...results: Array<Parameters<typeof makeChild>[0]>) {
  let index = 0;
  spawn.mockImplementation(() => makeChild(results[Math.min(index++, results.length - 1)] ?? { code: 0 }));
}

function pluginState(
  source = 'trusted/repo',
  ref = 'reviewed-sha',
  resolvedCommit = 'deadbeef',
): { stdout: string; code: number } {
  const [owner, repo, ...subdirParts] = source.split('/');
  return {
    stdout: JSON.stringify({
      result: {
        plugins: [{
          plugin_id: 'com.traex.herdr-integration',
          source: {
            owner,
            repo,
            ...(subdirParts.length ? { subdir: subdirParts.join('/') } : {}),
            ...(ref ? { requested_ref: ref } : {}),
            resolved_commit: resolvedCommit,
          },
        }],
      },
    }),
    code: 0,
  };
}

const LIST_EMPTY = { stdout: '{"result":{"plugins":[]}}', code: 0 };
const INSTALL_OK = { stdout: 'installed', code: 0 };
const ACTION_OK = { stdout: 'hooks written', code: 0 };

async function loadSubject() {
  vi.resetModules();
  return import('../src/setup/ensure-herdr-integrations.js');
}

describe('TraeX herdr plugin installation', () => {
  let home: string;
  let markerPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-herdr-int-'));
    markerPath = join(home, '.botmux', 'state', 'herdr-traex-plugin.json');
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', '');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SOURCE', '');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_REF', '');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', '');
    spawn.mockReset();
    spawnSync.mockReset();
    execSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    execSync.mockReturnValue('herdr 0.7.3');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function writeMarker(source: string, ref: string, resolvedCommit: string) {
    mkdirSync(join(home, '.botmux', 'state'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ source, ref, resolvedCommit, actionInvokedAt: '2026-01-01T00:00:00.000Z' }));
  }

  it('stays inert unless the machine-wide opt-in is enabled', async () => {
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);
    expect(result.traexPlugin).toMatchObject({ attempted: false, enabled: false, skippedReason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('requires an operator-supplied source', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);
    expect(result.traexPlugin).toMatchObject({ attempted: false, enabled: true, skippedReason: 'missing_source' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gates herdr versions without the plugin capability and reports the version', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SOURCE', 'trusted/repo');
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'unknown command' });
    execSync.mockReturnValue('herdr 0.6.6');
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);
    expect(result.traexPlugin).toMatchObject({
      attempted: false,
      skippedReason: 'plugin_unsupported',
      herdrVersion: '0.6.6',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes source and ref as separate argv, invokes the action, and writes the marker', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SOURCE', 'trusted/repo/subdir');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_REF', 'reviewed-sha');
    queueSpawn(LIST_EMPTY, INSTALL_OK, pluginState('trusted/repo/subdir'), ACTION_OK);

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: true,
      source: 'trusted/repo/subdir',
      ref: 'reviewed-sha',
      installed: true,
      actionInvoked: true,
    });
    expect(spawn).toHaveBeenNthCalledWith(2, 'herdr', [
      'plugin', 'install', 'trusted/repo/subdir', '--ref', 'reviewed-sha', '--yes',
    ], expect.objectContaining({ detached: true }));
    expect(spawn).toHaveBeenNthCalledWith(4, 'herdr', [
      'plugin', 'action', 'invoke', 'com.traex.herdr-integration.install',
    ], expect.objectContaining({ detached: true }));
    expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toMatchObject({
      source: 'trusted/repo/subdir',
      ref: 'reviewed-sha',
      resolvedCommit: 'deadbeef',
    });
  });

  it('skips install and action only when herdr metadata and the action marker both match', async () => {
    writeMarker('trusted/repo', 'reviewed-sha', 'deadbeef');
    queueSpawn(pluginState());
    const { installTraexPluginNow } = await loadSubject();
    const result = await installTraexPluginNow('trusted/repo', 'reviewed-sha');
    expect(result).toMatchObject({ alreadyInstalled: true, installed: false, actionInvoked: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not invoke third-party actions when post-install metadata cannot verify source/ref/commit', async () => {
    queueSpawn(LIST_EMPTY, INSTALL_OK, pluginState('other/repo', 'reviewed-sha', 'deadbeef'));
    const { installTraexPluginNow } = await loadSubject();
    const result = await installTraexPluginNow('trusted/repo', 'reviewed-sha');
    expect(result.failed).toMatchObject({ step: 'install' });
    expect(result.failed?.reason).toContain('元数据不匹配');
    expect(spawn.mock.calls.filter(([, args]) => args?.[1] === 'action')).toHaveLength(0);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('retries a failed action without reinstalling the already-correct source/ref', async () => {
    queueSpawn(
      LIST_EMPTY,
      INSTALL_OK,
      pluginState(),
      { stderr: 'action boom', code: 1 },
      pluginState(),
      ACTION_OK,
    );
    const { installTraexPluginNow } = await loadSubject();

    const first = await installTraexPluginNow('trusted/repo', 'reviewed-sha');
    expect(first.failed).toMatchObject({ step: 'action', reason: 'action boom' });
    expect(existsSync(markerPath)).toBe(false);

    const second = await installTraexPluginNow('trusted/repo', 'reviewed-sha');
    expect(second).toMatchObject({ installed: false, actionInvoked: true });
    const installCalls = spawn.mock.calls.filter(([, args]) => args?.[1] === 'install');
    const actionCalls = spawn.mock.calls.filter(([, args]) => args?.[1] === 'action');
    expect(installCalls).toHaveLength(1);
    expect(actionCalls).toHaveLength(2);
  });

  it('reinstalls when the desired ref changes, even though the plugin id is present', async () => {
    writeMarker('trusted/repo', 'old-sha', 'old-commit');
    queueSpawn(
      pluginState('trusted/repo', 'old-sha', 'old-commit'),
      INSTALL_OK,
      pluginState('trusted/repo', 'new-sha', 'new-commit'),
      ACTION_OK,
    );
    const { installTraexPluginNow } = await loadSubject();
    const result = await installTraexPluginNow('trusted/repo', 'new-sha');
    expect(result).toMatchObject({ installed: true, actionInvoked: true });
    expect(spawn).toHaveBeenNthCalledWith(2, 'herdr', [
      'plugin', 'install', 'trusted/repo', '--ref', 'new-sha', '--yes',
    ], expect.any(Object));
  });

  it('serializes concurrent triggers so install/action run once', async () => {
    queueSpawn(LIST_EMPTY, INSTALL_OK, pluginState(), ACTION_OK, pluginState());
    const { installTraexPluginNow } = await loadSubject();
    const [first, second] = await Promise.all([
      installTraexPluginNow('trusted/repo', 'reviewed-sha'),
      installTraexPluginNow('trusted/repo', 'reviewed-sha'),
    ]);
    expect([first, second].some(result => result.installed)).toBe(true);
    expect([first, second].some(result => result.alreadyInstalled)).toBe(true);
    expect(spawn.mock.calls.filter(([, args]) => args?.[1] === 'install')).toHaveLength(1);
    expect(spawn.mock.calls.filter(([, args]) => args?.[1] === 'action')).toHaveLength(1);
  });

  it('kills the detached process group on timeout and resolves only after close', async () => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 24680;
    child.kill = vi.fn();
    spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { spawnHerdrAsync } = await loadSubject();

    let settled = false;
    const promise = spawnHerdrAsync(['plugin', 'list'], 10).then(result => {
      settled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(kill).toHaveBeenCalledWith(-24680, 'SIGKILL');
    expect(settled).toBe(false);
    child.emit('close', null);
    await expect(promise).resolves.toMatchObject({ ok: false, reason: 'timeout after 10ms' });
  });

  it('reports install failures with a valid source/ref manual command', async () => {
    queueSpawn(LIST_EMPTY, { stderr: 'network', code: 1 });
    const { installTraexPluginNow } = await loadSubject();
    const result = await installTraexPluginNow('trusted/repo', 'reviewed-sha');
    expect(result.failed).toMatchObject({
      step: 'install',
      reason: 'network',
      manualCommand: 'herdr plugin install trusted/repo --ref reviewed-sha --yes && herdr plugin action invoke com.traex.herdr-integration.install',
    });
  });

  it('only installs on a touched, enabled settings patch with a non-empty source', async () => {
    const { maybeInstallTraexPluginOnSettingsChange } = await loadSubject();
    const installFn = vi.fn(async (source: string, ref: string) => ({
      attempted: true,
      enabled: true,
      source,
      ref,
      installed: true,
      alreadyInstalled: false,
      actionInvoked: true,
    }));
    expect(await maybeInstallTraexPluginOnSettingsChange(false, { enabled: true, source: 'a/b', ref: 'sha' }, installFn)).toBeUndefined();
    expect(await maybeInstallTraexPluginOnSettingsChange(true, { enabled: false, source: 'a/b', ref: 'sha' }, installFn)).toBeUndefined();
    expect(await maybeInstallTraexPluginOnSettingsChange(true, { enabled: true, source: ' ', ref: '' }, installFn)).toBeUndefined();
    expect(installFn).not.toHaveBeenCalled();

    const result = await maybeInstallTraexPluginOnSettingsChange(true, { enabled: true, source: 'a/b', ref: 'sha' }, installFn);
    expect(installFn).toHaveBeenCalledWith('a/b', 'sha');
    expect(result).toMatchObject({ installed: true });
  });
});
