import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PLAYER = resolve('test/helpers/traex-tape-player.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const EYES_SHUT = '\x1b7\x1b[3;5H─\x1b[3;7H─\x1b8';
const ERASE_BELOW = '\x1b[?2026h\x1b[23;1H\x1b[J';
const CURSOR_ONLY = '\x1b[?2026h\x1b[?25l\x1b[25;1H\x1b[0 q\x1b[27;3H\x1b[?25h';

describe('TraeX tape player idle blink', () => {
  it('loops only logo-eye repaints, never a visible-empty redraw chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'traex-tape-player-'));
    dirs.push(dir);
    const tapePath = join(dir, 'tape.json');
    writeFileSync(tapePath, JSON.stringify({
      version: 1,
      nativeSessionId: '00000000-0000-7000-8000-000000000999',
      events: [
        { t: 0, kind: 'pty', data: '\x1b[2J\x1b[H│ banner │\r\n❯ composer\r\n' },
        { t: 100, kind: 'submit', text: 'one' },
        { t: 150, kind: 'pty', data: 'working' },
        { t: 200, kind: 'rollout', record: { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } } },
        // Real post-turn redraw: erase below, then the composer.
        { t: 210, kind: 'pty', data: ERASE_BELOW },
        { t: 220, kind: 'pty', data: '\x1b[24;1H❯ composer' },
        { t: 230, kind: 'pty', data: '\x1bM\x1bM\r\n' },
        // A redraw split inside its control sequence: neither half may loop.
        { t: 240, kind: 'pty', data: '\x1b[23;1H\x1b[' },
        { t: 241, kind: 'pty', data: 'J' },
        { t: 300, kind: 'pty', data: CURSOR_ONLY },
        // node-pty may split one repaint across callbacks.
        { t: 301, kind: 'pty', data: '\x1b7\x1b[3;5H◆' },
        { t: 302, kind: 'pty', data: '\x1b[3;7H◆\x1b8' },
        { t: 500, kind: 'pty', data: EYES_SHUT },
        // The post-turn slice may END inside a control sequence; its final
        // byte only arrives with the next turn.
        { t: 990, kind: 'pty', data: '\x1b[24;1H\x1b[' },
        { t: 1000, kind: 'submit', text: 'two' },
        { t: 1010, kind: 'pty', data: 'J' },
      ],
    }));
    const child = spawn(process.execPath, [PLAYER], {
      cwd: dir,
      env: {
        ...process.env,
        TRAEX_TAPE: tapePath,
        TRAEX_TAPE_ROLLOUT: join(dir, 'rollout.jsonl'),
        TRAEX_TAPE_HISTORY: join(dir, 'history.jsonl'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    // No submit: startup plays, then the idle blink loop runs (≥1 cycle).
    await new Promise(r => setTimeout(r, 3_000));
    child.kill('SIGKILL');

    expect(out).toContain('❯ composer');
    expect(out).toContain('\x1b7\x1b[3;5H◆\x1b[3;7H◆\x1b8');
    expect(out).toContain(EYES_SHUT);
    expect(out).toContain(CURSOR_ONLY);
    // Structural redraw pieces must never loop while idle.
    expect(out).not.toContain('\x1b[J');
    expect(out).not.toContain('\x1bM');
    expect(out).not.toContain('\x1b[23;1H');
    expect(out).not.toContain('\x1b[24;1H\x1b[');
  }, 10_000);
});
