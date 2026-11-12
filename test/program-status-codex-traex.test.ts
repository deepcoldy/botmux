import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProgramStatusFramingStream, type ProgramStatusPart } from '../src/utils/program-status-parser.js';
import { IdleDetector, type ProgramStatusEvent } from '../src/utils/idle-detector.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { cliVersionAtLeast, programStatusBlockHoldsTypeAhead, programStatusEnabledForLaunch, startupIdleReportScreenAdmits } from '../src/core/program-status-gate.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

// Real pipe-pane byte streams: codex-cli 0.163.0 / 0.167.0 and traecli
// 0.214.1 in a private tmux server, driven by a loopback model. `write` marks
// where a botmux-style paste + Enter (or a typed slash command) went in.
type Item = [number, 'out' | 'write' | 'key', string];
interface Recording { cli: 'codex' | 'traex'; version: string; scenario: string; items: Item[] }
const { recordings } = JSON.parse(readFileSync(new URL('./fixtures/program-status/codex-traex-osc7501.json', import.meta.url), 'utf8')) as { recordings: Recording[] };
const recording = (cli: string, version: string, scenario: string): Recording => {
  const found = recordings.find(r => r.cli === cli && r.version === version && r.scenario === scenario);
  if (!found) throw new Error(`missing recording ${cli} ${version} ${scenario}`);
  return found;
};
const adapterFor = (cli: Recording['cli']): CliAdapter => cli === 'codex' ? createCodexAdapter('/bin/codex') : createTraexAdapter('/bin/traex');
const writeTimes = (rec: Recording, label?: string) => rec.items.filter(([, kind, data]) => kind === 'write' && (!label || data === label)).map(([t]) => t);
const reportTimes = (rec: Recording, state: string) => rec.items.flatMap(([t, kind, data]) => kind === 'out'
  ? [...data.matchAll(/\x1b\]7501;state=(\w+)/g)].filter(m => m[1] === state).map(() => t) : []);

interface Edge { t: number; edge: 'idle' | 'busy'; source?: string }

/** Replay a recording on a fake clock through the worker's own pipeline:
 * ProgramStatusFramingStream → IdleDetector.observeProgramStatus / feed, and
 * IdleDetector.reset({ inputCycle: true }) where botmux wrote. */
function replay(rec: Recording, opts: { onStatus?: (t: number, event: ProgramStatusEvent, detector: IdleDetector) => void; tailMs?: number } = {}) {
  vi.useFakeTimers({ now: 0 });
  const detector = new IdleDetector(adapterFor(rec.cli));
  const stream = new ProgramStatusFramingStream();
  const edges: Edge[] = [];
  let now = 0;
  detector.onIdle(source => { edges.push({ t: now, edge: 'idle', source }); });
  detector.onBusy(() => { edges.push({ t: now, edge: 'busy' }); });
  for (const [t, kind, data] of rec.items) {
    vi.advanceTimersByTime(t - now);
    now = t;
    if (kind === 'write') { detector.reset({ inputCycle: true }); continue; }
    if (kind !== 'out') continue;
    for (const part of stream.feed(data)) {
      if (part.type === 'status') {
        detector.observeProgramStatus(part.event);
        opts.onStatus?.(t, part.event, detector);
      } else if (part.type === 'data') {
        detector.feed(part.text);
      }
    }
  }
  const end = now + (opts.tailMs ?? 20_000);
  for (let step = now + 100; step <= end; step += 100) { vi.advanceTimersByTime(100); now = step; }
  return { detector, edges };
}
const statusIdles = (edges: Edge[]) => edges.filter(e => e.edge === 'idle' && e.source === 'program-status').map(e => e.t);

afterEach(() => { vi.useRealTimers(); });

