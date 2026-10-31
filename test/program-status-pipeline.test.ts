import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProgramStatusFramingStream } from '../src/utils/program-status-parser.js';
import { IdleDetector, PROGRAM_STATUS_FALLBACK_MS } from '../src/utils/idle-detector.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createSeedAdapter } from '../src/adapters/cli/seed.js';
import { createRelayAdapter } from '../src/adapters/cli/relay.js';
import { createKimiAdapter } from '../src/adapters/cli/kimi.js';
import { buildBotmuxEnvAssignments } from '../src/adapters/backend/tmux-backend.js';

describe('ProgramStatus pipeline (FramingStream + IdleDetector)', () => {
  it('processes probe, working, and done transitions end-to-end', () => {
    const stream = new ProgramStatusFramingStream();
    const idleEvents: string[] = [];
    const detector = new IdleDetector({
      id: 'claude-code',
      displayName: 'Claude',
      command: 'claude',
      readyPattern: /❯/,
    } as any);

    detector.onIdle((source) => {
      idleEvents.push(source);
    });

    const backendWrites: string[] = [];
    const mockBackend = {
      write: (data: string) => {
        backendWrites.push(data);
      },
    };

    const feedPipeline = (rawChunk: string, isLiveStream = true) => {
      const parts = stream.feed(rawChunk);
      for (const part of parts) {
        if (part.type === 'probe') {
          if (isLiveStream) {
            mockBackend.write('\x1b]7501;?\x1b\\');
          }
        } else if (part.type === 'status') {
          detector.observeProgramStatus(part.event);
        } else if (part.type === 'data') {
          detector.feed(part.text);
        }
      }
    };

    // 1. Initial Claude Code probe
    feedPipeline('\x1b]7501;?\x1b\\');
    expect(backendWrites).toEqual(['\x1b]7501;?\x1b\\']);

    // 2. Working event arrives
    feedPipeline('\x1b]7501;state=working:progress=10\x1b\\');
    expect(detector.programStatusActive()).toBe(true);
    expect(idleEvents).toEqual([]);

    // 3. Normal TUI redraw while working - detector stays busy and does not fire idle
    feedPipeline('Thinking...\n❯ ');
    expect(idleEvents).toEqual([]);

    // 4. Done event arrives - immediately triggers program-status idle
    feedPipeline('\x1b]7501;state=done\x1b\\');
    expect(idleEvents).toEqual(['program-status']);
  });

  it('does not reply to probe if not in live stream (snapshot/history)', () => {
    const stream = new ProgramStatusFramingStream();
    const backendWrites: string[] = [];
    const mockBackend = {
      write: (data: string) => {
        backendWrites.push(data);
      },
    };

    const feedPipeline = (rawChunk: string, isLiveStream = true) => {
      const parts = stream.feed(rawChunk);
      for (const part of parts) {
        if (part.type === 'probe') {
          if (isLiveStream) {
            mockBackend.write('\x1b]7501;?\x1b\\');
          }
        }
      }
    };

    feedPipeline('historical output containing \x1b]7501;?\x1b\\', false);
    expect(backendWrites).toEqual([]);
  });

  it('handles blocked permission state with base64 decoded message', () => {
    const stream = new ProgramStatusFramingStream();
    const detector = new IdleDetector({
      id: 'claude-code',
      displayName: 'Claude',
      command: 'claude',
      readyPattern: /❯/,
    } as any);

    const promptText = 'Allow execution of git status?';
    const b64 = Buffer.from(promptText).toString('base64');
    const raw = `\x1b]7501;state=blocked:kind=permission:msg=${b64}\x07`;

    const parts = stream.feed(raw);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('status');
    if (parts[0].type === 'status') {
      expect(parts[0].event.msg).toBe(promptText);
      detector.observeProgramStatus(parts[0].event);
    }

    expect(detector.programStatusBlock()).toEqual({
      kind: 'permission',
      msg: promptText,
    });
  });

  it('preserves user text and non-7501 OSC codes while stripping 7501', () => {
    const stream = new ProgramStatusFramingStream();
    const dataChunks: string[] = [];

    const raw = 'Prefix\x1b]0;Title\x07\x1b]7501;state=working\x1b\\Middle\x1b]8;;https://example.com\x1b\\Link\x1b]8;;\x1b\\Suffix';
    const parts = stream.feed(raw);

    for (const part of parts) {
      if (part.type === 'data') {
        dataChunks.push(part.text);
      }
    }

    const joined = dataChunks.join('');
    expect(joined).toBe('Prefix\x1b]0;Title\x07Middle\x1b]8;;https://example.com\x1b\\Link\x1b]8;;\x1b\\Suffix');
  });

  it('declares supportsProgramStatus on verified adapters (claude-code and pi) and excludes forks (seed/relay)', () => {
    const claudeAdapter = createClaudeCodeAdapter('/bin/claude');
    expect(claudeAdapter.supportsProgramStatus).toBe(true);

    const piAdapter = createPiAdapter('/bin/pi', () => '/tmp/boundary.js');
    expect(piAdapter.supportsProgramStatus).toBe(true);
    expect(piAdapter.spawnEnv?.PI_PROGRAM_STATUS).toBeUndefined();

    const seedAdapter = createSeedAdapter('/bin/seed');
    expect(seedAdapter.supportsProgramStatus).toBeFalsy();

    const relayAdapter = createRelayAdapter('/bin/relay');
    expect(relayAdapter.supportsProgramStatus).toBeFalsy();
  });

  it('kimi declares program status and its pane gets PI_PROGRAM_STATUS=1', () => {
    // Kimi Code skips the 7501 probe when $TMUX is set, so unlike Pi there is
    // no handshake to answer: the env var is the only way to turn reports on
    // inside a tmux pane, and a pane only receives allow-listed keys.
    const kimi = createKimiAdapter('/bin/kimi');
    expect(kimi.supportsProgramStatus).toBe(true);
    expect(buildBotmuxEnvAssignments({ ...kimi.spawnEnv })).toContain('PI_PROGRAM_STATUS=1');
  });

  it('processes Pi OSC 7501 handshake, working, blocked dialog, and done transitions end-to-end', () => {
    const stream = new ProgramStatusFramingStream();
    const idleEvents: string[] = [];
    const piAdapter = createPiAdapter('/bin/pi', () => '/tmp/boundary.js');
    const detector = new IdleDetector(piAdapter);

    detector.onIdle((source) => {
      idleEvents.push(source);
    });

    const backendWrites: string[] = [];
    const mockBackend = {
      write: (data: string) => {
        backendWrites.push(data);
      },
    };

    const feedPipeline = (rawChunk: string, isLiveStream = true) => {
      const parts = stream.feed(rawChunk);
      for (const part of parts) {
        if (part.type === 'probe') {
          if (isLiveStream) {
            mockBackend.write('\x1b]7501;?\x1b\\');
          }
        } else if (part.type === 'status') {
          detector.observeProgramStatus(part.event);
        } else if (part.type === 'data') {
          detector.feed(part.text);
        }
      }
    };

    // 1. Initial Pi TUI probe
    feedPipeline('\x1b]7501;?\x1b\\');
    expect(backendWrites).toEqual(['\x1b]7501;?\x1b\\']);

    // 2. Pi working status arrives (app=pi)
    const sessionName = 'refactor-task';
    const b64SessionName = Buffer.from(sessionName).toString('base64');
    feedPipeline(`\x1b]7501;state=working:app=pi:msg=${b64SessionName}\x1b\\`);
    expect(detector.programStatusActive()).toBe(true);
    expect(idleEvents).toEqual([]);

    // 3. Normal TUI redraw while working with Working... marker - stays busy
    feedPipeline('Working...\nSome model output');
    expect(idleEvents).toEqual([]);

    // 4. Pi blocked dialog (e.g. extension confirmation)
    const dialogMsg = 'Allow running bash command?';
    const b64Dialog = Buffer.from(dialogMsg).toString('base64');
    feedPipeline(`\x1b]7501;state=blocked:app=pi:kind=permission:msg=${b64Dialog}\x1b\\`);
    expect(detector.programStatusBlock()).toEqual({
      kind: 'permission',
      msg: dialogMsg,
    });
    expect(idleEvents).toEqual([]);

    // 5. Run finishes and settles: done event arrives
    feedPipeline(`\x1b]7501;state=done:app=pi:msg=${b64SessionName}\x1b\\`);
    expect(idleEvents).toEqual(['program-status']);
    expect(detector.programStatusBlock()).toBeNull();
  });
});

