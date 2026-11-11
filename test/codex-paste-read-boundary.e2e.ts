/** Opt-in native acceptance: Codex submits pastes whose frame fills its
 * 1024-byte tty reads exactly. crossterm reads 1024 bytes per call under
 * edge-triggered epoll and returns on the first parsed event; an Enter that
 * arrives in the same write as such a frame stayed in the tty until the next
 * key. Uses an empty HOME and a loopback model fixture; never reads host
 * credentials, talks to Lark, or starts a shared daemon.
 * BOTMUX_CODEX_PASTE_TEST_BIN=/path/to/codex [BOTMUX_CODEX_PASTE_ROUNDS=10] \
 *   [BOTMUX_CODEX_PASTE_ONLY=1012,2036] [BOTMUX_CODEX_PASTE_REPORT=<jsonl>] \
 *   bun x vitest run --project e2e test/codex-paste-read-boundary.e2e.ts
 * ONLY limits the run to those body sizes (no routing-marker cases); REPORT
 * appends each transport's stranded inputs, for repeated before/after runs. */
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { PtyBackend } from '../src/adapters/backend/pty-backend.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { codexNativeComposerState } from '../src/services/codex-terminal-session.js';
import { buildOpenAiResponsesTextEvents } from './helpers/mock-llm-server/openai-responses-sse.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

const BIN = process.env.BOTMUX_CODEX_PASTE_TEST_BIN;
const ROUNDS = Math.max(1, Number(process.env.BOTMUX_CODEX_PASTE_ROUNDS) || 1);
/** Bytes the paste markers add around the body: ESC[200~ + ESC[201~. */
const FRAME_BYTES = 12;
/** `\n\n<botmux_routing>\nbotmux_input_id: <32 hex>\n</botmux_routing>`. */
const ROUTING_MARKER_BYTES = 86;
/** Body sizes from the field report: frame + body = 1023, 1024, 1025, 2048, 3072. */
const ONLY = process.env.BOTMUX_CODEX_PASTE_ONLY?.split(',').map(Number);
const PLAIN_SIZES = [1011, 1012, 1013, 2036, 3060].filter(size => !ONLY || ONLY.includes(size));
/** The same frames once writeInput appends the routing marker to a fresh pane. */
const MARKED_SIZES = ONLY ? [] : [1023, 1024, 1025, 2048, 3072].map(frame => frame - FRAME_BYTES - ROUTING_MARKER_BYTES);

