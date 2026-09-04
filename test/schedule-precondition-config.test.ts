import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  __setScheduleStoreBeforeRenameTestHook,
  createTask as createStoredTask,
  effectiveScheduleChatIds,
  setScheduleScope,
  getTask,
  listTasks,
  updateTask as updateStoredTask,
} from '../src/services/schedule-store.js';
import {
  activateSchedulePrecondition,
  resolveSchedulePrecondition,
  schedulePreconditionPath,
  schedulePreconditionRoot,
  schedulePreconditionTrustedFileExamplePath,
  schedulePreconditionTrustedFilesRoot,
  stageSchedulePrecondition,
} from '../src/services/schedule-precondition-store.js';
import {
  createTaskWithOptionalPrecondition,
  removeTaskWithPrecondition,
  toggleTaskDeliveryWithPrecondition,
  updateTaskWithOptionalPrecondition,
} from '../src/core/schedule-precondition-config.js';
import { executeScheduledTaskWithPrecondition } from '../src/services/schedule-precondition-gate.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';

const APP_ID = 'cli_precondition_config_test';
let tempDir: string;
let previousDataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-precondition-config-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(tempDir, 'data');
  setScheduleScope(APP_ID);
});

afterEach(() => {
  __setScheduleStoreBeforeRenameTestHook(undefined);
  config.session.dataDir = previousDataDir;
  setScheduleScope('cli_ipc_test_bot001');
  rmSync(tempDir, { recursive: true, force: true });
});

function createParams(name = 'guarded') {
  return {
    name,
    schedule: 'every 1h',
    prompt: 'run the model',
    workingDir: tempDir,
    chatId: 'oc_precondition_test',
    larkAppId: APP_ID,
  };
}

function createLegacySixChatTask() {
  const chatIds = ['oc_one', 'oc_two', 'oc_three', 'oc_four', 'oc_five', 'oc_six'];
  return createStoredTask({
    ...createParams('legacy six chats'),
    parsed: { kind: 'interval', minutes: 60, display: 'every hour' },
    executionPosition: 'top-level',
    chatId: chatIds[0],
    chatIds,
  });
}

function createLegacyFileTask(path: string, enabled = true, label = 'legacy-file') {
  const id = `${label}-${enabled ? 'enabled' : 'disabled'}`;
  const staged = stageSchedulePrecondition(APP_ID, id, {
    enabled,
    source: { kind: 'file', path },
  });
  const task = createStoredTask({
    ...createParams('legacy file'),
    id,
    parsed: { kind: 'interval', minutes: 60, display: 'every hour' },
    preconditionRef: staged.preconditionRef,
  });
  activateSchedulePrecondition(task, APP_ID);
  return task;
}

function createLegacyRelativeFileTask(enabled = true) {
  return createLegacyFileTask(
    'scripts/legacy-guard.sh',
    enabled,
    'legacy-relative',
  );
}

