// Value imports keep the order src/dashboard.ts imported these modules in when
// it imported them directly (onboarding last). Module evaluation has no side
// effects here (./api.ts only constructs its configuration and manager objects,
// which touch nothing), so where they sit in the Dashboard's graph is not observable.
import { handleWecomSessionApi, mergeWecomSessionSnapshot, wecomSessionsResponse } from './session-api.js';
import { WecomTerminalFront } from './terminal.js';
import { NativeTerminalAccess, nativeTerminalOrigin } from './terminal-access.js';
import { WecomDashboardSessions, type WecomSessionRow } from './sessions.js';
import { handleWecomConnectionsApi, wecomConnectionCount, wecomConnectionsManager } from './api.js';
import { handleWecomOnboardingApi, WecomOnboardingManager, type OnboardingActor } from './onboarding.js';
import { WECOM_SESSIONS_HINT_EVENT, WecomSessionObserver, type WecomSessionRead } from './session-observer.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../../config.js';
import { publicReverseProxyBaseUrl } from '../../platform/binding.js';
import type { ControlAuditSink } from '../control-audit.js';
import type { TerminalDashboardActor } from '../terminal-control.js';

/**
 * WeCom's one seam in the Dashboard server. src/dashboard.ts imports only this
 * module, constructs it once, and calls each method at the point of its request
 * pipeline where the WeCom handling sits; who may reach a method (host admin,
 * control CSRF, legacy authentication) stays decided there. The connections
 * API keeps its module-level configuration and manager in ./api.ts.
 */
export interface WecomDashboardOptions {
  /** Dashboard secret: native terminal grants, wake proofs, gateway terminal mints. */
  secret: string;
  audit: ControlAuditSink;
  /** The Dashboard's request identity; only a `legacy-dashboard` actor reaches WeCom terminals. */
  resolveActor(req: IncomingMessage): (TerminalDashboardActor & { kind?: string }) | null;
  /** Whether a Dashboard auth session is still live. */
  isAuthSessionLive(authSessionId: string): boolean;
  /** The port the Dashboard is listening on (it may have probed past its configured one): native terminal links point at it. */
  dashboardPort(): number;
}

/** Inputs the session API takes from the Dashboard's auth layer. */
export interface WecomSessionApiAccess {
  hostAdmin: boolean;
  csrfValid(): boolean;
  readBody(): Promise<Record<string, unknown>>;
}

/** Inputs the onboarding job API takes from the Dashboard's auth layer. */
export interface WecomOnboardingApiAccess {
  actor?: OnboardingActor;
  hostAdmin: boolean;
  csrfValid: () => boolean;
}

/** Path namespace of WeCom onboarding jobs (`wecom-jobs`, `wecom-<uuid>`). */
const WECOM_ONBOARDING_PATH_PREFIX = '/api/bot-onboarding/wecom-';

export class WecomDashboard {
  private readonly sessions: WecomDashboardSessions;
  private readonly terminal: WecomTerminalFront;
  private readonly onboarding: WecomOnboardingManager;
  private readonly observer: WecomSessionObserver;

  constructor(options: WecomDashboardOptions) {
    const sessions = new WecomDashboardSessions();
    this.observer = new WecomSessionObserver({ collect: () => this.collectSessions() });
    const nativeAccess = new NativeTerminalAccess({
      secret: options.secret,
      resolve: request => sessions.nativeTerminal(request),
      origin: () => nativeTerminalOrigin({
        publicUrl: publicReverseProxyBaseUrl(),
        host: config.dashboard.externalHost,
        port: options.dashboardPort(),
      }),
    });
    this.sessions = sessions;
    this.terminal = new WecomTerminalFront({
      nativeAccess,
      sessions,
      secret: options.secret,
      audit: options.audit,
      resolveActor: options.resolveActor,
      isAuthSessionLive: options.isAuthSessionLive,
    });
    this.onboarding = new WecomOnboardingManager({
      isActorLive: actor => options.isAuthSessionLive(actor.authSessionId),
      // One manager for the list and the wizard: one action per connection at a time.
      manager: wecomConnectionsManager(),
    });
  }

