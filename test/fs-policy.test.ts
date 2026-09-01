import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildFsPolicy,
  mergeFsRules,
  accessForPath,
  normalizeFsPath,
  coversPath,
  authPathsSurvivingCliDataRedirect,
  resolveRedirectedAdapterAuthPaths,
  ancestorsNeedingTraverse,
  compileToSeatbelt,
  compileToBwrap,
  migrateLegacySandboxFields,
  computeNoTransportAuthorityRoots,
  larkCliLinuxStorePath,
  larkCliChildDataRoot,
  resolveLarkCliLinuxStoreDir,
  cleanPosixAbsPath,
  FsPolicyConfigError,
  type FsPolicyContext,
  type FsRule,
} from '../src/adapters/cli/fs-policy.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';
import { createReasonixAdapter } from '../src/adapters/cli/reasonix.js';
import { createOhMyPiAdapter } from '../src/adapters/cli/oh-my-pi.js';
import { createEbsdAdapter } from '../src/adapters/cli/ebsd.js';

const ctx = (o: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
  platform: 'darwin',
  homeDir: '/Users/u',
  botmuxHome: '/Users/u/.botmux',
  sessionDataDir: '/Users/u/.botmux/data',
  sessionId: 's',
  workingDir: '/Users/u/proj',
  currentAppId: 'cli_self',
  botHome: '/Users/u/.botmux/bots/cli_self',
  redirectedCliData: true,
  ...o,
});

describe('normalizeFsPath', () => {
  it('normalizes and rejects unusable paths', () => {
    expect(normalizeFsPath('/a/b/')).toBe('/a/b');
    expect(normalizeFsPath('/')).toBe('/');
    expect(normalizeFsPath('relative/x')).toBeNull();
    expect(normalizeFsPath('/a/../b')).toBeNull();
    expect(normalizeFsPath('')).toBeNull();
  });
});

describe('coversPath', () => {
  it('matches self and descendants only', () => {
    expect(coversPath('/a', '/a')).toBe(true);
    expect(coversPath('/a', '/a/b')).toBe(true);
    expect(coversPath('/a', '/ab')).toBe(false);
    expect(coversPath('/', '/anything')).toBe(true);
  });
});

describe('mergeFsRules + accessForPath (the policy semantics)', () => {
  it('deepest rule wins (longest-prefix)', () => {
    const rules = mergeFsRules([
      { path: '/Users/u/Library', access: 'readOnly', source: 'baseline' },
      { path: '/Users/u/Library/Application Support/lark-cli', access: 'deny', source: 'baseline' },
      { path: '/Users/u/Library/Application Support', access: 'readWrite', source: 'baseline' },
    ]);
    expect(accessForPath(rules, '/Users/u/Library/Fonts/x.ttf').access).toBe('readOnly');
    expect(accessForPath(rules, '/Users/u/Library/Application Support/Code/settings').access).toBe('readWrite');
    expect(accessForPath(rules, '/Users/u/Library/Application Support/lark-cli/master.key.file').access).toBe('deny');
  });

  it('uncovered paths are inaccessible (deny-by-default)', () => {
    const rules = mergeFsRules([{ path: '/opt', access: 'readOnly', source: 'baseline' }]);
    expect(accessForPath(rules, '/etc/passwd').access).toBe('none');
    expect(accessForPath(rules, '/opt/x').access).toBe('readOnly');
  });

  it('white-in-black nesting: allow inside a denied tree', () => {
    const rules = mergeFsRules([
      { path: '/data/bots', access: 'deny', source: 'internal' },
      { path: '/data/bots/self', access: 'readWrite', source: 'internal' },
    ]);
    expect(accessForPath(rules, '/data/bots/other/secret').access).toBe('deny');
    expect(accessForPath(rules, '/data/bots/self/cred.json').access).toBe('readWrite');
  });

  it('same path: higher source rank wins; tie → more restrictive wins', () => {
    const rules = mergeFsRules([
      { path: '/p', access: 'deny', source: 'baseline' },
      { path: '/p', access: 'readWrite', source: 'user' },
    ]);
    expect(accessForPath(rules, '/p/x').access).toBe('readWrite');
    const tie = mergeFsRules([
      { path: '/q', access: 'readWrite', source: 'user' },
      { path: '/q', access: 'deny', source: 'user' },
    ]);
    expect(accessForPath(tie, '/q').access).toBe('deny');
  });

  it('sorts shallow→deep for emission', () => {
    const rules = mergeFsRules([
      { path: '/a/b/c', access: 'deny', source: 'user' },
      { path: '/a', access: 'readOnly', source: 'user' },
      { path: '/a/b', access: 'readWrite', source: 'user' },
    ]);
    expect(rules.map(r => r.path)).toEqual(['/a', '/a/b', '/a/b/c']);
  });
});

