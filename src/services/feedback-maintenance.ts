import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';
import { openDatabaseSync, type DatabaseSyncLike } from './sqlite-compat.js';
import { readFeedbackStorageConfig } from './feedback-storage-config.js';
import { FEEDBACK_TABLES } from './feedback-postgres-schema.js';
import { closeFeedbackStorage, getFeedbackStorage } from './feedback-storage.js';

export interface MaintenanceReport {
  migrationId: string;
  state: 'draining' | 'frozen' | 'blocked' | 'complete';
  generation: number;
  participants: Array<{ processId: number; processStartId: string; generation: number; ready: boolean }>;
  blockers: string[];
}
interface Participant {
  processId: number;
  processStartId: string;
  generation: number;
  migrationId?: string;
  ready: boolean;
  updatedAt: number;
  blockers: string[];
}
const controlPath = (dataDir: string) => join(dataDir, 'feedback-maintenance.json');
function readControl(dataDir: string): MaintenanceReport | undefined {
  const path = controlPath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value.migrationId !== 'string' || !['draining', 'frozen', 'blocked', 'complete'].includes(value.state) || !Number.isSafeInteger(value.generation)) throw new Error();
    return value;
  } catch { throw new Error('feedback_maintenance_state_invalid'); }
}
function writeControl(dataDir: string, value: MaintenanceReport): void {
  atomicWriteFileSync(controlPath(dataDir), JSON.stringify(value), { mode: 0o600, durable: true, followTargetSymlink: false });
}
export function assertFeedbackAdmission(dataDir: string): void {
  const state = readControl(dataDir);
  if (state && state.state !== 'complete') throw new Error('feedback_storage_maintenance');
}
export function feedbackMaintenanceActive(dataDir: string): boolean {
  try { assertFeedbackAdmission(dataDir); return false; } catch { return true; }
}
export function withFeedbackSendLease<Result>(dataDir: string, operation: () => Promise<Result>): Promise<Result> {
  mkdirSync(dataDir, { recursive: true });
  const identity = readDurableProcessIdentity(process.pid);
  if (!identity) throw new Error('feedback_process_identity_unavailable');
  const directory = join(dataDir, 'feedback-send-leases');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}-${crypto.randomUUID()}.json`);
  withFileLockSync(controlPath(dataDir), () => {
    assertFeedbackAdmission(dataDir);
    atomicWriteFileSync(path, JSON.stringify({ processId: process.pid, processStartId: identity }), { mode: 0o600, durable: true, followTargetSymlink: false });
  });
  return operation().finally(() => { try { unlinkSync(path); } catch {} });
}
export function writeFeedbackParticipant(dataDir: string, input: Omit<Participant, 'processId' | 'processStartId' | 'updatedAt'>): void {
  const identity = readDurableProcessIdentity(process.pid);
  if (!identity) throw new Error('feedback_process_identity_unavailable');
  const directory = join(dataDir, 'feedback-participants');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(directory, `${process.pid}.json`), JSON.stringify({
    ...input, processId: process.pid, processStartId: identity, updatedAt: Date.now(),
  }), { mode: 0o600, durable: true, followTargetSymlink: false });
}
export function currentFeedbackMaintenance(dataDir: string): MaintenanceReport | undefined { return readControl(dataDir); }

export function startFeedbackMaintenanceParticipant(
  dataDir: string,
  health: () => { busy: boolean; failed: number; pending: number },
  stopOutbox: () => Promise<void>,
  resumeOutbox: () => Promise<void>,
): () => void {
  let running = false;
  let stoppedOutbox = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const config = await readFeedbackStorageConfig(dataDir);
      const maintenance = readControl(dataDir);
      const state = health();
      let ready = false;
      const blockers: string[] = [];
      if (maintenance && maintenance.state !== 'complete') {
        if (state.busy) blockers.push('active_turns');
        if (state.pending) blockers.push('pending_terminal_writes');
        if (state.failed) blockers.push('failed_terminal_writes');
        if (!blockers.length) {
          await stopOutbox();
          stoppedOutbox = true;
          await closeFeedbackStorage(dataDir);
          if (config.active.backend === 'postgresql') await getFeedbackStorage(dataDir);
          ready = true;
        }
      } else if (stoppedOutbox) {
        await resumeOutbox();
        stoppedOutbox = false;
      }
      writeFeedbackParticipant(dataDir, { generation: config.generation, migrationId: maintenance?.migrationId, ready, blockers });
    } catch {
      writeFeedbackParticipant(dataDir, { generation: -1, ready: false, blockers: ['participant_check_failed'] });
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 500);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

export async function beginFeedbackMaintenance(dataDir: string, migrationId: string): Promise<MaintenanceReport> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(migrationId)) throw new Error('feedback_migration_id_invalid');
  const config = await readFeedbackStorageConfig(dataDir);
  return withFileLockSync(controlPath(dataDir), () => {
    const existing = readControl(dataDir);
    if (existing && existing.state !== 'complete') {
      if (existing.migrationId !== migrationId) throw new Error('feedback_migration_conflict');
      return existing;
    }
    const report: MaintenanceReport = { migrationId, state: 'draining', generation: config.generation, participants: [], blockers: [] };
    writeControl(dataDir, report);
    return report;
  });
}

export async function inspectFeedbackMaintenance(dataDir: string, migrationId: string): Promise<MaintenanceReport> {
  const state = readControl(dataDir);
  if (!state || state.migrationId !== migrationId) throw new Error('feedback_migration_identity_conflict');
  const blockers: string[] = [];
  const participants: Participant[] = [];
  const directory = join(dataDir, 'feedback-participants');
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const participant: Participant = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    const current = readDurableProcessIdentity(participant.processId);
    if (!current || current !== participant.processStartId) continue;
    participants.push(participant);
    if (participant.migrationId !== migrationId || !participant.ready || Date.now() - participant.updatedAt > 10000) {
      blockers.push(`participant_not_ready:${participant.processId}`);
    }
    blockers.push(...participant.blockers);
  }
  const leases = join(dataDir, 'feedback-send-leases');
  for (const name of existsSync(leases) ? readdirSync(leases) : []) {
    const lease = JSON.parse(readFileSync(join(leases, name), 'utf8'));
    if (readDurableProcessIdentity(lease.processId) === lease.processStartId) blockers.push(`send_in_progress:${lease.processId}`);
    else blockers.push(`send_outcome_unknown:${lease.processId}`);
  }
  const fleetPath = join(process.env.HOME ?? homedir(), '.botmux', 'fleet-state.json');
  if (existsSync(fleetPath)) {
    const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
    if (!Array.isArray(fleet.procs)) throw new Error('feedback_fleet_state_invalid');
    for (const processState of fleet.procs) {
      if (!/^botmux-\d+$/.test(processState.name) || !processState.pid) continue;
      const identity = readDurableProcessIdentity(processState.pid);
      if (!identity) continue;
      if (!participants.some(participant => participant.processId === processState.pid && participant.processStartId === identity)) {
        blockers.push(`unsupported_daemon:${processState.pid}`);
      }
    }
  }
  return { ...state, participants, blockers, state: blockers.length ? 'blocked' : state.state };
}

async function source(dataDir: string): Promise<DatabaseSyncLike> {
  const database = await openDatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
  return database;
}
export async function freezeFeedbackSource(dataDir: string, migrationId: string): Promise<void> {
  const report = await inspectFeedbackMaintenance(dataDir, migrationId);
  if (report.blockers.length) throw new Error(`feedback_maintenance_blocked:${report.blockers.join(',')}`);
  const database = await source(dataDir);
  try {
    database.exec('BEGIN IMMEDIATE');
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_outbox'").get()) {
      const inflight = database.prepare("SELECT COUNT(*) count FROM feedback_outbox WHERE status='inflight'").get() as { count: number };
      if (inflight.count) throw new Error('feedback_outbox_unsettled');
    }
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version < 1 || version > 8) throw new Error('feedback_source_schema_unsupported');
    database.exec("CREATE TABLE IF NOT EXISTS feedback_source_guard(singleton INTEGER PRIMARY KEY CHECK(singleton=1),migration_id TEXT NOT NULL,state TEXT NOT NULL)");
    const guard = database.prepare('SELECT * FROM feedback_source_guard WHERE singleton=1').get() as { migration_id: string; state: string } | undefined;
    if (guard && guard.migration_id !== migrationId) throw new Error('feedback_migration_identity_conflict');
    if (!guard) database.prepare("INSERT INTO feedback_source_guard VALUES(1,?,'frozen')").run(migrationId);
    for (const table of FEEDBACK_TABLES) {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        database.exec(`CREATE TRIGGER IF NOT EXISTS feedback_guard_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'feedback_source_frozen'); END`);
      }
    }
    database.exec('COMMIT');
    withFileLockSync(controlPath(dataDir), () => writeControl(dataDir, { ...report, state: 'frozen' }));
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally { database.close(); }
}
export async function retireFeedbackSource(dataDir: string, migrationId: string): Promise<void> {
  const database = await source(dataDir);
  try {
    const result = database.prepare("UPDATE feedback_source_guard SET state='retired' WHERE singleton=1 AND migration_id=?").run(migrationId);
    if (Number(result.changes) !== 1) throw new Error('feedback_migration_identity_conflict');
  } finally { database.close(); }
}
export async function restoreFeedbackSource(dataDir: string, migrationId: string): Promise<void> {
  const database = await source(dataDir);
  try {
    database.exec('BEGIN IMMEDIATE');
    const guard = database.prepare('SELECT * FROM feedback_source_guard WHERE singleton=1').get() as { migration_id: string; state: string } | undefined;
    if (!guard || guard.migration_id !== migrationId) throw new Error('feedback_migration_identity_conflict');
    if (guard.state === 'retired') throw new Error('feedback_source_retired');
    for (const table of FEEDBACK_TABLES) {
      for (const action of ['insert', 'update', 'delete']) database.exec(`DROP TRIGGER IF EXISTS feedback_guard_${table}_${action}`);
    }
    database.exec('DELETE FROM feedback_source_guard');
    database.exec('COMMIT');
    withFileLockSync(controlPath(dataDir), () => {
      const control = readControl(dataDir);
      if (!control || control.migrationId !== migrationId) throw new Error('feedback_migration_identity_conflict');
      writeControl(dataDir, { ...control, state: 'complete' });
    });
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); }
}
export async function releaseFeedbackMaintenance(dataDir: string, migrationId: string, generation: number): Promise<void> {
  const report = await inspectFeedbackMaintenance(dataDir, migrationId);
  if (report.blockers.length || report.participants.some(participant => participant.generation !== generation)) {
    throw new Error('feedback_maintenance_generation_pending');
  }
  withFileLockSync(controlPath(dataDir), () => writeControl(dataDir, { ...report, generation, state: 'complete' }));
}