describe('recorded codex / traex OSC 7501 byte streams', () => {
  const statesOf = (parts: ProgramStatusPart[]) => parts.flatMap(p => p.type === 'status' ? [`${p.event.state}:${p.event.app}${p.event.kind ? `:${p.event.kind}` : ''}`] : []);
  const dataOf = (parts: ProgramStatusPart[]) => parts.map(p => p.type === 'data' ? p.text : '').join('');

  it.each(recordings.map(r => [`${r.cli} ${r.version} ${r.scenario}`, r] as const))('%s parses identically whole, per recorded chunk and byte by byte', (_name, rec) => {
    const chunks = rec.items.filter(([, kind]) => kind === 'out').map(([, , data]) => data);
    const whole = new ProgramStatusFramingStream().feed(chunks.join(''));
    const perChunk = (() => { const s = new ProgramStatusFramingStream(); return chunks.flatMap(c => s.feed(c)); })();
    const perChar = (() => { const s = new ProgramStatusFramingStream(); return [...chunks.join('')].flatMap(c => s.feed(c)); })();
    const expected = statesOf(whole);
    expect(expected.length).toBeGreaterThan(0);
    expect(statesOf(perChunk)).toEqual(expected);
    expect(statesOf(perChar)).toEqual(expected);
    expect(dataOf(perChunk)).toBe(dataOf(whole));
    // The reports are stripped from the screen bytes, nothing else is.
    expect(dataOf(whole)).toBe(chunks.join('').replace(/\x1b\]7501;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
    expect(dataOf(whole)).not.toContain('7501;');
  });
});

describe('codex OSC 7501 turn edges (recorded)', () => {
  it('ignores startup reports: the provisional-composer idle and an MCP-boot working publish nothing', () => {
    const rec = recording('codex', '0.167.0', 'turns-with-slow-mcp-startup');
    const [firstWrite] = writeTimes(rec);
    // Recorded: idle on the provisional composer, then working until the slow
    // MCP server is up — while the composer already accepts and runs input.
    expect(reportTimes(rec, 'idle')[0]).toBeLessThan(firstWrite!);
    expect(reportTimes(rec, 'working')[0]).toBeLessThan(firstWrite!);
    const states: string[] = [];
    const { edges } = replay(rec, {
      onStatus: (t, event, detector) => { if (t < firstWrite!) states.push(`${event.state}:${detector.programStatusActive()}`); },
    });
    expect(states).toEqual(['idle:false', 'working:false']);
    expect(edges.filter(e => e.t < firstWrite!)).toEqual([]);
  });

  it('ends each turn on its done report, never on the idle that acknowledges the previous result', () => {
    const rec = recording('codex', '0.167.0', 'turns-with-slow-mcp-startup');
    const done = reportTimes(rec, 'done');
    const ackIdles = reportTimes(rec, 'idle').filter(t => t > writeTimes(rec)[0]!);
    expect(ackIdles.length).toBeGreaterThan(0);
    const { edges } = replay(rec);
    // The first message went in while MCP boot still reported working: its
    // turn reports only done. The follow-up written while the third turn
    // reported working is covered by that turn's done (typed ahead).
    expect(statusIdles(edges)).toEqual(done);
    expect(edges.filter(e => e.edge === 'idle' && ackIdles.includes(e.t))).toEqual([]);
  });

  it('codex 0.163.0 (before done/error existed) ends the turn on idle', () => {
    const rec = recording('codex', '0.163.0', 'turns');
    const [write] = writeTimes(rec);
    const { edges } = replay(rec);
    expect(statusIdles(edges)).toEqual(reportTimes(rec, 'idle').filter(t => t > write!));
  });

  it('stays busy through a 15s approval prompt and completes on done', () => {
    const rec = recording('codex', '0.167.0', 'approval-15s');
    const [blockedAt] = reportTimes(rec, 'blocked');
    const [doneAt] = reportTimes(rec, 'done');
    expect(doneAt! - blockedAt!).toBeGreaterThan(15_000);
    const { edges } = replay(rec);
    expect(edges.filter(e => e.edge === 'idle' && e.t > blockedAt! && e.t < doneAt!)).toEqual([]);
    expect(statusIdles(edges)).toEqual([doneAt]);
  });

  it('/status and /clear report nothing: the screen settles them instead of a 15s report wait', () => {
    const rec = recording('codex', '0.167.0', 'slash-status-clear');
    const [status] = writeTimes(rec, '/status');
    const [clear] = writeTimes(rec, '/clear');
    const [after] = writeTimes(rec, 's1-after-clear');
    const { edges } = replay(rec);
    const idleBetween = (from: number, to: number) => edges.filter(e => e.edge === 'idle' && e.t > from && e.t < to);
    expect(idleBetween(status!, clear!).map(e => e.source)).toEqual(['screen']);
    expect(idleBetween(clear!, after!).map(e => e.source)).toEqual(['screen']);
    // The next real turn is back on its reports.
    expect(statusIdles(edges).filter(t => t > after!)).toEqual(reportTimes(rec, 'done').filter(t => t > after!));
  });
});

describe('traex OSC 7501 turn edges (recorded)', () => {
  it('remembers but does not act on the startup idle sent while the model fetch is stalled', () => {
    const rec = recording('traex', '0.214.1', 'turns-model-fetch-stalled');
    const [write] = writeTimes(rec);
    const [startupIdle] = reportTimes(rec, 'idle');
    expect(startupIdle).toBeLessThan(write!);
    let reportedBeforeWrite: string | undefined;
    const { edges } = replay(rec, {
      onStatus: (t, _event, detector) => { if (t < write!) reportedBeforeWrite = detector.lastProgramStatusReport(); },
    });
    expect(reportedBeforeWrite).toBe('idle');
    expect(edges.filter(e => e.t < write! && e.source === 'program-status')).toEqual([]);
    expect(statusIdles(edges)).toEqual(reportTimes(rec, 'done'));
  });

  it('a resumed session reports idle in the burst that draws its lock page: no edge from that report', () => {
    const rec = recording('traex', '0.214.1', 'resume-session-lock');
    // One output burst: the idle report, then the page that replaces the composer.
    const burst = rec.items.find(([, kind, data]) => kind === 'out' && data.includes('This conversation is open in another app'))![2];
    expect(burst.indexOf('\x1b]7501;state=idle')).toBeGreaterThanOrEqual(0);
    expect(burst.indexOf('\x1b]7501;state=idle')).toBeLessThan(burst.indexOf('This conversation is open in another app'));
    const { detector, edges } = replay(rec);
    expect(detector.lastProgramStatusReport()).toBe('idle');
    expect(edges.filter(e => e.source === 'program-status')).toEqual([]);
  });

  it('a message written while MCP servers still boot ends on that turn\'s done', () => {
    const rec = recording('traex', '0.214.1', 'write-during-mcp-boot');
    const [write] = writeTimes(rec);
    // Recorded: working (MCP boot) before the write, no new working after it.
    expect(reportTimes(rec, 'working').every(t => t < write!)).toBe(true);
    let beforeWrite: string | undefined;
    const { edges } = replay(rec, {
      onStatus: (t, _e, detector) => { if (t < write!) beforeWrite = `${detector.lastProgramStatusReport()}:${detector.programStatusActive()}`; },
    });
    expect(beforeWrite).toBe('working:false');
    expect(edges.filter(e => e.t < write! && e.source === 'program-status')).toEqual([]);
    expect(statusIdles(edges)).toEqual(reportTimes(rec, 'done'));
  });

  it('stays busy through a 15s approval prompt and completes on done', () => {
    const rec = recording('traex', '0.214.1', 'approval-15s');
    const [blockedAt] = reportTimes(rec, 'blocked');
    const [doneAt] = reportTimes(rec, 'done');
    const { edges } = replay(rec);
    expect(edges.filter(e => e.edge === 'idle' && e.t > blockedAt! && e.t < doneAt!)).toEqual([]);
    expect(statusIdles(edges)).toEqual([doneAt]);
  });
});

describe('traex startup idle vs the rendered screen', () => {
  /** The screen botmux renders from a recording's output before its first
   *  write, at the recording's terminal size. */
  async function screenBeforeFirstWrite(rec: Recording): Promise<string> {
    const firstWrite = rec.items.find(([, kind]) => kind === 'write')?.[0] ?? Infinity;
    const renderer = new TerminalRenderer(100, 30);
    try {
      for (const [t, kind, data] of rec.items) if (kind === 'out' && t < firstWrite) await renderer.writeAndFlush(data);
      return renderer.rawSnapshot();
    } finally {
      renderer.dispose();
    }
  }
  const readyPattern = createTraexAdapter('/bin/traex').readyPattern;

  it('stands for the composer the CLI reported idle on (footer unknown or not)', async () => {
    expect(startupIdleReportScreenAdmits(await screenBeforeFirstWrite(recording('traex', '0.214.1', 'turns-model-fetch-stalled')), readyPattern)).toBe(true);
  });

  it('not for the session-lock page drawn in the same burst as the idle report', async () => {
    const rec = recording('traex', '0.214.1', 'resume-session-lock');
    expect(reportTimes(rec, 'idle').length).toBeGreaterThan(0);
    expect(startupIdleReportScreenAdmits(await screenBeforeFirstWrite(rec), readyPattern)).toBe(false);
  });

  it('not for a blank or unreadable screen', () => {
    expect(startupIdleReportScreenAdmits('', readyPattern)).toBe(false);
    expect(startupIdleReportScreenAdmits('\n\n', readyPattern)).toBe(false);
  });
});

describe('busy reported before the first write', () => {
  for (const cli of ['codex', 'traex'] as const) {
    it(`${cli}: a blocked carried into the write cycle still names the block`, () => {
      const detector = new IdleDetector(adapterFor(cli));
      const idle: string[] = [];
      detector.onIdle(source => { idle.push(source); });
      // E.g. a prompt typed in the web terminal hit an approval before botmux wrote.
      detector.observeProgramStatus({ state: 'working' });
      detector.observeProgramStatus({ state: 'blocked', kind: 'permission' });
      expect(detector.programStatusBlock()).toBeNull();
      detector.reset({ inputCycle: true });
      expect(detector.programStatusActive()).toBe(true);
      expect(detector.programStatusBlock()).toEqual({ kind: 'permission' });
      detector.observeProgramStatus({ state: 'working' });
      expect(detector.programStatusBlock()).toBeNull();
      detector.observeProgramStatus({ state: 'done' });
      expect(idle).toEqual(['program-status']);
      detector.dispose();
    });
  }
});

describe('queued input while the CLI reports blocked', () => {
  it('an approval, auth or unnamed block holds type-ahead; a question takes the next message', () => {
    expect(programStatusBlockHoldsTypeAhead({ kind: 'permission' })).toBe(true);
    expect(programStatusBlockHoldsTypeAhead({ kind: 'auth' })).toBe(true);
    expect(programStatusBlockHoldsTypeAhead({})).toBe(true);
    expect(programStatusBlockHoldsTypeAhead({ kind: 'question' })).toBe(false);
    expect(programStatusBlockHoldsTypeAhead(null)).toBe(false);
  });

  it('the recorded approval dialog is a block that holds', () => {
    for (const cli of ['codex', 'traex'] as const) {
      const blocks: Array<ReturnType<IdleDetector['programStatusBlock']>> = [];
      replay(recording(cli, cli === 'codex' ? '0.167.0' : '0.214.1', 'approval-15s'), {
        onStatus: (_t, event, detector) => { if (event.state === 'blocked') blocks.push(detector.programStatusBlock()); },
      });
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every(programStatusBlockHoldsTypeAhead)).toBe(true);
    }
  });
});