describe('buildFsPolicy', () => {
  it('isolates OMP transcripts while keeping shared agent state and only the current sid writable', () => {
    const adapter = createOhMyPiAdapter('/usr/bin/omp');
    const sessionsRoot = '/home/u/.omp/agent/sessions';
    const ownSessionDir = `${sessionsRoot}/botmux/self`;
    const p = buildFsPolicy(ctx({
      platform: 'linux',
      homeDir: '/home/u',
      botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      workingDir: '/home/u/proj',
      redirectedCliData: false,
      authPaths: adapter.authPaths?.map(path => path.replace(/^~/, '/home/u')),
      mandatoryDenyPaths: [sessionsRoot],
      extraWritePaths: [ownSessionDir],
    }));

    for (const path of [
      '/home/u/.omp/agent/agent.db',
      '/home/u/.omp/agent/agent.db-wal',
      '/home/u/.omp/agent/config.yml',
      '/home/u/.omp/agent/terminal-sessions/pane',
      `${ownSessionDir}/turn.jsonl`,
    ]) {
      expect(accessForPath(p.rules, path).access).toBe('readWrite');
    }
    expect(accessForPath(p.rules, sessionsRoot).access).toBe('deny');
    expect(accessForPath(p.rules, `${sessionsRoot}/botmux/sibling/secret.jsonl`).access).toBe('deny');

    const { args } = compileToBwrap(p, {
      emptyDir: '/sbx/empty',
      emptiesDir: '/sbx/empties',
      chdir: '/home/u/proj',
    });
    const mask = args.indexOf(sessionsRoot);
    const carve = args.indexOf(ownSessionDir);
    expect(args[mask - 1]).toBe('--tmpfs');
    expect(carve).toBeGreaterThan(mask);
    expect(args[carve - 1]).toBe('--bind');
    expect(args.lastIndexOf(sessionsRoot)).toBeGreaterThan(carve);
    expect(args[args.lastIndexOf(sessionsRoot) - 1]).toBe('--remount-ro');
  });

  it('isolates ebsd sibling transcripts while retaining service state', () => {
    const adapter = createEbsdAdapter('/usr/bin/ebsd');
    const sessionsRoot = '/home/u/.ebsd/agent/sessions';
    const ownSessionDir = `${sessionsRoot}/botmux/self`;
    const p = buildFsPolicy(ctx({
      platform: 'linux',
      homeDir: '/home/u',
      botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      workingDir: '/home/u/proj',
      redirectedCliData: false,
      authPaths: adapter.authPaths?.map(path => path.replace(/^~/, '/home/u')),
      mandatoryDenyPaths: [sessionsRoot],
      extraWritePaths: [ownSessionDir],
    }));
    expect(accessForPath(p.rules, '/home/u/.ebsd/agent/agent.db').access).toBe('readWrite');
    expect(accessForPath(p.rules, `${ownSessionDir}/turn.jsonl`).access).toBe('readWrite');
    expect(accessForPath(p.rules, `${sessionsRoot}/botmux/sibling/secret.jsonl`).access).toBe('deny');
  });

  it('reasonix state root is read-write so identity, sessions, leases and skills persist in sandbox', () => {
    const adapter = createReasonixAdapter('/usr/bin/reasonix');
    const p = buildFsPolicy(ctx({
      platform: 'linux',
      homeDir: '/home/u',
      botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      workingDir: '/home/u/proj',
      redirectedCliData: false,
      authPaths: adapter.authPaths?.map(path => path.replace(/^~/, '/home/u')),
    }));
    for (const path of [
      '/home/u/.reasonix/machine-id.key',
      '/home/u/.reasonix/projects/-home-u-proj/sessions/s.jsonl.lease.json',
      '/home/u/.reasonix/skills/botmux-send/SKILL.md',
    ]) {
      expect(accessForPath(p.rules, path).access).toBe('readWrite');
    }
  });

  it('darwin baseline: system ro, scratch rw, crown jewels denied, lark-cli store denied', () => {
    const p = buildFsPolicy(ctx());
    expect(accessForPath(p.rules, '/System/Library/Frameworks/x').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/usr/bin/env').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/private/var/folders/ab/T/x').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.ssh/id_rsa').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/Library/Application Support/lark-cli/appsecret.enc').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/Library/Keychains/login.keychain').access).toBe('deny');
    // ~/.botmux is NOT exposed wholesale (deny-by-default) — cross-bot secrets
    // and unlisted files are simply uncovered ('none' = inaccessible).
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_other/send-cred.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/other-project/secret').access).toBe('none');
  });

  it('readonlyRoots (traex/coco migration markers) expose the marker READ-ONLY without making sibling ~/.trae code writable', () => {
    // Regression for the traex/coco goal-mode wedge: the first-run migration
    // prompt is silenced by making ~/.trae/.coco-rollouts-migrated visible, but
    // via the readOnly channel — NOT by widening authPaths to the whole ~/.trae
    // (that root holds hooks/plugins/skills/traecli.toml, which authPaths would
    // bind readWrite and let a chat-driven sandbox mutate code other bots run).
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      authPaths: ['/home/u/.trae/cli'],
      readonlyRoots: ['/home/u/.trae/.coco-rollouts-migrated', '/home/u/.trae/.coco-migrated'],
    }));
    // markers visible read-only (mere existence gates the traecli prompt)
    expect(accessForPath(p.rules, '/home/u/.trae/.coco-rollouts-migrated').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/home/u/.trae/.coco-migrated').access).toBe('readOnly');
    // cli/ stays readWrite (SQLite state/log DBs)
    expect(accessForPath(p.rules, '/home/u/.trae/cli/state_x.sqlite').access).toBe('readWrite');
    // sibling executable/config surface stays UNwritable (deny-by-default 'none')
    expect(accessForPath(p.rules, '/home/u/.trae/hooks/hooks.json').access).toBe('none');
    expect(accessForPath(p.rules, '/home/u/.trae/plugins/p/hooks.json').access).toBe('none');
    expect(accessForPath(p.rules, '/home/u/.trae/skills/s/skill.md').access).toBe('none');
    expect(accessForPath(p.rules, '/home/u/.trae/traecli.toml').access).toBe('none');
  });

  it('language toolchains under $HOME are readable so python/perl/rust/go/etc. run; their credential files stay denied', () => {
    const p = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    // toolchains runnable (readOnly)
    for (const t of ['.pyenv/versions/3.12/bin/python', '.cargo/bin/rg', 'go/bin/tool', '.rbenv/shims/ruby', 'perl5/lib/X.pm', '.rustup/toolchains/x', '.sdkman/candidates/java/x', '.gem/ruby/x', 'Library/Python/3.9/bin/x', '.local/lib/python3.11/site-packages/x']) {
      expect(accessForPath(p.rules, `/home/u/${t}`).access).toBe('readOnly');
    }
    // but the token/credential files inside them are re-denied (deeper wins)
    expect(accessForPath(p.rules, '/home/u/.cargo/credentials.toml').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/.gem/credentials').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/.m2/settings.xml').access).toBe('deny');
    // toolchains are read-only, not writable (agent runs them, can't tamper the host toolchain)
    expect(accessForPath(p.rules, '/home/u/.cargo/registry/x').access).toBe('readOnly');
  });

  it('botmux CLI runtime surface is an ALLOW-LIST (deny-by-default): install dir + a small ~/.botmux set readable, everything else — incl. creds + cross-bot — inaccessible', () => {
    const p = buildFsPolicy(ctx({ botmuxInstallRoot: '/opt/botmux' }));
    // install dir readable (hooks exec node <install>/dist/cli.js — verified live: without this, EPERM)
    expect(accessForPath(p.rules, '/opt/botmux/dist/cli.js').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/opt/botmux/node_modules/x').access).toBe('readOnly');
    // explicitly allow-listed ~/.botmux reads the CLI/hooks need
    expect(accessForPath(p.rules, '/Users/u/.botmux/.dashboard-port').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bin/botmux').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/claude-plugin/x').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/dashboard-daemons/cli_x.json').access).toBe('readOnly'); // daemon IPC discovery
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/bots-info.json').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/bot-openids-cli_self.json').access).toBe('readOnly'); // own
    // own session store = the per-bot SQLite DIRECTORY (dir grant, not file binds:
    // SQLite recreates -wal/-shm, so a pinned inode would read a dead WAL forever)
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self/sessions.db').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self/sessions.db-wal').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self').access).toBe('readOnly');
    // …and the bot's OWN pre-SQLite `sessions-<self>.json` is NOT granted any more:
    // it is a one-shot import source the store never reads at runtime, so the
    // allow-list stops covering it (narrower surface, not a weakened assertion).
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_self.json').access).toBe('readOnly');     // own（升级窗口内仍是唯一可读的会话来源）
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/turn-sends/s.jsonl').access).toBe('readWrite');        // OWN session marker only
    // blocker #4: turn-sends is granted per-session-FILE, not the whole dir —
    // another session's marker is NOT writable (can't corrupt its send-dedup).
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/turn-sends/other.jsonl').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/turn-sends').access).toBe('none');
    // own BOT_HOME rw + own attachments ro (allow-listed elsewhere)
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_self/claude/x').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_self/m/f.pdf').access).toBe('readWrite'); // botmux quoted downloads here
    // ── everything else under ~/.botmux is DENY-BY-DEFAULT ('none') — no umbrella ──
    // credentials (codex critical finding): config.json voice keys, .env, webhook master key
    expect(accessForPath(p.rules, '/Users/u/.botmux/config.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/.env').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/webhook-master.key').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/webhook-secrets.json').access).toBe('none');
    // cross-bot content/routing (codex high finding)
    // schedules moved into per-bot BOT_HOMEs: the legacy shared path is no
    // longer granted (own store rides the BOT_HOME rw; sibling stores denied).
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/schedules.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_other/schedules.json').access).toBe('none'); // sibling store
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_other.json').access).toBe('none');
    // sibling session stores stay deny-by-default: neither the store DIR nor any
    // file in it is covered (the grant is scoped to `session-stores/<self>`).
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_other').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_other/sessions.db').access).toBe('none');
    // the shared parent is not granted either — no umbrella over every bot's store
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/bot-openids-cli_other.json').access).toBe('none'); // sibling
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_other/send-cred.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/logs/daemon-0.log').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_other/m/f.pdf').access).toBe('none');
    // a file created AFTER spawn (codex #3 fail-open) is ALSO denied — allow-list, not enumeration
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_futureBot.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_futureBot/sessions.db').access).toBe('none');
  });

  it('lark-cli key store: OWN appsecret + master.key readable, siblings denied (verified live: without this `lark-cli auth` fails EPERM)', () => {
    const p = buildFsPolicy(ctx()); // currentAppId = cli_self
    const store = '/Users/u/Library/Application Support/lark-cli';
    // own material re-allowed (deeper than the store deny)
    expect(accessForPath(p.rules, `${store}/master.key.file`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('readOnly');
    // siblings' ciphertext + tokens stay denied → master key alone can't decrypt them
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/cli_other_ou_x.enc`).access).toBe('deny');
    // linux never emits the macOS `Library/…` keystore rule (it has its OWN store
    // carve-out under ~/.local/share/lark-cli — asserted in the next test)
    const lin = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    expect(lin.rules.some(r => r.path.includes('Library/Application Support/lark-cli'))).toBe(false);
  });

  it('LINUX lark-cli key store: OWN appsecret + master.key readable, siblings/token/future-file denied, toolchain not clobbered (cross-bot leak fix)', () => {
    // lark-cli on Linux writes keys to `$HOME/.local/share/lark-cli` (or `<LARKSUITE_CLI_DATA_DIR>/lark-cli`)
    // (verified live: appsecret_<appId>.enc + master.key, NOT master.key.file), which
    // the baseline `ro(~/.local/share)` grant otherwise exposed read-only to every
    // sandboxed bot — the cross-bot impersonation hole macOS already closed. This is
    // the Linux mirror of the darwin carve-out test above.
    const linCtx = { platform: 'linux' as const, homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' };
    const p = buildFsPolicy(ctx(linCtx)); // currentAppId = cli_self, default store
    const store = '/home/u/.local/share/lark-cli';
    // own material re-allowed (deeper than the store deny → longest-prefix-wins)
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('readOnly');
    // the store DIR itself is denied — the pre-fix `ro(~/.local/share)` exposure
    expect(accessForPath(p.rules, store).access).toBe('deny');
    // siblings' ciphertext + user tokens stay denied → master key can't decrypt them
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/cli_other_ou_x.enc`).access).toBe('deny');
    // future files under the store are denied-by-default (deny of the whole dir)
    expect(accessForPath(p.rules, `${store}/future_new_secret.enc`).access).toBe('deny');
    // darwin's master.key.file NAME does NOT get a Linux carve-out (Linux uses master.key)
    expect(accessForPath(p.rules, `${store}/master.key.file`).access).toBe('deny');
    // the REST of ~/.local/share (toolchains: pipx, bytedcli SSO, etc.) stays readable
    // — the deny is scoped to the lark-cli subdir, not the whole default data root.
    expect(accessForPath(p.rules, '/home/u/.local/share/some-toolchain/bin').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/home/u/.local/share/bytedcli/data/sso.json').access).toBe('readOnly');
  });

  it('LINUX lark-cli key store: BOTH the custom store AND the default are locked (no dependence on the lark-cli env-value validator); darwin unaffected', () => {
    // A custom LARKSUITE_CLI_DATA_DIR moves the store OUT of ~/.local/share. lark-cli
    // opens EITHER the custom store (value accepted) OR the default (value rejected by its
    // control-char/bidi validator, which we do NOT replicate). So the policy locks BOTH:
    // deny both dirs + carve own keys in both. Whichever lark-cli picks, siblings + master
    // stay denied (no leak) and own keys are readable (auth works).
    const store = '/data00/cli-data/lark-cli';
    const dflt = '/home/u/.local/share/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      larkCliLinuxStore: store,
    }));
    // custom store: own keys RO, siblings + dir denied
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, store).access).toBe('deny');
    // DEFAULT store ALSO locked (the fix): own keys RO there too, siblings denied — so if
    // lark-cli rejected the custom value and fell back here, the shared keystore is NOT
    // left exposed read-only under baseline ro(~/.local/share).
    expect(accessForPath(p.rules, dflt).access).toBe('deny');
    expect(accessForPath(p.rules, `${dflt}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${dflt}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${dflt}/appsecret_cli_self.enc`).access).toBe('readOnly');
    // darwin never emits a Linux store rule even when larkCliLinuxStore is set
    const dar = buildFsPolicy(ctx({ larkCliLinuxStore: store }));
    expect(dar.rules.some(r => r.path === store)).toBe(false);
  });

  it('LINUX lark-cli key store: default-only case (no custom store) dedupes to ONE store, unchanged behavior', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      // larkCliLinuxStore omitted → resolver default == /home/u/.local/share/lark-cli
    }));
    const dflt = '/home/u/.local/share/lark-cli';
    expect(accessForPath(p.rules, `${dflt}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${dflt}/appsecret_cli_other.enc`).access).toBe('deny');
    // exactly ONE deny rule for the store path (resolved == default, deduped)
    expect(p.rules.filter(r => r.path === dflt && r.access === 'deny')).toHaveLength(1);
  });

  it('LINUX symlinked-leaf degrade precondition: when the canonical custom store basename != lark-cli (child falls back to default), BOTH the custom AND default stores are locked (no leak on fallback)', () => {
    // The symlinked-leaf case: worker resolved larkCliLinuxStore to a canonical dir whose
    // basename is NOT `lark-cli` (e.g. `data/lark-cli` → `elsewhere/keys`), so
    // larkCliChildDataRoot returns null and the child degrades to the DEFAULT store. That
    // degrade is only SAFE if the policy locks BOTH the canonical custom store AND the
    // default (the safety precondition) — else the store the child actually opens on
    // fallback would be exposed. Assert both are deny+own-carve, siblings denied in both.
    const customCanon = '/data00/elsewhere/keys';   // canonical custom (basename 'keys')
    const dflt = '/home/u/.local/share/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      larkCliLinuxStore: customCanon,
    }));
    for (const s of [customCanon, dflt]) {
      expect(accessForPath(p.rules, s).access).toBe('deny');
      expect(accessForPath(p.rules, `${s}/appsecret_cli_other.enc`).access).toBe('deny');     // sibling — no leak
      expect(accessForPath(p.rules, `${s}/master.key`).access).toBe('readOnly');              // own auth works on either
      expect(accessForPath(p.rules, `${s}/appsecret_cli_self.enc`).access).toBe('readOnly');
    }
  });

  it('LINUX lark-cli key store NESTED INSIDE BOT_HOME (LARKSUITE_CLI_DATA_DIR=<BOT_HOME>): own keys RO, siblings deny — transport', () => {
    // nested-authority surface: a deployment may set LARKSUITE_CLI_DATA_DIR into BOT_HOME so
    // the store resolves to `<BOT_HOME>/lark-cli`. The transport carve-out must STILL
    // isolate — the store deny + own-key carve-out ride on top of the BOT_HOME rw grant
    // (deeper prefix wins), so siblings/master stay isolated even though the whole
    // BOT_HOME is otherwise writable.
    const botHome = '/home/u/.botmux/bots/cli_self';
    const store = `${botHome}/lark-cli`;
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome,
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      larkCliLinuxStore: store,
    }));
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    // BOT_HOME scratch OUTSIDE the store stays writable (the carve-out is scoped)
    expect(accessForPath(p.rules, `${botHome}/scratch.txt`).access).toBe('readWrite');
  });

  it('LINUX lark-cli key store EXACTLY ON BOT_HOME (store===botHome): store deny outranks the BOT_HOME rw grant — transport', () => {
    // Equality edge of the nested-authority fix: a deployment can wire the store ONTO
    // BOT_HOME itself (appId 'lark-cli' — assertSafeAppId is charset-only, no `cli_`
    // prefix enforcement — plus LARKSUITE_CLI_DATA_DIR=<botmuxHome>/bots). The internal
    // BOT_HOME readWrite grant then lands on the SAME path as the store deny; the deny
    // must be tagged `mandatory` (rank 4 > internal 2) or the whole keystore — siblings
    // included — goes readWrite by same-path source rank. Own-key carve-outs still win by depth.
    const botHome = '/home/u/.botmux/bots/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome, currentAppId: 'lark-cli',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      larkCliLinuxStore: botHome,
    }));
    expect(accessForPath(p.rules, botHome).access).toBe('deny');
    expect(accessForPath(p.rules, `${botHome}/master.key`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${botHome}/appsecret_lark-cli.enc`).access).toBe('readOnly');
    expect(accessForPath(p.rules, `${botHome}/appsecret_cli_other.enc`).access).toBe('deny');
  });

  it('internal injections: workingDir + BOT_HOME rw, own session store + attachments ro; siblings uncovered', () => {
    const p = buildFsPolicy(ctx());
    expect(accessForPath(p.rules, '/Users/u/proj/src/x.ts').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_self/claude/x.jsonl').access).toBe('readWrite');
    // own session store: the per-bot SQLite dir (and everything inside it) is ro
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self/sessions.db').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self/sessions.db-shm').access).toBe('readOnly');
    // the legacy `sessions-<self>.json` is a one-shot import source, never read at
    // runtime → deliberately NOT granted (was readOnly before the SQLite-only cut)
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_self.json').access).toBe('readOnly');     // own（升级窗口内仍是唯一可读的会话来源）
    // siblings simply not covered under the allow-list → inaccessible
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_other.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_other').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_other/sessions.db').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_self/m1/f.pdf').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_other/m1/f.pdf').access).toBe('none');
  });

  it('own role-library subtree is rw (enumerate/switch/create roles + post-switch knowledge writes); sibling bots’ libraries stay uncovered', () => {
    const p = buildFsPolicy(ctx({ roleLibrarySubtree: '/Users/u/botmux-roles/cli_self' }));
    // library-root protocol file the 新建角色 flow copies into each new role dir
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/_role-protocol.md').access).toBe('readWrite');
    // sibling role dirs 「切换角色」 enumerates, and their display-name metadata
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/shared/pm/.botmux-dir.json').access).toBe('readWrite');
    // 「新建角色」 writes under users/<openId>/<slug>/
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/users/ou_x/xhs-ops/CLAUDE.md').access).toBe('readWrite');
    // 「沉淀知识」 writes knowledge/ in whatever role is active AFTER a switch —
    // this is why the grant is rw, not ro (a ro grant only EPERMs at this step).
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/shared/pm/knowledge/INDEX.md').access).toBe('readWrite');
    // scoped per-appId: another bot's library (incl. its users' private roles)
    // stays denied by construction, and the shared root itself is not granted.
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_other/shared/default/CLAUDE.md').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_other/users/ou_y/secret/CLAUDE.md').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/botmux-roles').access).toBe('none');
    // the owner can still lock it back down: a user rule outranks the internal
    // grant at the same path (user > internal), and a nested deny wins by depth.
    const off = buildFsPolicy(ctx({
      roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
      userPaths: { deny: ['/Users/u/botmux-roles/cli_self'] },
    }));
    expect(accessForPath(off.rules, '/Users/u/botmux-roles/cli_self/shared/pm/CLAUDE.md').access).toBe('deny');
  });

  it('an ANCESTOR deny (owner or mandatory) suppresses the role-library grant — longest-prefix-wins must not punch a hole in it', () => {
    // source rank only settles same-path conflicts; without the suppression the
    // deeper internal rw would re-open <appId> under a denied library root.
    for (const key of ['userPaths', 'mandatoryDenyPaths'] as const) {
      const p = buildFsPolicy(ctx({
        roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
        ...(key === 'userPaths'
          ? { userPaths: { deny: ['/Users/u/botmux-roles'] } }
          : { mandatoryDenyPaths: ['/Users/u/botmux-roles'] }),
      }));
      expect(p.rules.some(r => r.path === '/Users/u/botmux-roles/cli_self')).toBe(false);
      expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/shared/pm/CLAUDE.md').access).toBe('deny');
    }
    // baseline deny counts too (defence-in-depth: a canonical library path
    // shouldn't be able to land inside a crown jewel, but that's not a check).
    const inJewel = buildFsPolicy(ctx({ roleLibrarySubtree: '/Users/u/.ssh/roles/cli_self' }));
    expect(inJewel.rules.some(r => r.path === '/Users/u/.ssh/roles/cli_self')).toBe(false);
    expect(accessForPath(inJewel.rules, '/Users/u/.ssh/roles/cli_self/x').access).toBe('deny');
    // a mandatory deny REGEX matching the subtree also suppresses it: compileToBwrap
    // does not consume denyRegexes at all, so on Linux an rw grant inside a
    // regex-denied tree would simply win (Seatbelt emits regex denies last).
    const rx = buildFsPolicy(ctx({
      roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
      mandatoryDenyRegexes: ['^/Users/u/botmux-roles/'],
    }));
    expect(rx.rules.some(r => r.path === '/Users/u/botmux-roles/cli_self')).toBe(false);
    // an unusable regex must not be a grant decision either way (no throw, rule kept)
    const badRx = buildFsPolicy(ctx({
      roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
      mandatoryDenyRegexes: ['([unclosed'],
    }));
    expect(badRx.rules.some(r => r.path === '/Users/u/botmux-roles/cli_self')).toBe(true);
  });

  it('a covering readOnly (owner or mandatory) DOWNGRADES the grant to readOnly instead of silently upgrading to rw', () => {
    // Same longest-prefix trap as the deny case: an owner who marks the library
    // read-only must not get a writable `<appId>` hole. Downgrading (not dropping)
    // keeps enumerate/switch working — only the knowledge write fails.
    for (const key of ['userPaths', 'mandatoryReadOnlyPaths'] as const) {
      const p = buildFsPolicy(ctx({
        roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
        ...(key === 'userPaths'
          ? { userPaths: { readOnly: ['/Users/u/botmux-roles'] } }
          : { mandatoryReadOnlyPaths: ['/Users/u/botmux-roles'] }),
      }));
      expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/shared/pm/CLAUDE.md').access).toBe('readOnly');
      expect(p.rules.find(r => r.path === '/Users/u/botmux-roles/cli_self')?.access).toBe('readOnly');
    }
    // deny still beats readOnly when both cover it → no rule at all
    const both = buildFsPolicy(ctx({
      roleLibrarySubtree: '/Users/u/botmux-roles/cli_self',
      userPaths: { readOnly: ['/Users/u/botmux-roles'], deny: ['/Users/u/botmux-roles'] },
    }));
    expect(both.rules.some(r => r.path === '/Users/u/botmux-roles/cli_self')).toBe(false);
  });

  it('no role-library rule at all when the subtree is absent (bot never used roles)', () => {
    const p = buildFsPolicy(ctx());
    expect(p.rules.some(r => r.path.includes('botmux-roles'))).toBe(false);
    expect(accessForPath(p.rules, '/Users/u/botmux-roles/cli_self/shared/default/CLAUDE.md').access).toBe('none');
  });

  it('user paths take precedence and support nested deny', () => {
    const p = buildFsPolicy(ctx({
      userPaths: {
        readWrite: ['/Users/u/my-data'],
        readOnly: ['/Users/u/ref'],
        deny: ['/Users/u/my-data/secrets'],
      },
    }));
    expect(accessForPath(p.rules, '/Users/u/my-data/a.txt').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/my-data/secrets/k').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/ref/doc.md').access).toBe('readOnly');
  });

  it('non-redirected CLI data stays rw at real paths', () => {
    const p = buildFsPolicy(ctx({
      redirectedCliData: false,
      cliDataPaths: ['/Users/u/.claude', '/Users/u/.claude.json'],
    }));
    expect(accessForPath(p.rules, '/Users/u/.claude/projects/x.jsonl').access).toBe('readWrite');
    const redirected = buildFsPolicy(ctx({ redirectedCliData: true, cliDataPaths: ['/Users/u/.claude'] }));
    expect(accessForPath(redirected.rules, '/Users/u/.claude/projects/x.jsonl').access).toBe('none');
  });

  it('authPaths at the policy layer are always rw (redirect suppression happens upstream in the worker)', () => {
    // The policy builder itself does NOT know about redirect for auth — whatever
    // authPaths it's handed become rw. The redirect-aware SUPPRESSION is the
    // worker's job (authPathsSurvivingCliDataRedirect, asserted separately below).
    // This just pins that a non-suppressed authPath is rw so the two layers compose.
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      workingDir: '/home/u/proj', botHome: '/home/u/.botmux/bots/cli_self',
      redirectedCliData: true,
      authPaths: ['/home/u/.local/share/bytedcli'], // a survivor the worker kept
    }));
    expect(accessForPath(p.rules, '/home/u/.local/share/bytedcli/data/sso_session.json').access).toBe('readWrite');
  });
});

describe('resolveRedirectedAdapterAuthPaths (redirect authPath suppression)', () => {
  // The four redirect-eligible adapters (supportsReadIsolation===true): claude-code,
  // codex, seed, relay. Rule: drop authPaths INSIDE a rehomed host data root; keep
  // authPaths OUTSIDE it. rehomed roots = claude-family host claudeDataDir + codex ~/.codex.
  // These call the SAME resolver the worker calls (not a re-implementation).
  const resolve4 = (declaredAuthPaths: string[], rehomedHostRoots: string[]) =>
    resolveRedirectedAdapterAuthPaths({ declaredAuthPaths, willRedirectCliData: true, rehomedHostRoots });

  it('not redirected → declared authPaths pass through verbatim', () => {
    expect(resolveRedirectedAdapterAuthPaths({
      declaredAuthPaths: ['/home/u/.codex', '/home/u/.local/share/bytedcli'],
      willRedirectCliData: false,
      rehomedHostRoots: ['/home/u/.codex'], // ignored when not redirecting
    })).toEqual(['/home/u/.codex', '/home/u/.local/share/bytedcli']);
  });

  it('claude-code: ~/.claude/.credentials.json is inside ~/.claude → dropped (BOT_HOME copy is provisioned)', () => {
    expect(resolve4(['/home/u/.claude/.credentials.json'], ['/home/u/.claude'])).toEqual([]);
  });

  it('codex: ~/.codex is the rehomed root itself → dropped (this is the host-dir leak fix)', () => {
    expect(resolve4(['/home/u/.codex'], ['/home/u/.codex'])).toEqual([]);
  });

  it('seed/relay: ~/.local/share/bytedcli is OUTSIDE the data root → kept (external SSO login source)', () => {
    // relay: dataDir ~/.relay; seed: dataDir <pkg>/.claude-runtime. bytedcli is
    // outside both → must survive or cold-start login regresses. byted-cloud-auth
    // (inside the data root) is dropped — it is never the redirected read location
    // anyway (CLI reads $CLAUDE_CONFIG_DIR/byted-cloud-auth.json = BOT_HOME/claude).
    expect(resolve4(
      ['/home/u/.local/share/bytedcli', '/home/u/.relay/byted-cloud-auth.json'],
      ['/home/u/.relay'],
    )).toEqual(['/home/u/.local/share/bytedcli']);
    expect(resolve4(
      ['/home/u/.local/share/bytedcli', '/opt/relay/.claude-runtime/byted-cloud-auth.json'],
      ['/opt/relay/.claude-runtime'],
    )).toEqual(['/home/u/.local/share/bytedcli']);
  });

  it('path boundary: a sibling like ~/.relay2 is NOT judged inside ~/.relay', () => {
    // coversPath requires exact match or a `${root}/` prefix, so a lexical
    // prefix that is not a real ancestor must survive.
    expect(resolve4(['/home/u/.relay2/x'], ['/home/u/.relay'])).toEqual(['/home/u/.relay2/x']);
    expect(resolve4(['/home/u/.codexvault'], ['/home/u/.codex'])).toEqual(['/home/u/.codexvault']);
  });

  it('multiple rehomed roots + normalization (trailing slash, empty entries)', () => {
    expect(resolve4(
      ['/home/u/.claude/.credentials.json', '/home/u/.local/share/bytedcli', '/home/u/.codex/auth.json'],
      ['/home/u/.claude/', '/home/u/.codex'], // trailing slash normalized
    )).toEqual(['/home/u/.local/share/bytedcli']);
    // empty / unusable entries are filtered, not crashing
    expect(authPathsSurvivingCliDataRedirect(['', '/home/u/x'], [''])).toEqual(['/home/u/x']);
  });

  it('LEXICAL containment: a leaf declared inside the root is dropped by its DECLARED path, not its realpath', () => {
    // The resolver decides containment purely on the (lexical) strings it's given.
    // The worker MUST pass lexically-expanded (not realpath'd) paths — asserted in
    // WIRING GUARD below — so that a symlinked-out leaf like
    // ~/.claude/.credentials.json → /external/creds is still judged INSIDE ~/.claude
    // and dropped. If the worker instead realpath'd first, the resolver would see
    // /external/creds (outside the root) and wrongly KEEP it → the real host
    // credential gets RW-bound back into the sandbox. This asserts the resolver's
    // half: given the declared (lexical) leaf, it drops it.
    expect(resolve4(['/home/u/.claude/.credentials.json'], ['/home/u/.claude'])).toEqual([]);
    // …and if a caller wrongly pre-resolved the leaf to an external target, the
    // resolver can only honor what it's handed — documenting WHY the worker must
    // filter lexically (the KEEP here is the bug the worker-order + guard prevent).
    expect(resolve4(['/external/creds/claude.json'], ['/home/u/.claude'])).toEqual(['/external/creds/claude.json']);
  });

  it('WIRING GUARD: worker.ts assembles authPaths via resolveRedirectedAdapterAuthPaths, filtered in ONE LEXICAL HOME namespace then keepExisting', () => {
    // A pure-fn test alone can't catch the worker dropping/reverting the call or
    // passing wrong roots (the blind spot that let the first cut miss Seed/Relay),
    // the ORDER bug (realpath before containment leaks a symlinked-out leaf), nor
    // the NAMESPACE bug (codex #605 P1: expanding declaredAuthPaths with the
    // CANONICAL home `sandboxHome` while `cliAdapter.claudeDataDir` is lexical →
    // coversPath misses under a symlinked $HOME → the host credential leaks back in).
    // Assert the actual call site in worker.ts source: it must (a) produce authPaths
    // by keepExisting-wrapping the resolver, (b) feed the resolver declared paths
    // expanded with the LEXICAL home (expandTildeLexical, NOT keepExisting/realpath
    // first, NOT the canonical expandTilde), (c) thread willRedirectCliData, (d)
    // build rehomedHostRoots from cliAdapter.claudeDataDir + the LEXICAL codex host
    // root, also lexically expanded — both sides in the same namespace.
    const src = readFileSync(resolve('src/worker.ts'), 'utf8');
    // (a) survivors are realpath/existence-filtered AFTER the resolver, not before.
    expect(src).toMatch(/authPaths:\s*keepExisting\(resolveRedirectedAdapterAuthPaths\(\{/);
    // (b) declared authPaths reach the resolver via the LEXICAL expander, not keepExisting, not canonical expandTilde.
    expect(src).toMatch(/declaredAuthPaths:\s*\[\.\.\.\(cliAdapter\.authPaths[\s\S]*?\)\]\.map\(expandTildeLexical\)/);
    // (c) the redirect flag is threaded in.
    expect(src).toMatch(/resolveRedirectedAdapterAuthPaths\(\{[\s\S]*?willRedirectCliData,/);
    // (d) rehomed roots = adapter host data dir + codex host root, LEXICAL home, lexically expanded.
    expect(src).toMatch(/rehomedHostRoots:\s*\[cliAdapter\.claudeDataDir,\s*isolatedCodexHome\s*\?\s*`\$\{lexicalHome\}\/\.codex`/);
    expect(src).toMatch(/rehomedHostRoots:[\s\S]*?\.map\(expandTildeLexical\)/);
    // negative: the resolver must NOT be fed keepExisting/realpath'd paths (the leak-order bug).
    expect(src).not.toMatch(/declaredAuthPaths:\s*keepExisting\(/);
    // negative: containment must NOT use the CANONICAL home expander on either side
    // (the #605 P1 namespace bug — canonical vs lexical divergence under symlinked $HOME).
    expect(src).not.toMatch(/declaredAuthPaths:\s*\[\.\.\.\(cliAdapter\.authPaths[\s\S]*?\)\]\.map\(expandTilde\)(?!Lexical)/);
    expect(src).not.toMatch(/isolatedCodexHome\s*\?\s*`\$\{sandboxHome\}\/\.codex`/);
  });

  it('WIRING GUARD: worker routes exact service credentials through their dedicated policy channel', () => {
    const src = readFileSync(resolve('src/worker.ts'), 'utf8');
    expect(src).toContain("import { resolveServiceSecretReadonlyFiles } from './adapters/cli/service-secret-files.js';");
    expect(src).toMatch(/const serviceCredentialReadOnlyPaths\s*=\s*resolveServiceSecretReadonlyFiles\([\s\S]*?cliAdapter\.sandboxSecretReadonlyPaths/);
    expect(src).toMatch(/const fsPolicyCtx[\s\S]*?serviceCredentialReadOnlyPaths,/);
    expect(src).not.toContain('mandatoryReadOnlyPaths.push(...keepSecretReadonlyFiles');
    expect(src).toContain("if (cliAdapter.id === 'ebsd') assertEbsdPerBotEnv(perBotInjectEnv);");
  });

  it('WIRING GUARD: worker pre-creates and carves the same effective OMP sid used by launch/resume args', () => {
    const src = readFileSync(resolve('src/worker.ts'), 'utf8');
    expect(src).toContain("import { ompSessionDir } from './adapters/cli/oh-my-pi.js';");
    expect(src).toMatch(/ompCurrentSessionDir\s*=\s*cliAdapter\.id === 'oh-my-pi'[\s\S]*?ompSessionDir\(effectiveAdapterSessionId\)/);
    // ebsd shares the same exact-session carve-out shape through its own
    // adapter-owned session dir; both feed the generalized managed dir.
    expect(src).toMatch(/import \{[^}]*ebsdBotmuxSessionDir[^}]*\} from '\.\/adapters\/cli\/ebsd\.js';/);
    expect(src).toMatch(/ebsdCurrentSessionDir\s*=\s*cliAdapter\.id === 'ebsd'[\s\S]*?ebsdBotmuxSessionDir\(effectiveAdapterSessionId\)/);
    expect(src).toContain('const managedCurrentSessionDir = ompCurrentSessionDir ?? ebsdCurrentSessionDir;');
    const precreate = src.indexOf('if (managedCurrentSessionDir) mkdirSync(managedCurrentSessionDir');
    const policyAssembly = src.indexOf('const fsPolicyCtx =', precreate);
    expect(precreate).toBeGreaterThan(-1);
    expect(policyAssembly).toBeGreaterThan(precreate);
    expect(src).toContain("relative(canonicalManagedSessionsRoot, canonicalManagedSessionDir) !== join('botmux', effectiveAdapterSessionId)");
    expect(src).toContain('mandatoryDenyPaths.push(canonicalManagedSessionsRoot)');
    expect(src).toContain('extraWritePaths: keepExisting([process.env.TMPDIR, canonicalManagedSessionDir])');
  });

  it('SYMLINKED-HOME regression (codex #605 P1): worker-assembly under /home/u → /data00/home/u keeps Claude/Codex dropped, Seed/Relay bytedcli kept', () => {
    // The matrix above hand-matches lexical strings on BOTH sides, so it never
    // exercises the canonical-vs-lexical home divergence the worker actually
    // produces. This models the REAL worker assembly on a symlinked $HOME:
    //   sandboxHome  = canonical(homedir()) = /data00/home/u   (used for BINDS)
    //   lexicalHome  = homedir()            = /home/u          (used for CONTAINMENT)
    //   claudeDataDir = join(homedir(),'.claude') = /home/u/.claude   (LEXICAL)
    // The fix expands declaredAuthPaths + rehomedHostRoots with the LEXICAL home so
    // both sides of coversPath share one namespace. If the worker regressed to the
    // canonical `sandboxHome` for declaredAuthPaths (the bug), Claude/Codex authPaths
    // would canonicalize to /data00/home/u/... , miss the /home/u/... roots, and leak.
    const lexicalHome = '/home/u';
    const canonicalHome = '/data00/home/u'; // realpath(homedir()) — MUST NOT be used for containment
    // The exact expander the worker uses for containment (lexical, raw homedir()).
    const expandTildeLexical = (raw: string) => raw.replace(/^~(?=\/|$)/, lexicalHome);
    // The buggy canonical expander — proving it would leak if wired for containment.
    const expandTildeCanonical = (raw: string) => raw.replace(/^~(?=\/|$)/, canonicalHome);
    const claudeDataDir = `${lexicalHome}/.claude`; // = join(homedir(),'.claude')

    const workerAssemble = (
      adapterAuthPaths: string[],
      dataDir: string,
      isolatedCodex: boolean,
      expand: (r: string) => string,
    ) => resolveRedirectedAdapterAuthPaths({
      declaredAuthPaths: adapterAuthPaths.map(expand),
      willRedirectCliData: true,
      rehomedHostRoots: [dataDir, isolatedCodex ? `${lexicalHome}/.codex` : undefined]
        .filter((r): r is string => !!r)
        .map(expand),
    });

    // Claude: ~/.claude/.credentials.json → dropped (BOT_HOME copy is provisioned).
    expect(workerAssemble(['~/.claude/.credentials.json'], claudeDataDir, false, expandTildeLexical)).toEqual([]);
    // Codex: ~/.codex is the rehomed root itself → dropped (headline leak fix, must
    // survive the lexical namespace change).
    expect(workerAssemble(['~/.codex'], claudeDataDir, true, expandTildeLexical)).toEqual([]);
    // Seed/Relay: bytedcli (outside data root) kept; byted-cloud-auth (inside) dropped.
    expect(workerAssemble(
      ['~/.local/share/bytedcli', `${lexicalHome}/.relay/byted-cloud-auth.json`],
      `${lexicalHome}/.relay`, false, expandTildeLexical,
    )).toEqual([`${lexicalHome}/.local/share/bytedcli`]);

    // PROOF the namespace matters: with the CANONICAL expander (the bug), the Claude
    // credential canonicalizes to /data00/home/u/... , escapes the lexical /home/u/.claude
    // root, and WRONGLY survives → this is exactly the P1 leak the fix closes.
    expect(workerAssemble(['~/.claude/.credentials.json'], claudeDataDir, false, expandTildeCanonical))
      .toEqual([`${canonicalHome}/.claude/.credentials.json`]);
  });
});

describe('buildFsPolicy (baseline + net)', () => {
  it('linux baseline: toolchain ro, no darwin paths', () => {
    const p = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    expect(accessForPath(p.rules, '/usr/lib/x.so').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/etc/ssl/certs/ca.pem').access).toBe('readOnly');
    expect(p.rules.some(r => r.path.startsWith('/System'))).toBe(false);
  });

  it('net defaults true; false only when explicitly disabled', () => {
    expect(buildFsPolicy(ctx()).net).toBe(true);
    expect(buildFsPolicy(ctx({ net: false })).net).toBe(false);
  });
});

describe('ancestorsNeedingTraverse', () => {
  it('collects strict ancestors of non-deny rules only', () => {
    const rules = mergeFsRules([
      { path: '/a/b/c', access: 'readWrite', source: 'user' },
      { path: '/x/y', access: 'deny', source: 'user' },
    ]);
    const anc = ancestorsNeedingTraverse(rules);
    expect(anc).toContain('/a');
    expect(anc).toContain('/a/b');
    expect(anc).toContain('/');
    expect(anc).not.toContain('/x'); // deny-only subtree needs no traverse
    expect(anc).not.toContain('/a/b/c');
  });
});

describe('compileToSeatbelt', () => {
  const policy = () => buildFsPolicy(ctx({
    userPaths: { deny: ['/Users/u/proj/secrets'] },
  }));

  it('deny-by-default header: (deny default) + Apple bsd.sb base + op re-grants', () => {
    const prof = compileToSeatbelt(policy());
    const lines = prof.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
    expect(lines[2]).toBe('(import "/System/Library/Sandbox/Profiles/bsd.sb")');
    expect(prof).toContain('(allow process*)');
    expect(prof).toContain('(allow network*)'); // net defaults true
  });

  // Regression: bsd.sb carries no iokit rule, so without this grant `(deny default)`
  // kills every IOServiceOpen — Chromium (headless screenshots) SIGSEGVs inside
  // IOKit with no sandbox diagnostic. See the e2e for the live proof.
  it('grants iokit-open (bsd.sb has none; missing it SIGSEGVs Chromium)', () => {
    expect(compileToSeatbelt(policy())).toContain('(allow iokit-open)');
  });

  it('omits network grants when net is disabled', () => {
    const prof = compileToSeatbelt(buildFsPolicy(ctx({ net: false })));
    expect(prof).not.toContain('(allow network*)');
    expect(prof).toContain('(allow iokit-open)'); // not gated on net
  });

  it('deeper rules are emitted later (last-match wins)', () => {
    const prof = compileToSeatbelt(policy());
    const rwProj = prof.indexOf('(allow file-write* (subpath "/Users/u/proj"))');
    const denySecrets = prof.indexOf('(deny file-write* (subpath "/Users/u/proj/secrets"))');
    expect(rwProj).toBeGreaterThan(-1);
    expect(denySecrets).toBeGreaterThan(rwProj);
  });

  it('ancestor traverse grants come AFTER rules so nested allows survive a broad deny', () => {
    const prof = compileToSeatbelt(compilePolicyWithNestedAllow());
    const denyIdx = prof.indexOf('(deny file-read* (subpath "/data/bots"))');
    const metaIdx = prof.indexOf('(allow file-read-metadata (literal "/data/bots"))');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(metaIdx).toBeGreaterThan(denyIdx);
  });

  it('readOnly re-asserts write-deny (ro inside rw tree drops write)', () => {
    const p = buildFsPolicy(ctx({ userPaths: { readOnly: ['/Users/u/proj/vendor'] } }));
    const prof = compileToSeatbelt(p);
    const rwProj = prof.indexOf('(allow file-write* (subpath "/Users/u/proj"))');
    const roVendor = prof.indexOf('(deny file-write* (subpath "/Users/u/proj/vendor"))');
    expect(roVendor).toBeGreaterThan(rwProj);
  });

  it('escapes quotes in paths', () => {
    const p = buildFsPolicy(ctx({ userPaths: { readOnly: ['/Users/u/we"ird'] } }));
    expect(compileToSeatbelt(p)).toContain('\\"');
  });

  function compilePolicyWithNestedAllow() {
    return {
      rules: mergeFsRules([
        { path: '/data/bots', access: 'deny', source: 'internal' },
        { path: '/data/bots/self', access: 'readWrite', source: 'internal' },
      ] as FsRule[]),
      net: true,
      writeRegexes: [],
    };
  }
});

describe('compileToBwrap', () => {
  const opts = { emptyDir: '/sbx/empty', emptiesDir: '/sbx/empties', chdir: '/home/u/proj' };

  it('tmpfs root + primitives + ordered binds', () => {
    const p = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    const { args } = compileToBwrap(p, opts);
    expect(args.slice(0, 2)).toEqual(['--tmpfs', '/']);
    expect(args).toContain('--proc');
    const roUsr = args.indexOf('/usr');
    expect(args[roUsr - 1]).toBe('--ro-bind');
    const rwProj = args.indexOf('/home/u/proj');
    expect(args[rwProj - 1]).toBe('--bind');
    expect(args).toContain('--chdir');
  });

  it('default: emits --unshare-pid (full process isolation) alongside the fresh --proc mount', () => {
    const p = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    const { args } = compileToBwrap(p, opts);
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-user');
    expect(args).toContain('--proc');
  });

  it('skipPidNamespace: drops ONLY --unshare-pid, keeps the fresh --proc mount + every other unshare + the FS masks', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/secrets'] },
    }));
    const { args } = compileToBwrap(p, { ...opts, skipPidNamespace: true });
    // The nested-sandbox failure was --unshare-pid + fresh --proc; drop ONLY the
    // pid unshare. Everything else (incl. the fresh proc mount) stays.
    expect(args).not.toContain('--unshare-pid');
    expect(args).toContain('--proc');
    expect(args).toContain('--unshare-user');   // credential-relevant uid map + best-effort environ block
    expect(args).toContain('--unshare-ipc');
    expect(args).toContain('--unshare-uts');
    expect(args).toContain('--unshare-cgroup-try');
    // The on-disk credential seal (deny mask) is UNAFFECTED by the pid degrade.
    const mask = args.indexOf('/home/u/proj/secrets');
    expect(mask).toBeGreaterThan(-1);
    expect(args[mask - 1]).toBe('/sbx/empty');
    expect(args[mask - 2]).toBe('--ro-bind');
  });

  it('deny under an exposed tree masks with a READ-ONLY empty-dir bind (not writable tmpfs); unreachable deny is skipped', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/secrets', '/home/u/never-exposed/x'] },
    }));
    const { args, maskMounts } = compileToBwrap(p, opts);
    const mask = args.indexOf('/home/u/proj/secrets');
    // real deny = read-only empty bind, NOT `--tmpfs` (which is writable inside)
    expect(args[mask - 1]).toBe('/sbx/empty');
    expect(args[mask - 2]).toBe('--ro-bind');
    const bind = args.indexOf('/home/u/proj');
    expect(mask).toBeGreaterThan(bind); // deeper mask after the bind it punches
    expect(args).not.toContain('/home/u/never-exposed/x');
    // no writable tmpfs mask leaked in for the deny path
    expect(args.indexOf('--tmpfs', bind)).not.toBe(mask - 1);
    // the reachable deny is reported as a dir-shaped mask mountpoint
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/secrets', kind: 'dir' });
    expect(maskMounts.some(m => m.path === '/home/u/never-exposed/x')).toBe(false);
  });

  it('MASKS a reachable deny even when it does not exist yet (no skip — closes the mkdir/TOCTOU hole)', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/secrets'] },
    }));
    // The compiler is host-stat-free: a reachable deny is ALWAYS masked (dir
    // shape unless the worker flagged it a file). The worker pre-creates the
    // mountpoint so bwrap can bind the empty mask — leaving it unmasked would
    // let the sandbox mkdir+write it onto the host.
    const { args, maskMounts } = compileToBwrap(p, opts);
    const mask = args.indexOf('/home/u/proj/secrets');
    expect(args[mask - 2]).toBe('--ro-bind');
    expect(args[mask - 1]).toBe('/sbx/empty');
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/secrets', kind: 'dir' });
  });

  it('file-shaped deny uses an empty ro-bind, reports the needed file AND a file-kind mask mount', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/.env'] },
    }));
    const { args, emptyFiles, maskMounts } = compileToBwrap(p, { ...opts, filePaths: new Set(['/home/u/proj/.env']) });
    expect(emptyFiles).toHaveLength(1);
    expect(emptyFiles[0].maskedPath).toBe('/home/u/proj/.env');
    const i = args.indexOf('/home/u/proj/.env');
    expect(args[i - 1]).toBe(emptyFiles[0].path);
    expect(args[i - 2]).toBe('--ro-bind');
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/.env', kind: 'file' });
  });

  it('replicates usrmerge symlinks and honors net=false', () => {
    const p = { ...buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/x', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj', net: false })) };
    const { args } = compileToBwrap(p, { ...opts, symlinks: [{ path: '/bin', target: 'usr/bin' }] });
    const i = args.indexOf('--symlink');
    expect(args.slice(i, i + 3)).toEqual(['--symlink', 'usr/bin', '/bin']);
    expect(args).toContain('--unshare-net');
  });

  it('white-in-black: deny WITH a deeper allow uses --tmpfs + deferred --remount-ro (mode-000 ro-bind cannot host a child submount)', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/denied'], readWrite: ['/home/u/proj/denied/self'] },
    }));
    const { args, maskMounts } = compileToBwrap(p, opts);
    const mask = args.indexOf('/home/u/proj/denied');
    expect(args[mask - 1]).toBe('--tmpfs'); // NOT the 000 ro-bind (which can't host the child)
    // the nested carve-out is bound (deeper, after the tmpfs)
    const self = args.indexOf('/home/u/proj/denied/self');
    expect(self).toBeGreaterThan(mask);
    // re-sealed read-only AFTER the nested bind
    const remount = args.lastIndexOf('/home/u/proj/denied');
    expect(args[remount - 1]).toBe('--remount-ro');
    expect(remount).toBeGreaterThan(self);
    // still a tracked mask mountpoint (needs pre-create + cleanup — tmpfs onto a
    // missing target also materialises a host mountpoint)
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/denied', kind: 'dir' });
  });

  it('redundant nested deny (deny /a + deny /a/b, no allow under a/b) is SKIPPED (ancestor mask already covers it; mounting on a RO mask would fail)', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/a', '/home/u/proj/a/b'] },
    }));
    const { args, maskMounts } = compileToBwrap(p, opts);
    // /a is masked (000 ro-bind), /a/b is NOT emitted (redundant — /a already hides it)
    expect(args).toContain('/home/u/proj/a');
    expect(args).not.toContain('/home/u/proj/a/b');
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/a', kind: 'dir' });
    expect(maskMounts.some(m => m.path === '/home/u/proj/a/b')).toBe(false);
  });

  it('deny → allow → deny: the DEEPEST deny is NOT redundant (an allow re-exposed the tree between the two denies) and MUST be masked', () => {
    // Security regression: `shadowedByDeny` must judge the NEAREST enclosing
    // rule, not "any ancestor deny exists". Here outer is denied, self re-allows,
    // secret is denied again — skipping secret (because outer is an ancestor
    // deny) leaked TOPSECRET through the tmpfs+bind carve-out.
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: {
        deny: ['/home/u/proj/outer', '/home/u/proj/outer/self/secret'],
        readWrite: ['/home/u/proj/outer/self'],
      },
    }));
    const { args, maskMounts } = compileToBwrap(p, opts);
    // outer has a nested allow → tmpfs; self is bound; secret is emitted (masked)
    expect(args.indexOf('/home/u/proj/outer')).toBeGreaterThanOrEqual(0);
    expect(args).toContain('/home/u/proj/outer/self');
    expect(args).toContain('/home/u/proj/outer/self/secret'); // NOT skipped
    expect(maskMounts).toContainEqual({ path: '/home/u/proj/outer/self/secret', kind: 'dir' });
    // semantic cross-check: accessForPath agrees the secret is denied
    expect(accessForPath(p.rules, '/home/u/proj/outer/self/secret/key').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/proj/outer/self/ok').access).toBe('readWrite');
  });
});

describe('migrateLegacySandboxFields', () => {
  it('maps old fields losslessly and keeps sandbox truthiness', () => {
    const m = migrateLegacySandboxFields({
      sandbox: true,
      sandboxReadonlyPaths: ['~/ref'],
      sandboxHidePaths: ['~/.ssh'],
      readDenyExtraPaths: ['~/.aws', '~/.ssh'],
    });
    expect(m).toEqual({
      sandbox: true,
      sandboxPaths: { readOnly: ['~/ref'], deny: ['~/.ssh', '~/.aws'] },
    });
  });

  it('readIsolation:true alone → sandbox:true (absorbed)', () => {
    expect(migrateLegacySandboxFields({ readIsolation: true })).toEqual({ sandbox: true });
  });

  it('no-ops when already migrated or nothing legacy present', () => {
    expect(migrateLegacySandboxFields({ sandbox: true, sandboxPaths: {} })).toBeNull();
    expect(migrateLegacySandboxFields({ sandbox: true })).toBeNull();
    expect(migrateLegacySandboxFields({})).toBeNull();
  });
});

describe('compiler parity with accessForPath', () => {
  it('a nested white-in-black policy yields consistent structures on both engines', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { readOnly: ['/srv/ref'], deny: ['/srv/ref/private'] },
    }));
    // semantic truth
    expect(accessForPath(p.rules, '/srv/ref/a').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/srv/ref/private/b').access).toBe('deny');
    // bwrap: ro-bind then deeper deny mask
    const { args } = compileToBwrap(p, { emptyDir: '/e/empty', emptiesDir: '/e', chdir: '/home/u/proj' });
    expect(args.indexOf('/srv/ref/private')).toBeGreaterThan(args.indexOf('/srv/ref'));
    // seatbelt: allow then deeper deny
    const prof = compileToSeatbelt(p);
    expect(prof.indexOf('(deny file-read* (subpath "/srv/ref/private"))'))
      .toBeGreaterThan(prof.indexOf('(allow file-read* (subpath "/srv/ref"))'));
  });
});

describe('no-Lark-transport credential profile (larkTransportEnabled=false)', () => {
  // Worst case: workingDir defaults to $HOME, which would grant the whole home
  // (bots.json + sibling BOT_HOMEs + lark-cli stores) readWrite. The mandatory
  // no-transport denies must beat that broad grant — but ONLY for Feishu
  // authority, never the model CLI's own auth. authPaths here uses the REAL
  // codex-app adapter surface (~/.codex), not a fictional one.
  const noTransport = (o: Partial<FsPolicyContext> = {}) => buildFsPolicy(ctx({
    larkTransportEnabled: false,
    workingDir: '/Users/u',                       // = homeDir (worst case)
    redirectedCliData: false,
    authPaths: ['/Users/u/.codex'],               // REAL codex-app CLI login/state surface
    ...o,
  }));

  it('denies Feishu authority (bots.json / lark-cli stores / sibling BOT_HOME) even with workingDir=~', () => {
    const p = noTransport();
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.lark-cli-bots/cli_self/config').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/Library/Application Support/lark-cli/master.key.file').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/sibling/send-cred.json').access).toBe('deny');
  });

  it('suppresses service credentials inside authority roots without filtering other mandatory read-only grants', () => {
    const serviceSecret = '/Users/u/.botmux/.dashboard-secret';
    const capability = '/Users/u/.botmux/data/origin-capability';
    const p = noTransport({
      serviceCredentialReadOnlyPaths: [serviceSecret],
      mandatoryReadOnlyPaths: [capability],
    });

    expect(accessForPath(p.rules, serviceSecret).access).toBe('deny');
    expect(p.finalReadOnlyPaths).not.toContain(serviceSecret);
    expect(p.suppressedAuthorityPaths).toContain(serviceSecret);
    expect(accessForPath(p.rules, capability).access).toBe('readOnly');
    expect(p.finalReadOnlyPaths).toContain(capability);
  });

  it('suppresses service credentials inside Linux authority roots too', () => {
    const serviceSecret = '/home/u/.botmux/.dashboard-secret';
    const p = buildFsPolicy(ctx({
      platform: 'linux',
      homeDir: '/home/u',
      botmuxHome: '/home/u/.botmux',
      sessionDataDir: '/home/u/.botmux/data',
      workingDir: '/home/u',
      botHome: '/home/u/.botmux/bots/cli_self',
      larkTransportEnabled: false,
      serviceCredentialReadOnlyPaths: [serviceSecret],
    }));

    expect(accessForPath(p.rules, serviceSecret).access).toBe('deny');
    expect(p.finalReadOnlyPaths).not.toContain(serviceSecret);
    expect(p.suppressedAuthorityPaths).toContain(serviceSecret);
  });

  it('keeps external service credentials mandatory read-only under no-transport', () => {
    const serviceSecret = '/run/secrets/ebsd-diag-token';
    const p = noTransport({
      serviceCredentialReadOnlyPaths: [serviceSecret],
      userPaths: { readWrite: [serviceSecret] },
    });

    expect(accessForPath(p.rules, serviceSecret).access).toBe('readOnly');
    expect(p.finalReadOnlyPaths).toContain(serviceSecret);
    expect(p.suppressedAuthorityPaths ?? []).not.toContain(serviceSecret);
  });

  it('LINUX no-transport: the lark-cli keystore is frozen with NO own-key carve-out (unlike transport-enabled)', () => {
    // A no-transport (apiOnly / HTTP-virtual) turn has no Feishu sender identity, so
    // it gets NO lark-cli credential at all — not even its OWN master.key. The store
    // is an authority root: denied wholesale, and the transport-only own-key carve-out
    // is gated OFF. This closes the no-transport path that previously left the shared
    // Linux keystore readable. workingDir=~ is worst case.
    const store = '/home/u/.local/share/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome: '/home/u/.botmux/bots/cli_self', redirectedCliData: false, authPaths: ['/home/u/.codex'],
    }));
    expect(accessForPath(p.rules, store).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('deny');        // OWN key too — no carve-out
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    // model CLI's own auth still works (not a Feishu cred)
    expect(accessForPath(p.rules, '/home/u/.codex/auth.json').access).toBe('readWrite');
  });

  it('LINUX no-transport: store EXACTLY ON BOT_HOME (store===botHome) — hostile user RW at master.key is STILL dropped', () => {
    // Equality edge of the per-root BOT_HOME exception: when the store root IS botHome,
    // the exception must NOT fire (it is meant only for STRICT ancestors like the botmux
    // root), or a hostile userPaths.readWrite straight at master.key escapes dropAuthority
    // and wins by depth — the exact escape the nested-root fix closed, re-opened at equality.
    const botHome = '/home/u/.botmux/bots/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u/proj',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome, currentAppId: 'lark-cli', redirectedCliData: false, authPaths: ['/home/u/.codex'],
      larkCliLinuxStore: botHome,
      userPaths: { readWrite: [`${botHome}/master.key`, `${botHome}/appsecret_lark-cli.enc`] },
    }));
    expect(accessForPath(p.rules, `${botHome}/master.key`).access).toBe('deny');
    expect(accessForPath(p.rules, `${botHome}/appsecret_lark-cli.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${botHome}/appsecret_cli_other.enc`).access).toBe('deny');
  });

  it('LINUX no-transport: BOTH candidate stores frozen when a custom LARKSUITE_CLI_DATA_DIR is set (both-candidate lock)', () => {
    // no-transport must deny whichever store lark-cli opens — custom OR default — without
    // depending on lark-cli's env-value validator. Both are authority roots, zero carve-out.
    const custom = '/data00/cli-data/lark-cli';
    const dflt = '/home/u/.local/share/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome: '/home/u/.botmux/bots/cli_self', redirectedCliData: false, authPaths: ['/home/u/.codex'],
      larkCliLinuxStore: custom,
    }));
    for (const s of [custom, dflt]) {
      expect(accessForPath(p.rules, s).access).toBe('deny');
      expect(accessForPath(p.rules, `${s}/master.key`).access).toBe('deny');            // no carve-out
      expect(accessForPath(p.rules, `${s}/appsecret_cli_self.enc`).access).toBe('deny');
      expect(accessForPath(p.rules, `${s}/appsecret_cli_other.enc`).access).toBe('deny');
    }
    expect(accessForPath(p.rules, '/home/u/.codex/auth.json').access).toBe('readWrite');
  });

  it('LINUX no-transport: a HOSTILE deeper user sandboxPaths.readWrite cannot re-open the keystore', () => {
    // deepest-prefix-wins: dropAuthority must strip a nested user grant that targets
    // the frozen store BEFORE merge, else it would beat the shallow authority deny.
    const store = '/home/u/.local/share/lark-cli';
    const p = buildFsPolicy(ctx({
      platform: 'linux', larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome: '/home/u/.botmux/bots/cli_self', redirectedCliData: false, authPaths: ['/home/u/.codex'],
      userPaths: { readWrite: [`${store}/appsecret_cli_other.enc`, store] },
    }));
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('deny');
  });

  it('LINUX no-transport: keystore NESTED INSIDE BOT_HOME still denies — BOT_HOME carve-out must not shadow a nested authority', () => {
    // The reproduced escape: LARKSUITE_CLI_DATA_DIR=<BOT_HOME> → store=<BOT_HOME>/lark-cli.
    // The old `insideAuthority = under(anyRoot) && !under(botHome)` exempted EVERYTHING
    // under BOT_HOME, so a deeper hostile user RW under the nested store escaped
    // dropAuthority and `master.key` resolved readWrite. The per-root BOT_HOME exception
    // (only exempts a root that is an ANCESTOR of BOT_HOME) must keep the nested store
    // restricting. Exercise ALL hostile channels: user RW/RO, readonlyRoots, extraWrite.
    const botHome = '/home/u/.botmux/bots/cli_self';
    const store = `${botHome}/lark-cli`;
    const p = buildFsPolicy(ctx({
      platform: 'linux', larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome, redirectedCliData: false, authPaths: ['/home/u/.codex'],
      larkCliLinuxStore: store,
      userPaths: {
        readWrite: [`${store}/master.key`, `${store}/appsecret_cli_other.enc`, store],
        readOnly: [`${store}/appsecret_cli_sneaky.enc`],
      },
      readonlyRoots: [`${store}/via-readonly.enc`],
      extraWritePaths: [`${store}/via-extrawrite.enc`],
    }));
    // NO channel may re-open any keystore file — all must resolve deny
    expect(accessForPath(p.rules, `${store}/master.key`).access).toBe('deny');            // the reproduced leak
    expect(accessForPath(p.rules, `${store}/appsecret_cli_other.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/appsecret_cli_sneaky.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/via-readonly.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, `${store}/via-extrawrite.enc`).access).toBe('deny');
    expect(accessForPath(p.rules, store).access).toBe('deny');
    // own appsecret ALSO denied under no-transport (no carve-out at all), and the
    // dropped hostile paths are recorded for diagnosability.
    expect(accessForPath(p.rules, `${store}/appsecret_cli_self.enc`).access).toBe('deny');
    expect(p.suppressedAuthorityPaths?.some(s => s.startsWith(store))).toBe(true);
    // BOT_HOME scratch OUTSIDE the nested store stays writable (exception still valid there)
    expect(accessForPath(p.rules, `${botHome}/scratch.txt`).access).toBe('readWrite');
    // ~/.codex (CLI's own auth, outside every authority root) still works
    expect(accessForPath(p.rules, '/home/u/.codex/auth.json').access).toBe('readWrite');
  });

  it('KEEPS the model CLI own auth (~/.codex) readWrite under no-transport — core functionality intact', () => {
    // The regression codex caught: authPaths are the CLI's OWN login (not Feishu),
    // so a core-only turn must still authenticate its CLI. ~/.codex stays RW even
    // though it lives under the workingDir=~ home.
    const p = noTransport();
    expect(accessForPath(p.rules, '/Users/u/.codex').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.codex/auth.json').access).toBe('readWrite');
  });

  it('own BOT_HOME stays writable but its send-cred.json is denied (Feishu secret)', () => {
    const p = buildFsPolicy(ctx({ larkTransportEnabled: false, workingDir: '/Users/u/.botmux/bots/cli_self' }));
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_self/scratch.txt').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_self/send-cred.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('deny');
  });

  it('withholds the role-library grant entirely (no Feishu sender identity → no role system)', () => {
    // The role library is NOT one of the authority roots (those are Feishu-cred
    // dirs), and roleLibAccess reads ctx.mandatoryDenyPaths — so dropAuthority/
    // authorityRoots can't suppress it. It must be an EXPLICIT larkTransport gate.
    const p = noTransport({ roleLibrarySubtree: '/Users/u/botmux-roles/cli_self' });
    expect(p.rules.some(r => r.path === '/Users/u/botmux-roles/cli_self')).toBe(false);
    // A transport-enabled bot with the SAME subtree DOES get the grant (proves it's
    // the gate, not some unrelated suppression).
    const on = buildFsPolicy(ctx({ larkTransportEnabled: true, roleLibrarySubtree: '/Users/u/botmux-roles/cli_self' }));
    expect(on.rules.find(r => r.path === '/Users/u/botmux-roles/cli_self')?.access).toBe('readWrite');
  });

  it('a NORMAL (transport-enabled) bot gets its own lark-cli, authPaths, and keystore', () => {
    const p = buildFsPolicy(ctx({ larkTransportEnabled: true, redirectedCliData: false, authPaths: ['/Users/u/.codex'] }));
    expect(accessForPath(p.rules, '/Users/u/.lark-cli-bots/cli_self/config').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.codex/auth.json').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/Library/Application Support/lark-cli/master.key.file').access).toBe('readOnly');
    // bots.json (sibling secrets) is baseline-denied for normal bots too.
  });

  it('DARWIN no-transport is byte-identical to pre-refactor: the Linux keystore paths are NOT frozen (cross-platform gate)', () => {
    // The Linux-store additions to computeNoTransportAuthorityRoots must be platform-gated,
    // or macOS no-transport behavior changes: a workingDir under ~/.local/share/lark-cli
    // (a normal macOS dir — macOS lark-cli uses the Library/… store) would newly fail
    // `working-dir-is-authority`, and that dir would be spuriously denied. Assert neither.
    // (1) workingDir under ~/.local/share/lark-cli must NOT throw on darwin
    expect(() => buildFsPolicy(ctx({
      platform: 'darwin', larkTransportEnabled: false, workingDir: '/Users/u/.local/share/lark-cli',
      redirectedCliData: false, authPaths: ['/Users/u/.codex'],
      larkCliLinuxStore: '/Users/u/.local/share/lark-cli',  // worker computes this on darwin too; must be ignored
    }))).not.toThrow();
    // (2) ~/.local/share/lark-cli is NOT specially frozen on darwin (workingDir=~ worst case)
    const p = buildFsPolicy(ctx({
      platform: 'darwin', larkTransportEnabled: false, workingDir: '/Users/u',
      redirectedCliData: false, authPaths: ['/Users/u/.codex'],
      larkCliLinuxStore: '/Users/u/.local/share/lark-cli',
    }));
    // the macOS keystore is still frozen (darwin's real store); the Linux path is not.
    expect(accessForPath(p.rules, '/Users/u/Library/Application Support/lark-cli/master.key.file').access).toBe('deny');
    expect(p.rules.some(r => r.path === '/Users/u/.local/share/lark-cli')).toBe(false);
  });

  it('denies the trusted-host HMAC + port table (escalation vector) even with workingDir=~', () => {
    // .dashboard-secret is the trusted-host HMAC — reading it would let a
    // no-transport agent sign sibling-daemon routes. dashboard-daemons is the
    // port-table discovery half. Both must be denied; .bak/.tmp sidecars too.
    const p = noTransport();
    expect(accessForPath(p.rules, '/Users/u/.botmux/.dashboard-secret').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/.dashboard-token').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/feishu-session.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/dashboard-daemons').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json.bak').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json.tmp').access).toBe('deny');
  });

  it('a HOSTILE deeper user sandboxPaths.readWrite cannot re-open an authority path', () => {
    // The deepest-prefix-wins semantics codex flagged: a nested user grant used
    // to beat the shallower authority deny. dropAuthority now strips it pre-merge.
    const p = noTransport({ userPaths: { readWrite: [
      '/Users/u/.lark-cli-bots/cli_self',        // deeper than the authority root
      '/Users/u/.botmux/.dashboard-secret',      // directly targets the HMAC
      '/Users/u/.botmux/bots.json',
    ] } });
    expect(accessForPath(p.rules, '/Users/u/.lark-cli-bots/cli_self/x').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/.dashboard-secret').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('deny');
  });

  it('freezes BOTH the configured AND the default ~/.botmux root (custom SESSION_DATA_DIR, BOTS_CONFIG unset)', () => {
    // codex P1: a custom data dir moves configuredBotmuxHome (=dirname(dataDir))
    // but the default ~/.botmux still holds the live .dashboard-secret HMAC +
    // bots.json. Denying only the configured root left the sibling-daemon
    // escalation open. buildFsPolicy must deny BOTH from workingDir=~.
    const p = buildFsPolicy(ctx({
      larkTransportEnabled: false,
      homeDir: '/home/u',
      workingDir: '/home/u',                              // HTTP-trigger default
      botmuxHome: '/srv/botmux',                          // configured (dirname of a custom dataDir)
      sessionDataDir: '/srv/botmux/data',
      defaultBotmuxHome: '/home/u/.botmux',               // the ALWAYS-frozen default root
      botHome: '/srv/botmux/bots/cli_self',
      redirectedCliData: false,
      authPaths: ['/home/u/.codex'],
    }));
    // default root — was the leak
    expect(accessForPath(p.rules, '/home/u/.botmux/.dashboard-secret').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/.botmux/.dashboard-token').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/.botmux/feishu-session.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/home/u/.botmux/bots.json').access).toBe('deny');
    // configured root
    expect(accessForPath(p.rules, '/srv/botmux/.dashboard-secret').access).toBe('deny');
    expect(accessForPath(p.rules, '/srv/botmux/bots.json').access).toBe('deny');
    // own BOT_HOME (under the configured root) stays usable; ~/.codex kept
    expect(accessForPath(p.rules, '/srv/botmux/bots/cli_self/scratch.txt').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/home/u/.codex/auth.json').access).toBe('readWrite');
  });

  it('freezes bare ~/.lark-cli as an authority root — a hostile nested user RW/RO cannot re-open it', () => {
    // codex P1: ~/.lark-cli is repo-marked sensitive (isolated-bot-deploy.md) but
    // was only baseline-denied, not a frozen no-transport authority root — so a
    // deeper user grant re-opened it (deepest-prefix wins). Now it's an authority
    // root and dropAuthority strips the nested grant pre-merge.
    const p = noTransport({ userPaths: {
      readWrite: ['/Users/u/.lark-cli/accounts/self'],
      readOnly: ['/Users/u/.lark-cli/tokens'],
    } });
    expect(accessForPath(p.rules, '/Users/u/.lark-cli/accounts/self/token.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.lark-cli/tokens/t.json').access).toBe('deny');
    // and the suppressed grants are RECORDED for the worker to log (not silent)
    expect(p.suppressedAuthorityPaths).toEqual(
      expect.arrayContaining(['/Users/u/.lark-cli/accounts/self', '/Users/u/.lark-cli/tokens']),
    );
  });

  it('a loaded bots-config in a DENIED subtree of a frozen root builds (config + dir + sidecar all deny)', () => {
    // Default layout: getLoadedConfigPath() = ~/.botmux/bots.json, denied wholesale
    // by the authority-root deny (NOT re-opened by any carve-out) — no throw, and
    // the post-merge self-check confirms config + dirname + sidecars are all deny.
    const p = noTransport({ loadedBotsConfigPath: '/Users/u/.botmux/bots.json' });
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('deny');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json.bak').access).toBe('deny');
    // A config in a plain denied subdir (not a carve-out) also builds, dir denied.
    const q = noTransport({ loadedBotsConfigPath: '/Users/u/.botmux/conf/bots.json' });
    expect(accessForPath(q.rules, '/Users/u/.botmux/conf/bots.json').access).toBe('deny');
    expect(accessForPath(q.rules, '/Users/u/.botmux/conf').access).toBe('deny');
  });

  it('a loaded bots-config that lands in a trusted CARVE-OUT FAILS CLOSED (inside-root is not sufficient)', () => {
    // codex P1: white-in-black + deepest-prefix-wins means a deeper trusted
    // carve-out (own BOT_HOME RW / bin RO / attachments RW / outbox / install-root)
    // re-opens the config even though it's INSIDE a frozen authority root — which
    // would re-expose every bot's secret + sidecars. The post-merge accessForPath
    // self-check (config AND its dirname must be deny) catches every such case,
    // including future carve-outs, without enumerating filenames.
    const carve = (o: Partial<FsPolicyContext>) => noTransport({
      botmuxInstallRoot: '/Users/u/.botmux/install',
      outbox: '/Users/u/.botmux/data/sandboxes/s/outbox',
      ...o,
    });
    for (const bad of [
      '/Users/u/.botmux/bots/cli_self/bots.json',            // own BOT_HOME (readWrite)
      '/Users/u/.botmux/bin/bots.json',                      // CLI bin (readOnly)
      '/Users/u/.botmux/data/attachments/cli_self/bots.json',// own attachments (readWrite)
      '/Users/u/.botmux/data/sandboxes/s/outbox/bots.json',  // relay outbox (readWrite)
      '/Users/u/.botmux/install/bots.json',                  // install root (readOnly)
    ]) {
      expect(() => carve({ loadedBotsConfigPath: bad }), bad).toThrowError(FsPolicyConfigError);
    }
    // kind is machine-branchable
    try {
      carve({ loadedBotsConfigPath: '/Users/u/.botmux/bots/cli_self/bots.json' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FsPolicyConfigError);
      expect((e as FsPolicyConfigError).kind).toBe('bots-config-in-carveout');
    }
    // a transport-ENABLED bot with the same carve-out placement does NOT throw
    // (the self-check is no-transport-only).
    expect(() => buildFsPolicy(ctx({
      larkTransportEnabled: true, botmuxInstallRoot: '/Users/u/.botmux/install',
      loadedBotsConfigPath: '/Users/u/.botmux/bots/cli_self/bots.json',
    }))).not.toThrow();
  });

  it('an EXTERNAL loaded bots-config (outside every authority root) FAILS CLOSED — never silent parent-dir mask', () => {
    // codex P1: BOTS_CONFIG allows any file. Silently masking dirname(config)
    // would hide /tmp, /etc, or a project root and brick the core CLI. A
    // no-transport turn must refuse the layout with a clear error instead.
    for (const bad of ['/home/u/project/bots.json', '/tmp/bots.json', '/etc/bots.json']) {
      expect(() => noTransport({ homeDir: '/home/u', workingDir: '/home/u', loadedBotsConfigPath: bad }))
        .toThrowError(FsPolicyConfigError);
    }
    // the error carries a machine-branchable kind (not just a string message)
    try {
      noTransport({ homeDir: '/home/u', workingDir: '/home/u', loadedBotsConfigPath: '/tmp/bots.json' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FsPolicyConfigError);
      expect((e as FsPolicyConfigError).kind).toBe('external-bots-config');
    }
    // transport-ENABLED bot with the same external config: no throw (gate is
    // no-transport-only; a normal bot's config path isn't an authority concern here).
    expect(() => buildFsPolicy(ctx({
      larkTransportEnabled: true, homeDir: '/home/u', workingDir: '/home/u',
      loadedBotsConfigPath: '/tmp/bots.json',
    }))).not.toThrow();
  });

  it('a workingDir that IS a Feishu-authority root FAILS CLOSED (own BOT_HOME excepted, ~-ancestor allowed)', () => {
    // codex P1: workingDir must be granted, so it can't be silently dropped. If it
    // lives inside an authority root (own BOT_HOME excepted) the layout is
    // unresolvable → throw. workingDir=~ (mere ancestor of the roots) is fine —
    // the deeper parent deny masks the nested authority.
    expect(() => noTransport({ workingDir: '/Users/u/.botmux/data' }))
      .toThrowError(FsPolicyConfigError);
    expect(() => noTransport({ workingDir: '/Users/u/.lark-cli-bots/cli_self' }))
      .toThrowError(FsPolicyConfigError);
    try {
      noTransport({ workingDir: '/Users/u/.botmux' });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as FsPolicyConfigError).kind).toBe('working-dir-is-authority');
    }
    // own BOT_HOME as workingDir is allowed (sanctioned carve-out, not a throw)
    expect(() => buildFsPolicy(ctx({
      larkTransportEnabled: false, workingDir: '/Users/u/.botmux/bots/cli_self',
    }))).not.toThrow();
    // workingDir=~ (ancestor) stays granted, nested authority still denied
    const home = noTransport({ workingDir: '/Users/u' });
    expect(accessForPath(home.rules, '/Users/u/proj/file').access).toBe('readWrite');
    expect(accessForPath(home.rules, '/Users/u/.botmux/.dashboard-secret').access).toBe('deny');
  });

  it('computeNoTransportAuthorityRoots dedupes when configured === default and includes lark-cli stores', () => {
    // Pure-helper unit lock: the provenance logic the worker's real assembly uses.
    const roots = computeNoTransportAuthorityRoots({
      platform: 'linux', homeDir: '/home/u', botmuxHome: '/home/u/.botmux', defaultBotmuxHome: '/home/u/.botmux',
    });
    expect(roots).toEqual(expect.arrayContaining([
      '/home/u/.botmux', '/home/u/.lark-cli', '/home/u/.lark-cli-bots',
    ]));
    // configured === default → a single ~/.botmux entry, not two
    expect(roots.filter(r => r === '/home/u/.botmux')).toHaveLength(1);
    // distinct configured root is added too
    const dual = computeNoTransportAuthorityRoots({
      platform: 'linux', homeDir: '/home/u', botmuxHome: '/srv/botmux', defaultBotmuxHome: '/home/u/.botmux',
    });
    expect(dual).toEqual(expect.arrayContaining(['/srv/botmux', '/home/u/.botmux']));
  });

  it('computeNoTransportAuthorityRoots freezes the Linux keystore ONLY on linux (default + custom); darwin gets NEITHER', () => {
    // linux default: LARKSUITE_CLI_DATA_DIR unset → store under ~/.local/share
    const def = computeNoTransportAuthorityRoots({ platform: 'linux', homeDir: '/home/u', botmuxHome: '/home/u/.botmux' });
    expect(def).toEqual(expect.arrayContaining(['/home/u/.local/share/lark-cli']));
    // linux custom store (worker resolved an absolute LARKSUITE_CLI_DATA_DIR) is frozen too
    const custom = computeNoTransportAuthorityRoots({
      platform: 'linux', homeDir: '/home/u', botmuxHome: '/home/u/.botmux', larkCliLinuxStore: '/data00/cli-data/lark-cli',
    });
    expect(custom).toEqual(expect.arrayContaining(['/data00/cli-data/lark-cli', '/home/u/.local/share/lark-cli']));
    // DARWIN: the Linux store paths must NOT be added (macOS uses the Library/… store, which
    // IS present). Freezing ~/.local/share/lark-cli on darwin would change darwin behavior
    // (cross-platform regression) — assert it's absent even if larkCliLinuxStore is passed.
    const dar = computeNoTransportAuthorityRoots({
      platform: 'darwin', homeDir: '/Users/u', botmuxHome: '/Users/u/.botmux', larkCliLinuxStore: '/Users/u/.local/share/lark-cli',
    });
    expect(dar).toEqual(expect.arrayContaining(['/Users/u/Library/Application Support/lark-cli'])); // macOS store still frozen
    expect(dar).not.toContain('/Users/u/.local/share/lark-cli');   // Linux default NOT added
    expect(dar.some(r => r === '/Users/u/.local/share/lark-cli')).toBe(false);
  });

  it('resolveLarkCliLinuxStoreDir mirrors lark-cli SafeEnvDirPath (absolute Cleaned; relative/tilde/empty/control-char → $HOME; XDG ignored)', () => {
    // strace-verified against lark-cli v1.0.76 keychain_other.go::StorageDir + SafeEnvDirPath:
    // absolute LARKSUITE_CLI_DATA_DIR → <clean(value)>/lark-cli
    expect(resolveLarkCliLinuxStoreDir('/data00/cli-data', '/home/u')).toBe('/data00/cli-data/lark-cli');
    // a `..`-bearing absolute value is CLEANED (lark-cli does filepath.Clean),
    // NOT rejected+fallback — else policy anchors the default while lark-cli opens the real dir.
    expect(resolveLarkCliLinuxStoreDir('/srv/review/data/../actual', '/home/u')).toBe('/srv/review/actual/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('/a/b/../../etc', '/home/u')).toBe('/etc/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('/srv/review/actual//', '/home/u')).toBe('/srv/review/actual/lark-cli'); // // collapsed
    expect(resolveLarkCliLinuxStoreDir('/srv/../..', '/home/u')).toBe('/lark-cli');                             // .. clamped at root
    // unset / empty → $HOME/.local/share/lark-cli
    expect(resolveLarkCliLinuxStoreDir(undefined, '/home/u')).toBe('/home/u/.local/share/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('', '/home/u')).toBe('/home/u/.local/share/lark-cli');
    // RELATIVE / tilde values are spec-invalid → lark-cli IGNORES them, falls back to
    // $HOME (verified by strace: `relseg/x` and `~/t` both opened ~/.local/share).
    expect(resolveLarkCliLinuxStoreDir('relseg/x', '/home/u')).toBe('/home/u/.local/share/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('~/tildetest', '/home/u')).toBe('/home/u/.local/share/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('.', '/home/u')).toBe('/home/u/.local/share/lark-cli');
    // CONTROL CHARS are rejected by lark-cli's validator → fallback to $HOME (strace-verified)
    expect(resolveLarkCliLinuxStoreDir('/srv/\x01bad', '/home/u')).toBe('/home/u/.local/share/lark-cli');
    expect(resolveLarkCliLinuxStoreDir('/srv/\x00nul', '/home/u')).toBe('/home/u/.local/share/lark-cli');
  });

  it('cleanPosixAbsPath: Go filepath.Clean semantics + control-char rejection (mirrors lark-cli SafeEnvDirPath)', () => {
    expect(cleanPosixAbsPath('/a/b/../c')).toBe('/a/c');
    expect(cleanPosixAbsPath('/a/./b//c/')).toBe('/a/b/c');
    expect(cleanPosixAbsPath('/a/../../b')).toBe('/b');   // .. clamps at root
    expect(cleanPosixAbsPath('/')).toBe('/');
    expect(cleanPosixAbsPath('/srv/../..')).toBe('/');
    // non-absolute → null
    expect(cleanPosixAbsPath('rel/x')).toBeNull();
    expect(cleanPosixAbsPath('~/x')).toBeNull();
    expect(cleanPosixAbsPath('')).toBeNull();
    // control chars → null (lark-cli treats as invalid)
    expect(cleanPosixAbsPath('/a/\x01b')).toBeNull();
    expect(cleanPosixAbsPath('/a/\x7f')).toBeNull();
    expect(cleanPosixAbsPath('/a/\nb')).toBeNull();
  });

  it('larkCliLinuxStorePath: override wins; unnormalizable override → NULL (no carve-out), never silent default fallback', () => {
    // a clean absolute override is used verbatim
    expect(larkCliLinuxStorePath('/home/u', '/data00/cli-data/lark-cli')).toBe('/data00/cli-data/lark-cli');
    // no override → default under homeDir
    expect(larkCliLinuxStorePath('/home/u')).toBe('/home/u/.local/share/lark-cli');
    // a `..`-bearing override must NOT silently fall back to the default
    // store (that leaves the real store exposed). It returns NULL → buildFsPolicy emits
    // NO Linux carve-out and the store stays denied-by-default. (In practice the worker
    // Cleans first via resolveLarkCliLinuxStoreDir, so a `..` never reaches here.)
    expect(larkCliLinuxStorePath('/home/u', '/a/../b')).toBeNull();
    expect(larkCliLinuxStorePath('/home/u', 'relative')).toBeNull();
  });

  it('larkCliChildDataRoot: same-source pin when basename is lark-cli; null (safe degrade) for a symlinked leaf to a different name', () => {
    // common / symlink-to-same-name: canonical store basename is `lark-cli` →
    // pin = dirname, so child opens <pin>/lark-cli == the policy-protected store.
    expect(larkCliChildDataRoot('/home/u/.local/share/lark-cli')).toBe('/home/u/.local/share');
    expect(larkCliChildDataRoot('/data00/cli-data/lark-cli')).toBe('/data00/cli-data');
    expect(larkCliChildDataRoot('/other/lark-cli')).toBe('/other');       // symlink resolved to another lark-cli dir
    // symlinked `lark-cli` leaf → canonical basename differs → NULL (worker pins nothing;
    // child falls back to the default store, which is ALSO locked → no leak, auth degrades).
    expect(larkCliChildDataRoot('/tmp/elsewhere/keys')).toBeNull();
    expect(larkCliChildDataRoot('/store')).toBeNull();                    // basename 'store' != lark-cli
    // unusable inputs
    expect(larkCliChildDataRoot(null)).toBeNull();
    expect(larkCliChildDataRoot(undefined)).toBeNull();
    expect(larkCliChildDataRoot('/')).toBeNull();
    expect(larkCliChildDataRoot('relative/lark-cli')).toBeNull();         // not absolute
    // a store directly at root: /lark-cli → pin '/'
    expect(larkCliChildDataRoot('/lark-cli')).toBe('/');
  });

  it('CLI runtime still works under no-transport (.data-dir / bin / bots-info / own session)', () => {
    const p = noTransport({ botmuxInstallRoot: '/opt/botmux' });
    expect(accessForPath(p.rules, '/Users/u/.botmux/.data-dir').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bin/botmux').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/bots-info.json').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self').access).toBe('readOnly');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_self/sessions.db').access).toBe('readOnly');
    // the legacy `sessions-<self>.json` is no longer allow-listed, so under
    // no-transport it falls back to the frozen ~/.botmux authority deny.
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_self.json').access).toBe('readOnly');
    // sibling store dirs get no carve-out out of that authority deny either
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/session-stores/cli_other/sessions.db').access).toBe('deny');
    expect(accessForPath(p.rules, '/opt/botmux/dist/cli.js').access).toBe('readOnly');
  });

  it('the REAL codex-app adapter: own CODEX_HOME (redirected to BOT_HOME) usable, host ~/.codex dropped, all under no-transport', () => {
    // codex P2: prior "codex-app" tests hand-wrote authPaths:['~/.codex'] and never
    // touched the real adapter or the redirect→BOT_HOME path. Instantiate the ACTUAL
    // adapter and run its declared authPaths through resolveRedirectedAdapterAuthPaths
    // (the worker's single source of truth) for a redirected no-transport turn.
    const adapter = createCodexAppAdapter();
    expect(adapter.id).toBe('codex-app');
    expect(adapter.authPaths).toEqual(['~/.codex']);
    // Redirected: the host ~/.codex is rehomed into BOT_HOME's CODEX_HOME, so the
    // host copy must be DROPPED (keeping it would be a leak) — its BOT_HOME copy is
    // provisioned + covered readWrite by the botHome rule.
    const survivors = resolveRedirectedAdapterAuthPaths({
      declaredAuthPaths: (adapter.authPaths ?? []).map(a => a.replace(/^~/, '/home/u')),
      willRedirectCliData: true,
      rehomedHostRoots: ['/home/u/.codex'],
    });
    expect(survivors).toEqual([]);   // host ~/.codex NOT re-bound under redirect
    // The redirected BOT_HOME CODEX_HOME (own bot's dir) stays usable under
    // no-transport: BOT_HOME is readWrite (minus send-cred), and CODEX_HOME lives
    // inside it, so the app-server's SQLite/state is writable.
    const p = buildFsPolicy(ctx({
      larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome: '/home/u/.botmux/bots/cli_self', defaultBotmuxHome: '/home/u/.botmux',
      redirectedCliData: true, authPaths: survivors,
    }));
    expect(accessForPath(p.rules, '/home/u/.botmux/bots/cli_self/.codex/state.sqlite').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/home/u/.botmux/bots/cli_self/send-cred.json').access).toBe('deny');
    // NOT redirected (cold-start login): the real host ~/.codex IS kept readWrite
    // even under no-transport (it's the model CLI's OWN auth, not Feishu).
    const cold = buildFsPolicy(ctx({
      larkTransportEnabled: false, homeDir: '/home/u', workingDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      botHome: '/home/u/.botmux/bots/cli_self', defaultBotmuxHome: '/home/u/.botmux',
      redirectedCliData: false, authPaths: ['/home/u/.codex'],
    }));
    expect(accessForPath(cold.rules, '/home/u/.codex/auth.json').access).toBe('readWrite');
    // and the Feishu authority is still denied in both cases
    expect(accessForPath(p.rules, '/home/u/.botmux/.dashboard-secret').access).toBe('deny');
    expect(accessForPath(cold.rules, '/home/u/.botmux/.dashboard-secret').access).toBe('deny');
  });
});
