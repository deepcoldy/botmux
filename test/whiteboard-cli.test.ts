import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

let home: string;
let dataDir: string;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) throw new Error('dist/cli.js missing — run `pnpm build` first');
  home = mkdtempSync(join(tmpdir(), 'botmux-whiteboard-cli-'));
  dataDir = join(home, '.botmux', 'data');
  mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeSession(sessionId: string, workingDir: string): void {
  writeFileSync(join(dataDir, 'sessions-app1.json'), JSON.stringify({
    [sessionId]: {
      sessionId,
      chatId: 'chat1',
      rootMessageId: 'root1',
      title: 's',
      status: 'active',
      createdAt: new Date().toISOString(),
      larkAppId: 'app1',
      workingDir,
    },
  }, null, 2));
}

describe('botmux whiteboard CLI', () => {
  it('is disabled by default and refuses agent reads/writes', () => {
    const status = runCli(['whiteboard', 'status']);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).enabled).toBe(false);

    const update = runCli(['whiteboard', 'update', '--id', 'missing', 'x']);
    expect(update.status).not.toBe(0);
    expect(update.stderr).toContain('Whiteboard is disabled');
    expect(existsSync(join(dataDir, 'whiteboards'))).toBe(false);
  });

  it('enables without creating boards, then reuses one default board per chat across bots and working dirs', () => {
    const enable = runCli(['whiteboard', 'enable']);
    expect(enable.status).toBe(0);
    expect(existsSync(join(dataDir, 'whiteboards', 'index.json'))).toBe(false);

    const first = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app1', '--chat-id', 'chat1', '--working-dir', join(home, 'repo-a')]);
    expect(first.status).toBe(0);
    const id = JSON.parse(first.stdout).current.id;
    expect(id).toMatch(/^wb_/);

    const second = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app2', '--chat-id', 'chat1', '--working-dir', join(home, 'repo-b')]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).current.id).toBe(id);
  });

  it('does not let explicit create occupy the chat default binding', () => {
    const explicit = runCli(['whiteboard', 'create', '--id', 'explicit_chat_default_probe', '--title', 'Probe', '--lark-app-id', 'app1', '--chat-id', 'chat-default-probe', '--working-dir', join(home, 'explicit')]);
    expect(explicit.status).toBe(0);
    const cur = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app2', '--chat-id', 'chat-default-probe', '--working-dir', join(home, 'other')]);
    expect(cur.status).toBe(0);
    const currentId = JSON.parse(cur.stdout).current.id;
    expect(currentId).not.toBe('explicit_chat_default_probe');
    const again = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app3', '--chat-id', 'chat-default-probe', '--working-dir', join(home, 'third')]);
    expect(JSON.parse(again.stdout).current.id).toBe(currentId);
  });

  it('supports explicit multiple boards plus stdin update', () => {
    const created = runCli(['whiteboard', 'create', '--id', 'manual_board', '--title', 'Manual', '--lark-app-id', 'app1', '--chat-id', 'chat1', '--working-dir', join(home, 'repo')]);
    expect(created.status).toBe(0);
    const second = runCli(['whiteboard', 'create', '--id', 'manual_board_2', '--title', 'Manual', '--lark-app-id', 'app2', '--chat-id', 'chat1', '--working-dir', join(home, 'other-repo')]);
    expect(second.status).toBe(0);
    const otherChat = runCli(['whiteboard', 'create', '--id', 'manual_other_chat', '--title', 'Manual', '--lark-app-id', 'app3', '--chat-id', 'chat-other', '--working-dir', join(home, 'repo')]);
    expect(otherChat.status).toBe(0);

    const update = runCli(['whiteboard', 'update', '--id', 'manual_board'], 'current state from stdin\n');
    expect(update.status).toBe(0);
    const read = runCli(['whiteboard', 'read', '--id', 'manual_board']);
    expect(read.stdout).toContain('current state from stdin');

    const post = runCli(['whiteboard', 'post', '--id', 'manual_board', '--to', 'bot-b'], 'handoff note\n');
    expect(post.status).not.toBe(0);
    expect(post.stderr).toContain('Unknown whiteboard command: post');
  });

  it('seeds a new board with the Chinese 当前状态 template', () => {
    const created = runCli(['whiteboard', 'create', '--id', 'template_board', '--title', '模板', '--lark-app-id', 'app1', '--chat-id', 'chat-tmpl', '--working-dir', join(home, 'tmpl-repo')]);
    expect(created.status).toBe(0);
    const read = runCli(['whiteboard', 'read', '--id', 'template_board']);
    expect(read.stdout).toContain('# 当前状态');
    expect(read.stdout).toContain('## 项目目标');
    expect(read.stdout).toContain('## 下一步');
  });

  it('requires --yes for overwrite', () => {
    const denied = runCli(['whiteboard', 'write', '--id', 'manual_board'], 'new body');
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('--yes');
    const ok = runCli(['whiteboard', 'write', '--id', 'manual_board', '--yes'], 'new body');
    expect(ok.status).toBe(0);
    expect(runCli(['whiteboard', 'read', '--id', 'manual_board']).stdout).toContain('new body');
  });

  it('can bind current session explicitly', () => {
    writeSession('session1', join(home, 'repo2'));
    const cur = runCli(['whiteboard', 'current', '--create', '--session-id', 'session1']);
    expect(cur.status).toBe(0);
    const id = JSON.parse(cur.stdout).current.id;
    const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions-app1.json'), 'utf-8'));
    expect(sessions.session1.whiteboardId).toBe(id);
  });

  it('rotates log.jsonl by size into fixed 3 archives without losing update entries', () => {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_WHITEBOARD_LOG_MAX_BYTES: '180',
    };
    const run = (args: string[], input?: string) => {
      const r = spawnSync('node', [CLI_PATH, ...args], {
        cwd: home,
        env,
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

    expect(run(['whiteboard', 'create', '--id', 'rotate_board', '--title', 'Rotate']).status).toBe(0);
    for (let i = 0; i < 8; i++) {
      const r = run(['whiteboard', 'update', '--id', 'rotate_board'], `update-${i}-` + 'x'.repeat(120));
      expect(r.status).toBe(0);
    }
    const dir = join(dataDir, 'whiteboards', 'rotate_board');
    const files = readdirSync(dir).filter(f => /^log(?:\.[1-3])?\.jsonl$/.test(f)).sort();
    expect(files).toContain('log.jsonl');
    expect(files).toContain('log.1.jsonl');
    expect(files).toContain('log.2.jsonl');
    expect(files).toContain('log.3.jsonl');
    expect(files).not.toContain('log.4.jsonl');
    const current = readFileSync(join(dir, 'log.jsonl'), 'utf-8');
    expect(current).toContain('overwrite 129 chars');
    const combined = files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(combined).toContain('overwrite 129 chars');
  });

  it('serializes concurrent update writes that trigger log rotation', async () => {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_WHITEBOARD_LOG_MAX_BYTES: '220',
    };
    const create = spawnSync('node', [CLI_PATH, 'whiteboard', 'create', '--id', 'concurrent_board', '--title', 'Concurrent'], {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    expect(create.status).toBe(0);

    const runs = Array.from({ length: 10 }, (_, i) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('node', [CLI_PATH, 'whiteboard', 'update', '--id', 'concurrent_board'], {
        cwd: home,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
      child.on('close', code => resolve({ status: code ?? 1, stdout, stderr }));
      child.stdin.end(`concurrent-${i}-` + 'y'.repeat(160));
    }));
    const results = await Promise.all(runs);
    expect(results.every(r => r.status === 0)).toBe(true);

    const dir = join(dataDir, 'whiteboards', 'concurrent_board');
    const files = readdirSync(dir).filter(f => /^log(?:\.[1-3])?\.jsonl$/.test(f)).sort();
    expect(files).toContain('log.jsonl');
    expect(files).not.toContain('log.4.jsonl');
    expect(files.filter(f => /^log\.[1-3]\.jsonl$/.test(f)).length).toBeLessThanOrEqual(3);
    expect(existsSync(join(dir, '.log.lock'))).toBe(false);
    const combined = files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');
    // With 3 archives + current log and a tiny threshold, only the most recent
    // entries are retained, but every concurrent writer must complete and at
    // least one update audit entry must be present in the rotated set.
    expect(combined).toContain('overwrite 173 chars');
  });

  it('deletes board files, bindings, and stale session whiteboard references', async () => {
    const created = runCli(['whiteboard', 'create', '--id', 'delete_board', '--title', 'Delete me', '--lark-app-id', 'app1', '--chat-id', 'delete-chat', '--working-dir', join(home, 'delete-repo')]);
    expect(created.status).toBe(0);
    const dir = join(dataDir, 'whiteboards', 'delete_board');
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dataDir, 'sessions-app1.json'), JSON.stringify({
      s1: { sessionId: 's1', chatId: 'delete-chat', rootMessageId: 'r', title: 's', status: 'active', createdAt: new Date().toISOString(), larkAppId: 'app1', whiteboardId: 'delete_board' },
    }, null, 2));

    const prevDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    const { deleteWhiteboard } = await import('../dist/services/whiteboard-store.js');
    const result = deleteWhiteboard('delete_board');
    if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = prevDataDir;
    expect(result).toMatchObject({ ok: true, id: 'delete_board', clearedSessions: 1 });
    expect(existsSync(dir)).toBe(false);
    const index = JSON.parse(readFileSync(join(dataDir, 'whiteboards', 'index.json'), 'utf-8'));
    expect(index.boards.delete_board).toBeUndefined();
    expect(Object.values(index.bindings)).not.toContain('delete_board');
    const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions-app1.json'), 'utf-8'));
    expect(sessions.s1.whiteboardId).toBeUndefined();
  });

  // Regression (Major 3 / Traex review): the read→merge→update flow used to be
  // blind last-writer-wins — two agents merging off the SAME stale snapshot
  // would silently clobber each other. writeWhiteboard gained a per-board lock
  // + an optional expectedUpdatedAt CAS primitive; this test wires the CAS
  // through the CLI (--expected-updated-at) and proves a stale-version write
  // is refused (exit 2, whiteboard_cas_mismatch) WITHOUT clobbering the winner,
  // while a fresh-version write succeeds.
  it('read --json exposes updatedAt, and update --expected-updated-at refuses stale overwrites (CAS)', () => {
    expect(runCli(['whiteboard', 'create', '--id', 'cas_board', '--title', 'CAS', '--lark-app-id', 'app1', '--chat-id', 'cas-chat', '--working-dir', join(home, 'cas-repo')]).status).toBe(0);

    // read --json returns the version tag an agent needs to CAS on update.
    const base = runCli(['whiteboard', 'read', '--id', 'cas_board', '--json']);
    expect(base.status).toBe(0);
    const parsed = JSON.parse(base.stdout);
    expect(parsed.id).toBe('cas_board');
    expect(typeof parsed.updatedAt).toBe('string');
    expect(parsed.content).toContain('# 当前状态');
    const v1 = parsed.updatedAt;

    // First writer CASes on v1 → succeeds and returns a newer updatedAt.
    const w1 = runCli(['whiteboard', 'update', '--id', 'cas_board', '--expected-updated-at', v1], 'agent-a merge\n');
    expect(w1.status).toBe(0);
    const v2 = JSON.parse(w1.stdout).board.updatedAt;
    expect(v2).not.toBe(v1);

    // Second writer still holding the STALE base v1 → must be refused, not clobber.
    const w2 = runCli(['whiteboard', 'update', '--id', 'cas_board', '--expected-updated-at', v1], 'agent-b merge\n');
    expect(w2.status).toBe(2);
    expect(w2.stderr).toContain('CAS mismatch');
    expect(w2.stderr).toContain('--json');
    const after = runCli(['whiteboard', 'read', '--id', 'cas_board']).stdout;
    expect(after).toContain('agent-a merge');
    expect(after).not.toContain('agent-b merge');

    // After the conflict, re-reading surfaces a fresh updatedAt; CAS on it wins.
    const v3 = JSON.parse(runCli(['whiteboard', 'read', '--id', 'cas_board', '--json']).stdout).updatedAt;
    const w3 = runCli(['whiteboard', 'update', '--id', 'cas_board', '--expected-updated-at', v3], 'agent-b re-merged\n');
    expect(w3.status).toBe(0);
    expect(runCli(['whiteboard', 'read', '--id', 'cas_board']).stdout).toContain('agent-b re-merged');
  });

  // Back-compat: omitting --expected-updated-at keeps the legacy direct-overwrite
  // behavior (no CAS), so existing callers/skills that don't pass a version still work.
  it('update without --expected-updated-at overwrites directly (no CAS, back-compat)', () => {
    expect(runCli(['whiteboard', 'create', '--id', 'nocas_board', '--title', 'NoCAS', '--lark-app-id', 'app1', '--chat-id', 'nocas-chat', '--working-dir', join(home, 'nocas-repo')]).status).toBe(0);
    expect(runCli(['whiteboard', 'update', '--id', 'nocas_board'], 'first\n').status).toBe(0);
    expect(runCli(['whiteboard', 'update', '--id', 'nocas_board'], 'second\n').status).toBe(0);
    expect(runCli(['whiteboard', 'read', '--id', 'nocas_board']).stdout).toContain('second');
  });

  it('goal charter works while global whiteboard injection feature is disabled', () => {
    expect(runCli(['whiteboard', 'disable']).status).toBe(0);
    const regular = runCli(['whiteboard', 'current', '--create', '--chat-id', 'goal-disabled']);
    expect(regular.status).not.toBe(0);
    expect(regular.stderr).toContain('Whiteboard is disabled');

    const current = runCli(['goal', 'charter', 'current', '--goal', 'goal-disabled', '--create', '--title', 'Goal Disabled']);
    expect(current.status).toBe(0);
    const parsedCurrent = JSON.parse(current.stdout);
    expect(parsedCurrent.enabled).toBe(false);
    expect(parsedCurrent.goal).toBe('goal-disabled');
    expect(parsedCurrent.current.id).toMatch(/^goal_[0-9a-f]{16}$/);
    expect(parsedCurrent.current.title).toBe('Goal Disabled');
    expect(parsedCurrent.current.scope).toBe('custom');
    expect(parsedCurrent.current.chatId).toBe('goal-disabled');

    const read = runCli(['goal', 'charter', 'read', '--goal', 'goal-disabled', '--json']);
    expect(read.status).toBe(0);
    const base = JSON.parse(read.stdout);
    expect(base.id).toBe(parsedCurrent.current.id);
    expect(base.content).toContain('# 当前状态');

    const update = runCli(['goal', 'charter', 'update', '--goal', 'goal-disabled', '--expected-updated-at', base.updatedAt], 'goal charter state\n');
    expect(update.status).toBe(0);
    const stale = runCli(['goal', 'charter', 'update', '--goal', 'goal-disabled', '--expected-updated-at', base.updatedAt], 'stale charter state\n');
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain('botmux goal charter read --goal goal-disabled --json');
    expect(stale.stderr).not.toContain('botmux whiteboard read');
    const after = runCli(['goal', 'charter', 'read', '--goal', 'goal-disabled']);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain('goal charter state');
    expect(after.stdout).not.toContain('stale charter state');
  });
});
