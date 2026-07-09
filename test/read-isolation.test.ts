import { describe, it, expect } from 'vitest';
import {
  buildSeatbeltProfile,
  evaluateReadIsolationGate,
  isolatedPaneReattachSafe,
  botHomePath,
  buildV2DenyPaths,
  buildV2DenyRegexes,
  buildV2CarveOuts,
  sendCredFilePath,
  assertSafeAppId,
  normalizeIsolationPath,
  type V2IsolationContext,
} from '../src/adapters/cli/read-isolation.js';

const v2 = (o: Partial<V2IsolationContext> = {}): V2IsolationContext => ({
  homeDir: '/Users/bot',
  botmuxHome: '/Users/bot/.botmux',
  sessionDataDir: '/Users/bot/.botmux/data',
  currentAppId: 'cli_self',
  ...o,
});

describe('normalizeIsolationPath (path hardening)', () => {
  it('drops relative / traversal paths instead of silently keeping them', () => {
    expect(normalizeIsolationPath('relative/x')).toBeNull();
    expect(normalizeIsolationPath('/a/../b')).toBeNull();
    expect(normalizeIsolationPath('/ok/path')).toBe('/ok/path');
  });

  it('strips trailing slashes', () => {
    expect(normalizeIsolationPath('/a/b/')).toBe('/a/b');
  });
});