  /** End every WeCom terminal lease held by a Dashboard auth session that ended. */
  releaseAuthSession(authSessionId: string): void {
    this.terminal.releaseByAuthSession(authSessionId);
  }

  /** `/wecom-terminal/*` and the gateway's `/__wecom/terminal-mint`. True when handled. */
  terminalHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    return this.terminal.http(req, res, url);
  }

  /** WebSocket upgrades under `/wecom-terminal/`. True when handled. */
  terminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    return this.terminal.upgrade(req, socket, head);
  }

  /** `/api/sessions/wecom:*`. True when handled. */
  handleSessionApi(req: IncomingMessage, res: ServerResponse, url: URL, access: WecomSessionApiAccess): Promise<boolean> {
    return handleWecomSessionApi(req, res, url, { ...access, sessions: this.sessions, terminal: this.terminal });
  }

  /** Whether `pathname` is in the WeCom onboarding job namespace. */
  isOnboardingPath(pathname: string): boolean {
    return pathname.startsWith(WECOM_ONBOARDING_PATH_PREFIX);
  }

  /** WeCom onboarding job routes. True when handled. */
  handleOnboardingApi(req: IncomingMessage, res: ServerResponse, url: URL, access: WecomOnboardingApiAccess): Promise<boolean> {
    return handleWecomOnboardingApi(req, res, url, { manager: this.onboarding, ...access });
  }

  /** `POST /api/bot-onboarding/start` with `platform: 'wecom'`. */
  startOnboarding(raw: Record<string, unknown>, actor: OnboardingActor) {
    return this.onboarding.start(raw, actor);
  }

  /** `/api/wecom/*`, including the session read a hint on `/events` asks for. */
  handleConnectionsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: Parameters<typeof handleWecomConnectionsApi>[3]): Promise<boolean> {
    return handleWecomConnectionsApi(req, res, url, { ...deps, sessions: () => this.readSessions() });
  }

  /**
   * Configured WeCom connections; reads no configuration and probes no gateway.
   * The board request computes this for every host admin anyway, so the count
   * is also handed to the session observer, which runs only while it is above zero.
   */
  connectionCount(): number {
    const count = wecomConnectionCount();
    this.observer.noteConnectionCount(count);
    return count;
  }

  /**
   * `/events`: while `hostAdmin` (the same test `/api/sessions` merges WeCom rows
   * under), `write(event)` is called each time the WeCom session rows change.
   * Any other stream subscribes to nothing. Returns the unsubscribe.
   */
  watchSessions(hostAdmin: boolean, write: (event: string) => void): () => void {
    if (!hostAdmin) {
      return () => {};
    }
    return this.observer.watch(() => write(WECOM_SESSIONS_HINT_EVENT));
  }

  /** The observer's latest read while it runs (the one its last hint was about), otherwise a fresh read. */
  private async readSessions() {
    return wecomSessionsResponse(this.observer.current() ?? await this.collectSessions());
  }

  private async collectSessions(): Promise<WecomSessionRead> {
    const connectionCount = wecomConnectionCount();
    if (connectionCount === 0) {
      return { sessions: [], complete: true, connectionCount };
    }
    return { ...(await this.sessions.snapshot()), connectionCount };
  }

  /** WeCom session rows for the session board, read from each verified core. */
  sessionSnapshot(): Promise<{ sessions: WecomSessionRow[]; complete: boolean }> {
    return this.sessions.snapshot();
  }

  /** Merge WeCom rows into the board's rows before sorting and pagination. */
  mergeSessionSnapshot<T extends { sessionId: string }>(legacy: T[], hostAdmin: boolean, privateSnapshot: { sessions: T[]; complete: boolean }) {
    return mergeWecomSessionSnapshot(legacy, hostAdmin, privateSnapshot);
  }

  /** Machine environment routes when this host has no Feishu fleet to ask. */
  machineEnvironment(path: string, init?: RequestInit): Promise<Response> {
    return this.sessions.machineEnvironment(path, init);
  }
}
