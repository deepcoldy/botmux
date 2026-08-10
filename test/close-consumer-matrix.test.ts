/**
 * Repo-level guard for close consumers — CALL-SITE level, via the TypeScript AST.
 *
 * Every review round of this work found another consumer flattening a residual (or
 * a refused close) into an ordinary success. Patching them one per round never
 * converged because nothing FAILED when a new one appeared: the discriminant does
 * not survive a JSON seam, and a caller reading only `.ok` compiles fine.
 *
 * A FILE-level version was tried first and was not good enough — it was broken in
 * two minimal mutations. Most new consumers get added to an already-listed file
 * (daemon.ts, a handler), which a file inventory can never catch, and
 * `import { closeSession as close }` defeats name matching outright. Scanning raw
 * text also counts a `closeSession()` written inside a comment.
 *
 * So this resolves real CallExpressions against the imported binding — alias,
 * namespace and destructured dynamic import included — and keys each site by
 * `file::enclosing function::sink`, never by line number. A new call anywhere,
 * under any alias, fails until it is classified.
 *
 * Run:  pnpm vitest run test/close-consumer-matrix.test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve('src');

type Category =
  /** Renders the outcome to a human: MUST surface refusal AND residual. */
  | 'user_surface'
  /** No user surface: MUST log them (prefer closeSessionForBackgroundCleanup). */
  | 'background'
  /** Defines/serves the close contract rather than consuming it. */
  | 'infrastructure'
  /** Provably cannot produce a residual — `why` must state how it is proven. */
  | 'impossible_by_invariant';

/** Exported names that close a session. */
const SINKS = new Set([
  'closeSession',
  'closeSessionForBackgroundCleanup',
  'closeSessionsForAgentSwitch',
  'closeCliMismatchedSessionsForBot',
]);
/** Only these modules' `closeSession` is the lifecycle one (not the store's). */
const SINK_MODULE_RE = /worker-pool\.js$|session-manager\.js$/;

interface CallSite { key: string; sink: string }

