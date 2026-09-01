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
  'closeCliMismatchedSessionsForBot',
  'runIdempotencyFailClose',
  'runWithdrawAutoClose',
]);
/** Only these modules' `closeSession` is the lifecycle one (not the store's). */
const SINK_MODULE_RE = /worker-pool\.js$|session-manager\.js$|daemon-background-close\.js$/;

interface CallSite { key: string; sink: string }

/** How many calls a key is allowed to cover, so a NEW call in the SAME function
 *  still fails. `file::function::sink` alone collapses them into one key. */
interface Rule { category: Category; why: string; count?: number }

/** The matrix, keyed per CALL SITE. */
const CONSUMERS: Record<string, Rule> = {
  'core/worker-pool.ts::closeSessionForBackgroundCleanup::closeSession': {
    category: 'infrastructure',
    why: 'The background wrapper delegating to the definition it wraps.',
  },
  'core/worker-pool.ts::transferSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Closes ONLY daemon-command scratch placeholders at the target anchor: the '
      + 'guard immediately above rejects anything with lastCliInput/queued (a real '
      + 'session), and a scratch has no CLI session, hence no remote lineage.',
    count: 2,
  },
  'core/worker-pool.ts::forkSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Rolls back a just-created fork CHILD whose worker never started (slot lost '
      + 'before registration, or spawn threw). No turn ran, so no remote session '
      + 'was ever created for it.',
    count: 3,
  },
  // ── user surfaces: must render refusal AND residual ──────────────────────
  'core/command-handler.ts::handleCommand::closeSession': {
    category: 'user_surface',
    why: '/close plus shared-adopt /detach and /disconnect all branch on '
      + 'refused/residual results; none report an ordinary close/disconnect while '
      + 'cleanup is unproven.',
    count: 4,
  },
  'core/command-handler.ts::commitRepoSelection::closeSession': {
    category: 'user_surface',
    why: 'Text /repo: a refusal or residual aborts the switch and names the id.',
  },
  'im/lark/card-handler.ts::handleCardAction::closeSession': {
    category: 'user_surface',
    why: 'Close/disconnect cards branch on refusal/residual, including stale '
      + 'shared-adopt close cards; they never report disconnect success while '
      + 'cleanup is unproven.',
    count: 3,
  },
  'im/lark/card-handler.ts::commitRepoSelection::closeSession': {
    category: 'user_surface',
    why: 'Card repo switch: aborts rather than spawning over an uncancelled remote.',
  },
  'core/dashboard-ipc-server.ts::<module>::closeCliMismatchedSessionsForBot': {
    category: 'user_surface',
    why: 'Agent-switch route: the sweep returns { closed, residual, failed } and the '
      + 'route forwards all three to the dashboard, so a remote session that survived '
      + 'its close is reported rather than flattened into "closed N".',
    count: 1,
  },
  'core/dashboard-ipc-server.ts::<module>::closeSession': {
    category: 'user_surface',
    why: 'Close/prune routes serialise the whole result; the closed-row fast path '
      + 'replays the residual; goal cleanup returns closed/residual/failed counts '
      + 'and its card fanout renders incomplete cleanup to the operator.',
    count: 5,
  },

  // ── background: no UI, so refusal/residual must be logged ────────────────
  'core/session-manager.ts::closeActiveSessionIfCliMismatch::closeSession': {
    category: 'background',
    why: 'Returns close_failed / closed_with_residual to the sweep; a refusal is '
      + 'never reported as closed.',
  },
  'core/session-manager.ts::restoreActiveSessions::closeSession': {
    category: 'background',
    why: 'Restore CLI-mismatch and durable prepared-Mojo recovery: a refusal '
      + 'quarantines the row instead of leaving it active-but-unregistered.',
    count: 2,
  },
  'core/session-manager.ts::resumeSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Closes only a worker:null daemon-command scratch placeholder occupying '
      + 'the anchor (isRelayableRealSession is excluded), which has no CLI session '
      + 'and therefore no remote lineage to leave behind.',
    count: 3,
  },
  'core/session-manager.ts::spawnDashboardSession::closeSession': {
    category: 'impossible_by_invariant',
    why: 'Same scratch-placeholder eviction as resumeSession: no remote lineage.',
  },
  'core/session-manager.ts::executeScheduledTask::closeSession': {
    category: 'background',
    why: 'Scheduled-run teardown; a refusal leaves the row active and is logged by '
      + 'closeSession itself. No user surface at schedule time.',
    count: 2,
  },
  'core/session-manager.ts::suspendActiveSessionsForBot::closeSession': {
    category: 'background',
    why: 'Bot-wide suspend sweep; a refusal keeps the row active and logged.',
  },
  'core/trigger-session.ts::reconcileIdempotencyLeasesOnBoot::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Boot reconcile: wrapper logs refusal and residual with the remote id.',
    count: 7,
  },
  'core/trigger-session.ts::reuseExistingWinner::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Loser cleanup on an idempotency race; wrapper logs both.',
  },
  'core/trigger-session.ts::triggerSessionTurnAdmitted::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Admission failure cleanup; wrapper logs both.',
    count: 4,
  },
  'daemon.ts::closeSession::closeSessionForBackgroundCleanup': {
    category: 'background',
    why: 'Deferred-schedule settlement injection: settlement returns close_refused '
      + 'rather than closed.',
  },
  'daemon.ts::failCloseIdempotentTurnIfConvergenceWriteFailed::runIdempotencyFailClose': {
    category: 'background',
    why: 'Typed consumer: refusal never claims fail-closed, residual uses the '
      + 'background wrapper, and throw is logged as unproven.',
  },
  'daemon.ts::closeSession::runWithdrawAutoClose': {
    category: 'background',
    why: 'Typed consumer: refusal returns false, residual is locally closed and '
      + 'reported by the wrapper, and throw is logged as unproven before returning false.',
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
export function closeSinkBindings(sf: ts.SourceFile, rel = ''): {
  locals: Map<string, string>;
  namespaces: Set<string>;
} {
  const locals = new Map<string, string>();
  const namespaces = new Set<string>();
  // worker-pool DEFINES the sinks, so its own consumers are same-module
  // references with no import to resolve. Treat the bare names as sinks there;
  // the declarations themselves are filtered out at the call-site walk.
  if (/worker-pool\.ts$/.test(rel)) for (const name of SINKS) locals.set(name, name);
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
  const { locals, namespaces } = closeSinkBindings(sf, rel);
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

let cachedCallSites: CallSite[] | undefined;

function allCallSites(): CallSite[] {
  if (cachedCallSites) return cachedCallSites;
  cachedCallSites = walk(SRC).flatMap((file) => {
    const sf = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    );
    return closeCallSitesIn(sf, relative(SRC, file).split('\\').join('/'));
  });
  return cachedCallSites;
}


/**
 * Second matrix: RESPONSE sites.
 *
 * The lifecycle matrix above only sees calls to the four sink functions. Every
 * consumer on the far side of the close ROUTE is invisible to it — the CLI, the
 * web dashboard, the Lark session card, the dashboard proxy — and those are
 * exactly the ones that kept flattening a residual into a plain success. An
 * earlier revision of this guard dropped them entirely when it moved to the AST,
 * so a new fetch to /close reading only `body.ok` stayed green.
 */
interface ResponseSite { key: string; parses: boolean }
interface ResponseRule { why: string; mustParse: boolean; count?: number }

const RESPONSE_CONSUMERS: Record<string, ResponseRule> = {
  'cli.ts::abandonSessionAuthoritatively::close-route': {
    why: 'botmux delete + interactive picker: per-row warning and a residual count.',
    mustParse: true,
  },
  'dashboard.ts::closeSessionsMatching::close-route': {
    why: 'Proxies idle-cleanup and group-cascade closes; forwards residual.',
    mustParse: true,
  },
  'dashboard.ts::<module>::close-route': {
    why: 'Idle cleanup close callback forwards residual separately from failures.',
    mustParse: true,
  },
  'dashboard/web/sessions-page.tsx::SessionsPage::close-route': {
    why: 'Web single + bulk close: residual alert, counted apart from failures.',
    mustParse: true,
  },
  'dashboard/web/sessions-page.tsx::worker::close-route': {
    why: 'Web bulk-close worker counts residual separately from failures.',
    mustParse: true,
  },
  'im/lark/sessions-card.ts::handleSessionsCardAction::close-route': {
    why: 'Sessions board card: residual banner on the closed detail card.',
    mustParse: true,
  },
  'core/dashboard-ipc-server.ts::<module>::close-route': {
    why: 'Serves the route; replays the residual on the closed-row fast path.',
    mustParse: false,
  },
};

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** True only for the immediate call that carries the close route. */
function isCloseRouteCall(node: ts.CallExpression, sf: ts.SourceFile): boolean {
  const callee = expressionName(node.expression);
  if (callee === 'postSessionCliIpc') {
    return node.arguments.some(arg => ts.isStringLiteralLike(arg) && arg.text === 'close');
  }
  const routeTexts: string[] = [];
  for (const arg of node.arguments) {
    if (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg)) {
      routeTexts.push(arg.getText(sf));
      continue;
    }
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
        ? prop.name.text
        : undefined;
      if (name === 'path') routeTexts.push(prop.initializer.getText(sf));
    }
  }
  return routeTexts.some(text => /\/sessions\/[\s\S]*\/close/.test(text));
}

