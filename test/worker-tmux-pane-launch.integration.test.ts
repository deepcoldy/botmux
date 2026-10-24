/**
 * A real worker starts a NEW Grok session on a real tmux in the shape that
 * failed live on 2026-10-24 ("command too long"): Grok's system prompt via
 * `--rules` plus a first turn in argv, 41 session-env removals — 20 of them in
 * the shared server's global env, one exported by the rcfile — and a long
 * per-bot PATH. Inline, that launch does not fit one tmux command; through the
 * pane launch file it starts, the CLI gets exactly its argv, and every removed
 * variable is still absent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { TMUX_COMMAND_MAX_BYTES, tmuxCommandBytes } from '../src/adapters/backend/pane-launch.js';
import { shellCommandArgv, shellWrapperScript } from '../src/adapters/backend/tmux-backend.js';
import { spawnTsScript, nodeTsRunnerPrefix } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';

const hasTmux = spawnSync('tmux', ['-V']).status === 0 && process.platform === 'linux';

it.skipIf(!hasTmux)('a new Grok session past the inline cap starts with exact argv and the overlay removals intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bmx-wpl-'));
  const data = join(root, 'data');
  const work = join(root, 'work');
  mkdirSync(data);
  mkdirSync(work);
  const report = join(root, 'report.json');
  const probe = join(root, 'probe.cjs');
  writeFileSync(probe, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(`${report}.tmp`)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
fs.renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
setInterval(() => {}, 1000);
`);
  const fixture = join(root, 'grok');
  writeFileSync(fixture, `#!/bin/sh\nexec '${nodeTsRunnerPrefix().command}' '${probe}' "$@"\n`, { mode: 0o700 });
  writeFileSync(join(root, '.bashrc'), 'export RC_GONE=from-rcfile\nexport RC_KEPT=yes\n');

  const uid = process.getuid?.() ?? 0;
  const managedSocket = join(root, `tmux-${uid}`, 'botmux');
  const defaultSocket = join(root, `tmux-${uid}`, 'default');
  const serverGone = Array.from({ length: 20 }, (_, i) => `SERVER_GONE_${i}`);
  const envUnset = [...serverGone, 'RC_GONE', ...Array.from({ length: 20 }, (_, i) => `MIDSCENE_MODEL_SETTING_${i}`)];
  const longPath = [process.env.PATH, ...Array.from({ length: 120 }, (_, i) => `/opt/botmux-test/toolchain-${i}/bin`)].join(':');
  const firstTurn = `【定时任务】每日更新部署：${'拉取最新代码，构建镜像，迁移数据库，校验健康检查并汇报。'.repeat(40)}`;

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BOTMUX_HOME: join(root, '.botmux'), SESSION_DATA_DIR: data,
    TMUX_TMPDIR: root, SHELL: '/bin/bash', BOTMUX_NO_CLAIM: '1', LARK_APP_ID: 'test', LARK_APP_SECRET: 'test' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.BOTMUX_TMUX_SOCKET;
  const sessionId = randomUUID();
  try {
    // Both servers exist up front (the worker tells "no session" from "socket
    // unreachable"); the managed one carries what the overlay must remove.
    expect(spawnSync('tmux', ['new-session', '-d', '-s', 'fixture', 'sleep', '120'], { env }).status).toBe(0);
    const seedEnv = { ...env, SERVER_KEPT: 'kept', ...Object.fromEntries(serverGone.map(name => [name, `server-${name}`])) };
    expect(spawnSync('tmux', ['-S', managedSocket, 'new-session', '-d', '-s', 'seed', 'sleep', '120'], { env: seedEnv }).status).toBe(0);

    const child = spawnTsScript(resolve('src/worker.ts'), [], { env, cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = '';
    child.stdout?.on('data', b => { logs += b; });
    child.stderr?.on('data', b => { logs += b; });
    const exited = new Promise<void>(r => child.once('exit', () => r()));
    try {
      child.send!({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
        workingDir: work, cliId: 'grok', cliPathOverride: fixture, backendType: 'tmux', prompt: firstTurn,
        launchShell: '/bin/bash', env: { PATH: longPath, PROVIDER_TOKEN: 'provider-secret-0123456789' }, envUnset,
        botName: 'TestBot', locale: 'zh', larkAppId: 'test', larkAppSecret: 'test' });
      // Plain deadline loop: `expect.poll` does not exist under `bun test`.
      const deadline = Date.now() + 20_000;
      while (!existsSync(report) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      if (!existsSync(report)) throw new Error(`the CLI never started within 20s\n${logs}`);
      const got = JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> };

      const rules = got.argv[got.argv.indexOf('--rules') + 1] ?? '';
      expect(rules.length, logs).toBeGreaterThan(1000);
      expect(got.argv.at(-1)).toBe(firstTurn);
      expect(got.cwd).toBe(work);
      // Precondition: the old inline pane command — even leaving out every
      // BOTMUX_* assignment it also carried — does not fit one tmux command.
      const inline = shellCommandArgv({ shell: '/bin/bash', flags: ['-i'] }, shellWrapperScript(join(root, '.botmux', 'bin'), 'bash'),
        [work, ...envUnset.flatMap(name => ['-u', name]), `PATH=${longPath}`, fixture, ...got.argv]);
      expect(tmuxCommandBytes(['new-session', '-d', '-s', `bmx-${sessionId.slice(0, 8)}`, '--', ...inline]))
        .toBeGreaterThan(TMUX_COMMAND_MAX_BYTES);

      for (const name of envUnset) expect(got.env, name).not.toHaveProperty(name);
      expect(got.env.SERVER_KEPT).toBe('kept');
      expect(got.env.RC_KEPT).toBe('yes');
      // The bot's PATH, behind the session's identity bin (as on the live fleet).
      expect(got.env.PATH).toBe(`${join(data, 'cli-identity', `${sessionId}.bin`)}:${longPath}`);
      expect(got.env.PROVIDER_TOKEN).toBe('provider-secret-0123456789');
      expect(got.env.BOTMUX_SESSION_ID).toBe(sessionId);

      // The launch file sat in this session's own directory and is gone.
      const launchDir = join(data, 'pane-launch', sessionId);
      expect(existsSync(launchDir), logs).toBe(true);
      expect(readdirSync(launchDir)).toEqual([]);
      const startCommand = execFileSync('tmux', ['-S', managedSocket, 'display-message', '-p', '-t', `=bmx-${sessionId.slice(0, 8)}:`, '#{pane_start_command}'], { env, encoding: 'utf8' });
      expect(startCommand).toContain(launchDir);
      expect(startCommand).not.toContain('provider-secret');
      expect(startCommand).not.toContain('每日更新部署');
    } finally {
      if (child.connected) child.send!({ type: 'close' });
      const timer = setTimeout(() => { void killProcessTree(child); }, 5000);
      await exited;
      clearTimeout(timer);
    }
  } finally {
    // Only this test's own private sockets.
    for (const socket of [managedSocket, defaultSocket]) spawnSync('tmux', ['-S', socket, 'kill-server'], { env, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
