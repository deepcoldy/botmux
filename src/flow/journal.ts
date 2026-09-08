/**
 * journal：追加、读取、完整性校验与跨代次投影（设计文档 §5.4、§6.2）。
 *
 * - 追加只在所有权临界区内进行（`appendRowsLocked` 由 `withRunOwnership` 的回调调用，
 *   或经 `appendRows` 自动包一层）。单次 `O_APPEND` 写一整行；`FSYNC_ROW_TYPES` 额外 fsync。
 * - 投影分两步：① 完整性校验（gen 序列一致，任何被剔除的行都是协议被绕过的证据）；
 *   ② 在有效行上按 identity 取最新 attempt，decision 跨代次按 {identity, content, attempt} 索引。
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { withRunOwnership, type RunSelf } from './ownership.js';
import {
  FSYNC_ROW_TYPES,
  JOURNAL_FILE,
  JOURNAL_ROW_MAX_BYTES,
  type ActivityRow,
  type AttemptPhase,
  type ContainerCreatedRow,
  type DecisionRow,
  type DivergenceRow,
  type EscapeRow,
  type FailedRow,
  type JournalRow,
  type ResultRow,
  type RunErrorRow,
  type RunFinishedRow,
  type RunHealth,
  type RunInterruptedRow,
  type RunStartedRow,
  type RunTakeoverRow,
  type SignalRow,
  type WaitDeliveryRow,
  type WaitRow,
} from './types.js';

export function journalPath(runDir: string): string {
  return join(runDir, JOURNAL_FILE);
}

export class JournalRowTooLargeError extends Error {
  constructor(readonly rowType: string, readonly bytes: number) {
    super(`journal row ${rowType} is ${bytes} bytes, limit ${JOURNAL_ROW_MAX_BYTES}`);
    this.name = 'JournalRowTooLargeError';
  }
}

export function serializeRow(row: JournalRow): string {
  const line = `${JSON.stringify(row)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > JOURNAL_ROW_MAX_BYTES) throw new JournalRowTooLargeError(row.t, bytes);
  return line;
}

/**
 * 临界区内追加。调用方必须已经在 `withRunOwnership` 里（核对过 lease）。
 * 一次打开、逐行单次 write；任一行需要 fsync 则在关闭前 fsync 一次。
 */
export function appendRowsLocked(runDir: string, rows: readonly JournalRow[]): void {
  if (rows.length === 0) return;
  const lines = rows.map(serializeRow); // 先序列化，大小超限时什么都不写
  const needFsync = rows.some((row) => FSYNC_ROW_TYPES.has(row.t));
  const fd = openSync(journalPath(runDir), 'a');
  try {
    for (const line of lines) {
      const buf = Buffer.from(line, 'utf8');
      let offset = 0;
      while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    if (needFsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 进临界区、核对、追加：runner 侧最常用的形态。 */
export async function appendRows(runDir: string, self: RunSelf, rows: readonly JournalRow[]): Promise<void> {
  await withRunOwnership(runDir, self, () => appendRowsLocked(runDir, rows));
}

export async function appendRow(runDir: string, self: RunSelf, row: JournalRow): Promise<void> {
  await appendRows(runDir, self, [row]);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export interface RawJournal {
  rows: JournalRow[];
  /** 解析失败的行（含末尾半行）。半行只可能是最后一行：崩溃时的截断。 */
  malformed: Array<{ line: number; text: string }>;
}

export function readJournal(runDir: string): RawJournal {
  let text: string;
  try {
    text = readFileSync(journalPath(runDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], malformed: [] };
    throw err;
  }
  return parseJournal(text);
}

export function parseJournal(text: string): RawJournal {
  const rows: JournalRow[] = [];
  const malformed: RawJournal['malformed'] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRowShaped(value)) rows.push(value);
      else malformed.push({ line: i + 1, text: line.slice(0, 200) });
    } catch {
      malformed.push({ line: i + 1, text: line.slice(0, 200) });
    }
  }
  return { rows, malformed };
}

function isRowShaped(value: unknown): value is JournalRow {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { t?: unknown }).t === 'string' &&
    Number.isSafeInteger((value as { gen?: unknown }).gen) &&
    typeof (value as { ts?: unknown }).ts === 'number'
  );
}

// ---------------------------------------------------------------------------
// 第一步：完整性校验
// ---------------------------------------------------------------------------

export interface DroppedRow {
  index: number;
  row: JournalRow;
  reason: 'gen_not_advancing' | 'gen_mismatch';
  currentGen: number;
}

export interface IntegrityResult {
  valid: JournalRow[];
  dropped: DroppedRow[];
  /** 最后一条有效 run.started/run.takeover 的 gen；journal 为空时 0。 */
  gen: number;
}

