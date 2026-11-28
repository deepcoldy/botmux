/** Native TRAE enterprise login, owned by the daemon rather than a model turn.
 * Botmux never reads or copies credentials. The CLI verifies the callback and
 * persists its own login. Pending challenges live only for this daemon's life.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntrySpawn } from '../core/self-spawn.js';
import { withFileLock } from '../utils/file-lock.js';

export interface TraeLoginTarget { bin: string; root: string; env: NodeJS.ProcessEnv }
export interface TraeLoginOwner { appId: string; openId: string }
export type TraeLoginState = 'starting' | 'pending' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
export interface TraeLoginView { id: string; state: TraeLoginState; expiresAt: number; url?: string }
type SpawnLogin = (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
interface Attempt extends TraeLoginView {
  owner: TraeLoginOwner; target: TraeLoginTarget; callback?: URL; output: string;
  child?: ChildProcess; timer?: NodeJS.Timeout; done?: Promise<void>;
  ready: (view: TraeLoginView) => void; readyPromise: Promise<TraeLoginView>;
  valid?: () => Promise<boolean>; validating?: boolean; validationTimer?: NodeJS.Timeout;
}

export function redactTraeLoginCommand(text: string, commandText = text): string {
  return /^\s*\/dashboard\s+trae-login\s+complete\b/i.test(commandText)
    ? '/dashboard trae-login complete [redacted]' : text;
}

export function parseTraeLoginChallenge(output: string): { url: string; callback: URL } | undefined {
  if (!output.includes('copy the final 127.0.0.1 callback URL')) return;
  for (const raw of output.match(/https:\/\/[^\s\x1b]+/g) ?? []) {
    try {
      const url = new URL(raw);
      if (url.hostname !== 'console.enterprise.trae.cn' || url.pathname !== '/authorization') continue;
      const callback = new URL(url.searchParams.get('auth_callback_url') ?? '');
      if (!isLoopbackCallback(callback)) continue;
      return { url: url.toString(), callback };
    } catch { /* incomplete output chunk */ }
  }
}

function isLoopbackCallback(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !!url.port && !url.username && !url.password && !url.hash;
}

export function validateTraeLoginCallback(raw: string, expected: URL): boolean {
  if (raw.length > 8192 || /[\r\n\x00]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    // The native CLI accepts the final browser URL and validates its auth
    // material. Botmux bounds that input to this attempt's loopback endpoint.
    return isLoopbackCallback(url) && url.port === expected.port
      && url.pathname === expected.pathname && !!url.search;
  } catch { return false; }
}

