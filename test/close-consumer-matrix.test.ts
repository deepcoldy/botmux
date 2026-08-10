/**
 * Repo-level guard for close consumers.
 *
 * Every review round of this work found another consumer quietly flattening
 * `closed_with_residual` (or a refused close) into an ordinary success. Patching
 * them one per round never converged, because nothing failed when a NEW consumer
 * appeared — the type cannot help across a JSON seam, and a caller that reads only
 * `.ok` compiles fine.
 *
 * So the invariant is enforced here instead: every place that closes a session, or
 * reads a close response, must be classified. An unclassified one fails this test
 * with instructions, which is the only mechanism that makes the next consumer
 * visible at the time it is written.
 *
 * Deliberately NOT line-number based, and deliberately no TODO allowlist: known
 * debt is either fixed or classified honestly with the risk stated.
 *
 * Run:  pnpm vitest run test/close-consumer-matrix.test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve('src');

type Category =
  /** Renders the outcome to a human: MUST surface failure and residual. */
  | 'user_surface'
  /** No user surface: MUST at least log a failure/residual (observability). */
  | 'background'
  /** Owns/serves the close contract itself rather than consuming it. */
  | 'infrastructure'
  /** Cannot produce a residual; must say why, and be provable. */
  | 'impossible_by_invariant';

interface ConsumerRule {
  category: Category;
  why: string;
  /** Background callers must go through closeSessionForBackgroundCleanup. */
  forbidBareClose?: boolean;
  /** JSON-seam consumers must decode via the shared parser, never ad hoc. */
  requireSharedParser?: boolean;
}

/**
 * The matrix. Adding a close consumer without adding a line here fails the test.
 */
const CONSUMERS: Record<string, ConsumerRule> = {
  'core/worker-pool.ts': {
    category: 'infrastructure',
    why: 'Defines closeSession(), the residual model and the background wrapper.',
  },
  'services/session-store.ts': {
    category: 'infrastructure',
    why: 'Durable close transaction (status + parked lineage) — not a consumer.',
  },
  'core/close-residual.ts': {
    category: 'infrastructure',
    why: 'The shared JSON parser every seam decodes with.',
  },
  'core/command-handler.ts': {
    category: 'user_surface',
    why: '/close and text /repo: report refusal and residual, refuse repo switch.',
  },
  'im/lark/card-handler.ts': {
    category: 'user_surface',
    why: 'Close button and card repo switch: warning toast / abort with the id.',
  },
  'im/lark/sessions-card.ts': {
    category: 'user_surface',
    why: 'Sessions board card: residual banner on the closed detail card.',
    requireSharedParser: true,
  },
  'dashboard/web/sessions-page.tsx': {
    category: 'user_surface',
    why: 'Web single + bulk close: residual alert, counted apart from failures.',
    requireSharedParser: true,
  },
  'dashboard/web/groups-page.tsx': {
    category: 'user_surface',
    why: 'Group leave/disband cascade: residual count + ids in the summary.',
  },
  'dashboard/web/bot-defaults-page.tsx': {
    category: 'user_surface',
    why: 'Agent switch: residual/failed counts, ids, and no green tick.',
  },
  'dashboard/groups-action-helpers.ts': {
    category: 'user_surface',
    why: 'Builds the group cascade result the groups page renders.',
  },
  'dashboard.ts': {
    category: 'user_surface',
    why: 'Proxies idle-cleanup and group-cascade closes; forwards residual.',
    requireSharedParser: true,
  },
  'core/dashboard-ipc-server.ts': {
    category: 'user_surface',
    why: 'Close route + agent-switch transaction; replays residual on closed rows.',
  },
  'core/session-manager.ts': {
    category: 'background',
    why: 'CLI-mismatch sweep and agent-switch transaction: counted + logged.',
  },
  'core/trigger-session.ts': {
    category: 'background',
    why: 'Boot reconcile / lease cleanup: no user surface, so it must log.',
    forbidBareClose: true,
  },
  'core/deferred-schedule-settlement.ts': {
    category: 'background',
    why: 'Returns close_refused instead of modelling a refusal as closed.',
  },
  'cli.ts': {
    category: 'user_surface',
    why: '`botmux delete` + interactive picker: per-row warning and a separate '
      + 'residual count in the summary.',
    requireSharedParser: true,
  },
  'dashboard/session-cleanup.ts': {
    category: 'infrastructure',
    why: 'Idle-cleanup result shape; carries `residual` apart from `closed`.',
  },
  'daemon.ts': {
    category: 'background',
    why: 'Scheduler settlement + sweeps; injects the background wrapper.',
  },
};

