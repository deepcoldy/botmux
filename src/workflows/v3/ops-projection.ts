/**
 * v3 dashboard projection: a run dir (journal.ndjson + dag.json) → a read-only
 * `RunView` the dashboard renders as a DAG graph with per-node live/replay
 * terminals.
 *
 * Mirrors `src/workflows/ops-projection.ts` (the v0.2 read-only projection):
 * runId allowlist + path-inside-dir defense before touching the filesystem,
 * and defensive reads (missing/partial files degrade gracefully, never throw)
 * so a half-written run still renders.
 *
 * Node status comes from `materialize(journal)` (the canonical fold); live
 * terminal info comes from the `nodeSessionReady` event (written mid-run, kept
 * even if the node later fails); edges/goal come from the persisted dag.json.
 */
import { readFileSync, existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { readJournal } from './journal.js';
import { materialize, type V3RunStatus } from './state.js';
import type { V3NodeStatus } from './orchestrator.js';
import {
  foldV3Revisions,
  tryLoadEffectiveV3Dag,
  v3RevisionDigest,
  v3RevisionFilePaths,
  type V3RevisionHistory,
} from './dag-revision.js';
import { foldV3NodeInterventions } from './interventions.js';
import { v3CheckpointMarkedSince, v3CheckpointSuccesses } from './checkpoint-hold.js';
import { loadDag } from './dag-loader.js';

/** Same allowlist shape as v0.2 ops-projection — validate BEFORE path-joining a
 *  caller-supplied runId, so it can't escape runsDir via traversal. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

/** Allowlist for the gate/wait id (`<instanceId|nodeId>-gate`, e.g. `A#001-gate`).
 *  Same defense as {@link isValidRunId}: a card callback's `waitId` is joined into
 *  `runDir/waits/<waitId>.json`, so it must be validated BEFORE the join or a
 *  `../..` waitId escapes the run dir. Includes `#` for instance-scoped ids; the
 *  nonce check alone is NOT sufficient (it is non-secret and reproducible). */
const WAIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._#-]{0,127}$/;
export function isValidWaitId(waitId: string): boolean {
  return WAIT_ID_RE.test(waitId);
}

/** Default run root, aligned with cli-run.ts / grill-state.ts. */
export function defaultRunsDir(): string {
  return join(homedir(), '.botmux', 'v3-runs');
}

export interface WebTerminalView {
  sessionId: string;
  webPort?: number;
  // NO `token` — the dashboard view is READ-ONLY; the write token is never
  // exposed through the read API (codex security review 2026-06-02).  A live
  // view connects read-only to `http://<host>:<webPort>/`.
  /** `live` while the node's work worker is in flight; `closed` once the node
   *  reached a terminal verdict (then replay via the pty-log endpoint). */
  status: 'live' | 'closed';
}

export interface RunNodeView {
  id: string;
  status: V3NodeStatus;
  /** Upstream node ids (graph edges) — from the persisted dag.json. */
  depends: string[];
  goal?: string;
  attemptId?: string;
  /** Present once the node's worker reported `nodeSessionReady`. */
  webTerminal?: WebTerminalView;
  /** Whether a raw PTY log exists for replay.  The absolute path is NOT exposed
   *  to the frontend (codex review) — a replay endpoint locates it server-side
   *  via `ptyLogPathFor(runsDir, runId, nodeId)`. */
  hasPtyLog: boolean;
  /** Whether the node produced a manifest (i.e. succeeded with a recorded
   *  manifest).  The raw fs path is NOT exposed — same rationale as `hasPtyLog`:
   *  `GET /api/v3/runs/:id` is link-shareable public-read, so a public reader
   *  must never see absolute `/root/.botmux/...` paths (codex security review
   *  2026-06-02).  A download, if ever needed, goes through a cookie-auth
   *  endpoint that locates the file server-side via runId/nodeId. */
  hasManifest: boolean;
  /** For blocked/failed nodes: the coarse error class + the node's
   *  self-reported `manifest.error.code` (e.g. AUTH_REQUIRED).  The free-text
   *  `message` is deliberately NOT projected — it can quote validator problems
   *  containing absolute paths, and this view is link-shareable public-read. */
  errorClass?: string;
  errorCode?: string;
  /** True for composite loop nodes (from dag.json). */
  isLoop?: boolean;
  /** Composite loop progress (loop nodes only, once started).  `lastDecision`
   *  is the coarse enum; the free-text decision `detail` is deliberately NOT
   *  projected (it can quote agent-written result strings) — same public-read
   *  rationale as `message`. */
  loopState?: {
    iteration: number;
    maxIterations?: number;
    granted: number;
    lastDecision?: 'exit' | 'continue' | 'exhausted';
    /** Per-iteration verdict history (enum ONLY — same no-detail rationale).
     *  Lets the dashboard draw an honest round timeline instead of guessing
     *  past verdicts from `lastDecision`. */
    decisions: Array<{ iteration: number; decision: 'exit' | 'continue' | 'exhausted' }>;
    /** Body template shape (authored ids + body-internal depends) — the
     *  dashboard lays every round's mini-dag on this skeleton, so a round
     *  whose later nodes have not dispatched yet still shows its full shape
     *  (undispatched slots render as pending ghosts). */
    bodyTemplate: Array<{ id: string; depends: string[] }>;
  };
  /** For loop BODY INSTANCE nodes (`repairLoop.i001.code`): the structured
   *  membership ref from the dispatch event.  The id stays opaque — group by
   *  THIS, never parse the id string. */
  loop?: { loopId: string; iteration: number; bodyNodeId: string };
  /** Who executes this node. Goal / loop-body nodes resolve through the run's
   *  frozen `bots.snapshot.json` (selector → snapshot); only display-safe
   *  identity fields are projected — never workingDir, sandbox, env, or
   *  wrapper settings. Absent for host nodes and loop containers. */
  bot?: RunNodeBotView;
  /** Host nodes only: the trusted executor that performs the side effect. */
  host?: { executor: string };
  /** Epoch ms when the CURRENT attempt was dispatched (journal `ts`). */
  startedAt?: number;
  /** Epoch ms when the node reached its current terminal-ish state (done /
   *  failed / blocked / cancelled / skipped / superseded). Absent while the
   *  node is pending, waiting on a gate, or running. */
  endedAt?: number;
  /** Epoch ms when the currently pending human gate was dispatched. */
  gateSince?: number;
  /** Every work attempt of this node (all instances), oldest first. Enum and
   *  timestamps only — the free-text failure message is never projected. */
  attempts: RunAttemptView[];
  /** Runtime flow revisions (design §13.7): `added` / `changed` relative to
   *  the approved flow. Absent for an unchanged node or a never-edited run. */
  revisionMark?: 'added' | 'changed';
  /** What the pending (unconfirmed) proposal would do to this node. The
   *  dashboard draws these dashed. `add` nodes exist only in the proposal. */
  pendingChange?: 'add' | 'remove' | 'change';
  /** The main bot's automatic retries / reassignments / re-runs of this node
   *  and every hand-over to a human, oldest first (design §13.6). Roles and
   *  the reasons as given only — never an open_id. Absent when none. */
  interventions?: RunNodeInterventionView[];
  /** A completed checkpoint node of a bot-executed run (design §13.6):
   *  `holding` — its dependants wait for the main bot; `reviewed` — the main
   *  bot's turn ended and they went on; `notReviewed` — they went on without
   *  that review (the wake could not be delivered, or the wait timed out). */
  checkpoint?: 'holding' | 'reviewed' | 'notReviewed';
  /** Checkpoint nodes this not-yet-started node waits behind. */
  waitingOnCheckpoint?: string[];
}

export interface RunNodeInterventionView {
  kind: 'retry' | 'reassign' | 'rerun' | 'handedToHuman';
  by: 'mainBot' | 'initiator' | 'other';
  reason: string;
  at: number;
  attemptId?: string;
}

export interface RunRevisionEntryView {
  revision: number;
  state: 'applied' | 'pending' | 'rejected';
  /** Generated count summary only (the free-text note is not projected). */
  summary: string;
  /** Who made it, as a role (open_ids are not projected). */
  by: 'mainBot' | 'initiator' | 'other';
  at: number;
  /** Went through the initiator's confirmation card. */
  confirmed: boolean;
  rejectedReason?: 'rejected' | 'stale' | 'superseded' | 'runEnded';
  /** `by: 'mainBot'` only: why the main bot made it (design §13.6). */
  reason?: string;
}

export interface RunRevisionView {
  /** Effective revision (1 = the approved flow). */
  current: number;
  history: RunRevisionEntryView[];
  pending?: { revision: number; summary: string };
  /** A revision file failed its digest check: the graph shows the last
   *  verifiable flow and the runtime fails closed. */
  integrityError?: boolean;
}

export interface RunNodeBotView {
  /** The DAG selector as authored (`larkAppId` or bot name); absent = run default. */
  selector?: string;
  larkAppId?: string;
  /** Live / persisted Feishu display name, when the host can resolve it. */
  name?: string;
  cliId?: string;
  model?: string;
}

export type RunAttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'interrupted'
  | 'superseded';

export interface RunAttemptView {
  attemptId: string;
  instanceId?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: RunAttemptOutcome;
  errorCode?: string;
}

export interface RunView {
  runId: string;
  runStatus: V3RunStatus;
  failedNodeId?: string;
  blockedNodeId?: string;
  nodes: RunNodeView[];
  /** Present once the run's flow was edited or an edit was proposed. */
  revision?: RunRevisionView;
  /** Server clock (epoch ms) when this view was projected. Clients compute
   *  live elapsed time against this instead of their own clock, so a skewed
   *  browser clock can't show negative or inflated durations. */
  generatedAt: number;
}

export interface ProjectRunOptions {
  /** Resolve a Feishu display name for a bot app id (live registry first,
   *  persisted bots-info second). Optional: names are cosmetic. */
  botName?: (larkAppId: string) => string | undefined;
  /** Injectable clock for `generatedAt`. */
  now?: () => number;
}

interface DagNodeLite {
  id: string;
  /** Canonical JSON of the authored node — compares revisions. */
  signature: string;
  depends: string[];
  goal?: string;
  isLoop?: boolean;
  /** Host nodes only. */
  executor?: string;
  /** Authored bot selector (goal / loop nodes). */
  bot?: string;
  maxIterations?: number;
  /** Loop nodes only: body template — body-INTERNAL depends + goal per body
   *  node id.  Used to give body instances their real intra-round edges (the
   *  dashboard draws each round as a mini-dag, not a flat chip row). */
  body?: Map<string, { depends: string[]; goal?: string; bot?: string }>;
}

/** Flatten a persisted depends entry to its source nodeId for display.
 *  runDirs persist the NORMALIZED dag (edge-activation design §1.1), so
 *  entries are `{ from, when? }` objects in new runs and plain strings in
 *  pre-edge-activation runDirs — the projection accepts both. */
function dependsToIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) => (typeof d === 'string' ? d : String((d as { from?: unknown } | null)?.from ?? '')))
    .filter((s) => s.length > 0);
}

