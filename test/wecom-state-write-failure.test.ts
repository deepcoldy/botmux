/**
 * A WeCom gateway whose state document (state.json) cannot be written stops
 * processing messages but stays connected. The failure is made visible: the
 * bridge reports its first failed write once, the gateway's runtime record
 * carries it (best effort: that record usually sits on the same disk, so it is
 * retried on every refresh), and the Dashboard shows the connection as no
 * longer processing, with the cause the error code stands for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import {
  createWecomRuntimePublisher,
  readWecomRuntime,
  wecomBotRoot,
  WECOM_RUNTIME_REFRESH_MS,
} from '../src/im/wecom/config/runtime.js';
import { wecomRoot } from '../src/im/wecom/config/discovery.js';
import {
  describeWecomStateWriteFailure,
  wecomStateWriteFailureCause,
  type WecomStateWriteFailure,
} from '../src/im/wecom/contract/state-write-failure.js';
import { fleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import { WecomDashboardManager } from '../src/dashboard/wecom/manager.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wecom-state-write-failure-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const message = (id: string, user = 'alice'): WecomInboundMessage =>
  ({ messageId: id, userId: user, conversationId: user, chatType: 'single', text: 'task', attachments: [], replyContext: { requestId: id } });

const core: WecomCore = {
  trigger: async (request: TriggerRequest) => ({
    ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn' as const, sessionId: 's1' },
  }),
  result: async () => ({ ok: true, state: 'running' as const }),
  interrupt: async () => {},
};

function bridgeAt(stateFile: string, onStateWriteFailure?: (failure: WecomStateWriteFailure) => void | Promise<void>, botId = 'bot') {
  const lines: string[] = [];
  const bridge = new WecomBridge({
    botId,
    allowedUsers: ['alice'],
    stateFile,
    transport: { reply: async () => {}, send: async () => {} },
    core,
    peerRoot: tempRoot(),
    log: line => lines.push(line),
    ...(onStateWriteFailure ? { onStateWriteFailure } : {}),
  });
  return { bridge, lines };
}

/** The error `fn` throws (or rejects with); undefined when it succeeds. */
async function failureOf(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the cause of a failed state write', () => {
  // The codes are errno names (an external protocol): each lands in its cause.
  it.each([
    ['ENOSPC', 'disk_full'],
    ['EDQUOT', 'quota_exceeded'],
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['EROFS', 'read_only'],
    ['EIO', 'io_error'],
    ['ENOENT', 'path_unusable'],
    ['ENOTDIR', 'path_unusable'],
    ['EISDIR', 'path_unusable'],
    ['EEXIST', 'path_unusable'],
    ['ELOOP', 'path_unusable'],
    ['ENAMETOOLONG', 'path_unusable'],
    ['EMFILE', 'too_many_open_files'],
    ['ENFILE', 'too_many_open_files'],
  ])('%s is %s', (code, cause) => {
    expect(wecomStateWriteFailureCause(code)).toBe(cause);
  });

  it('is `other` for a well-formed code outside the table, and names that code', () => {
    expect(wecomStateWriteFailureCause('EXDEV')).toBe('other');
    expect(describeWecomStateWriteFailure('EXDEV').reason).toContain('EXDEV');
  });

  it('is `unknown` without a code, or with one that is not an errno name', () => {
    for (const code of [undefined, '', 'enospc', 'E NOSPC', 'E'.repeat(33), 28, { code: 'ENOSPC' }]) {
      expect(wecomStateWriteFailureCause(code), JSON.stringify(code)).toBe('unknown');
      expect(describeWecomStateWriteFailure(code).code, JSON.stringify(code)).toBeUndefined();
    }
  });

  it('gives every cause its own reason and its own action', () => {
    const codes = ['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS', 'EIO', 'ENOENT', 'EMFILE', 'EXDEV', undefined];
    const described = codes.map(code => describeWecomStateWriteFailure(code));
    expect(new Set(described.map(entry => entry.cause)).size).toBe(codes.length);
    expect(new Set(described.map(entry => entry.reason)).size).toBe(codes.length);
    expect(new Set(described.map(entry => entry.action)).size).toBe(codes.length);
  });
});

