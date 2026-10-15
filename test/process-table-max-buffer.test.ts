/**
 * Whole-process-table `ps` scans must not fall over at Node's default 1MiB
 * exec maxBuffer (ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER), which silently
 * drops every caller into its fail-closed branch on a busy host.
 *
 *  1. Static guard: every whole-table `ps` exec in src/ passes the shared
 *     PROCESS_TABLE_MAX_BUFFER (so the cap stays uniform and new scans can't
 *     regress to the default). The classifier keys on the *shape* of the call
 *     — an exec/spawn family callee whose argv selects the whole table
 *     (`-A` / `-a…` / `-e…`, not a single `-p <pid>`) — and inspects the full
 *     call text, so it is blind neither to aliased callees
 *     (`const exec = promisify(execFile)`), absolute ps paths (`'/bin/ps'`),
 *     ps-path variables (`PS_BINS`, `systemPsBin()`), double-quoted literals,
 *     shell-form strings (`'ps -A …'`) nor `spawn`. Bounded single-pid `-p`
 *     lookups are excluded by construction (they cannot select the whole
 *     table).
 *  2. Behavioural: in a child process with a fake `ps` on PATH that prints
 *     >1MiB, the real call sites return the correct answer instead of their
 *     ENOBUFS fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PROCESS_TABLE_MAX_BUFFER } from '../src/utils/exec-limits.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Blank out comments (line + block) while leaving string literals intact, so a
 * `ps -A` mention in a doc comment is not mistaken for a call. Template
 * interpolation is not modelled — no whole-table scan uses one — but quotes
 * inside strings are honoured so a `//` in a URL does not hide the rest of the
 * file.
 */
export function maskComments(src: string): string {
  const out = src.split('');
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'bt';
  let state: State = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i++; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'bt';
      continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; else out[i] = ' '; continue; }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i++; continue; }
      if (c !== '\n') out[i] = ' ';
      continue;
    }
    // inside a string literal
    if (c === '\\') { i++; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'bt' && c === '`')) state = 'code';
  }
  return out.join('');
}

