/**
 * tmux panes read their launch argv from a private file (src/adapters/backend/
 * pane-launch.ts) instead of tmux's single-message command, which tmux caps at
 * 16,364 packed bytes. Real shells, real tmux on private sockets, a real Node
 * probe standing in for the CLI.
 *
 * What must hold:
 *   - the cap is tmux's actual one (pinned against the real binary);
 *   - the worst launch seen live (long Grok system prompt + first turn, dozens
 *     of session-env removals, a long PATH) starts through TmuxPipeBackend,
 *     although the same launch inline is rejected by tmux;
 *   - argv, cwd and environment are exactly what the inline launch delivered,
 *     in every supported shell, with the user's rcfile in play;
 *   - session-env removals still hold against the server's global env and the
 *     rcfile;
 *   - nothing of the launch stays in tmux's pane_start_command or on disk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBotmuxEnvAssignments, shellCommandArgv, shellKindForPath, shellWrapperScript, type ShellSpec } from '../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { paneLaunchLoader, TMUX_COMMAND_MAX_BYTES, tmuxCommandBytes, writePaneLaunchFile } from '../src/adapters/backend/pane-launch.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { strictPaneCommand, strictPaneEnvArgs } from '../src/adapters/backend/strict-env.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { isExecutable } from '../src/utils/executable.js';
import { nodeTsRunnerPrefix } from './helpers/ts-runner.js';

let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { /* optional */ }
const nodeBin = nodeTsRunnerPrefix().command;

const CANDIDATE_SHELLS: ShellSpec[] = [
  { shell: '/bin/bash', flags: ['-i'] },
  { shell: existsSync('/bin/zsh') ? '/bin/zsh' : '/usr/bin/zsh', flags: ['-l', '-i'] },
  { shell: '/bin/sh', flags: [] },
  { shell: existsSync('/usr/bin/fish') ? '/usr/bin/fish' : '/usr/local/bin/fish', flags: ['-i'] },
];

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** Short root: unix socket paths are capped near 104 bytes. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const PROBE = `const fs = require('node:fs');
const [report, ...args] = process.argv.slice(2);
fs.writeFileSync(report + '.tmp', JSON.stringify({ argv: args, cwd: process.cwd(), env: process.env }));
fs.renameSync(report + '.tmp', report);
if (report.endsWith('.linger')) setTimeout(() => {}, 120000);
`;

interface ProbeReport { argv: string[]; cwd: string; env: Record<string, string> }

/** A HOME whose startup files fight the launch: an rm that removes nothing
 *  (think rm → trash), allexport, a variable the overlay removes, a stray cd. */
function hostileHome(root: string): string {
  const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'fish'), { recursive: true });
  const posix = "rm() { :; }\nexport RC_GONE=from-rcfile\nexport RC_KEPT=yes\ncd /\n";
  writeFileSync(join(home, '.bashrc'), `set -a\n${posix}`);
  writeFileSync(join(home, '.zshrc'), `setopt allexport\n${posix}`);
  writeFileSync(join(home, '.config', 'fish', 'config.fish'), "function rm; end\nset -gx RC_GONE from-rcfile\nset -gx RC_KEPT yes\ncd /\n");
  return home;
}

const HOSTILE_ARGS = [
  '--rules', `多行\n规则 'q' "dq" $HOME \${Y} \`id\` !!x !\\ \\\\ \t 结尾`,
  '', '-x', '--', '-', '@file', 'a=b', '$(touch pwned)', "it's",
];