describe('Kimi under tmux: approval dialog vs turn completion', () => {
  afterEach(() => { vi.useRealTimers(); });

  // Byte shapes as Kimi Code 2.4.1 writes them into a tmux pane.
  const wrap = (inner: string) => `\x1bPtmux;${inner.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  const report = (payload: string) => wrap(`\x1b]7501;${payload}\x1b\\`);
  const dialog = [
    '● Running a command · $ rm -rf ./work',
    '  ▶ Run this command?',
    '  Dangerous: recursive delete',
    '  ▶ 1. Approve once',
    '    2. Approve for this session',
    '    3. Reject',
    '    4. Reject with feedback',
    '  ↑/↓ select · 1/2/3/4 choose · ↵ confirm',
  ].join('\r\n');

  function pipeline(adapter = createKimiAdapter('/bin/kimi')) {
    const stream = new ProgramStatusFramingStream();
    const detector = new IdleDetector(adapter);
    const idle: string[] = [];
    detector.onIdle(source => idle.push(source));
    const feed = (raw: string) => {
      for (const part of stream.feed(raw)) {
        if (part.type === 'status') detector.observeProgramStatus(part.event);
        else if (part.type === 'data') detector.feed(part.text);
      }
    };
    return { detector, idle, feed };
  }

  it('stays busy while the approval dialog sits still, and completes on done', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    detector.reset(); // botmux submit
    feed(report('state=working:app=kimi-code'));
    feed('● Writing the report...\r\n');
    feed(report('state=blocked:app=kimi-code:kind=permission'));
    feed(dialog);
    vi.advanceTimersByTime(60_000);
    expect(idle).toEqual([]);
    expect(detector.programStatusBlock()).toEqual({ kind: 'permission' });

    feed(report('state=working:app=kimi-code'));
    feed('● Sending the file\r\n');
    feed(report('state=done:app=kimi-code'));
    expect(idle).toEqual(['program-status']);
  });

  it('without status reports the same screen goes idle (the screen-quiet fallback)', () => {
    // A Kimi build that never reports keeps the old behaviour: 2s of quiet on
    // a static dialog reads as a finished turn.
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    detector.reset();
    feed('● Writing the report...\r\n');
    feed(dialog);
    vi.advanceTimersByTime(10_000);
    expect(idle).toEqual(['screen']);
  });

  // The first prompt of a fresh Kimi process resets its session runtime, which
  // reports `clear` and then `idle` before `working` (seen live on 2.4.1).
  it('cold start: clear + idle right after the submit do not complete the turn', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    feed(report('state=idle:app=kimi-code')); // startup, before any submit
    idle.length = 0;
    detector.reset(); // botmux submit
    feed(report('state=clear'));
    feed(report('state=idle:app=kimi-code'));
    vi.advanceTimersByTime(5_000);
    expect(idle).toEqual([]);

    feed(report('state=working:app=kimi-code'));
    feed(report('state=done:app=kimi-code'));
    expect(idle).toEqual(['program-status']);
  });

  it('a submit that never produces work falls back to the screen at the deadline', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    detector.reset();
    feed(report('state=clear'));
    feed(report('state=idle:app=kimi-code'));
    vi.advanceTimersByTime(PROGRAM_STATUS_FALLBACK_MS - 1_000);
    feed(report('state=idle:app=kimi-code')); // a repeat does not push the deadline
    vi.advanceTimersByTime(1_000 + 5_000);
    expect(idle).toEqual(['screen']);
  });

  it('without programStatusSubmitAwaitsBusy an idle right after the submit completes the turn', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline({ ...createKimiAdapter('/bin/kimi'), programStatusSubmitAwaitsBusy: false });
    detector.reset();
    feed(report('state=idle:app=kimi-code'));
    expect(idle).toEqual(['program-status']);
  });

  // The cold-start `clear` can arrive on its own, with the approval dialog
  // painted afterwards and the next report seconds later. Dropping authority on
  // that clear would reopen the screen-quiet path (3.2s past the spinner guard),
  // so the static dialog would settle the turn before `working` ever arrived.
  it('a bare clear after submit keeps authority over a static screen until busy arrives', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    feed(report('state=idle:app=kimi-code')); // authority engaged at spawn
    idle.length = 0;
    detector.reset(); // botmux submit
    feed(report('state=clear'));
    feed(dialog); // static approval dialog painted after the reset
    vi.advanceTimersByTime(6_000); // well past 2s quiescence + 3s spinner guard
    expect(idle).toEqual([]);
    expect(detector.programStatusActive()).toBe(true);

    feed(report('state=working:app=kimi-code'));
    feed(report('state=done:app=kimi-code'));
    expect(idle).toEqual(['program-status']);
  });

  it('a clear followed by no busy report still falls back to the screen at the deadline', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    feed(report('state=idle:app=kimi-code'));
    idle.length = 0;
    detector.reset();
    feed(report('state=clear'));
    feed(dialog);
    vi.advanceTimersByTime(PROGRAM_STATUS_FALLBACK_MS + 5_000);
    expect(idle).toEqual(['screen']);
  });

  // The post-SessionStart evidence paths must obey the same submit-busy wait as
  // the ordinary terminal publish; otherwise a held terminal republishes
  // through either of them before the submit's busy report.
  it('held terminal is not republished via resetReadyEvidence/seedReadyEvidence while awaiting busy', () => {
    vi.useFakeTimers();
    const { detector, idle, feed } = pipeline();
    feed(report('state=idle:app=kimi-code'));
    idle.length = 0;
    detector.reset();
    feed(report('state=idle:app=kimi-code')); // terminal held behind the submit wait
    expect(idle).toEqual([]);

    detector.resetReadyEvidence();
    expect(idle).toEqual([]);
    expect(detector.seedReadyEvidence()).toBe(false);
    expect(idle).toEqual([]);

    feed(report('state=working:app=kimi-code'));
    feed(report('state=done:app=kimi-code'));
    expect(idle).toEqual(['program-status']);
  });
});
