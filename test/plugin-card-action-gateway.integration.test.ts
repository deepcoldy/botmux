import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginCardActionGateway } from '../src/core/plugins/card-actions/gateway.js';
import type { InstalledPluginRecord, PluginRegistryFile } from '../src/core/plugins/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const fixturePath = resolve('test/fixtures/plugin-card-action-service.ts');
const children = new Set<ChildProcess>();
const tempRoots = new Set<string>();

const recordFor = (pluginId = 'example-actions'): InstalledPluginRecord => {
  const now = new Date(0).toISOString();
  return {
    id: pluginId,
    packageName: `@botmux-ai/plugin-${pluginId}`,
    version: '1.0.0',
    source: { type: 'local', spec: `/plugins/${pluginId}` },
    manifest: { schemaVersion: 1, id: pluginId, service: { mode: 'auto' } },
    contributions: {
      service: { entry: 'service/index.js', mode: 'auto' },
      cardActions: {
        schemaVersion: 1,
        actions: ['example.review.submit'],
        endpoint: '/botmux/card-actions/v1',
      },
    },
    installedAt: now,
    updatedAt: now,
  };
};

const registryFor = (record: InstalledPluginRecord): PluginRegistryFile => ({
  schemaVersion: 1,
  plugins: { [record.id]: record },
});

const waitForReady = (child: ChildProcess): Promise<number> => new Promise((resolveReady, reject) => {
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => reject(new Error(`fixture_ready_timeout:${stderr}`)), 10_000);
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.stdout?.on('data', chunk => {
    stdout += String(chunk);
    const newline = stdout.indexOf('\n');
    if (newline < 0) return;
    clearTimeout(timeout);
    try {
      const ready = JSON.parse(stdout.slice(0, newline));
      resolveReady(ready.port);
    } catch (error) {
      reject(error);
    }
  });
  child.once('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', code => {
    if (code !== null && code !== 0) {
      clearTimeout(timeout);
      reject(new Error(`fixture_exited:${code}:${stderr}`));
    }
  });
});

const startFixture = async (
  mode: string,
  options: { port?: number; token?: string; delayMs?: number } = {},
): Promise<{ child: ChildProcess; port: number; token: string; logPath: string }> => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-card-action-fixture-'));
  tempRoots.add(root);
  const logPath = join(root, 'requests.ndjson');
  const token = options.token ?? 'fixture-token';
  const child = spawnTsScript(fixturePath, [
    String(options.port ?? 0),
    '/botmux/card-actions/v1',
    token,
    mode,
    logPath,
    String(options.delayMs ?? 0),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const port = await waitForReady(child);
  return { child, port, token, logPath };
};

const stopFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
  children.delete(child);
};

const requestsFrom = (logPath: string): Array<Record<string, any>> => {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
};

afterEach(async () => {
  await Promise.all([...children].map(stopFixture));
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe('plugin card action gateway loopback integration', () => {
  it('将已启用插件的卡片动作完整转发并返回同步 ACK', async () => {
    const fixture = await startFixture('success', { token: 'per-plugin-secret' });
    const record = recordFor();
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: appId => appId === 'cli_current' ? [record.id] : [],
      readRegistry: () => registryFor(record),
      readServiceState: () => ({
        pluginId: record.id,
        updatedAt: new Date().toISOString(),
        status: 'online',
        port: fixture.port,
      }),
      readToken: () => fixture.token,
    });

    const ack = await gateway.dispatch({
      event_id: 'evt-123',
      operator: { open_id: 'ou_verified', union_id: 'on_verified' },
      context: { open_message_id: 'om-123' },
      action: {
        name: 'submit',
        value: { action: 'example.review.submit', record_id: 'rec-1' },
        option: 'approve',
        form_value: { choice: 'approve', note: 'looks good' },
      },
    }, 'cli_current');

    expect(ack).toEqual({ toast: { type: 'success', content: 'accepted' } });
    expect(requestsFrom(fixture.logPath)).toEqual([expect.objectContaining({
      method: 'POST',
      url: '/botmux/card-actions/v1',
      authorization: 'Bearer per-plugin-secret',
      contentType: 'application/json',
      body: {
        schemaVersion: 1,
        eventId: 'evt-123',
        larkAppId: 'cli_current',
        operator: { open_id: 'ou_verified', union_id: 'on_verified' },
        context: { open_message_id: 'om-123' },
        actionName: 'example.review.submit',
        action: {
          name: 'submit',
          value: { action: 'example.review.submit', record_id: 'rec-1' },
          option: 'approve',
          formValue: { choice: 'approve', note: 'looks good' },
        },
      },
    })]);
  });

  it('隔离不可用服务和非法插件响应', async () => {
    for (const testCase of [
      { mode: 'non2xx', responseMaxBytes: 1024, timeoutMs: 500 },
      { mode: 'redirect', responseMaxBytes: 1024, timeoutMs: 500 },
      { mode: 'invalid-json', responseMaxBytes: 1024, timeoutMs: 500 },
      { mode: 'invalid-schema', responseMaxBytes: 1024, timeoutMs: 500 },
      { mode: 'oversized', responseMaxBytes: 256, timeoutMs: 500 },
      { mode: 'success', responseMaxBytes: 1024, timeoutMs: 25, delayMs: 200 },
    ]) {
      const fixture = await startFixture(testCase.mode, { delayMs: testCase.delayMs });
      const record = recordFor();
      const gateway = createPluginCardActionGateway({
        resolvePluginIds: () => [record.id],
        readRegistry: () => registryFor(record),
        readServiceState: () => ({ pluginId: record.id, updatedAt: '', status: 'online', port: fixture.port }),
        readToken: () => fixture.token,
        responseMaxBytes: testCase.responseMaxBytes,
        timeoutMs: testCase.timeoutMs,
      });

      await expect(gateway.dispatch({
        action: { value: { action: 'example.review.submit' } },
      }, 'cli_current')).resolves.toBeUndefined();
      expect(requestsFrom(fixture.logPath)).toHaveLength(1);
      await stopFixture(fixture.child);
    }
  });

  it('服务与长连接恢复后无需重新注册业务 Handler', async () => {
    const record = recordFor();
    let fixture = await startFixture('success', { token: 'stable-token' });
    let activePort = fixture.port;
    const gateway = createPluginCardActionGateway({
      resolvePluginIds: () => [record.id],
      readRegistry: () => registryFor(record),
      readServiceState: () => ({ pluginId: record.id, updatedAt: '', status: 'online', port: activePort }),
      readToken: () => 'stable-token',
    });
    const event = { event_id: 'evt-reconnect', action: { value: { action: 'example.review.submit' } } };

    await expect(gateway.dispatch(event, 'cli_current')).resolves.toMatchObject({ toast: { type: 'success' } });
    expect(requestsFrom(fixture.logPath)).toHaveLength(1);
    await stopFixture(fixture.child);

    fixture = await startFixture('success', { token: 'stable-token' });
    activePort = fixture.port;
    await expect(gateway.dispatch({ ...event, event_id: 'evt-after-reconnect' }, 'cli_current'))
      .resolves.toMatchObject({ toast: { type: 'success' } });
    expect(requestsFrom(fixture.logPath)).toHaveLength(1);
  });
});