describe('trusted schedule precondition configuration', () => {
  it('leaves the legacy create path untouched when no script is configured', () => {
    const task = createTaskWithOptionalPrecondition(createParams('legacy'), APP_ID);

    expect(task.preconditionRef).toBeUndefined();
    expect(resolveSchedulePrecondition(task, APP_ID)).toEqual({ kind: 'none' });
    expect(existsSync(schedulePreconditionRoot())).toBe(false);
  });

  it('normalizes multi-chat create and rejects retained-topic fan-out', () => {
    const task = createTaskWithOptionalPrecondition({
      ...createParams('fan out'),
      chatIds: ['oc_primary', 'oc_secondary', 'oc_primary'],
      executionPosition: 'top-level',
    }, APP_ID);
    expect(task).toMatchObject({
      chatId: 'oc_primary',
      chatIds: ['oc_primary', 'oc_secondary'],
    });

    expect(() => createTaskWithOptionalPrecondition({
      ...createParams('invalid topic fan out'),
      chatIds: ['oc_primary', 'oc_secondary'],
      executionPosition: 'topic',
      rootMessageId: 'om_topic',
    }, APP_ID)).toThrow('multiple_chats_topic_unsupported');
    expect(listTasks(APP_ID)).toHaveLength(1);
  });

  it.each([undefined, 'printf 1'])('limits new tasks to five unique chats with condition %j', (condition) => {
    const chatIds = ['oc_one', 'oc_two', 'oc_three', 'oc_four', 'oc_five'];
    expect(() => createTaskWithOptionalPrecondition({
      ...createParams(), chatIds: [...chatIds, 'oc_six'],
    }, APP_ID, condition)).toThrow('too_many_target_chats');
    expect(listTasks(APP_ID)).toEqual([]);
    expect(existsSync(schedulePreconditionRoot())).toBe(false);

    const created = createTaskWithOptionalPrecondition({
      ...createParams(), chatIds: [...chatIds, ' oc_one '],
    }, APP_ID, condition);
    expect(created.chatIds).toEqual(chatIds);
  });

  it('rejects oversized target changes before touching the task or protected source', () => {
    const created = createTaskWithOptionalPrecondition(createParams(), APP_ID, 'printf 1');
    const path = schedulePreconditionPath(APP_ID, created.id);
    const sourceBefore = readFileSync(path, 'utf8');
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));
    try {
      expect(updateTaskWithOptionalPrecondition(created.id, {
        name: 'must not change',
        chatIds: ['oc_one', 'oc_two', 'oc_three', 'oc_four', 'oc_five', 'oc_six'],
      }, APP_ID, 'printf 0')).toEqual({ ok: false, error: 'too_many_target_chats' });
    } finally {
      unsubscribe();
    }
    expect(getTask(created.id, APP_ID)).toEqual(created);
    expect(readFileSync(path, 'utf8')).toBe(sourceBefore);
    expect(events).toEqual([]);
  });

  it('preserves unchanged legacy six-chat bindings and permits reducing them to five', () => {
    const created = createLegacySixChatTask();
    const original = created.chatIds!;
    expect(updateTaskWithOptionalPrecondition(created.id, {
      name: 'renamed legacy', chatIds: [...original],
    }, APP_ID, 'printf 1')).toMatchObject({ ok: true });
    updateStoredTask(created.id, { lastStatus: 'skipped' }, APP_ID);
    expect(effectiveScheduleChatIds(getTask(created.id, APP_ID)!)).toEqual(original);
    expect(getTask(created.id, APP_ID)).toMatchObject({
      name: 'renamed legacy', enabled: true, lastStatus: 'skipped',
    });
    expect(updateTaskWithOptionalPrecondition(created.id, {
      chatIds: [...original].reverse(),
    }, APP_ID)).toEqual({ ok: false, error: 'too_many_target_chats' });
    expect(updateTaskWithOptionalPrecondition(created.id, {
      chatIds: [...original.slice(0, 5), 'oc_other'],
    }, APP_ID)).toEqual({ ok: false, error: 'too_many_target_chats' });

    expect(updateTaskWithOptionalPrecondition(created.id, {
      chatIds: original.slice(0, 5),
    }, APP_ID)).toMatchObject({ ok: true });
    expect(getTask(created.id, APP_ID)?.chatIds).toEqual(original.slice(0, 5));
    expect(resolveSchedulePrecondition(getTask(created.id, APP_ID)!, APP_ID)).toMatchObject({
      kind: 'configured', source: { kind: 'inline', script: 'printf 1' },
    });
  });

  it('restores a legacy six-chat binding if a five-chat compound update fails', () => {
    const legacy = createLegacySixChatTask();
    const created = updateTaskWithOptionalPrecondition(legacy.id, {}, APP_ID, 'printf 1').task!;
    const path = schedulePreconditionPath(APP_ID, created.id);
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));
    __setScheduleStoreBeforeRenameTestHook(() => {
      __setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(path, { force: true });
    });
    try {
      expect(() => updateTaskWithOptionalPrecondition(created.id, {
        chatIds: created.chatIds!.slice(0, 5),
      }, APP_ID, 'printf 0')).toThrow('staged protected record is missing');
    } finally {
      unsubscribe();
      __setScheduleStoreBeforeRenameTestHook(undefined);
    }
    expect(getTask(created.id, APP_ID)?.chatIds).toEqual(created.chatIds);
    expect(events.filter(event => event.type === 'schedule.updated')).toEqual([]);
  });

  it('creates, rebinds, replaces, and explicitly clears a protected script', () => {
    const created = createTaskWithOptionalPrecondition(
      createParams(),
      APP_ID,
      'printf 1',
    );
    expect(created.preconditionRef).toMatch(/^spc_/);
    expect(resolveSchedulePrecondition(created, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'printf 1' },
    });

    const ordinaryEdit = updateTaskWithOptionalPrecondition(
      created.id,
      { prompt: 'changed model prompt' },
      APP_ID,
      undefined,
    );
    expect(ordinaryEdit).toMatchObject({ ok: true, hasPrecondition: true });
    expect(resolveSchedulePrecondition(ordinaryEdit.task!, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'printf 1' },
    });

    const replacement = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      'printf 0',
    );
    expect(replacement).toMatchObject({ ok: true, hasPrecondition: true });
    expect(resolveSchedulePrecondition(replacement.task!, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'printf 0' },
    });

    const cleared = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      null,
    );
    expect(cleared).toMatchObject({ ok: true, hasPrecondition: false });
    expect(cleared.task?.preconditionRef).toBeUndefined();
    expect(resolveSchedulePrecondition(cleared.task!, APP_ID)).toEqual({ kind: 'none' });
  });

  it('keeps disabled live-file configuration across edits and legacy replacement', () => {
    const filePath = join(
      schedulePreconditionTrustedFilesRoot(),
      'nested',
      'does-not-need-to-exist-yet.sh',
    );
    const created = createTaskWithOptionalPrecondition(
      createParams('file guard'),
      APP_ID,
      {
        enabled: false,
        source: { kind: 'file', path: filePath },
      },
    );
    expect(resolveSchedulePrecondition(created, APP_ID)).toEqual({
      kind: 'configured',
      enabled: false,
      source: { kind: 'file', path: filePath },
    });

    const kept = updateTaskWithOptionalPrecondition(
      created.id,
      { prompt: 'changed while disabled' },
      APP_ID,
      { action: 'keep' },
    );
    expect(kept).toMatchObject({
      ok: true,
      hasPrecondition: true,
      preconditionEnabled: false,
      preconditionSourceKind: 'file',
    });

    const legacyReplacement = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      'printf 1',
    );
    expect(resolveSchedulePrecondition(legacyReplacement.task!, APP_ID)).toEqual({
      kind: 'configured',
      enabled: false,
      source: { kind: 'inline', script: 'printf 1' },
    });
    expect(schedulePreconditionTrustedFilesRoot()).toBe(join(
      config.session.dataDir,
      'schedule-preconditions',
      'trusted-files',
    ));
    expect(schedulePreconditionTrustedFileExamplePath()).toBe(join(
      schedulePreconditionTrustedFilesRoot(),
      'check-ready.sh',
    ));
    expect(existsSync(schedulePreconditionTrustedFilesRoot())).toBe(true);
  });

  it('rejects relative file paths on create and replace before changing durable state', () => {
    expect(() => createTaskWithOptionalPrecondition(
      createParams('relative create'),
      APP_ID,
      { enabled: false, source: { kind: 'file', path: 'scripts/guard.sh' } },
    )).toThrow('Scheduled task precondition file path must be absolute');
    expect(listTasks(APP_ID)).toEqual([]);
    expect(existsSync(schedulePreconditionRoot())).toBe(false);

    const created = createTaskWithOptionalPrecondition(createParams('inline before replace'), APP_ID, 'printf 1');
    const before = getTask(created.id, APP_ID);
    expect(() => updateTaskWithOptionalPrecondition(
      created.id,
      { prompt: 'must not change' },
      APP_ID,
      { action: 'replace', source: { kind: 'file', path: './guard.sh' } },
    )).toThrow('Scheduled task precondition file path must be absolute');
    expect(getTask(created.id, APP_ID)).toEqual(before);
    expect(resolveSchedulePrecondition(created, APP_ID)).toMatchObject({
      kind: 'configured',
      source: { kind: 'inline', script: 'printf 1' },
    });
  });

  it('fails legacy relative files closed at runtime while keeping them manageable', async () => {
    const legacy = createLegacyRelativeFileTask(true);
    expect(resolveSchedulePrecondition(legacy, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'file', path: 'scripts/legacy-guard.sh' },
    });
    const blockedContinuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      legacy,
      APP_ID,
      blockedContinuation,
    )).rejects.toMatchObject({ code: 'invalid_path' });
    expect(blockedContinuation).not.toHaveBeenCalled();

    const disabled = updateTaskWithOptionalPrecondition(
      legacy.id,
      { prompt: 'edited while keeping the legacy source' },
      APP_ID,
      { action: 'set-enabled', enabled: false },
    );
    expect(disabled).toMatchObject({ ok: true, preconditionEnabled: false });
    const disabledContinuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      disabled.task!,
      APP_ID,
      disabledContinuation,
    )).resolves.toBe('executed');
    expect(disabledContinuation).toHaveBeenCalledOnce();
    expect(updateTaskWithOptionalPrecondition(
      legacy.id,
      { name: 'ordinary keep remains allowed' },
      APP_ID,
      { action: 'keep' },
    )).toMatchObject({ ok: true });

    expect(() => updateTaskWithOptionalPrecondition(
      legacy.id,
      { prompt: 'must not be written by rejected re-enable' },
      APP_ID,
      { action: 'set-enabled', enabled: true },
    )).toThrow('Scheduled task precondition file path must be absolute');
    expect(getTask(legacy.id, APP_ID)).toMatchObject({
      name: 'ordinary keep remains allowed',
      prompt: 'edited while keeping the legacy source',
    });
    expect(resolveSchedulePrecondition(getTask(legacy.id, APP_ID)!, APP_ID)).toMatchObject({
      kind: 'configured', enabled: false,
    });

    const cleared = updateTaskWithOptionalPrecondition(
      legacy.id,
      {},
      APP_ID,
      { action: 'clear' },
    );
    expect(cleared).toMatchObject({ ok: true, hasPrecondition: false });
  });

  it('rejects absolute paths outside the trusted root on create, replace, re-enable, and runtime', async () => {
    const outsidePath = join(tempDir, 'outside-guard.sh');
    writeFileSync(outsidePath, 'printf 1');

    expect(() => createTaskWithOptionalPrecondition(
      createParams('outside create'),
      APP_ID,
      { enabled: false, source: { kind: 'file', path: outsidePath } },
    )).toThrow('must be inside the daemon trusted-files directory');
    expect(listTasks(APP_ID)).toEqual([]);
    expect(existsSync(schedulePreconditionRoot())).toBe(false);

    const inline = createTaskWithOptionalPrecondition(
      createParams('inline before outside replace'),
      APP_ID,
      'printf 1',
    );
    const inlineBefore = getTask(inline.id, APP_ID);
    expect(() => updateTaskWithOptionalPrecondition(
      inline.id,
      { prompt: 'must not change' },
      APP_ID,
      { action: 'replace', source: { kind: 'file', path: outsidePath } },
    )).toThrow('must be inside the daemon trusted-files directory');
    expect(getTask(inline.id, APP_ID)).toEqual(inlineBefore);

    const legacy = createLegacyFileTask(outsidePath, false, 'legacy-outside');
    expect(resolveSchedulePrecondition(legacy, APP_ID)).toMatchObject({
      kind: 'configured',
      enabled: false,
      source: { kind: 'file', path: outsidePath },
    });
    expect(() => updateTaskWithOptionalPrecondition(
      legacy.id,
      { prompt: 'must not change on rejected re-enable' },
      APP_ID,
      { action: 'set-enabled', enabled: true },
    )).toThrow('must be inside the daemon trusted-files directory');
    expect(getTask(legacy.id, APP_ID)?.prompt).toBe('run the model');

    // Directly persisted legacy records stay parseable, but an enabled one is
    // rejected before Bash or the model continuation can run.
    const enabledLegacy = createLegacyFileTask(outsidePath, true, 'legacy-outside-runtime');
    const continuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      enabledLegacy,
      APP_ID,
      continuation,
    )).rejects.toMatchObject({ code: 'outside_trusted_directory' });
    expect(continuation).not.toHaveBeenCalled();
  });

  it('supports explicit set-enabled, replace, and clear mutations', () => {
    const created = createTaskWithOptionalPrecondition(
      createParams('mutations'),
      APP_ID,
      'printf 1',
    );

    const disabled = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      { action: 'set-enabled', enabled: false },
    );
    expect(disabled).toMatchObject({
      ok: true,
      hasPrecondition: true,
      preconditionEnabled: false,
      preconditionSourceKind: 'inline',
    });
    expect(disabled.task?.preconditionRef).toBe(created.preconditionRef);

    const trustedFilePath = schedulePreconditionTrustedFileExamplePath();
    const replacedAndEnabled = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      {
        action: 'replace',
        enabled: true,
        source: { kind: 'file', path: trustedFilePath },
      },
    );
    expect(replacedAndEnabled).toMatchObject({
      ok: true,
      hasPrecondition: true,
      preconditionEnabled: true,
      preconditionSourceKind: 'file',
    });
    expect(resolveSchedulePrecondition(replacedAndEnabled.task!, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'file', path: trustedFilePath },
    });

    const cleared = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      { action: 'clear' },
    );
    expect(cleared).toMatchObject({ ok: true, hasPrecondition: false });
    expect(cleared.task?.preconditionRef).toBeUndefined();
  });

  it('rolls back chatId/chatIds and suppresses the deferred event when a compound update fails', () => {
    const created = createTaskWithOptionalPrecondition(
      {
        ...createParams('rollback targets'),
        chatIds: ['oc_before_primary', 'oc_before_secondary'],
      },
      APP_ID,
      'printf 1',
    );
    const events: DashboardEvent[] = [];
    const unsubscribe = dashboardEventBus.subscribe(event => events.push(event));

    __setScheduleStoreBeforeRenameTestHook(() => {
      __setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(schedulePreconditionPath(APP_ID, created.id), { force: true });
    });
    try {
      expect(() => updateTaskWithOptionalPrecondition(
        created.id,
        { chatIds: ['oc_after_primary', 'oc_after_secondary'] },
        APP_ID,
        { action: 'replace', source: { kind: 'inline', script: 'printf 0' } },
      )).toThrow('staged protected record is missing');
    } finally {
      unsubscribe();
      __setScheduleStoreBeforeRenameTestHook(undefined);
    }

    expect(getTask(created.id, APP_ID)).toMatchObject({
      chatId: 'oc_before_primary',
      chatIds: ['oc_before_primary', 'oc_before_secondary'],
    });
    expect(events.filter(event => event.type === 'schedule.updated')).toEqual([]);
  });

  it('rejects set-enabled without a condition before changing ordinary fields', () => {
    const task = createTaskWithOptionalPrecondition(createParams('plain'), APP_ID);

    expect(() => updateTaskWithOptionalPrecondition(
      task.id,
      { prompt: 'must not be written' },
      APP_ID,
      { action: 'set-enabled', enabled: false },
    )).toThrow('schedule_precondition_not_configured');
    expect(getTask(task.id, APP_ID)?.prompt).toBe('run the model');
  });

  it('runs the continuation only for stdout 1 and skips it for stdout 0', async () => {
    const passTask = createTaskWithOptionalPrecondition(
      createParams('pass'),
      APP_ID,
      'printf "1\\n"',
    );
    const passContinuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      passTask,
      APP_ID,
      passContinuation,
    )).resolves.toBe('executed');
    expect(passContinuation).toHaveBeenCalledOnce();

    const skipTask = createTaskWithOptionalPrecondition(
      createParams('skip'),
      APP_ID,
      'printf 0',
    );
    const skipContinuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      skipTask,
      APP_ID,
      skipContinuation,
    )).resolves.toBe('skipped');
    expect(skipContinuation).not.toHaveBeenCalled();

    const errorTask = createTaskWithOptionalPrecondition(
      createParams('error'),
      APP_ID,
      'exit 7',
    );
    const errorContinuation = vi.fn(async () => undefined);
    await expect(executeScheduledTaskWithPrecondition(
      errorTask,
      APP_ID,
      errorContinuation,
    )).rejects.toMatchObject({ code: 'non_zero_exit' });
    expect(errorContinuation).not.toHaveBeenCalled();
  });

  it('rebinds a configured condition after the legacy delivery toggle', () => {
    const created = createTaskWithOptionalPrecondition(
      createParams(),
      APP_ID,
      'printf 1',
    );

    expect(toggleTaskDeliveryWithPrecondition(created.id, APP_ID)).toMatchObject({
      ok: true,
      executionPosition: 'new-topic',
    });
    const updated = getTask(created.id, APP_ID)!;
    expect(resolveSchedulePrecondition(updated, APP_ID)).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'printf 1' },
    });
  });

  it('removes the schedule first and then its protected sidecar', () => {
    const task = createTaskWithOptionalPrecondition(
      createParams(),
      APP_ID,
      'printf 1',
    );

    expect(removeTaskWithPrecondition(task.id, APP_ID)).toEqual({ ok: true });
    expect(getTask(task.id, APP_ID)).toBeUndefined();
    expect(listTasks(APP_ID)).toHaveLength(0);
  });
});