describe('transcript terminal vs a held working report', () => {
  const report = (state: ProgramStatusEvent['state'], extra: Partial<ProgramStatusEvent> = {}): ProgramStatusEvent => ({ state, app: 'codex', ...extra });
  for (const cli of ['codex', 'traex'] as const) {
    it(`${cli}: the rollout's final ends a turn whose working lingers; blocked still holds`, () => {
      const detector = new IdleDetector(adapterFor(cli));
      const idle: string[] = [];
      detector.onIdle(source => { idle.push(source); });
      detector.reset({ inputCycle: true });
      detector.observeProgramStatus(report('working'));
      expect(detector.programStatusHeldWorking()).toBe(true);
      detector.fireIdle();
      expect(idle).toEqual(['external']);
      expect(detector.programStatusActive()).toBe(false);

      detector.reset({ inputCycle: true });
      detector.observeProgramStatus(report('working'));
      detector.observeProgramStatus(report('blocked', { kind: 'permission' }));
      detector.fireIdle();
      expect(idle).toEqual(['external']);
      detector.observeProgramStatus(report('working'));
      detector.observeProgramStatus(report('done'));
      expect(idle).toEqual(['external', 'program-status']);
      detector.dispose();
    });
  }

  it('other CLIs keep the held working over a transcript terminal', () => {
    const detector = new IdleDetector(createClaudeCodeAdapter('/bin/claude'));
    const idle: string[] = [];
    detector.onIdle(source => { idle.push(source); });
    detector.observeProgramStatus({ state: 'working' });
    detector.fireIdle();
    expect(idle).toEqual([]);
    detector.dispose();
  });
});