let root: string | undefined;
let server: Server | undefined;
const stops: Array<() => void> = [];
afterEach(async () => {
  while (stops.length) { try { stops.pop()!(); } catch { /* already gone */ } }
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Exactly `bytes` UTF-8 bytes, with multibyte text so the count is in bytes. */
function body(bytes: number, tag: string): string {
  const head = `${tag} 中文 `;
  const pad = bytes - Buffer.byteLength(head);
  if (pad < 0) throw new Error(`tag too long for ${bytes} bytes`);
  const text = head + 'x'.repeat(pad);
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}

type Pane = { target: PtyHandle; capture: () => { viewport: string; cursor: { x: number; y: number } } };

it.skipIf(!BIN).each(['tmux', 'pty'] as const)('real Codex %s: pastes on the 1024-byte read boundary submit at once, exactly once', async transport => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codex-paste-boundary-')));
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  const cwd = join(root, 'work');
  mkdirSync(codexHome, { recursive: true }); mkdirSync(cwd);
  vi.stubEnv('CODEX_HOME', codexHome);
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of buildOpenAiResponsesTextEvents({ text: 'fixture completed' })) {
        const data = JSON.parse(event.data);
        if (data.item?.type === 'message') data.item.phase = 'final_answer';
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const args = [
    '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
    '-c', 'check_for_update_on_startup=false', '-c', 'model_provider="fixture"',
    '-c', `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
    '-c', `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
  ];
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
  const adapter = createCodexAdapter();
  const historyPath = join(codexHome, 'history.jsonl');
  const history = (): string[] => existsSync(historyPath)
    ? readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text as string)
    : [];
  const completedTurns = (): number => {
    const directory = join(codexHome, 'sessions');
    if (!existsSync(directory)) return 0;
    return readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.jsonl'))
      .flatMap(name => readFileSync(join(directory, String(name)), 'utf8').split('\n'))
      .filter(line => { try { const row = JSON.parse(line); return row.type === 'event_msg' && row.payload.type === 'task_complete'; } catch { return false; } })
      .length;
  };

  let paneSeq = 0;
  const open = async (): Promise<Pane> => {
    const index = paneSeq++;
    let pane: Pane;
    if (transport === 'tmux') {
      const socket = `paste-boundary-${process.pid}-${Date.now()}-${index}`;
      execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '100', '-y', '30', '-c', cwd,
        '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), BIN!, ...args]);
      stops.push(() => execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }));
      const backend = new TmuxPipeBackend('fixture', { socketName: socket });
      backend.cliPid = Number(execFileSync('tmux', ['-L', socket, 'display-message', '-p', '-t', 'fixture', '#{pane_pid}'], { encoding: 'utf8' }).trim());
      pane = { target: backend, capture: () => backend.captureInputState() ?? { viewport: '', cursor: { x: 0, y: 0 } } };
    } else {
      const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
      const backend = new PtyBackend();
      backend.spawn(BIN!, args, { cwd, cols: 100, rows: 30, env });
      stops.push(() => { backend.kill(); terminal.dispose(); });
      backend.onData(data => terminal.write(data));
      terminal.onData(data => backend.write(data)); // Answers Codex's terminal queries.
      const capture = () => {
        const buffer = terminal.buffer.active;
        return {
          viewport: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').join('\n'),
          cursor: { x: buffer.cursorX, y: buffer.cursorY },
        };
      };
      // The production PTY write path: the adapter writes through the backend.
      pane = { target: { cliPid: backend.getChildPid()!, write: data => backend.write(data), captureInputState: capture }, capture };
    }
    // The composer state writeInput itself requires (0.166+ paints a
    // provisional `›` first; that state is not `empty`).
    // Startup budget only; a loaded host can take well over 20s to cold-start.
    await waitFor(pane, () => codexNativeComposerState(pane.capture()) === 'empty', 60_000);
    await delay(500);
    return pane;
  };
  const waitFor = async (pane: Pane, condition: () => boolean, ms = 15_000): Promise<void> => {
    // Assert the observation that ended the wait: Codex keeps redrawing, so a
    // second capture can land on a transient frame.
    const end = Date.now() + ms;
    let met = condition();
    while (!met && Date.now() < end) { await delay(50); met = condition(); }
    const screen = pane.capture();
    expect(met, `${transport}\n${JSON.stringify(screen.cursor)}\n${screen.viewport}`).toBe(true);
  };

  const failures: string[] = [];
  let submittedTurns = 0;
  /** One input: it must submit within writeInput's own wait. A stranded one is
   * recorded, then released with a key so the next case starts clean. */
  const send = async (pane: Pane, text: string, label: string, correlateTranscript = false): Promise<void> => {
    const before = history().length;
    const result = await adapter.writeInput(pane.target, text, correlateTranscript ? { correlateTranscript } : undefined);
    if (!result.submitted) {
      failures.push(`${label}: ${JSON.stringify(result)}`);
      pane.target.write('\r');
    }
    await waitFor(pane, () => history().length > before);
    submittedTurns++;
    await waitFor(pane, () => completedTurns() >= submittedTurns && codexNativeComposerState(pane.capture()) === 'empty');
  };

  const expected: string[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    // An existing conversation: a seed turn first, then every boundary size.
    const pane = await open();
    const seed = `seed ${transport} r${round}`;
    await send(pane, seed, `r${round} seed`);
    expected.push(seed);
    for (const size of PLAIN_SIZES) {
      const text = body(size, `${transport} r${round} plain ${size}`);
      await send(pane, text, `r${round} plain ${size} (frame ${size + FRAME_BYTES})`);
      expected.push(text);
    }
    const next = `next ${transport} r${round}`;
    await send(pane, next, `r${round} next`);
    expected.push(next);
    stops.pop()!();

    // writeInput appends the routing marker only to a fresh pane's first input.
    for (const size of MARKED_SIZES) {
      const marked = await open();
      const text = body(size, `${transport} r${round} marked ${size}`);
      await send(marked, text, `r${round} marked ${size} (frame ${size + ROUTING_MARKER_BYTES + FRAME_BYTES})`, true);
      const recorded = history().at(-1)!;
      expect(recorded.startsWith(`${text}\n\n<botmux_routing>\nbotmux_input_id: `), recorded.slice(-120)).toBe(true);
      expect(Buffer.byteLength(recorded)).toBe(size + ROUTING_MARKER_BYTES);
      expected.push(recorded);
      const after = `after marked ${size} ${transport} r${round}`;
      await send(marked, after, `r${round} after marked ${size}`);
      expected.push(after);
      stops.pop()!();
    }
  }
  if (process.env.BOTMUX_CODEX_PASTE_REPORT) {
    appendFileSync(process.env.BOTMUX_CODEX_PASTE_REPORT, `${JSON.stringify({ transport, rounds: ROUNDS, failures })}\n`);
  }
  // Each input in the native history exactly once, in order, nothing extra.
  expect(history()).toEqual(expected);
  expect(failures).toEqual([]);
}, 300_000 * ROUNDS);