function readDagNodes(runDir: string): DagNodeLite[] {
  return readDagNodesFrom(join(runDir, 'dag.json'));
}

/** Read a DAG file's nodes; with `expectedSha256` the exact bytes must match
 *  (revision files are pinned by the journal). Undefined on any mismatch. */
function readDagNodesFrom(p: string, expectedSha256?: string): DagNodeLite[] {
  if (!existsSync(p)) return [];
  try {
    const bytes = readFileSync(p);
    if (expectedSha256 !== undefined && v3RevisionDigest(bytes) !== expectedSha256) return [];
    const dag = JSON.parse(bytes.toString('utf-8')) as { nodes?: unknown };
    if (!dag || !Array.isArray(dag.nodes)) return [];
    return dag.nodes.map((raw): DagNodeLite => {
      const n = raw as {
        id?: unknown; depends?: unknown; goal?: unknown; type?: unknown; maxIterations?: unknown;
        body?: unknown; bot?: unknown; executor?: unknown;
      };
      let body: DagNodeLite['body'];
      const bodyNodes = (n.body as { nodes?: unknown } | undefined)?.nodes;
      if (n.type === 'loop' && Array.isArray(bodyNodes)) {
        body = new Map(
          bodyNodes.map((b) => {
            const bn = b as { id?: unknown; depends?: unknown; goal?: unknown; bot?: unknown };
            return [
              String(bn.id),
              {
                depends: dependsToIds(bn.depends),
                goal: typeof bn.goal === 'string' ? bn.goal : undefined,
                bot: typeof bn.bot === 'string' ? bn.bot : undefined,
              },
            ];
          }),
        );
      }
      return {
        id: String(n.id),
        signature: JSON.stringify(raw),
        depends: dependsToIds(n.depends),
        goal: typeof n.goal === 'string' ? n.goal : undefined,
        isLoop: n.type === 'loop' || undefined,
        executor: n.type === 'host' && typeof n.executor === 'string' ? n.executor : undefined,
        bot: typeof n.bot === 'string' ? n.bot : undefined,
        maxIterations: typeof n.maxIterations === 'number' ? n.maxIterations : undefined,
        body,
      };
    });
  } catch {
    return [];
  }
}

