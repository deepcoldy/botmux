import { describe, it, expect } from 'vitest';
import {
  MIN_CLAUDE_SANDBOX_VERSION,
  defaultCredentialDenyPaths,
  buildReadDenyPaths,
  buildClaudeReadIsolationSettings,
  buildSeatbeltProfile,
  parseClaudeVersion,
  versionAtLeast,
  evaluateReadIsolationGate,
  isolatedPaneReattachSafe,
  botHomePath,
  buildV2DenyPaths,
  assertSafeAppId,
  type ReadIsolationContext,
} from '../src/adapters/cli/read-isolation.js';

const HOME = '/Users/bot';

function ctx(overrides: Partial<ReadIsolationContext> = {}): ReadIsolationContext {
  return {
    currentAppId: 'cli_self',
    otherAppIds: ['cli_other1', 'cli_other2'],
    sessionDataDir: '/Users/bot/.botmux/data',
    homeDir: HOME,
    ownTranscriptRoot: '/Users/bot/.claude/projects',
    ...overrides,
  };
}

describe('defaultCredentialDenyPaths', () => {
  it('covers common credential locations under home', () => {
    const p = defaultCredentialDenyPaths(HOME);
    expect(p).toContain('/Users/bot/.ssh');
    expect(p).toContain('/Users/bot/.aws');
    expect(p).toContain('/Users/bot/.config/gh');
    expect(p).toContain('/Users/bot/.config/glab-cli');
    expect(p).toContain('/Users/bot/.npmrc');
    expect(p).toContain('/Users/bot/.docker/config.json');
    expect(p).toContain('/Users/bot/.kube');
    expect(p).toContain('/Users/bot/.git-credentials');
    expect(p).toContain('/Users/bot/.codex/auth.json');
    expect(p).toContain('/Users/bot/.claude/.credentials.json');
  });
});

describe('path hardening (Codex review #4/#7)', () => {
  it('denies the legacy single-file sessions.json store', () => {
    expect(buildReadDenyPaths(ctx())).toContain('/Users/bot/.botmux/data/sessions.json');
  });

  it('drops relative / traversal extra deny paths instead of silently keeping them', () => {
    const paths = buildReadDenyPaths(ctx({ extraDenyPaths: ['relative/x', '/a/../b', '/ok/path'] }));
    expect(paths).toContain('/ok/path');
    expect(paths).not.toContain('relative/x');
    expect(paths.some((p) => p.includes('..'))).toBe(false);
  });

  it('strips trailing slashes and still excludes the own lark-cli dir', () => {
    const paths = buildReadDenyPaths(ctx({ extraDenyPaths: ['/Users/bot/.lark-cli-bots/cli_self/'] }));
    expect(paths).not.toContain('/Users/bot/.lark-cli-bots/cli_self');
  });
});