/** Text of the call starting at `start` (the callee name) up to its closing paren. */
function callText(src: string, start: number): string {
  const open = src.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/**
 * Callee names that reach `node:child_process`. `run`/`pExecFile`/`execFileP`/
 * `execFileAsync` are the repo's promisified wrappers; the guard must see
 * through them too.
 */
const EXEC_FAMILY = new Set([
  'exec', 'execSync', 'execFile', 'execFileSync',
  'spawn', 'spawnSync',
  'pExecFile', 'execFileP', 'execP', 'execFileAsync', 'run',
]);

/** A `ps` program: a literal (optionally an absolute path) or a ps-path variable. */
const PS_LITERAL = /['"`](?:[^'"`]*\/)?ps['"`]/;
const PS_SHELL = /['"`]\s*(?:[^'"`]*\/)?ps\s[^'"`]*['"`]/;
const PS_VAR = /\b(?:PS_BINS|psBin|ps_bin|systemPsBin)\b/;
const hasPs = (t: string): boolean => PS_LITERAL.test(t) || PS_SHELL.test(t) || PS_VAR.test(t);

/** A whole-table selector: `-A`/`-a…`/`-e…`, as a quoted token or inside a shell string. */
const SEL_QUOTED = /['"`]\s*-(?:A[A-Za-z]*|[ae][A-Za-z]+)\s*['"`]/;
const SEL_SHELL = /(?:^|[\s'"`])-(?:A(?=[\s'"`,]|$)|[ae][A-Za-z]+(?=[\s'"`,]|$))/;
const hasWholeTableSelector = (t: string): boolean => SEL_QUOTED.test(t) || SEL_SHELL.test(t);

/** A single-pid `-p <pid>` lookup — bounded by definitions, so never whole-table. */
const SINGLE_PID = /['"`]-p['"`]|(?:^|[\s'"`])-p(?=[\s'"`,]|$)/;

export interface PsCall {
  file: string;
  line: number;
  text: string;
  capped: boolean;
  single: boolean;
}

/** Every `ps`-touching exec/spawn family call in a source string, classified. */
export function classifyPsCalls(file: string, raw: string): PsCall[] {
  const src = maskComments(raw);
  const out: PsCall[] = [];
  const re = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const callee = m[1]!.split('.').pop()!;
    if (!EXEC_FAMILY.has(callee)) continue;
    const text = callText(src, m.index!);
    if (!hasPs(text)) continue;
    const single = SINGLE_PID.test(text);
    if (!single && !hasWholeTableSelector(text)) continue;
    out.push({
      file,
      line: raw.slice(0, m.index!).split('\n').length,
      text,
      capped: /\bmaxBuffer:\s*PROCESS_TABLE_MAX_BUFFER\b/.test(text),
      single,
    });
  }
  return out;
}

/**
 * Whole-table scans whose cap is applied *outside* the call itself. Each entry
 * asserts that the cap is really present (via `cap`), so deleting it turns the
 * guard red instead of silently exempting the site.
 *
 * The single-pid `-p` family needs no entry: {@link classifyPsCalls} never
 * classifies `-p` as whole-table (its output is bounded by one process's
 * columns/argv), and the boundary is asserted explicitly below.
 */
interface Exemption {
  file: string;
  /** Only calls matching this are exempt. */
  match: RegExp;
  /** Must be present somewhere in the file — the actual cap. */
  cap: RegExp;
  reason: string;
}
const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'src/core/resource-monitor/darwin.ts',
    match: /run\(PS_BINS,/,
    // The cap lives once in runTool, shared by every tool this sampler runs.
    cap: /execFileSync\(bin, args, \{[^}]*maxBuffer: COMMAND_MAX_BUFFER/s,
    reason: 'darwin resource sampler routes `ps` through runTool (16MiB); its table selects only '
      + 'fixed-width kernel columns (`pid,ppid,rss,time,lstart`), never `command`, so argv-sized '
      + 'output cannot reach the cap — the math is bounded by column count, not process argv.',
  },
  {
    file: 'src/core/browser-restart.ts',
    match: /run\('ps', \['-Axo', 'command='\]\)/,
    // The cap is on the `run` default that this call site uses.
    cap: /const run = opts\.run \?\? \(async \(file, args\) => pExecFile\(file, args, \{[^}]*maxBuffer: PROCESS_TABLE_MAX_BUFFER/s,
    reason: 'browser-restart liveness poll calls `run`, whose default runner already carries the cap.',
  },
];

describe('PROCESS_TABLE_MAX_BUFFER', () => {
  it('is well above Node\'s 1MiB default', () => {
    expect(PROCESS_TABLE_MAX_BUFFER).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('maskComments does not mistake a documented `ps -A` for a call', () => {
    // Comments recording the very pattern this guard hunts must not be flagged…
    expect(classifyPsCalls('doc.ts', '// `ps -A` lists everything\nexecFileSync(\'ps\', [\'-A\']);\n')).toHaveLength(1);
    // …while the real call is.
    expect(classifyPsCalls('doc.ts', '/* ps -axo pid= */\nconst x = 1;\n')).toHaveLength(0);
  });

  it('sees through every obfuscation of a whole-table ps scan', () => {
    const whole = [
      // aliased callee + absolute path
      `const exec = promisify(execFile);\nexec('/bin/ps', ['-axo', 'pid=,ppid=,comm='], {});`,
      // ps-path variable + promisified custom runner
      `run(PS_BINS, ['-Ao', 'pid=,ppid='], remainingMs);`,
      // double quotes
      `execFileSync("ps", ["-A", "-o", "uid=,comm="], {});`,
      // spawn (non-sync) is in the family too
      `spawn('ps', ['-axo', 'pid=']);`,
      // shell-form string
      `execSync('ps -A -o pid= -o ppid=', {});`,
      // template-literal shell form
      'execSync(`ps -axww -o pid=,ppid=,command=`, {});',
    ];
    for (const snippet of whole) {
      const calls = classifyPsCalls('t.ts', snippet);
      expect(calls, snippet).toHaveLength(1);
      expect(calls[0]!.single, snippet).toBe(false);
    }
    // Bounded single-pid lookups are excluded, in every shape they appear.
    const single = [
      `execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]);`,
      `spawnSync('ps', ['-p', String(pid), '-o', 'command=']);`,
      `exec('/bin/ps', ['-p', '123', '-o', 'lstart=']);`,
      `execSync(\`ps -o comm= -p \${pid}\`);`,
    ];
    for (const snippet of single) {
      const calls = classifyPsCalls('t.ts', snippet);
      expect(calls, snippet).toHaveLength(1);
      expect(calls[0]!.single, snippet).toBe(true);
    }
  });

  it('every whole-table ps exec in src/ uses the shared cap', () => {
    const hits: string[] = [];
    const missing: string[] = [];
    const exempted = new Map<string, Exemption>();
    for (const file of walk(SRC)) {
      const rel = relative(process.cwd(), file);
      for (const call of classifyPsCalls(rel, readFileSync(file, 'utf-8'))) {
        if (call.single) continue;
        const where = `${rel}:${call.line}`;
        hits.push(where);
        if (call.capped) continue;
        const exemption = EXEMPTIONS.find(e => e.file === rel && e.match.test(call.text));
        if (exemption) { exempted.set(where, exemption); continue; }
        missing.push(where);
      }
    }
    expect(missing).toEqual([]);
    // Every exemption must actually be exercised, so a stale entry can't hide a gap.
    for (const exemption of EXEMPTIONS) {
      expect([...exempted.values()], exemption.file).toContain(exemption);
      // …and the out-of-line cap it relies on must still be there.
      expect(readFileSync(join(process.cwd(), exemption.file), 'utf-8'), exemption.file).toMatch(exemption.cap);
    }
    // Non-vacuous: the known scans are all seen by the matcher.
    for (const f of [
      'src/adapters/cli/reasonix.ts',
      'src/adapters/backend/zellij-backend.ts',
      'src/adapters/backend/tmux-backend.ts',
      'src/core/session-discovery.ts',
      'src/core/browser-restart.ts',
      'src/core/worker-pool.ts',
      'src/services/codex-session-upgrade.ts',
      'src/core/resource-monitor/darwin.ts',
    ]) expect(hits.some(h => h.startsWith(`${f}:`)), f).toBe(true);
    expect(hits.filter(h => h.startsWith('src/adapters/backend/zellij-backend.ts:'))).toHaveLength(2);
    expect(hits.filter(h => h.startsWith('src/core/resource-monitor/darwin.ts:'))).toHaveLength(2);
  });

  it('browser-restart\'s default runner (used for `ps -Axo command=`) carries the cap', () => {
    const src = readFileSync(join(SRC, 'core/browser-restart.ts'), 'utf-8');
    expect(src).toMatch(/const run = opts\.run \?\? \(async \(file, args\) => pExecFile\(file, args, \{[^}]*maxBuffer: PROCESS_TABLE_MAX_BUFFER[^}]*\}\)\)/);
    expect(src).toMatch(/await run\('ps', \['-Axo', 'command='\]\)/);
  });
});