describe('a locally started turn after a screen-owned cycle emits its busy edge', () => {
  // P2: while awaiting the CLI's own busy report a screen-settled command
  // (/status, /clear — no OSC reports) or a post-terminal-fence fireIdle()
  // publishes the idle edge. Local/web-terminal input then clears isIdle, and
  // the working report takes authority. The busy edge must still fire: under
  // authority the later painted Working row can no longer trip idleToBusyPattern.
  const readyScreen = (cli: 'codex' | 'traex') => cli === 'codex'
    ? '\r\n› Ask Codex to do anything\r\n'
    : '\r\n❯ Ask TRAE CLI to do anything\r\n';
  for (const cli of ['codex', 'traex'] as const) {
    const app = cli === 'codex' ? 'codex' : 'traecli';

    it(`${cli}: a screen-settled, report-less command — OSC working still publishes one busy edge`, () => {
      vi.useFakeTimers({ now: 0 });
      const detector = new IdleDetector(adapterFor(cli));
      const busyEdges: string[] = [];
      detector.onBusy(() => busyEdges.push('busy'));
      detector.fireIdle(); // retire startup before the scenario cycle
      detector.reset({ inputCycle: true });
      detector.feed(readyScreen(cli));
      vi.advanceTimersByTime(3_500); // spinner guard 3s + quiescence 2s
      expect(detector.isIdleNow()).toBe(true);
      // Local (e.g. web-terminal) echo: any PTY bytes clear isIdle while the
      // one-shot busy edge stays armed.
      detector.feed('typed locally\r');
      expect(detector.isIdleNow()).toBe(false);
      detector.observeProgramStatus({ state: 'working', app });
      expect(busyEdges).toEqual(['busy']);
      // Repeated working records and the now-ignored Working row do not duplicate it.
      detector.observeProgramStatus({ state: 'working', app });
      detector.feed('\r\n• Working (0s • esc to interrupt)\r\n');
      expect(busyEdges).toEqual(['busy']);
      detector.dispose();
      vi.useRealTimers();
    });

    it(`${cli}: a post-terminal-fence fireIdle cycle — OSC working still publishes one busy edge`, () => {
      vi.useFakeTimers({ now: 0 });
      const detector = new IdleDetector(adapterFor(cli));
      const busyEdges: string[] = [];
      detector.onBusy(() => busyEdges.push('busy'));
      detector.fireIdle();
      detector.reset({ inputCycle: true });
      detector.fireIdle(); // fence recheck ends the turn while awaiting the busy report
      expect(detector.isIdleNow()).toBe(true);
      detector.feed('typed locally\r');
      detector.observeProgramStatus({ state: 'working', app });
      expect(busyEdges).toEqual(['busy']);
      detector.dispose();
      vi.useRealTimers();
    });
  }
});