export function checkIntegrity(rows: readonly JournalRow[]): IntegrityResult {
  const valid: JournalRow[] = [];
  const dropped: DroppedRow[] = [];
  let currentGen = 0;
  rows.forEach((row, index) => {
    if (row.t === 'run.started' || row.t === 'run.takeover') {
      if (row.gen > currentGen) {
        currentGen = row.gen;
        valid.push(row);
      } else {
        dropped.push({ index, row, reason: 'gen_not_advancing', currentGen });
      }
      return;
    }
    if (row.gen !== currentGen) {
      dropped.push({ index, row, reason: 'gen_mismatch', currentGen });
      return;
    }
    valid.push(row);
  });
  return { valid, dropped, gen: currentGen };
}

/** 接管时 `persistedMaxGen` 的 journal 分量：直接扫原始行，不依赖投影。 */
export function journalMaxGen(rows: readonly JournalRow[]): number {
  let max = 0;
  for (const row of rows) {
    if ((row.t === 'run.started' || row.t === 'run.takeover') && row.gen > max) max = row.gen;
  }
  return max;
}

// ---------------------------------------------------------------------------
// 第二步：跨代次投影
// ---------------------------------------------------------------------------

export interface AttemptProjection {
  identity: string;
  attempt: number;
  content: string;
  kind: 'agent' | 'signal';
  cli?: string;
  /** 创建该 attempt 的代次。 */
  gen: number;
  phase: AttemptPhase | null;
  container: string | null;
  pid: number | null;
  pidIdentity: string | null;
  cliPid: number | null;
  /** 有效 `send.intent` 存在即 effects 只能是 uncertain（§5.5）。 */
  intent: { gen: number; turn: number; outboxFile: string; container: string } | null;
  confirmed: boolean;
  state: 'inflight' | 'result' | 'failed';
  result: ResultRow | null;
  failed: FailedRow | null;
}

export interface IdentityProjection {
  identity: string;
  /** 行顺序上最后出现的 attempt。 */
  latest: AttemptProjection;
  attempts: AttemptProjection[];
}

export interface WaitProjection {
  identity: string;
  content: string;
  version: number;
  wait: WaitRow;
  /** 逻辑等待状态（§7.3）：只有它决定是否接受提交。 */
  state: 'open' | 'consumed' | 'superseded';
  signal: SignalRow | null;
  /** 卡片投递状态（§7.3）：该 version 最近一条 wait.delivery；只影响显示与重发。 */
  delivery: WaitDeliveryRow | null;
}

export interface Projection {
  gen: number;
  started: RunStartedRow | null;
  takeovers: RunTakeoverRow[];
  identities: Map<string, IdentityProjection>;
  /** key = decisionKey(identity, content, attempt)，同 key 后写的覆盖先写的。 */
  decisions: Map<string, DecisionRow>;
  runDecisions: DecisionRow[];
  containers: Map<string, ContainerCreatedRow>;
  /** identity → 最新版本的 wait（M2 才写入，这里先认得）。 */
  waits: Map<string, WaitProjection>;
  divergences: DivergenceRow[];
  escapes: EscapeRow[];
  errors: RunErrorRow[];
  activity: ActivityRow | null;
  notes: number;
  finished: RunFinishedRow | null;
  interrupted: RunInterruptedRow | null;
  /** 当前代次内最后出现的终态行（决定 inspect 显示 finished 还是 interrupted）。 */
  terminal: 'finished' | 'interrupted' | null;
  counts: { started: number; ok: number; failed: number; inflight: number };
  settled: boolean;
  health: RunHealth;
}

export function decisionKey(identity: string, content: string, attempt: number): string {
  return `${identity}\u0000${content}\u0000${attempt}`;
}

function attemptKey(identity: string, attempt: number): string {
  return `${identity}\u0000${attempt}`;
}