describe('whole-table ps scans survive >1MiB output (child process, fake ps)', () => {
  let dir: string;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-ps-maxbuf-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fill = (row: (i: number) => string, tail: string) => {
      const rows: string[] = [];
      let size = 0;
      for (let i = 0; size < 2 * 1024 * 1024; i++) { const r = row(i); rows.push(r); size += r.length + 1; }
      rows.push(tail);
      return rows.join('\n') + '\n';
    };
    const pad = 'x'.repeat(60);
    writeFileSync(join(dir, 'pidppid.txt'), fill(i => `${100000 + i} 1`, '777777 4242'));
    writeFileSync(join(dir, 'uidcomm.txt'), fill(() => `${uid} bash-${pad}`, `${uid} zsh`));
    writeFileSync(join(dir, 'rsscmd.txt'), fill(i => `10 /usr/bin/other-${i} ${pad}`, '204800 /Applications/Fake.app/Contents/MacOS/Fake'));
    writeFileSync(join(dir, 'cmd.txt'), fill(i => `/usr/bin/other-${i} ${pad}`, '/usr/sbin/launchd'));
    const sh = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    sh('ps', [
      `D='${dir}'`,
      'case "$*" in',
      '  *uid=*) exec cat "$D/uidcomm.txt" ;;',
      '  *rss=*) exec cat "$D/rsscmd.txt" ;;',
      '  *command=*) exec cat "$D/cmd.txt" ;;',
      '  *) exec cat "$D/pidppid.txt" ;;',
      'esac',
    ].join('\n'));
    sh('osascript', 'exit 0');
    sh('open', 'exit 0');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns real results instead of the ENOBUFS fallback', () => {
    const result = spawnSyncTsEvalWithRepoImports(`
      import { execFileSync } from 'node:child_process';
      import { getChildPids } from './src/core/session-discovery.js';
      import { noTmuxProcessForCurrentUser } from './src/adapters/backend/tmux-backend.js';
      import { detectRunningBrowsers, restartBrowser } from './src/core/browser-restart.js';

      // Control: the fixture really exceeds Node's default maxBuffer.
      let control = 'no-error';
      try { execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' }); }
      catch (e) { control = e.code ?? String(e); }

      const browsers = await detectRunningBrowsers(
        [{ bundleId: 'com.example.fake', label: 'Fake' }],
        { platform: 'darwin', appPathFor: async () => '/Applications/Fake.app' },
      );
      const restart = await restartBrowser(
        { bundleId: 'com.example.fake' },
        { appPath: '/Applications/Fake.app', sleep: async () => {}, quitTimeoutMs: 200 },
      );
      console.log(JSON.stringify({
        control,
        children: getChildPids(4242),
        noTmux: noTmuxProcessForCurrentUser(),
        browsers: browsers.map(b => [b.bundleId, b.memMB]),
        restart,
      }));
    `, {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const out = JSON.parse(String(result.stdout).trim().split('\n').pop()!);
    expect(out.control).toBe('ENOBUFS');
    expect(out.children).toEqual([777777]);
    expect(out.noTmux).toBe(true);
    expect(out.browsers).toEqual([['com.example.fake', 200]]);
    expect(out.restart).toEqual({ ok: true, quit: true, relaunched: true });
  }, 90_000);
});