describe('the bridge reporting its first failed state write', () => {
  // Mutations: removing the report, or its "first failure only" guard, turns this red.
  it('reports it once, with the error code, when it happened and the state directory', async () => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    const reports: WecomStateWriteFailure[] = [];
    const { bridge, lines } = bridgeAt(stateFile, failure => {
      reports.push(failure);
    });
    await bridge.receive(message('a1'));
    expect(reports).toEqual([]);

    const unblock = blockWecomStateWrites(stateFile);
    cleanups.push(unblock);
    const before = Date.now();
    expect(await failureOf(() => bridge.receive(message('a2')))).toMatchObject({ code: 'EISDIR' });
    const after = Date.now();
    expect(reports).toEqual([{ code: 'EISDIR', at: expect.any(Number), directory: root }]);
    expect(reports[0].at).toBeGreaterThanOrEqual(before);
    expect(reports[0].at).toBeLessThanOrEqual(after);

    // A later write that fails again is not a new report.
    bridge.state.routes.later = 'changed';
    expect(await failureOf(() => bridge.save())).toMatchObject({ code: 'EISDIR' });
    expect(reports).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(bridge.poisoned).toBe(true);
  });

  // Mutation: dropping the kind of the error from the line turns this red.
  it('names the kind of an error that has no code in its log line, since there is no cause to name', async () => {
    const root = tempRoot();
    const reports: WecomStateWriteFailure[] = [];
    const { bridge, lines } = bridgeAt(join(root, 'state.json'), failure => {
      reports.push(failure);
    });
    // A value JSON cannot hold: the write fails before it reaches the disk.
    (bridge.state.routes as Record<string, unknown>).broken = 1n;
    const failed = await failureOf(() => bridge.save());
    expect(failed).toBeInstanceOf(TypeError);
    expect(reports).toEqual([{ at: expect.any(Number), directory: root }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TypeError');
    expect(lines[0]).toContain(root);
    expect(lines[0]).not.toContain((failed as Error).message);
    expect(bridge.poisoned).toBe(true);
  });

  // Mutation: letting the report's own failure out of save() turns this red.
  it.each([
    ['throws', () => {
      throw new Error('report-failed-marker');
    }],
    ['rejects', () => Promise.reject(new Error('report-failed-marker'))],
  ] as const)('fails the write with the write\'s own error, and still poisons the bridge, when the report %s', async (_case, report) => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    // A plain function, not vi.fn: a mock subscribes to the promise it returns,
    // which would hide a rejection nobody handles.
    let reports = 0;
    const onStateWriteFailure = () => {
      reports++;
      return report();
    };
    const { bridge, lines } = bridgeAt(stateFile, onStateWriteFailure);
    const unblock = blockWecomStateWrites(stateFile);
    cleanups.push(unblock);

    const failed = await failureOf(() => bridge.receive(message('a1')));
    expect(failed).toMatchObject({ code: 'EISDIR' });
    expect(String((failed as Error).message)).not.toContain('report-failed-marker');
    expect(reports).toBe(1);
    expect(bridge.poisoned).toBe(true);
    expect(lines).toHaveLength(1);
    // Poisoned exactly as before: queued work is refused.
    expect(String((await failureOf(() => bridge.tick())) as Error)).toMatch(/状态写入失败/);
    // A rejected report is settled, not left to surface as an unhandled rejection.
    await new Promise(done => setTimeout(done, 0));
  });
});