describe('OSC 7501 launch gate', () => {
  const codex = createCodexAdapter('/bin/codex');
  const traex = createTraexAdapter('/bin/traex');
  it.each([
    ['0.162.0', false], ['0.163.0-alpha.3', false], ['0.163.0', true], ['0.167.0', true], ['codex-cli 0.167.0', true],
    ['1.0.0', true], ['unknown', false], ['', false], [undefined, false],
  ] as const)('codex %j → %s', (cliVersion, enabled) => {
    expect(programStatusEnabledForLaunch(codex, { cliVersion })).toBe(enabled);
  });
  it.each([
    ['0.213.1', false], ['0.214.0', false], ['0.214.1', true], ['0.214.1\ninstallation: internal', true],
    ['traecli 0.215.0-alpha.1', true], ['unknown', false], [undefined, false],
  ] as const)('traex %j → %s', (cliVersion, enabled) => {
    expect(programStatusEnabledForLaunch(traex, { cliVersion })).toBe(enabled);
  });
  it('an adopted pane or an RPC viewer keeps the screen path even on a new release', () => {
    expect(programStatusEnabledForLaunch(codex, { cliVersion: '0.167.0', adoptMode: true })).toBe(false);
    expect(programStatusEnabledForLaunch(codex, { cliVersion: '0.167.0', remoteViewer: true })).toBe(false);
    expect(programStatusEnabledForLaunch(traex, { cliVersion: '0.214.1', adoptMode: true })).toBe(false);
  });
  it('adapters without a version gate are unaffected', () => {
    const claude = createClaudeCodeAdapter('/bin/claude');
    expect(programStatusEnabledForLaunch(claude, {})).toBe(true);
    expect(programStatusEnabledForLaunch(claude, { adoptMode: true, cliVersion: 'unknown' })).toBe(true);
    expect(programStatusEnabledForLaunch({ supportsProgramStatus: false }, { cliVersion: '9.9.9' })).toBe(false);
  });
  it('compares release precedence, not strings', () => {
    expect(cliVersionAtLeast('0.1000.0', '0.214.1')).toBe(true);
    expect(cliVersionAtLeast('0.99.9', '0.163.0')).toBe(false);
  });
});
