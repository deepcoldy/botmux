import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeStartupCommand,
  normalizeStartupCommandList,
  parseStartupCommandsInput,
  shouldRunStartupCommandsOnSpawn,
  shouldDeferInitialPromptForStartup,
} from '../src/core/startup-commands.js';

describe('normalizeStartupCommand', () => {
  it('trims, adds a leading slash, and preserves argument spaces', () => {
    expect(normalizeStartupCommand('  effort ultracode ')).toBe('/effort ultracode');
    expect(normalizeStartupCommand('/effort ultracode')).toBe('/effort ultracode');
    expect(normalizeStartupCommand('/model opus')).toBe('/model opus');
  });

  it('collapses embedded newlines so a command submits as one line', () => {
    expect(normalizeStartupCommand('/effort\nultracode')).toBe('/effort ultracode');
  });

  it('rejects empty / non-string / over-long input', () => {
    expect(normalizeStartupCommand('   ')).toBeNull();
    expect(normalizeStartupCommand('')).toBeNull();
    expect(normalizeStartupCommand(42 as any)).toBeNull();
    expect(normalizeStartupCommand('/' + 'x'.repeat(300))).toBeNull();
  });
});

describe('parseStartupCommandsInput', () => {
  it('splits on comma OR newline (NOT space) so arguments survive', () => {
    expect(parseStartupCommandsInput('/effort ultracode, /model opus'))
      .toEqual(['/effort ultracode', '/model opus']);
    expect(parseStartupCommandsInput('/effort ultracode\n/model opus'))
      .toEqual(['/effort ultracode', '/model opus']);
  });

  it('adds missing leading slashes and dedupes in order', () => {
    expect(parseStartupCommandsInput('effort ultracode, /effort ultracode, mcp'))
      .toEqual(['/effort ultracode', '/mcp']);
  });

  it('drops empty tokens and tolerates trailing separators', () => {
    expect(parseStartupCommandsInput('/effort ultracode,,\n,')).toEqual(['/effort ultracode']);
    expect(parseStartupCommandsInput('')).toEqual([]);
    expect(parseStartupCommandsInput('   ')).toEqual([]);
  });
});

describe('normalizeStartupCommandList', () => {
  it('normalizes a bots.json array, dropping junk and deduping', () => {
    expect(normalizeStartupCommandList(['/effort ultracode', 'model opus', '', 42, '/effort ultracode']))
      .toEqual(['/effort ultracode', '/model opus']);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeStartupCommandList(undefined)).toEqual([]);
    expect(normalizeStartupCommandList('/effort ultracode' as any)).toEqual([]);
  });
});

describe('shouldRunStartupCommandsOnSpawn', () => {
  it('runs on a fresh spawn, SKIPS on reattach to a live persistent pane', () => {
    // Reattach = same CLP with settings already applied — replaying /clear etc.
    // would corrupt the recovered context (Codex review P1).
    expect(shouldRunStartupCommandsOnSpawn({ willReattachPersistent: false })).toBe(true);
    expect(shouldRunStartupCommandsOnSpawn({ willReattachPersistent: true })).toBe(false);
  });
});

describe('shouldDeferInitialPromptForStartup', () => {
  it('defers only when commands exist AND the CLI bakes the prompt into args', () => {
    // Gemini/OpenCode/MTR/Pi/Oh-My-Pi: prompt rides launch args → would run
    // before the startup-command hook unless deferred to the queue (Codex P1).
    expect(shouldDeferInitialPromptForStartup({ hasStartupCommands: true, adoptMode: false, passesInitialPromptViaArgs: true })).toBe(true);
  });

  it('does NOT defer for queue-input CLIs (Claude/Codex/…) — default path untouched', () => {
    expect(shouldDeferInitialPromptForStartup({ hasStartupCommands: true, adoptMode: false, passesInitialPromptViaArgs: false })).toBe(false);
  });

  it('does NOT defer without startup commands, nor in adopt mode', () => {
    expect(shouldDeferInitialPromptForStartup({ hasStartupCommands: false, adoptMode: false, passesInitialPromptViaArgs: true })).toBe(false);
    expect(shouldDeferInitialPromptForStartup({ hasStartupCommands: true, adoptMode: true, passesInitialPromptViaArgs: true })).toBe(false);
  });
});

// Source-level guards: worker.ts has no exports, so pin the wiring that connects
// the two predicates to the spawn path (the cross-path behaviour Codex flagged).
describe('worker.ts startup-commands wiring', () => {
  const src = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');

  it('re-arms the one-shot from the reattach prediction, not unconditionally', () => {
    // The re-arm is gated on the reattach prediction (skip on live reattach)…
    expect(src).toContain('hasRunStartupCommands = !shouldRunStartupCommandsOnSpawn({ willReattachPersistent })');
    // …and it lives AFTER willReattachPersistent is computed (must read it).
    expect(src.indexOf('hasRunStartupCommands = !shouldRunStartupCommandsOnSpawn'))
      .toBeGreaterThan(src.indexOf('const willReattachPersistent ='));
  });

  it('defers the args-baked initial prompt when startup commands are present', () => {
    // buildArgs gets undefined (not baked) and the init handler queues it instead.
    expect(src).toContain('initialPrompt: deferInitialPrompt ? undefined : (cfg.prompt || undefined)');
    expect(src).toContain('!cliAdapter?.passesInitialPromptViaArgs || deferInitialPrompt');
  });
});