export class TraeLoginManager {
  private attempts = new Map<string, Attempt>();
  constructor(private opts: { spawn?: SpawnLogin; ttlMs?: number; now?: () => number } = {}) {}
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private key(target: TraeLoginTarget): string {
    mkdirSync(target.root, { recursive: true, mode: 0o700 });
    return realpathSync(resolve(target.root));
  }
  private owns(a: Attempt, owner: TraeLoginOwner): boolean {
    return a.owner.appId === owner.appId && a.owner.openId === owner.openId;
  }
  private view(a: Attempt): TraeLoginView {
    return { id: a.id, state: a.state, expiresAt: a.expiresAt,
      ...(a.state === 'pending' && a.url ? { url: a.url } : {}) };
  }
  async begin(target: TraeLoginTarget, owner: TraeLoginOwner, valid?: () => Promise<boolean>): Promise<TraeLoginView> {
    const key = this.key(target);
    const old = this.attempts.get(key);
    if (old && ['starting', 'pending', 'verifying'].includes(old.state)) {
      if (!this.owns(old, owner)) throw new Error('login_busy');
      if (this.now() < old.expiresAt) return old.readyPromise.then(() => this.view(old));
      await this.cancelRequest(owner, old.id);
      return this.view(old);
    }
    let ready!: Attempt['ready'];
    const readyPromise = new Promise<TraeLoginView>(r => { ready = r; });
    const a: Attempt = { id: randomUUID(), state: 'starting', owner,
      target, expiresAt: this.now() + (this.opts.ttlMs ?? 10 * 60_000),
      output: '', ready, readyPromise, valid };
    this.attempts.set(key, a);
    // The same TRAE_HOME can be shared by several bots/daemons. Hold the
    // existing cross-process lock for the entire native login, not just spawn.
    const lock = join(key, '.botmux-enterprise-login-' + createHash('sha256').update(key).digest('hex').slice(0, 12));
    a.done = (this.opts.spawn ? withFileLock(lock, () => this.run(a), { maxWaitMs: 0 }) : this.run(a))
      .catch(() => { this.finish(a, 'failed'); });
    return readyPromise;
  }
  private finish(a: Attempt, state: TraeLoginState): void {
    a.state = state; a.url = undefined; a.callback = undefined; a.output = '';
    if (a.timer) clearTimeout(a.timer);
    if (a.validationTimer) clearInterval(a.validationTimer);
    a.ready(this.view(a));
  }
  private run(a: Attempt): Promise<void> {
    return new Promise(resolveDone => {
      if (a.state === 'cancelled') { this.finish(a, 'cancelled'); resolveDone(); return; }
      let child: ChildProcess;
      try {
        if (this.opts.spawn) child = this.opts.spawn(a.target.bin, ['login', '--enterprise'], a.target.env);
        else {
          const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
          const entry = resolveEntrySpawn('trae-login-runner', basename(dir) === 'src' ? resolve(dir, '..', 'dist') : dir);
          child = spawn(entry.command, [...entry.args, a.target.bin, a.target.root, String(a.expiresAt)], {
            env: a.target.env, cwd: a.target.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          });
        }
      } catch { this.finish(a, 'failed'); resolveDone(); return; }
      a.child = child;
      let settled = false;
      const settle = (state: TraeLoginState) => {
        if (settled) return;
        settled = true;
        this.finish(a, state); resolveDone();
      };
      const capture = (chunk: string) => {
        if (a.state !== 'starting') return;
        a.output += chunk;
        if (a.output.length > 32768) { a.state = 'failed'; this.stop(a); return; }
        const challenge = parseTraeLoginChallenge(a.output);
        if (challenge) {
          a.url = challenge.url; a.callback = challenge.callback;
          a.output = ''; a.state = 'pending';
          void this.validate(a).then(ok => {
            if (ok && a.state === 'pending' && this.now() < a.expiresAt) a.ready(this.view(a));
            else if (a.state === 'pending') { a.state = 'cancelled'; this.stop(a); }
          });
          if (a.timer) clearTimeout(a.timer);
          a.timer = setTimeout(() => {
            a.state = 'cancelled'; this.stop(a);
          }, Math.max(0, a.expiresAt - this.now()));
          a.timer.unref?.();
        }
      };
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', capture); child.stderr?.on('data', capture);
      child.stdin?.on('error', () => { a.state = 'failed'; this.stop(a); });
      child.once('error', () => settle('failed'));
      child.once('exit', async code => {
        const state = a.state;
        // Exit zero only counts after the actual interactive challenge was
        // observed. A status/file existence check cannot prove new login.
        const valid = await this.validate(a);
        settle(a.state === 'cancelled' || !valid || this.now() >= a.expiresAt ? 'cancelled'
          : code === 0 && ['pending', 'verifying'].includes(state) ? 'succeeded' : 'failed');
      });
      a.timer = setTimeout(() => {
        a.state = 'cancelled'; this.stop(a);
      }, Math.max(0, Math.min(20_000, a.expiresAt - this.now())));
      a.timer.unref?.();
      if (a.valid) {
        a.validationTimer = setInterval(() => {
          if (a.validating) return;
          a.validating = true;
          void this.validate(a).then(ok => {
            if (!ok && ['starting', 'pending', 'verifying'].includes(a.state)) {
              a.state = 'cancelled'; this.stop(a);
            }
          }).finally(() => { a.validating = false; });
        }, 1000);
        a.validationTimer.unref?.();
      }
    });
  }
  private async validate(a: Attempt): Promise<boolean> {
    try { return !a.valid || await a.valid(); } catch { return false; }
  }
  private stop(a: Attempt): void {
    if (this.opts.spawn) a.child?.kill('SIGKILL');
    else a.child?.stdin?.end(); // runner kills/reaps native before releasing its lock
  }
  status(target: TraeLoginTarget, owner: TraeLoginOwner): TraeLoginView | undefined {
    const a = this.attempts.get(this.key(target));
    return a && this.owns(a, owner) ? this.view(a) : undefined;
  }
  async complete(target: TraeLoginTarget, owner: TraeLoginOwner, id: string, callback: string): Promise<TraeLoginView> {
    const a = this.attempts.get(this.key(target));
    if (!a || !this.owns(a, owner) || a.id !== id) throw new Error('login_missing');
    const valid = await this.validate(a);
    if (a.state !== 'pending' || this.now() >= a.expiresAt || !valid) throw new Error('login_not_pending');
    if (!a.callback || !validateTraeLoginCallback(callback, a.callback)) throw new Error('login_bad_callback');
    if (!a.child?.stdin?.writable) throw new Error('login_not_pending');
    a.state = 'verifying'; a.url = undefined;
    a.child?.stdin?.write(callback + '\n');
    // The CLI validates asynchronously. A separate status request avoids
    // blocking the chat and does not assume that writing stdin succeeded.
    return this.view(a);
  }
  async cancel(target: TraeLoginTarget, owner: TraeLoginOwner): Promise<void> {
    const a = this.attempts.get(this.key(target));
    if (!a || !this.owns(a, owner)) throw new Error('login_missing');
    await this.cancelRequest(owner, a.id);
  }
  async cancelRequest(owner: TraeLoginOwner, id?: string): Promise<void> {
    const found = [...this.attempts.values()].filter(a => this.owns(a, owner) && (!id || a.id === id));
    await Promise.all(found.map(async a => {
    if (!['starting', 'pending', 'verifying'].includes(a.state)) return;
    a.state = 'cancelled'; this.stop(a);
    await a.done;
    }));
  }
  async shutdown(): Promise<void> {
    for (const a of this.attempts.values()) {
      if (!['starting', 'pending', 'verifying'].includes(a.state)) continue;
      a.state = 'cancelled'; this.stop(a);
    }
    await Promise.all([...this.attempts.values()].map(a => a.done));
  }
}

export const traeLoginManager = new TraeLoginManager();