export function project(valid: readonly JournalRow[]): Projection {
  const identities = new Map<string, IdentityProjection>();
  const attempts = new Map<string, AttemptProjection>();
  const decisions = new Map<string, DecisionRow>();
  const runDecisions: DecisionRow[] = [];
  const containers = new Map<string, ContainerCreatedRow>();
  const waits = new Map<string, WaitProjection>();
  const divergences: DivergenceRow[] = [];
  const escapes: EscapeRow[] = [];
  const errors: RunErrorRow[] = [];
  const takeovers: RunTakeoverRow[] = [];
  let started: RunStartedRow | null = null;
  let activity: ActivityRow | null = null;
  let notes = 0;
  let finished: RunFinishedRow | null = null;
  let interrupted: RunInterruptedRow | null = null;
  let terminal: Projection['terminal'] = null;
  let gen = 0;

  const ensureAttempt = (identity: string, attempt: number, rowGen: number): AttemptProjection => {
    const key = attemptKey(identity, attempt);
    let entry = attempts.get(key);
    if (!entry) {
      entry = {
        identity,
        attempt,
        content: '',
        kind: 'agent',
        gen: rowGen,
        phase: null,
        container: null,
        pid: null,
        pidIdentity: null,
        cliPid: null,
        intent: null,
        confirmed: false,
        state: 'inflight',
        result: null,
        failed: null,
      };
      attempts.set(key, entry);
      let ident = identities.get(identity);
      if (!ident) {
        ident = { identity, latest: entry, attempts: [] };
        identities.set(identity, ident);
      }
      ident.attempts.push(entry);
      ident.latest = entry;
    }
    return entry;
  };

  for (const row of valid) {
    switch (row.t) {
      case 'run.started':
        started = row;
        gen = row.gen;
        terminal = null;
        break;
      case 'run.takeover':
        takeovers.push(row);
        gen = row.gen;
        terminal = null;
        break;
      case 'container.created':
        containers.set(row.container, row);
        break;
      case 'started': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        entry.content = row.content;
        entry.kind = row.kind;
        if (row.cli !== undefined) entry.cli = row.cli;
        break;
      }
      case 'attempt.state': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        entry.phase = row.state;
        entry.container = row.container;
        if (row.pid !== undefined) entry.pid = row.pid;
        if (row.pidIdentity !== undefined) entry.pidIdentity = row.pidIdentity;
        if (row.cliPid !== undefined) entry.cliPid = row.cliPid;
        break;
      }
      case 'send.intent': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        entry.intent = { gen: row.gen, turn: row.turn, outboxFile: row.outboxFile, container: row.container };
        break;
      }
      case 'send.confirmed': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        entry.confirmed = true;
        break;
      }
      case 'result': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        entry.state = 'result';
        entry.result = row;
        entry.failed = null;
        break;
      }
      case 'failed': {
        const entry = ensureAttempt(row.identity, row.attempt, row.gen);
        // 已有 result 的 attempt 不会再失败；保守起见后写的覆盖先写的
        entry.state = 'failed';
        entry.failed = row;
        entry.result = null;
        break;
      }
      case 'decision':
        if ('run' in row.scope) runDecisions.push(row);
        else decisions.set(decisionKey(row.scope.identity, row.scope.content, row.scope.attempt), row);
        break;
      case 'divergence':
        divergences.push(row);
        break;
      case 'escape':
        escapes.push(row);
        break;
      case 'activity':
        activity = row;
        break;
      case 'note':
        notes++;
        break;
      case 'run.error':
        errors.push(row);
        break;
      case 'run.interrupted':
        interrupted = row;
        terminal = 'interrupted';
        break;
      case 'run.finished':
        finished = row;
        terminal = 'finished';
        break;
      case 'wait':
        waits.set(row.identity, {
          identity: row.identity,
          content: row.content,
          version: row.version,
          wait: row,
          state: 'open',
          signal: null,
          delivery: null,
        });
        break;
      case 'wait.delivery': {
        const wait = waits.get(row.identity);
        if (wait && wait.version === row.version) wait.delivery = row;
        break;
      }
      case 'signal': {
        const wait = waits.get(row.identity);
        if (wait && wait.version === row.version) {
          wait.state = 'consumed';
          wait.signal = row;
        } else {
          // 无对应 wait（或版本不同）的 signal：仍按 identity 记住，重放时 content 相同即可复用
          waits.set(row.identity, {
            identity: row.identity,
            content: row.content,
            version: row.version,
            wait: wait?.wait ?? ({ t: 'wait', gen: row.gen, ts: row.ts, identity: row.identity, content: row.content, version: row.version, schema: null, prompt: '' } as WaitRow),
            state: 'consumed',
            signal: row,
            delivery: null,
          });
        }
        break;
      }
      case 'wait.superseded': {
        const wait = waits.get(row.identity);
        if (wait && wait.version === row.version) wait.state = 'superseded';
        break;
      }
      default: {
        // 未知行类型：忽略（前向兼容），不算完整性问题
        const _exhaustive: never = row;
        void _exhaustive;
      }
    }
  }

  const counts = { started: 0, ok: 0, failed: 0, inflight: 0 };
  for (const ident of identities.values()) {
    counts.started++;
    if (ident.latest.state === 'result') counts.ok++;
    else if (ident.latest.state === 'failed') counts.failed++;
    else counts.inflight++;
  }
  const settled = counts.inflight === 0;
  const health: RunHealth =
    counts.failed === 0 ? 'ok' : counts.ok === 0 && counts.inflight === 0 ? 'all_failed' : 'degraded';

  return {
    gen,
    started,
    takeovers,
    identities,
    decisions,
    runDecisions,
    containers,
    waits,
    divergences,
    escapes,
    errors,
    activity,
    notes,
    finished,
    interrupted,
    terminal,
    counts,
    settled,
    health,
  };
}

export interface LoadedJournal {
  raw: RawJournal;
  integrity: IntegrityResult;
  projection: Projection;
}

/** 读 + 校验 + 投影一步到位。 */
export function loadJournal(runDir: string): LoadedJournal {
  const raw = readJournal(runDir);
  const integrity = checkIntegrity(raw.rows);
  return { raw, integrity, projection: project(integrity.valid) };
}
