// Hybrid Codex input engine.
//
// Runs one `codex app-server --listen ws://127.0.0.1:<port>` per session (the
// shared engine) and speaks JSON-RPC to it. The session's tmux pane runs the
// real `codex --remote ws://... resume <threadId>` TUI, so rendering / web
// terminal / idle detection are unchanged. User input is delivered via
// `turn/start` (an acked RPC) instead of a tmux paste — bypassing the terminal
// entirely, which is where codex drops bracketed pastes during its startup /
// settings-churn terminal re-init (see codex-0144 investigation).
//
// Coordination (verified — raw-WS repro + real `codex --remote` TUI): the
// app-server BROADCASTS a thread's turn/item events to EVERY connection that has
// the thread open (engine `thread/start`/`resume` + TUI `resume`), and the real
// TUI renders events for a turn another connection issued. So the engine owns the
// thread (`thread/start`, then the first turn — an empty thread has no rollout so
// the TUI can't resume it, hence the first turn persists the rollout BEFORE the
// TUI attaches), the TUI `resume`s it, and every engine turn thereafter renders
// live in the TUI via that broadcast. On a botmux resume (daemon restart /
// re-fork), the engine `thread/resume`s the persisted thread id AND the pane is
// respawned as a fresh `--remote resume` against the CURRENT app-server (a new
// port each incarnation) — reattaching the prior pane would leave it pointed at
// the now-dead prior app-server (that lifecycle bug, not any non-broadcast, is
// what froze the Web terminal). See codex-rpc-lifecycle + worker engageCodexRpc.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';

type Json = Record<string, any>;
type LogFn = (msg: string) => void;

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill the whole process group (node wrapper + its native app-server child).
 *  The app-server is spawned `detached`, so its pid is the group leader. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

export interface CodexRpcEngineOpts {
  /** Absolute path to the codex-family CLI binary (codex / traex / …). */
  cliBin: string;
  /** Working directory / agent root for the session. */
  cwd: string;
  /** Child env (must carry CODEX_HOME + proxy vars + BOTMUX_SESSION_ID). */
  env: NodeJS.ProcessEnv;
  /** botmux session id — used to name the app-server orphan-cleanup marker so a
   *  new incarnation of this session can reap a prior app-server (P0 teardown). */
  sessionId?: string;
  log?: LogFn;
  /** Optional model + reasoning effort forwarded to thread config (P1). */
  model?: string;
  reasoningEffort?: string;
  /** Override the per-request JSON-RPC timeout (default REQUEST_TIMEOUT_MS).
   *  Mainly for tests that assert the wedged-app-server recovery path. */
  requestTimeoutMs?: number;
  /** Called once if the app-server dies unexpectedly (not via stop()). The
   *  worker uses it to kill the now-orphaned `codex --remote` pane so the normal
   *  exit→daemon-refork→resume path re-engages RPC on a fresh app-server (P1). */
  onDead?: () => void;
}

/** Server→client requests are auto-answered so codex never blocks on a human;
 *  botmux already runs codex with approvals bypassed. Mirrors codex-app-runner. */
function autoApproval(method: string): unknown {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null };
  if (method === 'item/tool/call') return { contentItems: [], success: false };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'approved_for_session' };
  // commandExecution / fileChange requestApproval + anything else: accept.
  return { decision: 'acceptForSession' };
}

const MARKER_DIR = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');

/** Per JSON-RPC request timeout. Without it, a connected-but-wedged app-server
 *  (never answers turn/start / initialize / thread/*) would leave the caller
 *  awaiting forever — flushPending would stick in isFlushing and silently drop
 *  every later message (P1-5). A rejected request unblocks the caller, which
 *  fails-closed (engage) or surfaces a resync (sendTurn). Generous because the
 *  FIRST turn on a cold app-server pays MCP/model-list startup latency. */
const REQUEST_TIMEOUT_MS = 60_000;