/** AST response sites, paired with a parser call in the same owning function. */
export function responseCloseSitesIn(sf: ts.SourceFile, rel: string): ResponseSite[] {
  const parserOwners = new Set<string>();
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = expressionName(node.expression);
      if (callee === 'parseCloseResidual' || callee === 'hasCloseResidual') {
        parserOwners.add(enclosingName(node));
      }
      if (isCloseRouteCall(node, sf)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls.map(node => {
    const owner = enclosingName(node);
    return {
      key: `${rel}::${owner}::close-route`,
      parses: parserOwners.has(owner),
    };
  });
}

let cachedResponseSites: ResponseSite[] | undefined;

function responseSites(): ResponseSite[] {
  if (cachedResponseSites) return cachedResponseSites;
  cachedResponseSites = walk(SRC).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return responseCloseSitesIn(sf, relative(SRC, file).split('\\').join('/'));
  });
  return cachedResponseSites;
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

  it('every classified key covers the exact number of calls it declares', () => {
    // Without this, adding a second (or eighth) call inside an already-listed
    // function produces no new key and the guard stays green — the mutation that
    // defeated the previous revision.
    const counts = new Map<string, number>();
    for (const site of allCallSites()) counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
    const drifted = [...counts.entries()]
      .filter(([key, n]) => key in CONSUMERS && (CONSUMERS[key]!.count ?? 1) !== n)
      .map(([key, n]) => `${key} — declares ${CONSUMERS[key]!.count ?? 1}, found ${n}`);
    expect(
      drifted,
      'Call count changed. Each added call must be reviewed for how it consumes a '
      + `refusal/residual, then the declared count updated:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });

  it('every close-route response site is classified', () => {
    const unlisted = responseSites()
      .map(r => r.key)
      .filter(key => !(key in RESPONSE_CONSUMERS))
      .sort();
    expect(
      unlisted,
      'A new consumer of the close ROUTE. It must decode with parseCloseResidual '
      + 'and surface the residual, then be listed in RESPONSE_CONSUMERS:\n'
      + `${unlisted.join('\n')}`,
    ).toEqual([]);
  });

  it('every listed response consumer is still detected', () => {
    // Without this, an entry whose detection silently stops matching (the CLI
    // reaches the route through postSessionCliIpc, not a literal /close path)
    // keeps its mustParse obligation unenforced while the suite stays green.
    const detected = new Set(responseSites().map(r => r.key));
    const undetected = Object.keys(RESPONSE_CONSUMERS).filter(key => !detected.has(key));
    expect(
      undetected,
      `Listed but no longer detected — detection is broken for: ${undetected.join(', ')}`,
    ).toEqual([]);
  });

  it('every response key covers the exact number of close-route calls it declares', () => {
    const counts = new Map<string, number>();
    for (const site of responseSites()) counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
    const drifted = [...counts.entries()]
      .filter(([key, n]) => key in RESPONSE_CONSUMERS
        && (RESPONSE_CONSUMERS[key]!.count ?? 1) !== n)
      .map(([key, n]) => `${key} — declares ${RESPONSE_CONSUMERS[key]!.count ?? 1}, found ${n}`);
    expect(
      drifted,
      'Close-route call count changed. Every new fetch/IPC call must parse and '
      + `surface residual before its count is accepted:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });

  it('response sites required to parse actually CALL the shared parser', () => {
    // Import-presence is not enough: an unused import plus ad-hoc body.outcome
    // reading passed the previous string-based check.
    const offenders = responseSites()
      .filter(r => RESPONSE_CONSUMERS[r.key]?.mustParse && !r.parses)
      .map(r => r.key);
    expect(
      offenders,
      `Must call parseCloseResidual(...) on the close response: ${offenders.join(', ')}`,
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

  it('counts a second close-route call inside an already-classified function', () => {
    const sites = responseCloseSitesIn(probe(
      "import { parseCloseResidual } from './close-residual.js';\n"
      + 'export async function p(id: string) {\n'
      + "  const a = await fetch(`/api/sessions/${id}/close`, { method: 'POST' });\n"
      + '  parseCloseResidual(await a.json());\n'
      + "  const b = await fetch(`/api/sessions/${id}/close`, { method: 'POST' });\n"
      + '  return b.ok;\n}\n',
    ), 'probe.ts');
    expect(sites).toEqual([
      { key: 'probe.ts::p::close-route', parses: true },
      { key: 'probe.ts::p::close-route', parses: true },
    ]);
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
