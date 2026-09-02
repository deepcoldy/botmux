import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledTask } from '../src/types.js';
import {
  MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES,
  SchedulePreconditionStoreError,
  abortSchedulePrecondition,
  activateSchedulePrecondition,
  ensureSchedulePreconditionRoot,
  hasSchedulePrecondition,
  getSchedulePreconditionSummary,
  rebindSchedulePrecondition,
  removeSchedulePrecondition,
  resolveSchedulePrecondition,
  schedulePreconditionPath,
  schedulePreconditionRoot,
  setSchedulePreconditionEnabled,
  stageSchedulePrecondition,
  validateSchedulePreconditionDefinition,
  validateSchedulePreconditionSource,
  validateSchedulePreconditionScript,
  type SchedulePreconditionStoreErrorCode,
  type SchedulePreconditionStoreOptions,
} from '../src/services/schedule-precondition-store.js';

const APP_ID = 'cli_test_schedule_precondition';
const TASK_ID = 'task-precondition-1';
const CREATED_AT = '2026-08-28T01:02:03.000Z';
const NOW = '2026-08-28T02:03:04.000Z';
const REF_A = `spc_${'A'.repeat(43)}`;
const REF_B = `spc_${'B'.repeat(43)}`;

let tempDir: string;
let dataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-precondition-'));
  dataDir = join(tempDir, 'data');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function options(ref = REF_A): SchedulePreconditionStoreOptions {
  return { dataDir, now: () => NOW, createRef: () => ref };
}