/** Display-safe slice of `bots.snapshot.json` (selector → snapshot). Only the
 *  identity fields the dashboard shows are kept; everything else in a frozen
 *  snapshot (workingDir, sandbox paths, env policy, wrapper) stays on disk. */
function readBotSnapshots(runDir: string): Map<string, Omit<RunNodeBotView, 'selector' | 'name'>> {
  const out = new Map<string, Omit<RunNodeBotView, 'selector' | 'name'>>();
  const p = join(runDir, 'bots.snapshot.json');
  if (!existsSync(p)) return out;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [selector, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const snap = value as { larkAppId?: unknown; cliId?: unknown; model?: unknown };
      out.set(selector, {
        ...(typeof snap.larkAppId === 'string' ? { larkAppId: snap.larkAppId } : {}),
        ...(typeof snap.cliId === 'string' ? { cliId: snap.cliId } : {}),
        ...(typeof snap.model === 'string' && snap.model ? { model: snap.model } : {}),
      });
    }
  } catch {
    /* defensive read — a half-written snapshot just loses the bot column */
  }
  return out;
}

/** Newest of the given journal stamps (undefined entries ignored). */
function latestStamp(stamps: Array<number | undefined>): number | undefined {
  return stamps.reduce<number | undefined>(
    (latest, ts) => (ts === undefined || (latest !== undefined && ts < latest) ? latest : ts),
    undefined,
  );
}

const TERMINAL_NODE_STATUSES = new Set<V3NodeStatus>([
  'done', 'failed', 'blocked', 'cancelled', 'skipped', 'superseded',
]);

/**
 * Project an already-resolved run dir into a `RunView`.  Read-only + defensive:
 * a missing journal / dag still yields a (possibly sparse) view rather than
 * throwing — the dashboard polls this while a run is mid-flight.
 */