/** The matrix, keyed per CALL SITE. */
const CONSUMERS: Record<string, { category: Category; why: string }> = {
  // NOTE: worker-pool's own internal closeSession() call (inside the background
  // wrapper) is not listed — it is a same-module reference, not an imported
  // binding, so the detector does not see it. That is the definition site, not a
  // consumer.
  // ── user surfaces: must render refusal AND residual ──────────────────────
  'core/command-handler.ts::handleCommand::closeSession': {
    category: 'user_surface',
    why: '/close: close_refused message and closed_with_residual warning, never the '
      + 'ordinary closed card.',
  },
  'core/command-handler.ts::commitRepoSelection::closeSession': {
    category: 'user_surface',
    why: 'Text /repo: a refusal or residual aborts the switch and names the id.',
  },
  'im/lark/card-handler.ts::handleCardAction::closeSession': {
    category: 'user_surface',
    why: 'Close button: warning toast on refusal/residual, no closed card.',
  },
  'im/lark/card-handler.ts::commitRepoSelection::closeSession': {
    category: 'user_surface',
    why: 'Card repo switch: aborts rather than spawning over an uncancelled remote.',
  },
  'core/dashboard-ipc-server.ts::<module>::closeSession': {
    category: 'user_surface',
    why: 'Close route: serialises the whole result; the closed-row fast path '
      + 'replays the residual.',
  },
  // NOTE: the agent-switch call goes through agentSwitchCloseHook.run (a test
  // seam), so it is a property call on a local object rather than a resolvable
  // import. Covered instead by the route tests that assert the config is not
  // committed on refusal.

  // ── background: no UI, so refusal/residual must be logged ────────────────
  'core/session-manager.ts::closeActiveSessionIfCliMismatch::closeSession': {
    category: 'background',
    why: 'Returns close_failed / closed_with_residual to the sweep; a refusal is '
      + 'never reported as closed.',
  },
  'core/session-manager.ts::closeSessionsForAgentSwitch::closeSession': {
    category: 'background',
    why: 'Agent-switch transaction: collects refusal + residual, blocks the commit.',
  },
  'core/session-manager.ts::restoreActiveSessions::closeSession': {
    category: 'background',
    why: 'Restore CLI-mismatch close: a refusal quarantines the row instead of '
      + 'leaving it active-but-unregistered.',
  },
  'core/session-manager.ts::resumeSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Closes only a worker:null daemon-command scratch placeholder occupying '
      + 'the anchor (isRelayableRealSession is excluded), which has no CLI session '
      + 'and therefore no remote lineage to leave behind.',
  },
  'core/session-manager.ts::spawnDashboardSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Same scratch-placeholder eviction as resumeSession: no remote lineage.',
  },
  'core/session-manager.ts::executeScheduledTask::closeSession': {
    category: 'background',
    why: 'Scheduled-run teardown; a refusal leaves the row active and is logged by '
      + 'closeSession itself. No user surface at schedule time.',
  },
  'core/session-manager.ts::suspendActiveSessionsForBot::closeSession': {
    category: 'background',
    why: 'Bot-wide suspend sweep; a refusal keeps the row active and logged.',
  },
  'core/trigger-session.ts::reconcileIdempotencyLeasesOnBoot::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Boot reconcile: wrapper logs refusal and residual with the remote id.',
  },
  'core/trigger-session.ts::reuseExistingWinner::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Loser cleanup on an idempotency race; wrapper logs both.',
  },
  'core/trigger-session.ts::triggerSessionTurnAdmitted::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Admission failure cleanup; wrapper logs both.',
  },
  'daemon.ts::closeSession::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Deferred-schedule settlement injection; settlement returns close_refused '
      + 'rather than closed.',
  },
  'daemon.ts::closeSession::closeSession': {
    category: 'background',
    why: 'Withdraw auto-close: inspects ok and outcome — a refusal returns false '
      + 'and logs, and a residual warns with the remote id.',
  },
  'daemon.ts::failCloseIdempotentTurnIfConvergenceWriteFailed::closeSession': {
    category: 'background',
    why: 'Idempotency fail-close: only claims "fail-closed" when ok is true; a '
      + 'refusal logs that the row stays active.',
  },
  'daemon.ts::adoptCodexNotifierEvent::closeSession': {
    category: 'background',
    why: 'Adopt-notifier teardown; a refusal keeps the row active and logged.',
  },
  'daemon.ts::handleBotAdded::closeSession': {
    category: 'background',
    why: 'Bot re-registration cleanup; a refusal keeps the row active and logged.',
  },
  'daemon.ts::rollbackRegisteredJoinSession::closeSession': {
    category: 'background',
    why: 'Rolls back a just-registered join session; a refusal keeps it active '
      + 'rather than reporting a rollback that did not happen.',
  },
  'daemon.ts::onCodexAppLedgerDrained::closeCliMismatchedSessionsForBot': {
    category: 'background',
    why: 'Deferred CLI-mismatch resweep; the sweep counts residual and failed.',
  },
  'daemon.ts::retireVcMeetingCodexAppDispatchAfterBackingMissing::closeCliMismatchedSessionsForBot': {
    category: 'background',
    why: 'VC retire path resweep; the sweep counts residual and failed.',
  },
};

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

/** Local identifiers bound to a sink, plus namespace aliases of the sink modules. */
export function closeSinkBindings(sf: ts.SourceFile): {
  locals: Map<string, string>;
  namespaces: Set<string>;
} {
  const locals = new Map<string, string>();
  const namespaces = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && SINK_MODULE_RE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          // `closeSession as closeWorkerPoolSession` → key on the LOCAL name.
          const exported = (el.propertyName ?? el.name).text;
          if (SINKS.has(exported)) locals.set(el.name.text, exported);
        }
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.add(clause.namedBindings.name.text);
      }
    }
    // `const { closeSession } = await import('./worker-pool.js')`
    if (ts.isVariableDeclaration(node) && node.initializer
      && ts.isObjectBindingPattern(node.name)
      // Non-anchored: the text here is `await import('./worker-pool.js')`.
      && /worker-pool\.js|session-manager\.js/.test(node.initializer.getText(sf))) {
      for (const el of node.name.elements) {
        const exported = (el.propertyName ?? el.name).getText(sf);
        if (SINKS.has(exported) && ts.isIdentifier(el.name)) locals.set(el.name.text, exported);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { locals, namespaces };
}

/** Nearest named function/method/arrow-in-const — a stable, non-line-based key. */
function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    // Only when the variable/property IS the function — otherwise
    // `const closeResult = await closeSession(...)` would name the site after its
    // result variable instead of the function that owns it.
    if ((ts.isVariableDeclaration(cur) || ts.isPropertyAssignment(cur))
      && ts.isIdentifier(cur.name) && cur.initializer
      && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return '<module>';
}

/** Every resolved close call site in a source file. */
export function closeCallSitesIn(sf: ts.SourceFile, rel: string): CallSite[] {
  const { locals, namespaces } = closeSinkBindings(sf);
  if (locals.size === 0 && namespaces.size === 0) return [];
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let sink: string | undefined;
      if (ts.isIdentifier(node.expression)) {
        sink = locals.get(node.expression.text);
      } else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && namespaces.has(node.expression.expression.text)
        && SINKS.has(node.expression.name.text)) {
        sink = node.expression.name.text;
      }
      if (sink) found.push({ key: `${rel}::${enclosingName(node)}::${sink}`, sink });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function allCallSites(): CallSite[] {
  return walk(SRC).flatMap((file) => {
    const sf = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    );
    return closeCallSitesIn(sf, relative(SRC, file).split('\\').join('/'));
  });
}

