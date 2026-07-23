import { describe, it, expect } from 'vitest';
import {
  buildFsPolicy,
  mergeFsRules,
  accessForPath,
  normalizeFsPath,
  coversPath,
  ancestorsNeedingTraverse,
  compileToSeatbelt,
  compileToBwrap,
  migrateLegacySandboxFields,
  type FsPolicyContext,
  type FsRule,
} from '../src/adapters/cli/fs-policy.js';

const ctx = (o: Partial<FsPolicyContext> = {}): FsPolicyContext => ({
  platform: 'darwin',
  homeDir: '/Users/u',
  botmuxHome: '/Users/u/.botmux',
  sessionDataDir: '/Users/u/.botmux/data',
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
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_self.json').access).toBe('readOnly');     // own
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/turn-sends/s.jsonl').access).toBe('readWrite');        // CLI appends markers
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
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/schedules.json').access).toBe('readWrite'); // RMW schedule store — owner-accepted cross-bot exposure
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_other.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/bot-openids-cli_other.json').access).toBe('none'); // sibling
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_other/send-cred.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/logs/daemon-0.log').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_other/m/f.pdf').access).toBe('none');
    // a file created AFTER spawn (codex #3 fail-open) is ALSO denied — allow-list, not enumeration
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_futureBot.json').access).toBe('none');
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
    // linux keeps lark keys in ~/.lark-cli-bots/<self> → no darwin carve-out there
    const lin = buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj' }));
    expect(lin.rules.some(r => r.path.includes('Library/Application Support/lark-cli'))).toBe(false);
  });

  it('internal injections: workingDir + BOT_HOME rw, own session store + attachments ro; siblings uncovered', () => {
    const p = buildFsPolicy(ctx());
    expect(accessForPath(p.rules, '/Users/u/proj/src/x.ts').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/bots/cli_self/claude/x.jsonl').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_self.json').access).toBe('readOnly');
    // siblings simply not covered under the allow-list → inaccessible
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/sessions-cli_other.json').access).toBe('none');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_self/m1/f.pdf').access).toBe('readWrite');
    expect(accessForPath(p.rules, '/Users/u/.botmux/data/attachments/cli_other/m1/f.pdf').access).toBe('none');
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

  it('omits network grants when net is disabled', () => {
    const prof = compileToSeatbelt(buildFsPolicy(ctx({ net: false })));
    expect(prof).not.toContain('(allow network*)');
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
  const opts = { emptiesDir: '/sbx/empties', chdir: '/home/u/proj' };

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

  it('deny under an exposed tree masks with tmpfs; unreachable deny is skipped', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/secrets', '/home/u/never-exposed/x'] },
    }));
    const { args } = compileToBwrap(p, opts);
    const mask = args.indexOf('/home/u/proj/secrets');
    expect(args[mask - 1]).toBe('--tmpfs');
    const bind = args.indexOf('/home/u/proj');
    expect(mask).toBeGreaterThan(bind); // deeper mask after the bind it punches
    expect(args).not.toContain('/home/u/never-exposed/x');
  });

  it('masks a NONEXISTENT deny under an exposed parent (codex finding: agent must not create+access it)', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/secrets'] },
    }));
    // worker keeps deny rules even when the target does not exist yet; filePaths
    // is empty because statSync fails on a nonexistent path → tmpfs branch.
    const { args } = compileToBwrap(p, { ...opts, filePaths: new Set() });
    const mask = args.indexOf('/home/u/proj/secrets');
    expect(args[mask - 1]).toBe('--tmpfs');           // masked, not skipped
    expect(mask).toBeGreaterThan(args.indexOf('/home/u/proj')); // after the rw bind it punches
  });

  it('file-shaped deny uses an empty ro-bind and reports the needed file', () => {
    const p = buildFsPolicy(ctx({
      platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/cli_self',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj',
      userPaths: { deny: ['/home/u/proj/.env'] },
    }));
    const { args, emptyFiles } = compileToBwrap(p, { ...opts, filePaths: new Set(['/home/u/proj/.env']) });
    expect(emptyFiles).toHaveLength(1);
    expect(emptyFiles[0].maskedPath).toBe('/home/u/proj/.env');
    const i = args.indexOf('/home/u/proj/.env');
    expect(args[i - 1]).toBe(emptyFiles[0].path);
    expect(args[i - 2]).toBe('--ro-bind');
  });

  it('replicates usrmerge symlinks and honors net=false', () => {
    const p = { ...buildFsPolicy(ctx({ platform: 'linux', homeDir: '/home/u', botHome: '/home/u/.botmux/bots/x', botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data', workingDir: '/home/u/proj', net: false })) };
    const { args } = compileToBwrap(p, { ...opts, symlinks: [{ path: '/bin', target: 'usr/bin' }] });
    const i = args.indexOf('--symlink');
    expect(args.slice(i, i + 3)).toEqual(['--symlink', 'usr/bin', '/bin']);
    expect(args).toContain('--unshare-net');
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
    // bwrap: ro-bind then deeper tmpfs mask
    const { args } = compileToBwrap(p, { emptiesDir: '/e', chdir: '/home/u/proj' });
    expect(args.indexOf('/srv/ref/private')).toBeGreaterThan(args.indexOf('/srv/ref'));
    // seatbelt: allow then deeper deny
    const prof = compileToSeatbelt(p);
    expect(prof.indexOf('(deny file-read* (subpath "/srv/ref/private"))'))
      .toBeGreaterThan(prof.indexOf('(allow file-read* (subpath "/srv/ref"))'));
  });
});