export function projectRun(runId: string, runDir: string, opts: ProjectRunOptions = {}): RunView {
  const journalPath = join(runDir, 'journal.ndjson');
  // readJournal is fail-loud on mid-file corruption (hardening #11) for the
  // RUNTIME paths, but projectRun is the read-only dashboard projection and is
  // contractually defensive (see above): degrade to a sparse view instead of
  // throwing, so one corrupt journal can't 500 the whole runs list or its own
  // detail page. The runtime (decision-making) callers still get the throw.
  let events: ReturnType<typeof readJournal> = [];
  if (existsSync(journalPath)) {
    try {
      events = readJournal(journalPath);
    } catch {
      events = [];
    }
  }
  const snap = materialize(events);
  const approvedNodes = readDagNodes(runDir);
  const botSnapshots = readBotSnapshots(runDir);
  const revisions = projectRevisions(runDir, events, approvedNodes, botSnapshots);
  const interventions = foldV3NodeInterventions(events, readInitiatorOpenId(runDir));
  const checkpoints = projectCheckpoints(runDir, events);
  const dagNodes = revisions?.effectiveNodes ?? approvedNodes;

  const sessions = new Map<string, { sessionId: string; webPort?: number; ptyLogPath?: string }>();
  const manifests = new Map<string, string>();
  const errors = new Map<string, { errorClass: string; errorCode?: string }>();
  const loopRefs = new Map<string, { loopId: string; iteration: number; bodyNodeId: string }>();
  const loopDecisions = new Map<string, Array<{ iteration: number; decision: 'exit' | 'continue' | 'exhausted' }>>();
  // Timing: every attempt keyed by its globally-unique attemptId, plus the
  // node-level gate / skip timestamps. All values are journal `ts` stamps.
  const attemptsByNode = new Map<string, RunAttemptView[]>();
  const attemptById = new Map<string, RunAttemptView>();
  const pendingGateSince = new Map<string, number>();
  const skippedAt = new Map<string, number>();
  const cancelledAt = new Map<string, number>();
  const supersededAt = new Map<string, number>();
  // Node-level terminal stamps (any attempt). Loop containers have no attempt
  // of their own: they start at `loopStarted` and seal with a nodeSucceeded /
  // nodeFailed / nodeBlocked on the loop id.
  const terminalAt = new Map<string, number>();
  const loopStartedAt = new Map<string, number>();
  // Blocked states reached WITHOUT a nodeBlocked event on the node id:
  //  - loop `exhausted` decision blocks the LOOP container (materialize folds
  //    the decision; only runBlocked follows, no nodeBlocked on the loop id);
  //  - hostEffectUncertain blocks a host node directly.
  // Both still need a "blocked since" stamp for the waiting-time display.
  const blockedAt = new Map<string, number>();
  // waitId of the gate currently marking each node gateWaiting, so a stale
  // resolution for an old instance's wait (a revisit refreshes the gate under
  // a new waitId) cannot clear the NEW gate's pending timestamp. Mirrors
  // materialize's first-wins-per-waitId rule.
  const pendingGateWait = new Map<string, string>();
  // Instance ids materialize FROZEN as superseded: their late settle events are
  // ignored by the canonical fold, so they must not stamp the node either.
  const supersededInstances = new Set<string>();
  const endAttempt = (
    attemptId: string | undefined,
    ts: number,
    outcome: RunAttemptOutcome,
    errorCode?: string,
  ): void => {
    if (!attemptId) return;
    const attempt = attemptById.get(attemptId);
    if (!attempt || attempt.endedAt !== undefined) return;
    attempt.endedAt = ts;
    attempt.outcome = outcome;
    if (errorCode) attempt.errorCode = errorCode;
  };
  const beginAttempt = (
    nodeId: string,
    attemptId: string,
    ts: number,
    instanceId?: string,
  ): void => {
    if (attemptById.has(attemptId)) return;
    const attempt: RunAttemptView = {
      attemptId,
      ...(instanceId ? { instanceId } : {}),
      startedAt: ts,
    };
    attemptById.set(attemptId, attempt);
    (attemptsByNode.get(nodeId) ?? attemptsByNode.set(nodeId, []).get(nodeId)!).push(attempt);
  };
  for (const e of events) {
    if (e.type === 'nodeDispatched') {
      // Worker (goal) attempts start at dispatch.
      beginAttempt(e.nodeId, e.attemptId, e.ts, e.instanceId);
    } else if (e.type === 'hostEffectIntent') {
      // Host nodes never emit nodeDispatched: the approved effect INTENT is
      // where the provider call actually starts, so it opens the attempt row.
      beginAttempt(e.nodeId, e.attemptId, e.ts, e.instanceId);
    } else if (e.type === 'nodeSucceeded') {
      endAttempt(e.attemptId, e.ts, 'succeeded');
      if (!(e.instanceId && supersededInstances.has(e.instanceId))) terminalAt.set(e.nodeId, e.ts);
    } else if (e.type === 'nodeFailed') {
      endAttempt(e.attemptId, e.ts, 'failed', e.errorCode);
      if (!(e.instanceId && supersededInstances.has(e.instanceId))) terminalAt.set(e.nodeId, e.ts);
    } else if (e.type === 'nodeBlocked') {
      endAttempt(e.attemptId, e.ts, 'blocked', e.errorCode);
      if (!(e.instanceId && supersededInstances.has(e.instanceId))) terminalAt.set(e.nodeId, e.ts);
    } else if (e.type === 'nodeCancelled') {
      endAttempt(e.attemptId, e.ts, 'cancelled');
      cancelledAt.set(e.nodeId, e.ts);
    } else if (e.type === 'loopStarted') {
      if (!loopStartedAt.has(e.loopId)) loopStartedAt.set(e.loopId, e.ts);
    } else if (e.type === 'nodeAttemptDrained') {
      endAttempt(e.attemptId, e.ts, 'interrupted');
    } else if (e.type === 'nodeInstanceSuperseded') {
      supersededInstances.add(e.instanceId);
      for (const attempt of attemptsByNode.get(e.nodeId) ?? []) {
        if (attempt.instanceId === e.instanceId) endAttempt(attempt.attemptId, e.ts, 'superseded');
      }
      supersededAt.set(e.nodeId, e.ts);
    } else if (e.type === 'gateDispatched') {
      pendingGateSince.set(e.nodeId, e.ts);
      pendingGateWait.set(e.nodeId, e.waitId);
    } else if (e.type === 'gateResolved') {
      if (pendingGateWait.get(e.nodeId) === e.waitId) {
        pendingGateSince.delete(e.nodeId);
        pendingGateWait.delete(e.nodeId);
      }
    } else if (e.type === 'nodeSkipped') {
      skippedAt.set(e.nodeId, e.ts);
    } else if (e.type === 'hostEffectUncertain') {
      // Close the open host attempt as blocked (it never gets a nodeBlocked /
      // nodeSucceeded), and stamp the block time. Last uncertain wins: an
      // operator retry re-runs the node, and a later block measures from the
      // later event; a settled retry ignores this via the terminalAt-first
      // ordering in the end-stamp selection.
      endAttempt(e.attemptId, e.ts, 'blocked', e.errorCode);
      blockedAt.set(e.nodeId, e.ts);
    }
    if (e.type === 'nodeSessionReady') {
      sessions.set(e.nodeId, { ...e.sessionInfo, ptyLogPath: e.ptyLogPath });
    } else if (e.type === 'nodeSucceeded') {
      manifests.set(e.nodeId, e.manifestPath);
      errors.delete(e.nodeId); // a later successful attempt clears the error
    } else if (e.type === 'nodeFailed' || e.type === 'nodeBlocked') {
      errors.set(e.nodeId, { errorClass: e.errorClass, errorCode: e.errorCode });
    } else if (e.type === 'nodeDispatched' && e.loop) {
      loopRefs.set(e.nodeId, e.loop);
    } else if (e.type === 'loopIterationDecision') {
      // enum only — e.detail can quote agent-written strings, never project it.
      (loopDecisions.get(e.loopId) ?? loopDecisions.set(e.loopId, []).get(e.loopId)!)
        .push({ iteration: e.iteration, decision: e.decision });
      // Exhausted blocks the LOOP container with no nodeBlocked event on the
      // loop id, so stamp the block time here for the waiting display.
      if (e.decision === 'exhausted') blockedAt.set(e.loopId, e.ts);
    }
  }

  // Prefer the dag's node order (covers not-yet-dispatched nodes); fall back to
  // whatever the journal has seen if dag.json is missing.  Loop body INSTANCES
  // exist only in the journal (dag.json holds the body template) — append them
  // after the dag order, in first-dispatch order.
  const dagById = new Map(dagNodes.map((n) => [n.id, n]));
  const instanceIds = [...loopRefs.keys()].filter((id) => !dagById.has(id));
  const pendingAdded = (revisions?.pendingNodes ?? []).filter((node) => !dagById.has(node.id));
  for (const node of pendingAdded) dagById.set(node.id, node);
  const ids = dagNodes.length
    ? [...dagNodes.map((n) => n.id), ...pendingAdded.map((n) => n.id), ...instanceIds]
    : [...snap.nodes.keys()];

  // (loopId, iteration, bodyNodeId) → instance id, so an instance's template
  // depends map to its SAME-round sibling instances (structured refs only —
  // never derived by parsing the opaque instance id).
  const instByKey = new Map<string, string>();
  for (const [id, ref] of loopRefs) instByKey.set(`${ref.loopId} ${ref.iteration} ${ref.bodyNodeId}`, id);
  const instanceMeta = (id: string): { depends: string[]; goal?: string; bot?: string } | undefined => {
    const ref = loopRefs.get(id);
    if (!ref) return undefined;
    const loopNode = dagById.get(ref.loopId);
    const tpl = loopNode?.body?.get(ref.bodyNodeId);
    if (!tpl) return undefined;
    return {
      depends: tpl.depends
        .map((d) => instByKey.get(`${ref.loopId} ${ref.iteration} ${d}`))
        .filter((x): x is string => Boolean(x)),
      goal: tpl.goal,
      // Same inheritance the runtime freezes with (freezeDagBotSnapshots).
      bot: tpl.bot ?? loopNode?.bot,
    };
  };
  // Selector → display-safe bot view. A missing selector is the run's default
  // bot, keyed `''` in bots.snapshot.json exactly like the runtime. Without a
  // snapshot (manual / pre-envelope runs) fall back to the authored selector.
  const botView = (selector: string | undefined): RunNodeBotView | undefined => {
    const snapshot = botSnapshots.get(selector ?? '');
    if (!snapshot && selector === undefined) return undefined;
    const larkAppId = snapshot?.larkAppId;
    const name = larkAppId ? opts.botName?.(larkAppId) : undefined;
    return {
      ...(selector !== undefined ? { selector } : {}),
      ...snapshot,
      ...(name ? { name } : {}),
    };
  };

  const nodes: RunNodeView[] = ids.map((id) => {
    const status = (snap.nodes.get(id)?.status ?? 'pending') as V3NodeStatus;
    const sess = sessions.get(id);
    const inst = instanceMeta(id);
    const authored = dagById.get(id);
    const attempts = attemptsByNode.get(id) ?? [];
    const current = attempts[attempts.length - 1];
    const view: RunNodeView = {
      id,
      status,
      depends: inst?.depends ?? authored?.depends ?? [],
      goal: inst?.goal ?? authored?.goal,
      attemptId: snap.attempts.get(id),
      hasPtyLog: Boolean(sess?.ptyLogPath),
      hasManifest: manifests.has(id),
      attempts,
    };
    if (authored?.executor) {
      view.host = { executor: authored.executor };
    } else if (inst || (authored && !authored.isLoop)) {
      const bot = botView(inst ? inst.bot : authored?.bot);
      if (bot) view.bot = bot;
    }
    const startedAt = current?.startedAt ?? loopStartedAt.get(id);
    if (startedAt !== undefined && (status === 'running' || TERMINAL_NODE_STATUSES.has(status)) && status !== 'skipped') {
      view.startedAt = startedAt;
    }
    if (TERMINAL_NODE_STATUSES.has(status)) {
      // Latest known stamp, not a priority chain: a retry can settle the node
      // WITHOUT opening an attempt row (host input rejected before its intent),
      // so the node-level terminal stamp can be newer than the last attempt's end.
      const endedAt = latestStamp(
        status === 'skipped' ? [skippedAt.get(id)] : status === 'superseded'
          ? [supersededAt.get(id), current?.endedAt]
          : status === 'cancelled'
            ? [cancelledAt.get(id), current?.endedAt]
            : [terminalAt.get(id), current?.endedAt, blockedAt.get(id)],
      );
      if (endedAt !== undefined) view.endedAt = endedAt;
    }
    if (status === 'gateWaiting') {
      const since = pendingGateSince.get(id);
      if (since !== undefined) view.gateSince = since;
    }
    if (sess) {
      view.webTerminal = {
        sessionId: sess.sessionId,
        webPort: sess.webPort,
        status: status === 'running' ? 'live' : 'closed',
      };
    }
    const err = errors.get(id);
    if (err && (status === 'blocked' || status === 'failed')) {
      view.errorClass = err.errorClass;
      view.errorCode = err.errorCode;
    }
    const dagNode = dagById.get(id);
    if (dagNode?.isLoop) view.isLoop = true;
    const ls = snap.loops.get(id);
    if (ls) {
      view.isLoop = true;
      view.loopState = {
        iteration: ls.iteration,
        maxIterations: dagNode?.maxIterations,
        granted: ls.granted,
        lastDecision: ls.lastDecision,
        decisions: loopDecisions.get(id) ?? [],
        bodyTemplate: [...(dagNode?.body ?? new Map())].map(([bid, t]) => ({ id: bid, depends: t.depends })),
      };
    }
    const ref = loopRefs.get(id);
    if (ref) view.loop = ref;
    const mark = revisions?.marks.get(id);
    if (mark) view.revisionMark = mark;
    const pendingChange = revisions?.pendingChanges.get(id);
    if (pendingChange) view.pendingChange = pendingChange;
    const handled = interventions.get(id);
    if (handled?.length) view.interventions = handled.map((item) => ({ ...item }));
    const checkpoint = checkpoints?.states.get(id);
    if (checkpoint) view.checkpoint = checkpoint;
    const waitingOn = checkpoints?.waiting.get(id);
    if (waitingOn?.length && status === 'pending') view.waitingOnCheckpoint = waitingOn;
    return view;
  });

  return {
    runId,
    runStatus: snap.runStatus,
    failedNodeId: snap.failedNodeId,
    blockedNodeId: snap.blockedNodeId,
    nodes,
    ...(revisions ? { revision: revisions.view } : {}),
    generatedAt: (opts.now ?? Date.now)(),
  };
}