describe('v2 HYBRID model (buildV2DenyPaths)', () => {
  it('botHomePath is per-appId under BOTMUX_HOME/bots', () => {
    expect(botHomePath('/Users/bot/.botmux', 'cli_self')).toBe('/Users/bot/.botmux/bots/cli_self');
  });

  it('WHOLE-denies the CLI data dirs (F1): ~/.claude, ~/.claude.json, ~/.codex', () => {
    const d = buildV2DenyPaths(v2());
    expect(d).toContain('/Users/bot/.claude');
    expect(d).toContain('/Users/bot/.claude.json');
    expect(d).toContain('/Users/bot/.codex');
  });

  it('denies the broadened system-credential set (review M1)', () => {
    const d = buildV2DenyPaths(v2());
    for (const p of ['/Users/bot/.ssh', '/Users/bot/.aws', '/Users/bot/Library/Keychains',
      '/Users/bot/.gnupg', '/Users/bot/.netrc', '/Users/bot/.config/gcloud',
      '/Users/bot/.config/1Password', '/Users/bot/.password-store']) expect(d).toContain(p);
  });

  it('SURGICAL on ~/.botmux: denies the cross-bot sensitive parts, NOT the whole tree', () => {
    const d = buildV2DenyPaths(v2());
    // denied: secrets + other bots + content
    expect(d).toContain('/Users/bot/.botmux/bots.json');
    expect(d).toContain('/Users/bot/.botmux/logs');
    expect(d).toContain('/Users/bot/.lark-cli-bots');            // WHOLESALE (covers every sibling)
    // WHOLESALE deny of bots/ — covers EVERY sibling BOT_HOME, including bots added
    // AFTER this bot spawned (no cold-restart to pick them up). No per-sibling entries.
    expect(d).toContain('/Users/bot/.botmux/bots');
    expect(d).toContain('/Users/bot/.botmux/data/sessions.json'); // legacy shared store
    expect(d).toContain('/Users/bot/.botmux/data/frozen-cards');
    expect(d).toContain('/Users/bot/.botmux/data/turn-sends');
    expect(d).toContain('/Users/bot/.botmux/data/queues');        // all bots' inbound message content
    expect(d).toContain('/Users/bot/.botmux/data/read-isolation'); // profiles enumerate sibling sessions
    // schedules.json is a read-modify-write store — denying the read makes a
    // sandboxed `botmux schedule` load an empty map then overwrite the shared
    // file, wiping every bot's tasks. Deliberately NOT denied (accept the minor
    // leak of others' scheduled prompts) until schedule-store fail-closes. PR #387.
    expect(d).not.toContain('/Users/bot/.botmux/data/schedules.json');
    expect(d).toContain('/Users/bot/.botmux/feishu-session.json'); // Feishu web login session (can mint bots)
    expect(d).toContain('/Users/bot/.botmux/.dashboard-secret');   // loopback-HMAC signing key (mints write tokens)
    expect(d).toContain('/Users/bot/.botmux/.dashboard-token');    // dashboard admin bearer token
    // `.dashboard-port` is a bare port number (no credential value) — must stay readable
    expect(d).not.toContain('/Users/bot/.botmux/.dashboard-port');
    // NO per-sibling enumeration anywhere: sibling session stores are covered by the
    // filename-pattern regex (buildV2DenyRegexes), not per-appId path entries.
    expect(d.some((p) => p.includes('cli_other'))).toBe(false);
    // NOT denied — the whole tree, own data, and the tooling botmux CLI needs
    expect(d).not.toContain('/Users/bot/.botmux');                     // never whole-denied
    expect(d).not.toContain('/Users/bot/.botmux/data');                // data dir listable
    expect(d).not.toContain('/Users/bot/.botmux/bots/cli_self');       // own not a plain deny; re-allowed via carve-out
    expect(d).not.toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
    expect(d).not.toContain('/Users/bot/.botmux/config.json');         // config readable
    expect(d).not.toContain('/Users/bot/.lark-cli-bots/cli_self');     // own lark readable
  });

  it('denies per-bot session stores by filename PATTERN, re-allows only the own one', () => {
    // The regex covers EVERY sessions-<appId>.json — including bots added later —
    // without any sibling-appId enumeration.
    const regexes = buildV2DenyRegexes(v2());
    expect(regexes[0]).toBe('^/Users/bot/\\.botmux/data/sessions-[^/]+\\.json$');
    const re = new RegExp(regexes[0]);
    expect(re.test('/Users/bot/.botmux/data/sessions-cli_other1.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/sessions-cli_self.json')).toBe(true); // own matches too…
    expect(re.test('/Users/bot/.botmux/data/sessions.json')).toBe(false);          // legacy handled by path deny
    expect(re.test('/Users/bot/.botmux/data/sub/sessions-x.json')).toBe(false);    // same dir only
    // …but the own file is re-opened by a carve-out allow (Seatbelt last-match).
    expect(buildV2CarveOuts(v2()).allowPaths).toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
  });

  it('denies every bots.json SIDECAR (backup/temp) — .bak carries all siblings secrets', () => {
    // Regression: the exact bots.json is subpath-denied, but its setup/migration
    // backups (bots.json.bak, .bak.<suffix>, .tmp) carry the SAME plaintext
    // larkAppSecret for every bot under a different basename, which subpath does
    // NOT match. Without the sidecar regex an isolated bot could `cat bots.json.bak`
    // and recover all siblings' credentials.
    const re = new RegExp(buildV2DenyRegexes(v2())[1]);
    expect(re.test('/Users/bot/.botmux/bots.json.bak')).toBe(true);
    expect(re.test('/Users/bot/.botmux/bots.json.bak.isotest.1783089554')).toBe(true);
    expect(re.test('/Users/bot/.botmux/bots.json.tmp')).toBe(true);
    // The exact file is the subpath deny's job (not this regex), and unrelated
    // basenames must not be swept in.
    expect(re.test('/Users/bot/.botmux/bots.json')).toBe(false);
    expect(re.test('/Users/bot/.botmux/bots.jsonx')).toBe(false);
    // The exact bots.json is still covered by the path deny.
    expect(buildV2DenyPaths(v2())).toContain('/Users/bot/.botmux/bots.json');
  });

  it('own attachments bucket re-allowed under the wholesale attachments/ deny (Feishu uploads)', () => {
    // The agent must read files the user uploads in chat. attachments/ is keyed
    // per-appId (getAttachmentsDir) precisely because the Seatbelt profile is
    // static at spawn time — only a spawn-time-known key (the appId) can anchor
    // the carve-out. Siblings' buckets and the legacy flat attachments/<messageId>
    // layout stay under the wholesale deny.
    const d = buildV2DenyPaths(v2());
    expect(d).toContain('/Users/bot/.botmux/data/attachments');
    const carve = buildV2CarveOuts(v2());
    expect(carve.allowPaths).toContain('/Users/bot/.botmux/data/attachments/cli_self');
    // traverse shim so Read/realpath can stat through the denied parent without listing it
    expect(carve.traverseDirs).toContain('/Users/bot/.botmux/data/attachments');
  });

  it('denies LEGACY data-root send-cred files by pattern (pre-BOT_HOME leftovers)', () => {
    // Older builds wrote `<sd>/.send-cred-<appId>` at the data root; current builds
    // write inside BOT_HOME. The leftovers still hold live send credentials and the
    // data root is readable by design — so the legacy filename class must be denied.
    const re = new RegExp(buildV2DenyRegexes(v2()).find(r => r.includes('send-cred'))!);
    expect(re.test('/Users/bot/.botmux/data/.send-cred-cli_other1')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/.send-cred-cli_self')).toBe(true); // own legacy too — CLI reads BOT_HOME copy
    expect(re.test('/Users/bot/.botmux/data/send-cred.json')).toBe(false);
  });

  it('denies every identities-<appId>.json (interlocutor PII cache) — no own carve-out', () => {
    // open_id→display-name caches are daemon-side prompt-injection data; the CLI
    // never reads them, so unlike sessions-<appId>.json the OWN file gets no allow.
    const re = new RegExp(buildV2DenyRegexes(v2()).find(r => r.includes('identities'))!);
    expect(re.test('/Users/bot/.botmux/data/identities-cli_other1.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/identities-cli_self.json')).toBe(true);
    expect(re.test('/Users/bot/.botmux/data/sub/identities-x.json')).toBe(false); // same dir only
    const carve = buildV2CarveOuts(v2());
    expect(carve.allowPaths.some(p => p.includes('identities-'))).toBe(false);
  });

  it('send-cred lives inside BOT_HOME (unified per-bot private storage)', () => {
    // The botmux-send credential is stored in the bot's BOT_HOME, the SAME private
    // storage as its CLI data — one deny mechanism protects both (and any future
    // per-bot secret, e.g. a github token, dropped in there). sendCredFilePath takes
    // SESSION_DATA_DIR and derives BOTMUX_HOME (its parent) internally, matching the
    // worker's BOT_HOME = botHomePath(dirname(SESSION_DATA_DIR)).
    expect(sendCredFilePath('/Users/bot/.botmux/data', 'cli_self'))
      .toBe('/Users/bot/.botmux/bots/cli_self/send-cred.json');
    const d = buildV2DenyPaths(v2());
    // an OTHER bot's send-cred sits under its BOT_HOME → covered by the wholesale bots/ deny
    expect(sendCredFilePath('/Users/bot/.botmux/data', 'cli_other2'))
      .toBe('/Users/bot/.botmux/bots/cli_other2/send-cred.json');
    expect(d).toContain('/Users/bot/.botmux/bots');
    // own send-cred is under own BOT_HOME → readable via the carve-out
    expect(buildV2CarveOuts(v2()).allowPaths).toContain('/Users/bot/.botmux/bots/cli_self');
  });

  it('send-cred path follows a customized SESSION_DATA_DIR (review: codex)', () => {
    // BOTMUX_HOME is defined as dirname(SESSION_DATA_DIR); a custom data dir must
    // still resolve worker-write and deny to the SAME BOT_HOME — no hardcoded ~/.botmux.
    expect(sendCredFilePath('/var/botmux/data', 'cli_x'))
      .toBe('/var/botmux/bots/cli_x/send-cred.json');
    // the session-store regex must also follow the custom data dir
    expect(buildV2DenyRegexes(v2({ sessionDataDir: '/var/botmux/data' }))[0])
      .toBe('^/var/botmux/data/sessions-[^/]+\\.json$');
  });

  it('buildV2CarveOuts: own slices allowed + traverse shims + extraDenyPaths as FINAL deny', () => {
    const carve = buildV2CarveOuts(v2());
    // own slice of EACH wholesale/pattern-denied per-bot class re-allowed
    expect(carve.allowPaths).toEqual([
      '/Users/bot/.botmux/bots/cli_self',
      '/Users/bot/.lark-cli-bots/cli_self',
      '/Users/bot/.botmux/data/sessions-cli_self.json',
      '/Users/bot/.botmux/data/attachments/cli_self',
    ]);
    // traverse shim on each wholesale-denied parent (stat/realpath, not listing)
    expect(carve.traverseDirs).toEqual([
      '/Users/bot/.botmux/bots',
      '/Users/bot/.lark-cli-bots',
      '/Users/bot/.botmux/data/attachments',
    ]);
    expect(carve.finalDenyPaths).toEqual([]);
    // an admin deny UNDER the own BOT_HOME must WIN over the carve-out → goes to finalDeny
    const extra = '/Users/bot/.botmux/bots/cli_self/claude/.credentials.json';
    const c2 = buildV2CarveOuts(v2({ extraDenyPaths: [extra] }));
    expect(c2.finalDenyPaths).toContain(extra);
    expect(buildV2DenyPaths(v2({ extraDenyPaths: [extra] }))).not.toContain(extra); // not a plain deny
  });

  it('drops relative / traversal extraDenyPaths instead of silently keeping them', () => {
    const c = buildV2CarveOuts(v2({ extraDenyPaths: ['relative/x', '/a/../b', '/ok/path'] }));
    expect(c.finalDenyPaths).toEqual(['/ok/path']);
  });

  it('assertSafeAppId rejects path-traversal / separators, accepts real Feishu ids (review L2)', () => {
    expect(assertSafeAppId('cli_aab4eaea67395bc9')).toBe('cli_aab4eaea67395bc9');
    expect(() => assertSafeAppId('../evil')).toThrow();
    expect(() => assertSafeAppId('a/b')).toThrow();
    expect(() => assertSafeAppId('')).toThrow();
    // pure-dot ids are path-traversal segments: as a carve-out subpath, `bots/..`
    // canonicalizes to the PARENT (~/.botmux) and — emitted after the deny — would
    // re-open bots.json / bots/ / logs. Must be rejected (codex review).
    expect(() => assertSafeAppId('.')).toThrow();
    expect(() => assertSafeAppId('..')).toThrow();
    expect(() => assertSafeAppId('...')).toThrow();
    expect(() => buildV2CarveOuts(v2({ currentAppId: '..' }))).toThrow();
    // botHomePath must also reject an unsafe id (used for own + other BOT_HOMEs)
    expect(() => botHomePath('/Users/bot/.botmux', '../x')).toThrow();
  });
});

describe('buildSeatbeltProfile (verified format)', () => {
  it('emits allow-default + a file-read deny subpath per denied path', () => {
    const prof = buildSeatbeltProfile(buildV2DenyPaths(v2()));
    expect(prof).toContain('(version 1)');
    expect(prof).toContain('(allow default)');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots"))');
  });

  it('emits carve-out allows AFTER the denies (last-match wins) so own slices re-open', () => {
    const carve = buildV2CarveOuts(v2());
    const prof = buildSeatbeltProfile(
      buildV2DenyPaths(v2()), carve.allowPaths, carve.finalDenyPaths, carve.traverseDirs,
      buildV2DenyRegexes(v2()));
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots"))');
    // traverse: realpath/stat through bots/ works, but LISTING (read-data) stays denied
    expect(prof).toContain('(allow file-read-metadata (literal "/Users/bot/.botmux/bots"))');
    expect(prof).toContain('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))');
    // Seatbelt last-match-wins: own-allow MUST appear after the bots/ deny
    expect(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))'))
      .toBeGreaterThan(prof.indexOf('(deny file-read* (subpath "/Users/bot/.botmux/bots"))'));
    // pattern deny present (backslashes RAW inside the #"…" literal), and the own
    // session-file allow comes after it
    expect(prof).toContain('(deny file-read* (regex #"^/Users/bot/\\.botmux/data/sessions-[^/]+\\.json$"))');
    expect(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/data/sessions-cli_self.json"))'))
      .toBeGreaterThan(prof.indexOf('(deny file-read* (regex'));
  });

  it('FINAL denies come after the allows so admin extraDenyPaths win over the own carve-out', () => {
    const extra = '/Users/bot/.botmux/bots/cli_self/claude/.credentials.json';
    const carve = buildV2CarveOuts(v2({ extraDenyPaths: [extra] }));
    const prof = buildSeatbeltProfile(
      buildV2DenyPaths(v2()), carve.allowPaths, carve.finalDenyPaths, carve.traverseDirs);
    expect(prof.indexOf(`(deny file-read* (subpath "${extra}"))`))
      .toBeGreaterThan(prof.indexOf('(allow file-read* (subpath "/Users/bot/.botmux/bots/cli_self"))'));
  });

  it('no allowPaths → deny-only profile', () => {
    const prof = buildSeatbeltProfile(['/Users/bot/.botmux/bots.json']);
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).not.toContain('(allow file-read* (subpath');
  });
});