function task(preconditionRef?: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: TASK_ID,
    preconditionRef,
    name: 'Daily build',
    schedule: '0 9 * * *',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '每天 09:00' },
    prompt: 'Run the build pipeline',
    workingDir: '/workspace/project',
    chatId: 'oc_test_chat',
    larkAppId: APP_ID,
    enabled: true,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: SchedulePreconditionStoreErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SchedulePreconditionStoreError);
    expect((error as SchedulePreconditionStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected SchedulePreconditionStoreError(${code})`);
}

function stageAndActivate(script = 'exit 1\n'): ScheduledTask {
  const staged = stageSchedulePrecondition(APP_ID, TASK_ID, script, options());
  const configured = task(staged.preconditionRef);
  activateSchedulePrecondition(configured, APP_ID, options());
  return configured;
}

describe('schedule precondition protected store', () => {
  it('keeps legacy/no-script tasks unchanged without creating storage', () => {
    expect(resolveSchedulePrecondition(task(), APP_ID, options())).toEqual({ kind: 'none' });
    expect(hasSchedulePrecondition(task(), APP_ID, options())).toBe(false);
    expect(existsSync(schedulePreconditionRoot(dataDir))).toBe(false);
  });

  it('uses only hashed app/task path components', () => {
    const appId = '../../RAW_APP_SECRET\0';
    const taskId = '../RAW_TASK_SECRET\0';
    const path = schedulePreconditionPath(appId, taskId, dataDir);

    expect(path.startsWith(`${schedulePreconditionRoot(dataDir)}/`)).toBe(true);
    expect(path).not.toContain('RAW_APP_SECRET');
    expect(path).not.toContain('RAW_TASK_SECRET');
    expect(dirname(path).split('/').at(-1)).toMatch(/^[a-f0-9]{64}$/);
    expect(path.split('/').at(-1)).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('stages a private durable pending record and leaves no lock file', () => {
    const script = 'printf "ready"\nexit 1\n';
    const staged = stageSchedulePrecondition(APP_ID, TASK_ID, script, options());
    const path = schedulePreconditionPath(APP_ID, TASK_ID, dataDir);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    expect(staged.preconditionRef).toBe(REF_A);
    expect(staged.previous).toEqual({ kind: 'absent' });
    expect(raw).toMatchObject({
      schemaVersion: 2,
      state: 'pending',
      larkAppId: APP_ID,
      taskId: TASK_ID,
      preconditionRef: REF_A,
      enabled: true,
      source: { kind: 'inline', script },
    });
    expect(raw).not.toHaveProperty('canonicalInputHash');
    expect(raw).not.toHaveProperty('scriptHash');
    expect(existsSync(`${path}.lock`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(lstatSync(schedulePreconditionRoot(dataDir)).mode & 0o777).toBe(0o700);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed while pending, then resolves the exact script after activation', () => {
    const script = 'test -f /tmp/ready && echo 1\n';
    const staged = stageSchedulePrecondition(APP_ID, TASK_ID, script, options());
    const configured = task(staged.preconditionRef);

    expectCode(
      () => resolveSchedulePrecondition(configured, APP_ID, options()),
      'precondition_pending',
    );
    activateSchedulePrecondition(configured, APP_ID, options());
    expect(resolveSchedulePrecondition(configured, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script },
    });
    expect(hasSchedulePrecondition(configured, APP_ID, options())).toBe(true);
  });

  it('persists a live file source without reading or rewriting its path', () => {
    const source = { kind: 'file' as const, path: './guards/ready.sh' };
    const staged = stageSchedulePrecondition(
      APP_ID,
      TASK_ID,
      { enabled: true, source },
      options(),
    );
    const configured = task(staged.preconditionRef);
    activateSchedulePrecondition(configured, APP_ID, options());

    expect(resolveSchedulePrecondition(configured, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: true,
      source,
    });
    expect(getSchedulePreconditionSummary(configured, APP_ID, options())).toEqual({
      hasPrecondition: true,
      enabled: true,
      sourceKind: 'file',
    });
  });

  it('keeps disabled source material while still enforcing every task binding', () => {
    const configured = stageAndActivate('echo 1\n');
    setSchedulePreconditionEnabled(configured, APP_ID, false, options());

    expect(resolveSchedulePrecondition(configured, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: false,
      source: { kind: 'inline', script: 'echo 1\n' },
    });
    expect(hasSchedulePrecondition(configured, APP_ID, options())).toBe(true);
    expectCode(
      () => resolveSchedulePrecondition(
        { ...configured, prompt: 'tampered while disabled' },
        APP_ID,
        options(),
      ),
      'canonical_input_mismatch',
    );
  });

  it('reads strict v1 records as enabled inline and lazily upgrades on write', () => {
    const configured = stageAndActivate('echo legacy\n');
    const path = schedulePreconditionPath(APP_ID, TASK_ID, dataDir);
    const active = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      state: active.state,
      larkAppId: active.larkAppId,
      taskId: active.taskId,
      preconditionRef: active.preconditionRef,
      script: active.source.script,
      updatedAt: active.updatedAt,
      canonicalInputHash: active.canonicalInputHash,
      taskCreatedAt: active.taskCreatedAt,
    }), { mode: 0o600 });

    expect(resolveSchedulePrecondition(configured, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'echo legacy\n' },
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1);

    setSchedulePreconditionEnabled(configured, APP_ID, false, options());
    const upgraded = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      enabled: false,
      source: { kind: 'inline', script: 'echo legacy\n' },
    });
    expect(upgraded).not.toHaveProperty('script');
  });

  it('rejects sidecar-only, marker-only, and mismatched-marker states', () => {
    const configured = stageAndActivate();

    expectCode(
      () => resolveSchedulePrecondition(task(), APP_ID, options()),
      'precondition_ref_mismatch',
    );
    expectCode(
      () => resolveSchedulePrecondition(task(REF_B), APP_ID, options()),
      'precondition_ref_mismatch',
    );

    expect(removeSchedulePrecondition(APP_ID, TASK_ID, options())).toBe(true);
    expectCode(
      () => resolveSchedulePrecondition(configured, APP_ID, options()),
      'sidecar_missing',
    );

    expect(resolveSchedulePrecondition(task(), APP_ID, options())).toEqual({ kind: 'none' });
  });

  it('binds active records to canonical input and supports an explicit rebind', () => {
    const configured = stageAndActivate('echo 1\n');
    const updated = { ...configured, prompt: 'Run the changed pipeline' };

    expectCode(
      () => resolveSchedulePrecondition(updated, APP_ID, options()),
      'canonical_input_mismatch',
    );
    rebindSchedulePrecondition(updated, APP_ID, options());
    expect(resolveSchedulePrecondition(updated, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'echo 1\n' },
    });
  });

  it('binds to the concrete task instance independently of canonical input', () => {
    const configured = stageAndActivate();
    const replacement = { ...configured, createdAt: '2026-08-29T01:02:03.000Z' };

    expectCode(
      () => resolveSchedulePrecondition(replacement, APP_ID, options()),
      'task_instance_mismatch',
    );
    expectCode(
      () => rebindSchedulePrecondition(replacement, APP_ID, options()),
      'task_instance_mismatch',
    );
  });

  it('restores the previous active value on a matching abort and rejects stale aborts', () => {
    const original = stageAndActivate('echo old\n');
    const staged = stageSchedulePrecondition(APP_ID, TASK_ID, 'echo new\n', options(REF_B));

    expect(staged.previous.kind).toBe('record');
    abortSchedulePrecondition(APP_ID, TASK_ID, REF_B, staged.previous, options(REF_B));
    expect(resolveSchedulePrecondition(original, APP_ID, options())).toEqual({
      kind: 'configured',
      enabled: true,
      source: { kind: 'inline', script: 'echo old\n' },
    });
    expectCode(
      () => abortSchedulePrecondition(APP_ID, TASK_ID, REF_B, staged.previous, options(REF_B)),
      'transition_conflict',
    );
  });

  it('removes records idempotently while a remaining marker still fails closed', () => {
    const configured = stageAndActivate();

    expect(removeSchedulePrecondition(APP_ID, TASK_ID, options())).toBe(true);
    expect(removeSchedulePrecondition(APP_ID, TASK_ID, options())).toBe(false);
    expectCode(
      () => resolveSchedulePrecondition(configured, APP_ID, options()),
      'sidecar_missing',
    );
    expect(resolveSchedulePrecondition(task(), APP_ID, options())).toEqual({ kind: 'none' });
  });

  it('rejects malformed and identity-swapped records instead of treating them as absent', () => {
    const staged = stageSchedulePrecondition(APP_ID, TASK_ID, 'echo 1\n', options());
    const path = schedulePreconditionPath(APP_ID, TASK_ID, dataDir);
    writeFileSync(path, '{broken', { mode: 0o600 });
    expectCode(
      () => resolveSchedulePrecondition(task(staged.preconditionRef), APP_ID, options()),
      'corrupt_record',
    );

    rmSync(path);
    stageSchedulePrecondition(APP_ID, TASK_ID, 'echo 1\n', options());
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    raw.larkAppId = 'another-app';
    writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
    expectCode(
      () => resolveSchedulePrecondition(task(REF_A), APP_ID, options()),
      'identity_mismatch',
    );
  });

  it('rejects record symlinks without reading or replacing their target', () => {
    const path = schedulePreconditionPath(APP_ID, TASK_ID, dataDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(schedulePreconditionRoot(dataDir), 0o700);
    chmodSync(dirname(path), 0o700);
    const target = join(tempDir, 'outside-secret');
    writeFileSync(target, 'do-not-touch', { mode: 0o600 });
    symlinkSync(target, path);

    expectCode(
      () => resolveSchedulePrecondition(task(REF_A), APP_ID, options()),
      'unsafe_layout',
    );
    expectCode(
      () => stageSchedulePrecondition(APP_ID, TASK_ID, 'echo 1\n', options()),
      'unsafe_layout',
    );
    expect(readFileSync(target, 'utf8')).toBe('do-not-touch');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('rejects symlinked root and owner directories', () => {
    mkdirSync(dataDir, { recursive: true });
    const outsideRoot = join(tempDir, 'outside-root');
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, schedulePreconditionRoot(dataDir));
    expectCode(
      () => stageSchedulePrecondition(APP_ID, TASK_ID, 'echo 1\n', options()),
      'unsafe_layout',
    );

    rmSync(schedulePreconditionRoot(dataDir));
    ensureSchedulePreconditionRoot(dataDir);
    const path = schedulePreconditionPath(APP_ID, TASK_ID, dataDir);
    const outsideOwner = join(tempDir, 'outside-owner');
    mkdirSync(outsideOwner);
    symlinkSync(outsideOwner, dirname(path));
    expectCode(
      () => stageSchedulePrecondition(APP_ID, TASK_ID, 'echo 1\n', options()),
      'unsafe_layout',
    );
  });

  it('rejects records whose permissions are wider than 0600', () => {
    if (process.platform === 'win32') return;
    const configured = stageAndActivate();
    chmodSync(schedulePreconditionPath(APP_ID, TASK_ID, dataDir), 0o644);

    expectCode(
      () => resolveSchedulePrecondition(configured, APP_ID, options()),
      'unsafe_layout',
    );
    expectCode(
      () => removeSchedulePrecondition(APP_ID, TASK_ID, options()),
      'unsafe_layout',
    );
  });

  it('validates nonblank UTF-8 scripts within the exported size limit', () => {
    expect(validateSchedulePreconditionScript(' echo 1\n')).toBe(' echo 1\n');
    expectCode(() => validateSchedulePreconditionScript(' \n\t'), 'invalid_input');
    expectCode(
      () => validateSchedulePreconditionScript('x'.repeat(MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES + 1)),
      'invalid_input',
    );
  });

  it('validates mutually exclusive inline/file definitions', () => {
    expect(validateSchedulePreconditionDefinition({
      enabled: false,
      source: { kind: 'file', path: '/opt/botmux/guard.sh' },
    })).toEqual({
      enabled: false,
      source: { kind: 'file', path: '/opt/botmux/guard.sh' },
    });
    expectCode(
      () => validateSchedulePreconditionSource({
        kind: 'inline',
        script: 'echo 1',
        path: '/tmp/also-present',
      }),
      'invalid_input',
    );
    expectCode(
      () => validateSchedulePreconditionSource({ kind: 'file', path: '~/guard.sh' }),
      'invalid_input',
    );
  });
});