async function waitForReport(path: string, timeoutMs = 15_000): Promise<ProbeReport> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`probe never reported at ${path}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ProbeReport;
}

describe.skipIf(!realTmux)('tmux command size cap', () => {
  it('tmux sends exactly TMUX_COMMAND_MAX_BYTES packed bytes and refuses one more', () => {
    const socket = join(scratch('cap-'), 's');
    const env = { ...process.env, TMUX: '', TMUX_PANE: '' };
    const tmux = (...args: string[]) => spawnSync(realTmux!, ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' });
    expect(tmux('new-session', '-d', '-s', 'keep', '--', 'sleep', '60').status).toBe(0);
    try {
      // Counted in UTF-8 bytes, not characters: pad with CJK up to the edge.
      const command = (name: string, padBytes: number) => {
        const cjk = '中'.repeat(Math.floor(padBytes / 3));
        return ['new-session', '-d', '-s', name, '--', 'true', cjk + 'x'.repeat(padBytes - Buffer.byteLength(cjk))];
      };
      const fits = command('fits', 0);
      const atCap = command('fits', TMUX_COMMAND_MAX_BYTES - tmuxCommandBytes(fits));
      expect(tmuxCommandBytes(atCap)).toBe(TMUX_COMMAND_MAX_BYTES);
      const accepted = tmux(...atCap);
      expect(accepted.stderr.trim()).toBe('');
      expect(accepted.status).toBe(0);
      const over = command('over', TMUX_COMMAND_MAX_BYTES + 1 - tmuxCommandBytes(command('over', 0)));
      expect(tmuxCommandBytes(over)).toBe(TMUX_COMMAND_MAX_BYTES + 1);
      const refused = tmux(...over);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/failed to send command|command too long/);
    } finally {
      tmux('kill-server');
    }
  });
});

describe('launch file vs the inline launch, outside tmux', () => {
  for (const spec of CANDIDATE_SHELLS) {
    it.skipIf(!isExecutable(spec.shell))(`${spec.shell}: same argv, cwd and environment; the file is gone afterwards`, () => {
      const root = scratch('par-');
      const home = hostileHome(root);
      const cwd = join(root, "dir with 'quote' 空格");
      mkdirSync(cwd);
      const probe = join(root, 'probe.cjs');
      writeFileSync(probe, PROBE);
      const kind = shellKindForPath(spec.shell);
      const script = shellWrapperScript(join(root, 'wrapper-bin'), kind);
      const shellEnv = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', SERVER_GONE: 'from-server', SERVER_KEPT: 'kept' };
      const argvFor = (report: string) => [
        cwd,
        ...buildBotmuxEnvAssignments({ BOTMUX_SESSION_ID: 'sid-1' }, { INJECTED_TOKEN: "v a l'u\"e $HOME `id` 第二行\n中文" }, ['SERVER_GONE', 'RC_GONE']),
        nodeBin, probe, report, ...HOSTILE_ARGS,
      ];
      const run = (argv: string[]) => spawnSync(argv[0]!, argv.slice(1), { env: shellEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 });

      const inlineReport = join(root, 'inline.json');
      run(shellCommandArgv(spec, script, argvFor(inlineReport)));
      const fileReport = join(root, 'file.json');
      const launchDir = join(root, 'launch');
      const file = writePaneLaunchFile(launchDir, { kind, script, argv: argvFor(fileReport) });
      const result = run(shellCommandArgv(spec, paneLaunchLoader(kind), [file.path]));
      expect(existsSync(fileReport), result.stderr).toBe(true);

      const inline = JSON.parse(readFileSync(inlineReport, 'utf8')) as ProbeReport;
      const viaFile = JSON.parse(readFileSync(fileReport, 'utf8')) as ProbeReport;
      expect(viaFile).toEqual(inline);
      expect(viaFile.argv).toEqual(HOSTILE_ARGS);
      expect(viaFile.cwd).toBe(cwd);
      expect(viaFile.env.INJECTED_TOKEN).toBe("v a l'u\"e $HOME `id` 第二行\n中文");
      expect(viaFile.env.SERVER_KEPT).toBe('kept');
      expect(viaFile.env).not.toHaveProperty('SERVER_GONE');
      expect(viaFile.env).not.toHaveProperty('RC_GONE');
      expect(viaFile.env).not.toHaveProperty('DISABLE_AUTO_UPDATE');
      if (kind !== 'sh') expect(viaFile.env.RC_KEPT).toBe('yes');
      expect(readdirSync(launchDir)).toEqual([]);
      expect(existsSync(join(cwd, 'pwned'))).toBe(false);
      expect(existsSync(join(home, 'pwned'))).toBe(false);
    });
  }
});

describe('real CLI argv shapes', () => {
  // Every adapter's argv reaches its CLI through the same file — first prompts
  // within the adapter's own baked-prompt budget.
  const IDS: CliId[] = ['claude-code', 'codex', 'kimi', 'opencode', 'cursor', 'codem', 'traex', 'minimax', 'grok', 'gemini', 'pi'];
  it.each(IDS)('%s', id => {
    const root = scratch('cli-');
    const probe = join(root, 'probe.cjs');
    writeFileSync(probe, PROBE);
    const adapter = createCliAdapterSync(id);
    const budget = adapter.maxInitialPromptArgBytes ?? 8192;
    const initialPrompt = adapter.passesInitialPromptViaArgs
      ? `@Bot 请处理：'引号' "双引号" $VAR \`cmd\` !! ${'中文'.repeat(budget)}`.slice(0, Math.floor(budget / 3))
      : undefined;
    const args = adapter.buildArgs({
      sessionId: '11111111-2222-4333-8444-555555555555', resume: false, workingDir: root,
      initialPrompt, botName: 'TestBot', botOpenId: 'ou_test', larkAppId: 'cli_test',
    });
    const report = join(root, 'report.json');
    const spec: ShellSpec = { shell: '/bin/sh', flags: [] };
    const file = writePaneLaunchFile(join(root, 'launch'), {
      kind: 'sh',
      script: shellWrapperScript(join(root, 'wrapper-bin'), 'sh'),
      argv: [root, ...buildBotmuxEnvAssignments({ BOTMUX_SESSION_ID: 'sid' }), nodeBin, probe, report, ...args],
    });
    const [command, ...commandArgs] = shellCommandArgv(spec, paneLaunchLoader('sh'), [file.path]);
    const result = spawnSync(command!, commandArgs, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, encoding: 'utf8', timeout: 30_000,
    });
    expect(existsSync(report), result.stderr).toBe(true);
    expect((JSON.parse(readFileSync(report, 'utf8')) as ProbeReport).argv).toEqual(args);
  });
});