interface ProjectedRevisions {
  view: RunRevisionView;
  effectiveNodes?: DagNodeLite[];
  pendingNodes?: DagNodeLite[];
  marks: Map<string, 'added' | 'changed'>;
  pendingChanges: Map<string, 'add' | 'remove' | 'change'>;
}

/** Checkpoint holds of a bot-executed run (display only; degrades to none). */
function projectCheckpoints(
  runDir: string,
  events: ReturnType<typeof readJournal>,
): { states: Map<string, 'holding' | 'reviewed' | 'notReviewed'>; waiting: Map<string, string[]> } | undefined {
  if (!events.some((event) => event.type === 'runStarted' && event.nodeExecutor === 'bot')) return undefined;
  try {
    const authorized = loadDag(join(runDir, 'dag.json'));
    const effective = tryLoadEffectiveV3Dag(runDir, authorized, events)?.dag ?? authorized;
    const successes = v3CheckpointSuccesses({
      events,
      dag: effective,
      markedSince: v3CheckpointMarkedSince(runDir, authorized, events),
    });
    if (successes.length === 0) return undefined;
    const states = new Map<string, 'holding' | 'reviewed' | 'notReviewed'>();
    for (const success of successes) {
      states.set(success.nodeId, !success.released ? 'holding'
        : success.released.reason === 'wakeTurnEnded' ? 'reviewed' : 'notReviewed');
    }
    const holding = new Set(successes.filter((success) => !success.released).map((success) => success.nodeId));
    const waiting = new Map<string, string[]>();
    for (const node of effective.nodes) {
      const behind = node.depends.map((dep) => dep.from).filter((from) => holding.has(from));
      if (behind.length > 0) waiting.set(node.id, behind);
    }
    return { states, waiting };
  } catch {
    return undefined;
  }
}

