import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createTerminalFrontProxy } from '../terminal-front-proxy.js';
import { TerminalControlManager, type TerminalDashboardActor } from '../terminal-control.js';
import { resolveTerminalControlAction, type TerminalControlAction } from '../terminal-control-route.js';
import type { WecomDashboardSessions } from './sessions.js';
import type { ControlAuditSink } from '../control-audit.js';
import { matchXtermVendorPath } from '../../core/xterm-vendor-assets.js';
import type { NativeTerminalAccess, NativeTerminalBrowser } from './terminal-access.js';
import { signTerminalWakeProof } from '../../core/terminal-control-grant.js';
interface Entry {
  nativeSessionId: string;
  binding: string;
  port: number;
  control: TerminalControlManager;
  proxy: ReturnType<typeof createTerminalFrontProxy>;
  actors: Set<string>;
}
/** A separate lease namespace per source/core/worker birth. Native IDs never enter
 * the global Lark aggregator, and no raw worker port/capability reaches a browser. */
export class WecomTerminalFront {
  private readonly entries = new Map<string, Entry>();
  private readonly nativeActors = new WeakMap<IncomingMessage, NativeTerminalBrowser>();
  constructor(private readonly options: {
    sessions: Pick<WecomDashboardSessions, 'terminal'>;
    secret: string;
    audit: ControlAuditSink;
    resolveActor(req: IncomingMessage): (TerminalDashboardActor & { kind?: string }) | null;
    isAuthSessionLive(id: string): boolean;
    nativeAccess?: NativeTerminalAccess;
  }) {}
  private actor(req: IncomingMessage) {
    const native = this.nativeActors.get(req);
    if (native) {
      return native.actor;
    }
    const actor = this.options.resolveActor(req);
    return actor?.kind === 'legacy-dashboard' ? actor : null;
  }
  private revoke(entry: Entry) {
    for (const actor of entry.actors) {
      entry.control.releaseByAuthSession(actor);
    }
  }
  releaseByAuthSession(id: string) {
    for (const entry of this.entries.values()) {
      entry.control.releaseByAuthSession(id);
    }
  }
  private async resolve(id: string): Promise<Entry> {
    const target = await this.options.sessions.terminal(id);
    const previous = this.entries.get(id);
    if (previous?.binding === target.binding && previous.port === target.proxyPort) {
      return previous;
    }
    if (previous) {
      this.revoke(previous);
    }
    const actors = new Set<string>();
    const control = new TerminalControlManager({ secret: this.options.secret, audit: this.options.audit });
    const entry: Entry = {
      nativeSessionId: target.nativeSessionId,
      binding: target.binding,
      port: target.proxyPort,
      control,
      actors,
      proxy: createTerminalFrontProxy({
        resolvePort: sid => sid === target.nativeSessionId ? target.proxyPort : undefined,
        resolveActor: req => {
          const actor = this.actor(req);
          if (actor) {
            actors.add(actor.authSessionId);
          }
          return actor;
        },
        control,
        revalidateAuthSession: async (id) => id.startsWith('wecom-terminal:')
          ? this.options.nativeAccess?.live(id.slice('wecom-terminal:'.length)) ?? false
          : this.options.isAuthSessionLive(id),
        isAuthSessionLive: id => id.startsWith('wecom-terminal:')
          ? this.options.nativeAccess?.isLiveAuthSession(id) === true
          : this.options.isAuthSessionLive(id),
        wakeProof: sid => signTerminalWakeProof(this.options.secret, sid),
      }),
    };
    this.entries.set(id, entry);
    return entry;
  }
  async control(req: IncomingMessage, id: string, action: TerminalControlAction | undefined, search: URLSearchParams) {
    const actor = this.actor(req);
    if (!actor) {
      return { status: 403, body: { ok: false, error: 'wecom_host_admin_required' } };
    }
    const entry = await this.resolve(id);
    entry.actors.add(actor.authSessionId);
    return resolveTerminalControlAction({
      method: req.method ?? 'GET',
      sessionId: entry.nativeSessionId,
      action,
      search,
      identity: actor,
      control: entry.control,
    });
  }
  private match(url: URL) {
    const native = /^\/wecom-terminal\/native\/([A-Za-z0-9_-]{43})(\/.*)?$/.exec(url.pathname);
    if (native) {
      return { id: native[1], suffix: native[2] ?? '/', native: true };
    }
    const match = /^\/wecom-terminal\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) {
      return;
    }
    try {
      return { id: decodeURIComponent(match[1]), suffix: match[2] ?? '/', native: false };
    } catch {
      return;
    }
  }
  private watch(
    id: string,
    entry: Entry,
    socket: { destroy(): unknown; once(event: string, listener: () => void): unknown },
    browser?: NativeTerminalBrowser,
  ) {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void (async () => {
        if (browser && !await this.options.nativeAccess?.live(browser.id)) {
          entry.control.releaseByAuthSession(browser.actor.authSessionId);
          socket.destroy();
          return;
        }
        const current = await this.options.sessions.terminal(id);
        if (current.binding !== entry.binding) {
          socket.destroy();
        }
      })().catch(() => {
        if (browser) {
          entry.control.releaseByAuthSession(browser.actor.authSessionId);
        }
        socket.destroy();
      }).finally(() => {
        checking = false;
      });
    }, 1000);
    timer.unref();
    socket.once('close', () => clearInterval(timer));
  }
  private async prepare(req: IncomingMessage, match: NonNullable<ReturnType<WecomTerminalFront['match']>>, upgrade = false) {
    if (!match.native) {
      if (!this.actor(req)) {
        throw new Error('forbidden');
      }
      return { id: match.id, entry: await this.resolve(match.id) };
    }
    if (match.suffix !== '/' && !/^\/control(?:\/(takeover|release))?$/.test(match.suffix)
      && !matchXtermVendorPath(match.suffix, 'root')?.asset) {
      throw new Error('forbidden');
    }
    if (match.suffix !== '/' && upgrade) {
      throw new Error('forbidden');
    }
    const browser = await this.options.nativeAccess?.authenticate(req, match.id);
    if (!browser) {
      throw new Error('forbidden');
    }
    // Native cookies never authorize another route, and WS/unsafe methods must
    // originate on the origin the link was built on (ignore Forwarded headers).
    if ((upgrade || req.method !== 'GET' && req.method !== 'HEAD') && req.headers.origin !== browser.claim.origin) {
      throw new Error('forbidden');
    }
    this.nativeActors.set(req, browser);
    const entry = await this.resolve(browser.claim.target.uiSessionId);
    if (entry.binding !== browser.claim.target.binding) {
      throw new Error('forbidden');
    }
    entry.actors.add(browser.actor.authSessionId);
    if (!await this.options.nativeAccess?.live(browser.id)) {
      throw new Error('forbidden');
    }
    if (browser.claim.permission === 'write' && !browser.activated) {
      const result = entry.control.takeover(browser.actor, entry.nativeSessionId);
      if (!result.ok) {
        throw new Error('control_busy');
      }
      browser.activated = true;
    }
    return { id: browser.claim.target.uiSessionId, entry, browser };
  }
  async http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (await this.options.nativeAccess?.handle(req, res, url)) {
      return true;
    }
    const match = this.match(url);
    if (!match) {
      return false;
    }
    if (url.searchParams.has('token') || url.searchParams.has('viewToken')) {
      res.writeHead(403);
      res.end();
      return true;
    }
    try {
      const { id, entry, browser } = await this.prepare(req, match);
      if (match.native && /^\/control(?:\/(takeover|release))?$/.test(match.suffix)) {
        const action = match.suffix.split('/')[2] as TerminalControlAction | undefined;
        const result = resolveTerminalControlAction({
          method: req.method ?? 'GET',
          sessionId: entry.nativeSessionId,
          action,
          search: url.searchParams,
          identity: browser!.actor,
          control: entry.control,
        });
        res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result.body));
        return true;
      }
      const rewritten = new URL(url);
      rewritten.pathname = `/s/${encodeURIComponent(entry.nativeSessionId)}${match.suffix}`;
      req.url = rewritten.pathname + rewritten.search;
      this.watch(id, entry, res, browser);
      if (!entry.proxy.handleHttp(req, res, rewritten)) {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'wecom_terminal_unavailable' }));
    }
    return true;
  }
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = this.match(url);
    if (!match) {
      return false;
    }
    if (url.searchParams.has('token') || url.searchParams.has('viewToken')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return true;
    }
    try {
      const { id, entry, browser } = await this.prepare(req, match, true);
      url.pathname = `/s/${encodeURIComponent(entry.nativeSessionId)}${match.suffix}`;
      req.url = url.pathname + url.search;
      this.watch(id, entry, socket, browser);
      if (!entry.proxy.handleUpgrade(req, socket, head)) {
        socket.destroy();
      }
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    return true;
  }
}
