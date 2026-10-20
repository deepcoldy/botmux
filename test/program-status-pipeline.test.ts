import { describe, it, expect, vi } from 'vitest';
import { ProgramStatusFramingStream } from '../src/utils/program-status-parser.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createSeedAdapter } from '../src/adapters/cli/seed.js';
import { createRelayAdapter } from '../src/adapters/cli/relay.js';

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