describe('evaluateReadIsolationGate (fail-closed, single decision point)', () => {
  const ok = {
    configured: true,
    adapterSupports: true,
    wrapperCliSet: false,
    platform: 'darwin',
    sessionDataDirSet: true,
  };

  it('disabled (no fail-closed) when not configured', () => {
    expect(evaluateReadIsolationGate({ ...ok, configured: false })).toEqual({ enabled: false });
  });

  it('enables when everything is satisfied', () => {
    expect(evaluateReadIsolationGate(ok)).toEqual({ enabled: true });
  });

  it('fail-closed when adapter does not support isolation', () => {
    const r = evaluateReadIsolationGate({ ...ok, adapterSupports: false });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/support/i);
  });

  it('fail-closed when wrapperCli is set (strips the spawn args)', () => {
    const r = evaluateReadIsolationGate({ ...ok, wrapperCliSet: true });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/wrapperCli/i);
  });

  it('fail-closed on Linux (bwrap wrapper unimplemented) and other platforms', () => {
    const linux = evaluateReadIsolationGate({ ...ok, platform: 'linux' });
    expect(linux.enabled).toBe(false);
    expect(linux.failClosedReason).toMatch(/linux/i);
    const win = evaluateReadIsolationGate({ ...ok, platform: 'win32' });
    expect(win.enabled).toBe(false);
    expect(win.failClosedReason).toMatch(/unsupported/i);
  });

  it('fail-closed when SESSION_DATA_DIR is missing', () => {
    const r = evaluateReadIsolationGate({ ...ok, sessionDataDirSet: false });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/SESSION_DATA_DIR/);
  });
});

describe('isolatedPaneReattachSafe', () => {
  it('trusts any pane that carries an isolation marker', () => {
    // Marker present → pane was spawned isolated → still confined across daemon
    // restarts → safe warm reattach (preserves resume + tmux idle-suspend).
    expect(isolatedPaneReattachSafe('boot-abc')).toBe(true);
    expect(isolatedPaneReattachSafe('any-old-boot-id')).toBe(true);
    // No / blank marker → pane was NOT spawned isolated → unsafe (kill + cold-spawn).
    expect(isolatedPaneReattachSafe(null)).toBe(false);
    expect(isolatedPaneReattachSafe(undefined)).toBe(false);
    expect(isolatedPaneReattachSafe('')).toBe(false);
    expect(isolatedPaneReattachSafe('   ')).toBe(false);
  });
});