/** Minimal read of run.json for the initiator role (no schema import: this
 *  projection stays defensive and dependency-light). */
function readInitiatorOpenId(runDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')) as {
      authorization?: { kind?: unknown; authorizedByOpenId?: unknown };
      chatBinding?: { ownerOpenId?: unknown };
    };
    const gate2 = raw.authorization?.kind === 'gate2' ? raw.authorization.authorizedByOpenId : undefined;
    const owner = raw.chatBinding?.ownerOpenId;
    return typeof gate2 === 'string' ? gate2 : typeof owner === 'string' ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** Effective flow + revision history for the graph. Defensive: a corrupt or
 *  tampered revision degrades to the last verifiable flow with a flag. */
function projectRevisions(
  runDir: string,
  events: ReturnType<typeof readJournal>,
  approvedNodes: DagNodeLite[],
  botSnapshots: Map<string, Omit<RunNodeBotView, 'selector' | 'name'>>,
): ProjectedRevisions | undefined {
  let history: V3RevisionHistory;
  try {
    history = foldV3Revisions(events);
  } catch {
    return { view: { current: 1, history: [], integrityError: true }, marks: new Map(), pendingChanges: new Map() };
  }
  if (history.records.length === 0) return undefined;
  const initiator = readInitiatorOpenId(runDir);
  const role = (record: { by: string }): RunRevisionEntryView['by'] =>
    record.by === 'main_bot' ? 'mainBot' : record.by === initiator ? 'initiator' : 'other';
  let integrityError = false;
  let effectiveNodes: DagNodeLite[] | undefined;
  let verifiedRevision = 1;
  for (const record of history.applied) {
    const nodes = readDagNodesFrom(v3RevisionFilePaths(runDir, record.revision).dag, record.sha256);
    if (nodes.length === 0) {
      integrityError = true;
      break;
    }
    effectiveNodes = nodes;
    verifiedRevision = record.revision;
    if (record.botsSha256) {
      try {
        const bytes = readFileSync(v3RevisionFilePaths(runDir, record.revision).bots);
        if (v3RevisionDigest(bytes) === record.botsSha256) {
          for (const [selector, value] of Object.entries(JSON.parse(bytes.toString('utf-8')) as Record<string, { larkAppId?: unknown; cliId?: unknown; model?: unknown }>)) {
            if (botSnapshots.has(selector)) continue;
            botSnapshots.set(selector, {
              ...(typeof value.larkAppId === 'string' ? { larkAppId: value.larkAppId } : {}),
              ...(typeof value.cliId === 'string' ? { cliId: value.cliId } : {}),
              ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
            });
          }
        }
      } catch { /* display only */ }
    }
  }
  const current = effectiveNodes ?? approvedNodes;
  const approvedById = new Map(approvedNodes.map((node) => [node.id, node]));
  const marks = new Map<string, 'added' | 'changed'>();
  if (effectiveNodes) {
    for (const node of effectiveNodes) {
      const approved = approvedById.get(node.id);
      if (!approved) marks.set(node.id, 'added');
      else if (approved.signature !== node.signature) marks.set(node.id, 'changed');
    }
  }
  const pendingChanges = new Map<string, 'add' | 'remove' | 'change'>();
  let pendingNodes: DagNodeLite[] | undefined;
  const pending = history.pending;
  if (pending) {
    const proposed = readDagNodesFrom(v3RevisionFilePaths(runDir, pending.revision).dag, pending.sha256);
    if (proposed.length > 0) {
      pendingNodes = proposed;
      const currentById = new Map(current.map((node) => [node.id, node]));
      const proposedIds = new Set(proposed.map((node) => node.id));
      for (const node of proposed) {
        const before = currentById.get(node.id);
        if (!before) pendingChanges.set(node.id, 'add');
        else if (before.signature !== node.signature) pendingChanges.set(node.id, 'change');
      }
      for (const node of current) if (!proposedIds.has(node.id)) pendingChanges.set(node.id, 'remove');
      for (const nodeId of pending.touched ?? []) if (!pendingChanges.has(nodeId)) pendingChanges.set(nodeId, 'change');
    }
  }
  return {
    view: {
      current: integrityError ? verifiedRevision : history.current,
      history: history.records.map((record) => ({
        revision: record.revision,
        state: record.state,
        summary: record.summary,
        by: role(record),
        at: record.appliedAt ?? record.ts,
        confirmed: !!record.approvedBy,
        ...(record.rejected ? { rejectedReason: record.rejected.reason } : {}),
        ...(record.by === 'main_bot' && record.auto?.reason ? { reason: record.auto.reason } : {}),
      })),
      ...(pending ? { pending: { revision: pending.revision, summary: pending.summary } } : {}),
      ...(integrityError ? { integrityError: true } : {}),
    },
    ...(effectiveNodes ? { effectiveNodes } : {}),
    ...(pendingNodes ? { pendingNodes } : {}),
    marks,
    pendingChanges,
  };
}