function probe(code: string): ts.SourceFile {
  return ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true);
}

describe('close consumer matrix (call-site)', () => {
  it('every close call site is classified', () => {
    const unclassified = [...new Set(
      allCallSites().map(c => c.key).filter(key => !(key in CONSUMERS)),
    )].sort();

    expect(
      unclassified,
      'Unclassified close call site(s). Add each key to CONSUMERS with a category:\n'
      + '  user_surface  — must render a refusal AND a residual (taskId)\n'
      + '  background    — no UI, so it must LOG both (prefer closeSessionForBackgroundCleanup)\n'
      + '  infrastructure — defines/serves the contract\n'
      + '  impossible_by_invariant — `why` must state how that is proven\n\n'
      + `${unclassified.join('\n')}`,
    ).toEqual([]);
  });

  it('has no stale entries', () => {
    const present = new Set(allCallSites().map(c => c.key));
    const stale = Object.keys(CONSUMERS).filter(key => !present.has(key));
    expect(stale, `No longer a call site: ${stale.join(', ')}`).toEqual([]);
  });

  // ── detector self-tests: without these the guard can be decorative ────────

  it('resolves an ALIASED import (defeated the file-level guard)', () => {
    const { locals } = closeSinkBindings(probe(
      "import { closeSession as bye } from './worker-pool.js';\n"
      + 'export async function p(id: string) { await bye(id); }\n',
    ));
    expect(locals.get('bye')).toBe('closeSession');
  });

  it('resolves a NAMESPACE import call', () => {
    const sites = closeCallSitesIn(probe(
      "import * as wp from './worker-pool.js';\n"
      + 'export async function p(id: string) { await wp.closeSession(id); }\n',
    ), 'probe.ts');
    expect(sites.map(s => s.key)).toEqual(['probe.ts::p::closeSession']);
  });

  it('resolves a destructured DYNAMIC import', () => {
    const { locals } = closeSinkBindings(probe(
      "export async function p(id: string) {\n"
      + "  const { closeSession } = await import('./worker-pool.js');\n"
      + '  await closeSession(id);\n}\n',
    ));
    expect(locals.get('closeSession')).toBe('closeSession');
  });

  it('does NOT count a call written in a comment or a string', () => {
    const sites = closeCallSitesIn(probe(
      "import { closeSession } from './worker-pool.js';\n"
      + '// closeSession(id) in a comment\n'
      + 'export const s = "closeSession(id)";\n',
    ), 'probe.ts');
    expect(sites).toEqual([]);
  });

  it('catches a NEW call added to an already-classified file', () => {
    // The mutation a file inventory cannot see: same file, extra call site in a
    // different function.
    const sites = closeCallSitesIn(probe(
      "import { closeSession } from './worker-pool.js';\n"
      + 'export async function known(id: string) { await closeSession(id); }\n'
      + 'export async function sneaky(id: string) { await closeSession(id); }\n',
    ), 'daemon.ts');
    expect(sites.map(s => s.key)).toContain('daemon.ts::sneaky::closeSession');
  });

  it('ignores the session-store close, which is a different sink', () => {
    const sites = closeCallSitesIn(probe(
      "import * as sessionStore from './session-store.js';\n"
      + 'export function p(id: string) { sessionStore.closeSession(id); }\n',
    ), 'probe.ts');
    expect(sites).toEqual([]);
  });
});