/** The 10-24 shape on a private tmux: 20 variables the overlay removes sit in
 *  the shared server's global env (as the 10-23 global-layer removals did on
 *  the live fleet), a long per-bot PATH, Grok's `--rules` plus a first turn at
 *  its budget. */
function worstCase(shell: string) {
  const root = scratch('wc-');
  const socket = join(root, 's');
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  // Every tmux the backend runs goes to THIS private socket.
  writeFileSync(join(shimDir, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -S '${socket}' "$@"\n`, { mode: 0o755 });
  const home = hostileHome(root);
  const cwd = join(root, 'repo 工作区');
  mkdirSync(cwd);
  const probe = join(root, 'probe.cjs');
  writeFileSync(probe, PROBE);
  const report = join(root, 'report.linger');
  const serverGone = Array.from({ length: 20 }, (_, i) => `SERVER_GONE_${i}`);
  const serverEnv: Record<string, string> = {
    HOME: home, PATH: `${shimDir}:${process.env.PATH}`, SHELL: shell, TERM: 'xterm-256color', LANG: 'C.UTF-8',
    SERVER_KEPT: 'kept', ...Object.fromEntries(serverGone.map(name => [name, `server-${name}`])),
  };
  expect(spawnSync(realTmux!, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'seed', '--', 'sleep', '300'], { env: serverEnv }).status).toBe(0);
  vi.stubEnv('PATH', serverEnv.PATH);
  vi.stubEnv('TMUX', '');
  const unsetEnv = [
    ...serverGone, 'RC_GONE',
    ...Array.from({ length: 20 }, (_, i) => `MIDSCENE_MODEL_SETTING_${i}`),
  ];
  const injectedPath = [process.env.PATH, ...Array.from({ length: 120 }, (_, i) => `/opt/botmux-test/toolchain-${i}/bin`)].join(':');
  const injectEnv = { PATH: injectedPath, PROVIDER_TOKEN: 'provider-secret-0123456789' };
  const env: Record<string, string> = {
    HOME: home, PATH: serverEnv.PATH, SHELL: shell, TERM: 'xterm-256color',
    BOTMUX: '1', BOTMUX_SESSION_ID: 'feedface-0000-4000-8000-000000000001', BOTMUX_CHAT_ID: 'oc_test',
    BOTMUX_LARK_APP_ID: 'cli_test', TMPDIR: root,
  };
  const rules = `<botmux_rules>\n${'你在飞书话题里工作，回复必须用 botmux send 发送，不要把凭据写进消息。\n'.repeat(90)}</botmux_rules>`;
  const firstTurn = `部署任务：${'按顺序执行并汇报结果。'.repeat(130)}`;
  const cliArgs = [probe, report, '--session-id', 'feedface-0000-4000-8000-000000000001', '--rules', rules, firstTurn];
  const launchDir = join(root, 'pane-launch', 'feedface');
  const startCommand = () => execFileSync(realTmux!, ['-S', socket, 'display-message', '-p', '-t', '=bmx-feedface:', '#{pane_start_command}'], { encoding: 'utf8' });
  const killServer = () => spawnSync(realTmux!, ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  return { socket, serverEnv, home, cwd, report, unsetEnv, injectedPath, injectEnv, env, cliArgs, launchDir, startCommand, killServer };
}

function expectNothingLeftBehind(launchDir: string, startCommand: string) {
  // The pane shell read and deleted its file; tmux kept only the loader.
  expect(readdirSync(launchDir)).toEqual([]);
  expect(Buffer.byteLength(startCommand)).toBeLessThan(1024);
  expect(startCommand).not.toContain('provider-secret');
  expect(startCommand).not.toContain('botmux_rules');
  expect(startCommand).not.toContain('MIDSCENE_MODEL_SETTING_0');
}

describe.skipIf(!realTmux)('worst-case launch through TmuxPipeBackend on a real tmux', () => {
  for (const spec of CANDIDATE_SHELLS) {
    it.skipIf(!isExecutable(spec.shell))(`${spec.shell}: starts, gets exact argv/env, removals hold, nothing left behind`, async () => {
      const w = worstCase(spec.shell);
      const kind = shellKindForPath(spec.shell);
      // Precondition: inline, this launch is past tmux's cap and tmux says so.
      const inline = ['new-session', '-d', '-s', 'inline', '--', ...shellCommandArgv(spec, shellWrapperScript(join(w.home, '.botmux', 'bin'), kind),
        [w.cwd, ...buildBotmuxEnvAssignments(w.env, w.injectEnv, w.unsetEnv), nodeBin, ...w.cliArgs])];
      expect(tmuxCommandBytes(inline)).toBeGreaterThan(TMUX_COMMAND_MAX_BYTES);
      expect(spawnSync(realTmux!, ['-S', w.socket, ...inline], { env: w.serverEnv, encoding: 'utf8' }).stderr).toMatch(/command too long/);

      const backend = new TmuxPipeBackend('bmx-feedface', { createSession: true, ownsSession: true });
      try {
        backend.spawn(nodeBin, w.cliArgs, { cwd: w.cwd, cols: 160, rows: 50, env: w.env, injectEnv: w.injectEnv, unsetEnv: w.unsetEnv, launchShell: spec.shell, paneLaunchDir: w.launchDir });
        const got = await waitForReport(w.report);
        expect(got.argv).toEqual(w.cliArgs.slice(2));
        expect(got.cwd).toBe(w.cwd);
        expect(got.env.PATH).toBe(w.injectedPath);
        expect(got.env.PROVIDER_TOKEN).toBe('provider-secret-0123456789');
        expect(got.env.BOTMUX_SESSION_ID).toBe('feedface-0000-4000-8000-000000000001');
        expect(got.env.SERVER_KEPT).toBe('kept');
        for (const name of w.unsetEnv) expect(got.env, name).not.toHaveProperty(name);
        if (kind !== 'sh') expect(got.env.RC_KEPT).toBe('yes');
        expectNothingLeftBehind(w.launchDir, w.startCommand());
      } finally {
        backend.destroySession();
        w.killServer();
      }
    }, 30_000);
  }

  it('strict pane (env -i, v3 workflow): exactly the listed environment, exact argv, nothing left behind', async () => {
    const w = worstCase('/bin/bash');
    const opts = { cwd: w.cwd, cols: 160, rows: 50, env: w.env, injectEnv: w.injectEnv, unsetEnv: w.unsetEnv, strictEnv: true, paneLaunchDir: w.launchDir };
    // Precondition: the old direct `env -i` argv alone does not fit one tmux command.
    expect(tmuxCommandBytes(['new-session', '-d', '-s', 'bmx-feedface', '--', ...strictPaneCommand(nodeBin, w.cliArgs, opts)]))
      .toBeGreaterThan(TMUX_COMMAND_MAX_BYTES);
    const backend = new TmuxPipeBackend('bmx-feedface', { createSession: true, ownsSession: true });
    try {
      backend.spawn(nodeBin, w.cliArgs, opts);
      const got = await waitForReport(w.report);
      expect(got.argv).toEqual(w.cliArgs.slice(2));
      expect(got.cwd).toBe(w.cwd);
      // Nothing from the server's global env, the rcfile or the loader shell:
      // exactly what strict mode lists (removals already applied, bot PATH wins).
      const listed = Object.fromEntries(strictPaneEnvArgs(opts).slice(1).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
      expect(got.env).toEqual(listed);
      expect(got.env).not.toHaveProperty('SERVER_KEPT');
      expect(got.env.PATH).toBe(w.injectedPath);
      expectNothingLeftBehind(w.launchDir, w.startCommand());
    } finally {
      backend.destroySession();
      w.killServer();
    }
  }, 30_000);
});