/**
 * Validate a caller-supplied `runId`, resolve it under `runsDir` (re-checking
 * the join stays inside runsDir — defense in depth), and project.  Returns
 * `undefined` for an invalid id / traversal attempt / missing run.
 */
export function projectRunById(
  runsDir: string,
  runId: string,
  opts: ProjectRunOptions = {},
): RunView | undefined {
  if (!isValidRunId(runId)) return undefined;
  const root = resolve(runsDir);
  const runDir = resolve(root, runId);
  if (runDir !== root && !runDir.startsWith(root + sep)) return undefined;
  if (!existsSync(runDir)) return undefined;
  return projectRun(runId, runDir, opts);
}

/**
 * Resolve a live ephemeral v3 worker for the central `/s/<sessionId>` proxy.
 * Journal + materialized state are the authority: only the current running
 * attempt with a persisted per-boot read capability can register a port.
 */
export function liveV3TerminalPortForSession(runsDir: string, sessionId: string): number | undefined {
  if (!sessionId || !existsSync(runsDir)) return undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const journalPath = join(runsDir, entry.name, 'journal.ndjson');
    if (!existsSync(journalPath)) continue;
    let events: ReturnType<typeof readJournal>;
    try {
      events = readJournal(journalPath);
    } catch {
      continue;
    }
    const snapshot = materialize(events);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event.type !== 'nodeSessionReady' ||
        event.sessionInfo.sessionId !== sessionId ||
        !event.sessionInfo.viewToken
      ) continue;
      const port = event.sessionInfo.webPort;
      if (!Number.isInteger(port) || (port ?? 0) <= 0 || (port ?? 0) > 65_535) continue;
      const nodeState = snapshot.nodes.get(event.nodeId);
      const effectiveInstanceMatches = event.instanceId
        ? nodeState?.effectiveInstanceId === event.instanceId
        : nodeState?.effectiveInstanceId === undefined;
      if (
        nodeState?.status === 'running' &&
        effectiveInstanceMatches &&
        snapshot.attempts.get(event.instanceId ?? event.nodeId) === event.attemptId
      ) return port;
    }
  }
  return undefined;
}

