import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { setScheduleScope, getTask, listTasks } from '../src/services/schedule-store.js';
import {
  hasSchedulePrecondition,
  resolveSchedulePrecondition,
  schedulePreconditionRoot,
} from '../src/services/schedule-precondition-store.js';
import {
  createTaskWithOptionalPrecondition,
  removeTaskWithPrecondition,
  toggleTaskDeliveryWithPrecondition,
  updateTaskWithOptionalPrecondition,
} from '../src/core/schedule-precondition-config.js';
import { executeScheduledTaskWithPrecondition } from '../src/services/schedule-precondition-gate.js';

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

describe('trusted schedule precondition configuration', () => {
  it('leaves the legacy create path untouched when no script is configured', () => {
    const task = createTaskWithOptionalPrecondition(createParams('legacy'), APP_ID);

    expect(task.preconditionRef).toBeUndefined();
    expect(hasSchedulePrecondition(task, APP_ID)).toBe(false);
    expect(resolveSchedulePrecondition(task, APP_ID)).toEqual({ kind: 'none' });
    expect(existsSync(schedulePreconditionRoot())).toBe(false);
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
    const created = createTaskWithOptionalPrecondition(
      createParams('file guard'),
      APP_ID,
      {
        enabled: false,
        source: { kind: 'file', path: './does-not-need-to-exist-yet.sh' },
      },
    );
    expect(resolveSchedulePrecondition(created, APP_ID)).toEqual({
      kind: 'configured',
      enabled: false,
      source: { kind: 'file', path: './does-not-need-to-exist-yet.sh' },
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

    const replacedAndEnabled = updateTaskWithOptionalPrecondition(
      created.id,
      {},
      APP_ID,
      {
        action: 'replace',
        enabled: true,
        source: { kind: 'file', path: '/opt/botmux/ready.sh' },
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
      source: { kind: 'file', path: '/opt/botmux/ready.sh' },
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