describe('buildReadDenyPaths', () => {
  it('denies conversation content, bots.json, default lark-cli, and OTHER bots lark-cli dirs', () => {
    const paths = buildReadDenyPaths(ctx());
    expect(paths).toContain('/Users/bot/.botmux/bots.json');
    expect(paths).toContain('/Users/bot/.claude/projects');
    expect(paths).toContain('/Users/bot/.botmux/data/frozen-cards');
    expect(paths).toContain('/Users/bot/.botmux/data/turn-sends');
    expect(paths).toContain('/Users/bot/.lark-cli');
    expect(paths).toContain('/Users/bot/.lark-cli-bots/cli_other1');
    expect(paths).toContain('/Users/bot/.lark-cli-bots/cli_other2');
  });

  it('denies OTHER bots session metadata but NOT its own (send needs own routing)', () => {
    const paths = buildReadDenyPaths(ctx());
    expect(paths).toContain('/Users/bot/.botmux/data/sessions-cli_other1.json');
    expect(paths).not.toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
    // The whole SESSION_DATA_DIR is NOT blanket-denied (would break botmux send).
    expect(paths).not.toContain('/Users/bot/.botmux/data');
  });

  it('does NOT deny the bot OWN lark-cli config dir (needed for its own skills)', () => {
    const paths = buildReadDenyPaths(ctx());
    expect(paths).not.toContain('/Users/bot/.lark-cli-bots/cli_self');
  });

  it('includes the built-in default credential set', () => {
    const paths = buildReadDenyPaths(ctx());
    expect(paths).toContain('/Users/bot/.ssh');
    expect(paths).toContain('/Users/bot/.aws');
  });

  it('appends extraDenyPaths', () => {
    const paths = buildReadDenyPaths(ctx({ extraDenyPaths: ['/data/secret-token'] }));
    expect(paths).toContain('/data/secret-token');
  });

  it('denies foreign CLI transcript roots (cross-CLI chat-history isolation)', () => {
    // A Codex bot (no own ownTranscriptRoot) must still deny Claude's transcripts.
    const codex = buildReadDenyPaths(ctx({ ownTranscriptRoot: undefined, foreignTranscriptDirs: ['/Users/bot/.claude/projects'] }));
    expect(codex).toContain('/Users/bot/.claude/projects');
    // A Claude bot denies Codex's shared sessions dir.
    const claude = buildReadDenyPaths(ctx({ foreignTranscriptDirs: ['/Users/bot/.codex/sessions'] }));
    expect(claude).toContain('/Users/bot/.codex/sessions');
  });

  it('isolatedPaneReattachSafe: trusts any pane that carries an isolation marker', () => {
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

  it('never denies the running CLI own auth (ownAuthPaths) — else the wrapped CLI crashes', () => {
    // Codex bot: ~/.codex/auth.json is its OWN auth; the default cred set includes
    // it, but it must stay readable under the Seatbelt wrapper.
    const paths = buildReadDenyPaths(ctx({ ownAuthPaths: ['/Users/bot/.codex/auth.json'] }));
    expect(paths).not.toContain('/Users/bot/.codex/auth.json');
    // other-CLI creds the bot doesn't own are still denied
    expect(paths).toContain('/Users/bot/.claude/.credentials.json');
  });

  it('keeps a PARENT deny even when a preserved auth path lives under it (F5)', () => {
    // Deny /Users/bot/.app, preserve /Users/bot/.app/auth.json. The parent deny MUST
    // stay (dropping it would reopen the parent's OTHER children — e.g. a sibling
    // secret). The auth file itself is re-opened by the caller as a Seatbelt allow,
    // not by dropping the parent from the deny set.
    const paths = buildReadDenyPaths(ctx({
      extraDenyPaths: ['/Users/bot/.app'],
      ownAuthPaths: ['/Users/bot/.app/auth.json'],
    }));
    expect(paths).toContain('/Users/bot/.app');
    // a deny that IS the preserved path (or under it) is still dropped
    const paths2 = buildReadDenyPaths(ctx({
      extraDenyPaths: ['/Users/bot/.app/auth.json'],
      ownAuthPaths: ['/Users/bot/.app/auth.json'],
    }));
    expect(paths2).not.toContain('/Users/bot/.app/auth.json');
  });
});

describe('buildClaudeReadIsolationSettings (blocklist / default mode)', () => {
  it('sandbox.filesystem.denyRead uses plain absolute paths and enables fail-closed sandbox', () => {
    const s = buildClaudeReadIsolationSettings(ctx());
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.failIfUnavailable).toBe(true);
    expect(s.sandbox.filesystem.denyRead).toContain('/Users/bot/.botmux/bots.json');
    expect(s.sandbox.filesystem.denyRead).toContain('/Users/bot/.lark-cli-bots/cli_other1');
  });

  it('permissions.deny uses // double-slash absolute prefix + /** glob for Read/Grep/Glob', () => {
    const s = buildClaudeReadIsolationSettings(ctx());
    expect(s.permissions.deny).toContain('Read(//Users/bot/.botmux/bots.json/**)');
    expect(s.permissions.deny).toContain('Read(//Users/bot/.claude/projects/**)');
    // Grep + Glob also covered for at least one sensitive path
    expect(s.permissions.deny).toContain('Grep(//Users/bot/.claude/projects/**)');
    expect(s.permissions.deny).toContain('Glob(//Users/bot/.claude/projects/**)');
  });

  it('never denies the bot own lark-cli dir', () => {
    const s = buildClaudeReadIsolationSettings(ctx());
    expect(s.sandbox.filesystem.denyRead).not.toContain('/Users/bot/.lark-cli-bots/cli_self');
    expect(s.permissions.deny.join('|')).not.toContain('.lark-cli-bots/cli_self');
  });
});

describe('buildClaudeReadIsolationSettings (strict / allowlist mode)', () => {
  it('denies whole home and allows only the allow set', () => {
    const s = buildClaudeReadIsolationSettings(ctx({ strict: true, allowPaths: ['/work/project'] }));
    expect(s.sandbox.filesystem.denyRead).toContain('/Users/bot');
    expect(s.sandbox.filesystem.allowRead).toContain('/work/project');
    // own lark-cli dir must still be readable for skills
    expect(s.sandbox.filesystem.allowRead).toContain('/Users/bot/.lark-cli-bots/cli_self');
  });
});

describe('buildSeatbeltProfile (external-wrapper / Codex, verified format)', () => {
  it('emits allow-default + a file-read deny subpath per denied path', () => {
    const prof = buildSeatbeltProfile(buildReadDenyPaths(ctx()));
    expect(prof).toContain('(version 1)');
    expect(prof).toContain('(allow default)');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.lark-cli-bots/cli_other1"))');
    // own dir must not be denied
    expect(prof).not.toContain('cli_self"))');
  });

  it('emits carve-out allows AFTER the denies (last-match wins) so own project dir re-opens', () => {
    const prof = buildSeatbeltProfile(
      ['/Users/bot/.claude/projects', '/Users/bot/.botmux/bots.json'],
      ['/Users/bot/.claude/projects/-Users-bot-salesop'],
    );
    const denyIdx = prof.indexOf('(deny file-read* (subpath "/Users/bot/.claude/projects"))');
    const allowIdx = prof.indexOf('(allow file-read* (subpath "/Users/bot/.claude/projects/-Users-bot-salesop"))');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(-1);
    // The carve-out allow MUST come after the broad deny, or Seatbelt keeps it denied.
    expect(allowIdx).toBeGreaterThan(denyIdx);
  });

  it('no allowPaths → deny-only profile (Codex path, unchanged)', () => {
    const prof = buildSeatbeltProfile(['/Users/bot/.botmux/bots.json']);
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.botmux/bots.json"))');
    expect(prof).not.toContain('(allow file-read* (subpath');
  });
});

describe('parseClaudeVersion', () => {
  it('extracts semver from claude --version output', () => {
    expect(parseClaudeVersion('2.1.197 (Claude Code)')).toBe('2.1.197');
    expect(parseClaudeVersion('  2.1.187\n')).toBe('2.1.187');
  });
  it('returns null when no version present', () => {
    expect(parseClaudeVersion('no version here')).toBeNull();
  });
});

describe('evaluateReadIsolationGate (fail-closed)', () => {
  const ok = { configured: true, adapterSupports: true, wrapperCliSet: false, versionOk: true };

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

  it('fail-closed when wrapperCli is set (strips --settings)', () => {
    const r = evaluateReadIsolationGate({ ...ok, wrapperCliSet: true });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toMatch(/wrapperCli/i);
  });

  it('fail-closed when CLI version too old', () => {
    const r = evaluateReadIsolationGate({ ...ok, versionOk: false });
    expect(r.enabled).toBe(false);
    expect(r.failClosedReason).toContain(MIN_CLAUDE_SANDBOX_VERSION);
  });
});

describe('v2 HYBRID model (buildV2DenyPaths)', () => {
  const v2 = (o: Partial<Parameters<typeof buildV2DenyPaths>[0]> = {}) => ({
    homeDir: '/Users/bot',
    botmuxHome: '/Users/bot/.botmux',
    sessionDataDir: '/Users/bot/.botmux/data',
    currentAppId: 'cli_self',
    otherAppIds: ['cli_other1', 'cli_other2'],
    ...o,
  });

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
    expect(d).toContain('/Users/bot/.lark-cli-bots/cli_other1');
    expect(d).toContain('/Users/bot/.botmux/data/sessions-cli_other1.json');
    expect(d).toContain('/Users/bot/.botmux/data/.send-cred-cli_other2');
    expect(d).toContain('/Users/bot/.botmux/bots/cli_other1');   // other bot's BOT_HOME
    expect(d).toContain('/Users/bot/.botmux/data/frozen-cards');
    expect(d).toContain('/Users/bot/.botmux/data/turn-sends');
    // NOT denied — the whole tree, own data, and the tooling botmux CLI needs
    expect(d).not.toContain('/Users/bot/.botmux');                     // never whole-denied
    expect(d).not.toContain('/Users/bot/.botmux/data');                // data dir listable
    expect(d).not.toContain('/Users/bot/.botmux/bots/cli_self');       // OWN BOT_HOME readable
    expect(d).not.toContain('/Users/bot/.botmux/data/sessions-cli_self.json');
    expect(d).not.toContain('/Users/bot/.botmux/config.json');         // config readable
    expect(d).not.toContain('/Users/bot/.lark-cli-bots/cli_self');     // own lark readable
  });

  it('folds extraDenyPaths into the deny set (no allow carve-out to override them)', () => {
    const extra = '/Users/bot/.botmux/bots/cli_self/claude/.credentials.json';
    expect(buildV2DenyPaths(v2({ extraDenyPaths: [extra] }))).toContain(extra);
  });

  it('profile is deny-only over allow-default (no carve-outs / traversal shims needed)', () => {
    const prof = buildSeatbeltProfile(buildV2DenyPaths(v2()));
    expect(prof).toContain('(allow default)');
    expect(prof).toContain('(deny file-read* (subpath "/Users/bot/.claude"))');
    expect(prof).not.toContain('(allow file-read*');          // no subpath re-allows
    expect(prof).not.toContain('file-read-metadata');         // no traversal shim
  });

  it('assertSafeAppId rejects path-traversal / separators, accepts real Feishu ids (review L2)', () => {
    expect(assertSafeAppId('cli_aab4eaea67395bc9')).toBe('cli_aab4eaea67395bc9');
    expect(() => assertSafeAppId('../evil')).toThrow();
    expect(() => assertSafeAppId('a/b')).toThrow();
    expect(() => assertSafeAppId('')).toThrow();
    // botHomePath must also reject an unsafe id (used for own + other BOT_HOMEs)
    expect(() => botHomePath('/Users/bot/.botmux', '../x')).toThrow();
    expect(() => buildV2DenyPaths(v2({ otherAppIds: ['a/../b'] }))).toThrow();
  });
});

describe('versionAtLeast', () => {
  it('compares semver numerically, not lexically', () => {
    expect(versionAtLeast('2.1.197', MIN_CLAUDE_SANDBOX_VERSION)).toBe(true);
    expect(versionAtLeast('2.1.187', MIN_CLAUDE_SANDBOX_VERSION)).toBe(true);
    expect(versionAtLeast('2.1.100', MIN_CLAUDE_SANDBOX_VERSION)).toBe(false);
    expect(versionAtLeast('2.2.0', MIN_CLAUDE_SANDBOX_VERSION)).toBe(true);
    expect(versionAtLeast('1.9.9', MIN_CLAUDE_SANDBOX_VERSION)).toBe(false);
  });
});