/**
 * Server-side resolver for a node's raw PTY log path (for the replay endpoint).
 * The absolute path is NEVER in the public RunView — callers locate it here by
 * runId/nodeId, and it's re-validated to be inside the run dir (defense in
 * depth) before any read.  Returns undefined for invalid id / traversal / no log.
 */
export function ptyLogPathFor(runsDir: string, runId: string, nodeId: string): string | undefined {
  if (!isValidRunId(runId)) return undefined;
  const root = resolve(runsDir);
  const runDir = resolve(root, runId);
  if (runDir !== root && !runDir.startsWith(root + sep)) return undefined;
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return undefined;

  // Read-only endpoint: a corrupt journal (readJournal fail-loud) degrades to
  // "no pty log" (→ 404) rather than a 500 (hardening #11 read-only carve-out).
  let events: ReturnType<typeof readJournal>;
  try {
    events = readJournal(journalPath);
  } catch {
    return undefined;
  }
  let recorded: string | undefined;
  for (const e of events) {
    if (e.type === 'nodeSessionReady' && e.nodeId === nodeId && e.ptyLogPath) recorded = e.ptyLogPath;
  }
  if (!recorded) return undefined;

  const abs = resolve(recorded);
  if (abs !== runDir && !abs.startsWith(runDir + sep)) return undefined;
  return existsSync(abs) ? abs : undefined;
}

export interface RunSummary {
  runId: string;
  runStatus: V3RunStatus;
  nodeCount: number;
}

/** List runs under `runsDir` (dirs that have a journal.ndjson), newest-first by
 *  name (runIds carry a `<slug>-<yymmdd-hhmm>` stamp so name sort ≈ time sort). */
export function listRuns(runsDir: string): RunSummary[] {
  if (!existsSync(runsDir)) return [];
  const out: RunSummary[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    if (!existsSync(join(runsDir, entry.name, 'journal.ndjson'))) continue;
    const view = projectRun(entry.name, join(runsDir, entry.name));
    out.push({ runId: view.runId, runStatus: view.runStatus, nodeCount: view.nodes.length });
  }
  return out.sort((a, b) => b.runId.localeCompare(a.runId));
}