describe('the runtime record of a gateway that failed to write its state', () => {
  function publisherFor(botId: string) {
    vi.spyOn(fleetProcessIdentityRuntime, 'readIdentity').mockReturnValue('controlled-birth');
    const root = wecomBotRoot(botId);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const publisher = createWecomRuntimePublisher(botId, join(tempRoot(), 'config.json'));
    cleanups.push(() => publisher.stop());
    return { publisher, record: join(root, 'runtime.json') };
  }

  const failure: WecomStateWriteFailure = { code: 'ENOSPC', at: 1_700_000_000_000, directory: '/srv/wecom/state' };

  it('carries the failure as soon as it is reported, and keeps it through later updates', () => {
    const { publisher } = publisherFor(`state-write-failure-${process.pid}-a`);
    publisher.update({ phase: 'running', connection: 'connected' });
    publisher.stateWriteFailure(failure);
    expect(readWecomRuntime(`state-write-failure-${process.pid}-a`)?.stateWriteFailure).toEqual(failure);
    publisher.update({ connection: 'reconnecting' });
    expect(readWecomRuntime(`state-write-failure-${process.pid}-a`)).toMatchObject({ connection: 'reconnecting', stateWriteFailure: failure });
  });

  // The case this exists for: the disk is full, so the record cannot be written
  // either; once space is back, the next refresh shows the failure.
  // Mutation: recording it with a write that throws (like update()) turns this red.
  it('does not throw while the record cannot be written, and shows the failure at the first refresh that can', () => {
    vi.useFakeTimers();
    const botId = `state-write-failure-${process.pid}-b`;
    const { publisher, record } = publisherFor(botId);
    publisher.update({ phase: 'running', connection: 'connected' });
    // From here on every write of the record fails: its path is now a directory.
    rmSync(record, { force: true });
    mkdirSync(join(record, 'blocked'), { recursive: true });

    publisher.stateWriteFailure(failure);
    expect(readWecomRuntime(botId)).toBeUndefined();
    vi.advanceTimersByTime(WECOM_RUNTIME_REFRESH_MS);
    expect(readWecomRuntime(botId)).toBeUndefined();

    rmSync(record, { recursive: true, force: true });
    vi.advanceTimersByTime(WECOM_RUNTIME_REFRESH_MS);
    expect(readWecomRuntime(botId)).toMatchObject({ phase: 'running', connection: 'connected', stateWriteFailure: failure });

    publisher.stop();
    expect(readWecomRuntime(botId)).toMatchObject({ phase: 'stopped', connection: 'disconnected' });
  });

  it('copies only the fields of the failure it was given', () => {
    const botId = `state-write-failure-${process.pid}-c`;
    const { publisher, record } = publisherFor(botId);
    publisher.stateWriteFailure({ ...failure, extra: 'private-marker' } as WecomStateWriteFailure);
    expect(readFileSync(record, 'utf8')).not.toContain('private-marker');
    publisher.stateWriteFailure({ at: failure.at, directory: failure.directory });
    expect(readWecomRuntime(botId)?.stateWriteFailure).toEqual({ at: failure.at, directory: failure.directory });
  });
});

describe('a failed state write, from the bridge to the Dashboard', () => {
  it('shows the connection as having stopped processing, with the cause of the code, while it is still connected', async () => {
    vi.spyOn(fleetProcessIdentityRuntime, 'readIdentity').mockReturnValue('controlled-birth');
    const root = wecomRoot();
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const botId = `state-write-failure-${process.pid}-dashboard`;
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ botId, secretFile: join(root, 'secret'), coreUrl: 'http://127.0.0.1:19123', allowedUsers: ['alice'] }));
    const publisher = createWecomRuntimePublisher(botId, file);
    cleanups.push(() => publisher.stop());
    publisher.update({ phase: 'running', connection: 'connected' });
    const stateDir = tempRoot();
    const stateFile = join(stateDir, 'state.json');
    const { bridge } = bridgeAt(stateFile, report => publisher.stateWriteFailure(report), botId);
    const ns = fleetProcessIdentityRuntime.readPidNamespace(process.pid);
    const manager = new WecomDashboardManager({
      root,
      runtime: { readIdentity: () => 'controlled-birth', readCommandLine: () => undefined, readPidNamespace: () => ns, pidExists: () => true },
    });

    expect((await manager.list())[0].stateWriteFailure).toBeUndefined();
    const unblock = blockWecomStateWrites(stateFile);
    cleanups.push(unblock);
    await failureOf(() => bridge.receive(message('a1')));

    const [row] = await manager.list();
    expect(row.connection).toBe('connected');
    expect(row.stateWriteFailure).toEqual({ cause: 'path_unusable', code: 'EISDIR', at: expect.any(Number), directory: stateDir });
  });
});
