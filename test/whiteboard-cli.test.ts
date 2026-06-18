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

    const append = runCli(['whiteboard', 'append', '--id', 'missing', 'x']);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain('Whiteboard is disabled');
    expect(existsSync(join(dataDir, 'whiteboards'))).toBe(false);
  });

  it('enables without creating boards, then reuses the same binding', () => {
    const enable = runCli(['whiteboard', 'enable']);
    expect(enable.status).toBe(0);
    expect(existsSync(join(dataDir, 'whiteboards', 'index.json'))).toBe(false);

    const first = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app1', '--chat-id', 'chat1', '--working-dir', join(home, 'repo')]);
    expect(first.status).toBe(0);
    const id = JSON.parse(first.stdout).current.id;
    expect(id).toMatch(/^wb_/);

    const second = runCli(['whiteboard', 'current', '--create', '--lark-app-id', 'app1', '--chat-id', 'chat1', '--working-dir', join(home, 'repo')]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).current.id).toBe(id);
  });

  it('supports explicit multiple boards and stdin append/post', () => {
    const created = runCli(['whiteboard', 'create', '--id', 'manual_board', '--title', 'Manual', '--lark-app-id', 'app1', '--chat-id', 'chat1', '--working-dir', join(home, 'repo')]);
    expect(created.status).toBe(0);

    const append = runCli(['whiteboard', 'append', '--id', 'manual_board'], 'hello from stdin\n');
    expect(append.status).toBe(0);
    const read = runCli(['whiteboard', 'read', '--id', 'manual_board']);
    expect(read.stdout).toContain('hello from stdin');

    const post = runCli(['whiteboard', 'post', '--id', 'manual_board', '--to', 'bot-b'], 'handoff note\n');
    expect(post.status).toBe(0);
    const log = readFileSync(join(dataDir, 'whiteboards', 'manual_board', 'log.jsonl'), 'utf-8');
    expect(log).toContain('handoff note');
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

  it('rotates log.jsonl by size into fixed 3 archives without losing append/post entries', () => {
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
      const r = i % 2 === 0
        ? run(['whiteboard', 'post', '--id', 'rotate_board'], `post-${i}-` + 'x'.repeat(120))
        : run(['whiteboard', 'append', '--id', 'rotate_board'], `append-${i}-` + 'x'.repeat(120));
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
    expect(current).toContain('append-7');
    const combined = files.map(f => readFileSync(join(dir, f), 'utf-8')).join('\n');
    expect(combined).toContain('post-6');
    expect(combined).toContain('append-7');
  });

  it('serializes concurrent post writes that trigger log rotation', async () => {
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
      const child = spawn('node', [CLI_PATH, 'whiteboard', 'post', '--id', 'concurrent_board'], {
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
    // least one late entry must be present in the rotated set.
    expect(combined).toMatch(/concurrent-[0-9]/);
  });
});