export class CodexRpcEngine {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private port = 0;
  private threadId?: string;
  private closed = false;
  private deadNotified = false;
  private lastStderr = '';
  private readonly log: LogFn;

  constructor(private readonly opts: CodexRpcEngineOpts) {
    this.log = opts.log ?? (() => {});
  }

  get wsUrl(): string { return `ws://127.0.0.1:${this.port}`; }
  get activeThreadId(): string | undefined { return this.threadId; }
  get appServerPid(): number | undefined { return this.child?.pid; }

  /** Spawn the app-server, connect, and complete the initialize handshake. */
  async start(): Promise<void> {
    this.reapStaleAppServer();
    this.port = await findFreePort();
    this.child = spawn(this.opts.cliBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Own process group so stop()/reap can kill the node wrapper AND its
      // native app-server child in one shot (killGroup → kill(-pid)).
      detached: true,
    });
    this.child.unref(); // don't let the app-server keep the worker's loop alive
    this.child.stderr?.on('data', (c: Buffer) => {
      this.lastStderr = (this.lastStderr + c.toString('utf8')).slice(-4000);
    });
    this.child.once('error', err => this.failAll(new Error(`codex app-server spawn failed: ${err.message}`)));
    this.child.once('exit', (code, signal) => {
      this.removeMarkerIfOwned(); // child confirmed dead → drop OUR marker only (ABA-safe)
      if (!this.closed) this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
    });
    this.writeMarker();
    await this.waitReady(15_000);
    await this.connect(8_000);
    await this.request('initialize', {
      clientInfo: { name: 'botmux', version: '0.0.0', title: 'botmux' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  /** Create a fresh session thread. Its id (== codex rollout session id) is what
   *  the TUI resumes and what botmux persists for future resume. */
  async startThread(): Promise<string> {
    const r = await this.request('thread/start', this.threadParams());
    this.threadId = String(r?.thread?.id ?? '');
    if (!this.threadId) throw new Error('thread/start returned no thread id');
    return this.threadId;
  }

  /** Resume the persisted thread after a botmux reconnect (P0 resume-survival),
   *  so RPC mode stays engaged across daemon restarts instead of reverting to
   *  the paste path. */
  async resumeThread(threadId: string): Promise<string> {
    const params: Json = { ...this.threadParams(), threadId, excludeTurns: true };
    delete params.serviceName; // resume keeps the original thread's identity
    const r = await this.request('thread/resume', params);
    this.threadId = String(r?.thread?.id ?? threadId);
    return this.threadId;
  }

  private threadParams(): Json {
    const config: Json = {
      // Forward the full env (incl. BOTMUX_SESSION_ID / BOTMUX_LARK_APP_ID) to
      // shell subprocesses so `botmux send` from within codex finds its bot.
      shell_environment_policy: { inherit: 'all', ignore_default_excludes: true },
    };
    if (this.opts.model) config.model = this.opts.model;
    if (this.opts.reasoningEffort) config.model_reasoning_effort = this.opts.reasoningEffort;
    return {
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'botmux',
      ephemeral: false,
      persistExtendedHistory: true,
      config,
    };
  }

  /** Inject one user message as a turn. Resolves when the app-server acks the
   *  turn start (fast); the turn itself streams to the attached TUI.
   *  `clientUserMessageId` (a stable botmux turn id) is forwarded so codex can
   *  CORRELATE the message — NOT relied on for dedupe (the 0.144.1 schema carries
   *  it but promises no idempotency). Correctness comes from the caller never
   *  auto-resending an accepted turn (P1-1).
   *  opts.fatalOnTimeout=false makes a timeout reject only THIS request instead of
   *  tearing the engine down — used for the fresh first turn, whose ambiguity is
   *  then resolved against rollout persistence (see sendFirstTurn). */
  async sendTurn(content: string, clientUserMessageId?: string, opts?: { timeoutMs?: number; fatalOnTimeout?: boolean }): Promise<void> {
    if (!this.threadId) throw new Error('sendTurn before startThread/resumeThread');
    const params: Json = {
      threadId: this.threadId,
      input: [{ type: 'text', text: content, text_elements: [] }],
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    await this.request('turn/start', params, opts);
  }

  /** 首条用户消息落盘后设置线程名；失败不得拖垮仍在执行的模型 turn。 */
  async setThreadName(name: string): Promise<void> {
    if (!this.threadId) throw new Error('setThreadName before startThread/resumeThread');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.request('thread/name/set', {
        threadId: this.threadId,
        name,
      }, { timeoutMs: 7000, fatalOnTimeout: false });
      if ((await this.readThreadMetadata(7000)).name === name) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Codex thread name did not persist after 3 attempts');
  }

  /** 等待 Codex 的首条消息预览落盘；超时后由调用方继续设置标题。 */
  async waitForThreadPreview(timeoutMs = 10_000): Promise<string | undefined> {
    if (!this.threadId) throw new Error('waitForThreadPreview before startThread/resumeThread');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const { preview } = await this.readThreadMetadata(Math.min(remaining, 2000));
      if (preview) return preview;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  /** 等待 resume 后首次 append 的元数据补丁落库；超时后由调用方继续做最终覆盖。 */
  async waitForThreadUpdatedAfter(baseline: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const { updatedAt } = await this.readThreadMetadata(Math.min(remaining, 2000));
      if (updatedAt !== undefined && updatedAt > baseline) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  async readThreadMetadata(timeoutMs = 7000): Promise<{ name?: string; preview?: string; updatedAt?: number }> {
    if (!this.threadId) throw new Error('readThreadMetadata before startThread/resumeThread');
    const result = await this.request('thread/read', {
      threadId: this.threadId,
      includeTurns: false,
    }, { timeoutMs, fatalOnTimeout: false });
    const name = typeof result?.thread?.name === 'string' ? result.thread.name.trim() : '';
    const preview = typeof result?.thread?.preview === 'string' ? result.thread.preview.trim() : '';
    const updatedAt = typeof result?.thread?.updatedAt === 'number' ? result.thread.updatedAt : undefined;
    return {
      ...(name ? { name } : {}),
      ...(preview ? { preview } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  /** Deliver the FRESH first turn and resolve its outcome as one of THREE states,
   *  prioritising exactly-once over never-lost (P1-1). An empty thread can't be
   *  resumed by the TUI, so the first turn must persist the rollout before the
   *  pane spawns — but a lost/late ack must NOT be blindly re-pasted (that would
   *  double-execute, the failure users care about most):
   *    - 'accepted'  — ack received, OR (ack lost) the rollout already contains
   *                    THIS turn's user message → engaged, never resend.
   *    - 'not-sent'  — the turn/start FRAME was never dispatched (ws not open /
   *                    send threw) → the turn cannot have run → safe paste once.
   *    - 'ambiguous' — the frame WAS dispatched but no ack AND no positive rollout
   *                    evidence (timeout / transport / server / unknown error) →
   *                    it may have executed → NEVER auto-paste; the caller notifies
   *                    the user and lets the viewer resume (recovers if it landed).
   *  Only "frame not dispatched" is treated as safe; every dispatched-then-failed
   *  case is ambiguous, and a timeout is non-fatal so the engine survives to serve
   *  the accepted/ambiguous cases. `rolloutProbe` is the ground-truth positive
   *  check (matches this turn's user_message in the persisted rollout). */
  async sendFirstTurn(content: string, clientUserMessageId: string | undefined, rolloutProbe: (threadId: string) => Promise<boolean>): Promise<'accepted' | 'not-sent' | 'ambiguous'> {
    const threadId = this.threadId;
    if (!threadId) throw new Error('sendFirstTurn before startThread');
    let dispatched = false;
    const params: Json = {
      threadId,
      input: [{ type: 'text', text: content, text_elements: [] }],
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    try {
      await this.request('turn/start', params, { timeoutMs: this.opts.requestTimeoutMs ?? 15_000, fatalOnTimeout: false }, () => { dispatched = true; });
      return 'accepted'; // ack received
    } catch (err) {
      if (!dispatched) {
        this.log(`[codex-rpc] first turn/start not dispatched (${(err as Error).message}); safe to paste`);
        return 'not-sent';
      }
      // Dispatched but no ack — the ONLY safe resolution is positive rollout
      // evidence; absence is NOT proof it didn't run (it may persist >window or be
      // queued server-side), so no-evidence stays ambiguous.
      this.log(`[codex-rpc] first turn ack lost after dispatch (${(err as Error).message}); checking rollout for positive evidence`);
      const landed = await rolloutProbe(threadId);
      return landed ? 'accepted' : 'ambiguous';
    }
  }

  stop(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already gone */ }
    const pid = this.child?.pid;
    if (pid) {
      // Bounded SIGTERM → SIGKILL: don't leave a stubborn child as an untracked
      // orphan. The marker is removed by the child 'exit' handler (confirmed
      // dead), NOT here — if the child ignores SIGTERM and this worker then dies,
      // the surviving marker lets the next incarnation reap it (P1-2).
      try { killGroup(pid, 'SIGTERM'); } catch { /* already gone */ }
      const t = setTimeout(() => { if (isAlive(pid)) { try { killGroup(pid, 'SIGKILL'); } catch { /* */ } } }, 2000);
      t.unref?.();
    } else {
      this.removeMarkerIfOwned();
    }
    this.failAll(new Error('engine stopped'));
  }

  // ---- app-server orphan marker (P0 teardown) ------------------------------

  private markerPath(): string | undefined {
    if (!this.opts.sessionId) return undefined;
    return join(MARKER_DIR, `${this.opts.sessionId}.pid`);
  }

  /** Verify a pid is actually OUR app-server before signalling it — the marker
   *  can outlive a SIGKILLed worker and its pid may be REUSED by an unrelated
   *  process (daemon runs as root → mis-kill would be severe). Match the process
   *  argv against `app-server` AND, when recorded, the exact `--listen <url>` a
   *  reused pid could not carry (P1-2). */
  private processIsOurAppServer(pid: number, markedUrl?: string): boolean {
    let argv = '';
    try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
    catch {
      try { argv = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { return false; }
    }
    if (!/\bapp-server\b/.test(argv)) return false;
    if (markedUrl && !argv.includes(markedUrl)) return false;
    return true;
  }

  /** Kill an app-server left behind by a prior incarnation of this session
   *  (e.g. the worker was SIGKILLed so its exit hooks never ran). Identity-checked
   *  so a reused pid is never mis-killed. */
  private reapStaleAppServer(): void {
    const mp = this.markerPath();
    if (!mp || !existsSync(mp)) return;
    try {
      const [pidStr, markedUrl] = readFileSync(mp, 'utf8').trim().split('\n');
      const pid = parseInt(pidStr, 10);
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid) && this.processIsOurAppServer(pid, markedUrl)) {
        killGroup(pid, 'SIGKILL'); // orphan from a crashed worker — no grace needed
        this.log(`[codex-rpc] reaped stale app-server pid ${pid}`);
      }
      rmSync(mp, { force: true });
    } catch { /* best effort */ }
  }

  private writeMarker(): void {
    const mp = this.markerPath();
    if (!mp || !this.child?.pid) return;
    // pid + the exact --listen url so a reused pid fails the identity check.
    try { mkdirSync(MARKER_DIR, { recursive: true }); writeFileSync(mp, `${this.child.pid}\n${this.wsUrl}`, { mode: 0o600 }); }
    catch { /* best effort */ }
  }

  /** Remove the marker ONLY if it still names THIS engine's app-server (pid +
   *  wsUrl). Prevents an ABA race: a same-session engine B may have already
   *  reaped + rewritten the marker with its own pid/url by the time this (old)
   *  engine's child exits late — an unconditional delete would orphan B's live
   *  app-server (no marker → next incarnation can't reap it). P1-2. */
  private removeMarkerIfOwned(): void {
    const mp = this.markerPath();
    if (!mp) return;
    try {
      const [pidStr, url] = readFileSync(mp, 'utf8').trim().split('\n');
      if (parseInt(pidStr, 10) === this.child?.pid && url === this.wsUrl) rmSync(mp, { force: true });
    } catch { /* no marker / unreadable → leave it (next reap handles it) */ }
  }

  // ---- internals -----------------------------------------------------------

  private waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = (): void => {
        if (this.closed) return reject(new Error('engine closed during startup'));
        const req = httpGet({ host: '127.0.0.1', port: this.port, path: '/readyz', timeout: 1500 }, res => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) return resolve();
          retry();
        });
        req.once('error', retry);
        req.once('timeout', () => { req.destroy(); retry(); });
      };
      const retry = (): void => {
        if (this.closed) return reject(new Error('engine closed during startup'));
        if (Date.now() > deadline) return reject(new Error(`app-server not ready in ${timeoutMs}ms${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
        setTimeout(attempt, 250);
      };
      attempt();
    });
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error('ws connect timeout')); }, timeoutMs);
      ws.on('open', () => { clearTimeout(timer); this.ws = ws; resolve(); });
      ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf8')));
      ws.on('error', (err: Error) => { clearTimeout(timer); if (!this.ws) reject(err); else this.failAll(err); });
      ws.on('close', () => { if (!this.closed) this.failAll(new Error('ws closed')); });
    });
  }

  private request(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; fatalOnTimeout?: boolean },
    onDispatch?: () => void,
  ): Promise<any> {
    const timeoutMs = opts?.timeoutMs ?? this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const fatalOnTimeout = opts?.fatalOnTimeout !== false; // default fatal
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const err = new Error(`codex app-server request '${method}' timed out after ${timeoutMs}ms`);
        if (fatalOnTimeout) {
          // A connected-but-wedged app-server is FATAL for live turns: rejecting
          // just this request would leave the engine + pane alive and every later
          // turn/start would time out again. Route through failAll so ALL inflight
          // requests reject AND onDead fires — the worker then replaces the pane
          // and re-engages on a fresh app-server (P1-5).
          this.failAll(err);
        } else {
          // Non-fatal (the fresh first turn): reject only THIS request and keep
          // the engine alive, so its ambiguity can be resolved against rollout
          // persistence and the viewer can still resume if the turn landed (P1-1).
          this.pending.delete(id); reject(err);
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // onDispatch fires ONLY after send() succeeds (ws was OPEN + no throw) — the
      // frame is then on the socket, so any later failure is "dispatched" and must
      // be treated as ambiguous, never not-sent (Codex P1-1 boundary).
      try { this.send({ jsonrpc: '2.0', id, method, params }); onDispatch?.(); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error); }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send(params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method });
  }

  private respond(id: number, result: unknown): void {
    try { this.send({ jsonrpc: '2.0', id, result }); } catch { /* connection gone */ }
  }

  private send(msg: Json): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('app-server ws not open');
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(line: string): void {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    // Response to one of our requests.
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server→client request (approvals / elicitations): auto-answer.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.respond(msg.id, autoApproval(msg.method));
      return;
    }
    // Notifications (turn/item/mcp events) are ignored here — the attached TUI
    // renders them; botmux reads the pane as usual.
  }

  private failAll(err: Error): void {
    if (this.pending.size) this.log(`[codex-rpc] ${err.message}`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    if (!this.closed && !this.deadNotified) {
      this.deadNotified = true;
      try { this.opts.onDead?.(); } catch { /* best effort */ }
    }
  }
}