/** Actual call syntax, so a doc comment or a '/close' command string is not a hit. */
const CALL_RE =
  /(closeSession|closeWorkerPoolSession|closeSessionForBackgroundCleanup|closeSessionsForAgentSwitch|closeSessionsMatching)\s*\(/;
/** A JSON seam: something POSTing to the close route and reading its body. */
const SEAM_RE = /\}\/close`|\/close`, \{|sessions\/[^`'"]*\/close/;
/**
 * Consuming the RESULT counts too. A file that never calls close but renders (or
 * forwards) its outcome is exactly the kind of consumer that kept getting missed —
 * the group cascade summary and the agent-switch page both got here that way.
 */
const RESULT_RE =
  /parseCloseResidual|describeCloseResidual|closed_with_residual|close_refused|closedMismatchedResidual|CloseResidual/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function consumerFiles(): { key: string; source: string; isSeam: boolean }[] {
  return walk(SRC).flatMap(file => {
    const source = readFileSync(file, 'utf8');
    const isCall = CALL_RE.test(source);
    const isSeam = SEAM_RE.test(source);
    const isResult = RESULT_RE.test(source);
    if (!isCall && !isSeam && !isResult) return [];
    return [{ key: relative(SRC, file).split('\\').join('/'), source, isSeam }];
  });
}

describe('close consumer matrix', () => {
  it('every close consumer is classified', () => {
    const unclassified = consumerFiles()
      .map(f => f.key)
      .filter(key => !(key in CONSUMERS));

    expect(
      unclassified,
      'New close consumer(s) found. Add each to CONSUMERS in this file with a '
      + 'category:\n'
      + '  user_surface  — must render a refusal AND a residual (taskId), never a plain success\n'
      + '  background    — no UI, so it must at least log them (closeSessionForBackgroundCleanup)\n'
      + '  infrastructure — defines/serves the contract\n'
      + '  impossible_by_invariant — prove it cannot produce a residual\n'
      + `Unclassified: ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('the matrix has no stale entries', () => {
    const present = new Set(consumerFiles().map(f => f.key));
    const stale = Object.keys(CONSUMERS).filter(key => !present.has(key));
    expect(stale, `Entries no longer reference a close consumer: ${stale.join(', ')}`)
      .toEqual([]);
  });

  it('background consumers do not call closeSession() bare', () => {
    // Bare closeSession() on a path with no user surface discards the only signal
    // that a remote session survived.
    const offenders = consumerFiles()
      .filter(f => CONSUMERS[f.key]?.forbidBareClose)
      .filter(f => /(?<![\w.])closeSession\s*\(/.test(f.source))
      .map(f => f.key);
    expect(
      offenders,
      `Must use closeSessionForBackgroundCleanup(): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('JSON-seam consumers decode with the shared parser', () => {
    const offenders = consumerFiles()
      .filter(f => CONSUMERS[f.key]?.requireSharedParser)
      .filter(f => !f.source.includes('close-residual.js'))
      .map(f => f.key);
    expect(
      offenders,
      'Must import parseCloseResidual from core/close-residual.js rather than '
      + `reading outcome/residual ad hoc: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the scheduler injects the BACKGROUND wrapper, not a bare close', () => {
    // Binding-level check: settleDeferredScheduleRun already refuses to report a
    // refusal as closed, but swapping this injection back would silently drop the
    // residual log.
    const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8');
    const injection = daemon.slice(
      daemon.indexOf('settleDeferredScheduleRun('),
      daemon.indexOf('settleDeferredScheduleRun(') + 600,
    );
    expect(injection).toContain('closeSessionForBackgroundCleanup');
  });
});
