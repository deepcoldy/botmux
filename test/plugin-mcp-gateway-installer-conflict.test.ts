import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface FsReadControl {
  target: string;
  onRead: undefined | (() => void);
}

const fsControl: FsReadControl = { target: '', onRead: undefined };
(globalThis as Record<string, unknown>).__botmuxAgyConfigReadControl = fsControl;

vi.mock('node:fs', async () => {
  const { createRequire } = await import('node:module');
  const actual = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const readFileSyncProxy = ((path: unknown, options?: unknown) => {
    const control = (globalThis as Record<string, FsReadControl | undefined>).__botmuxAgyConfigReadControl;
    if (control && String(path) === control.target) control.onRead?.();
    return actual.readFileSync(path as Parameters<typeof actual.readFileSync>[0], options as never);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync: readFileSyncProxy };
});

import { ensureGatewayEntry } from '../src/core/plugins/mcp/gateway-installer.js';

const entry = { command: '/bin/botmux', args: ['mcp', 'serve'], maxToolTimeoutMs: 600_000 };

describe('Antigravity config writer interleavings', () => {
  // These cases cover conflicts OBSERVED by the pre-rename comparison. They do
  // not assert a no-clobber guarantee for a later uncoordinated agy rename.
  let home: string;
  let path: string;
  let reads: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-agy-write-conflict-'));
    path = join(home, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(dirname(path), { recursive: true });
    reads = 0;
    fsControl.target = path;
    fsControl.onRead = () => { reads++; };
  });

  afterEach(() => {
    fsControl.target = '';
    fsControl.onRead = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function adapter() {
    return { id: 'antigravity', mcpGateway: { format: 'antigravity-json' as const, configPath: path } };
  }

  function config() {
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  it('re-merges a server added by agy after the initial snapshot', () => {
    const initial = { mcpServers: { keep: { command: '/bin/keep', args: ['keep'] } }, custom: true };
    writeFileSync(path, JSON.stringify(initial));
    fsControl.onRead = () => {
      reads++;
      if (reads === 2) {
        // Same observable whole-file rewrite as `agy mcp add other ...`.
        writeFileSync(path, JSON.stringify({
          ...initial,
          mcpServers: { ...initial.mcpServers, other: { command: '/bin/other', args: ['other'], disabled: false } },
        }));
      }
    };

    expect(ensureGatewayEntry(adapter(), entry).state).toBe('installed');
    fsControl.onRead = () => { reads++; };
    const written = config();
    expect(written.custom).toBe(true);
    expect(written.mcpServers.keep.command).toBe('/bin/keep');
    expect(written.mcpServers.other.command).toBe('/bin/other');
    expect(written.mcpServers.botmux.command).toBe('/bin/botmux');
    expect(reads).toBeGreaterThan(2);
  });

  it('does not resurrect a server removed by agy after the initial snapshot', () => {
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        keep: { command: '/bin/keep' },
        removeMe: { command: '/bin/remove-me' },
      },
    }));
    fsControl.onRead = () => {
      reads++;
      if (reads === 2) writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: '/bin/keep' } } }));
    };

    expect(ensureGatewayEntry(adapter(), entry).state).toBe('installed');
    fsControl.onRead = () => { reads++; };
    const written = config();
    expect(written.mcpServers.keep.command).toBe('/bin/keep');
    expect(written.mcpServers).not.toHaveProperty('removeMe');
    expect(written.mcpServers.botmux.command).toBe('/bin/botmux');
  });

  it('leaves an externally malformed config untouched instead of replacing it', () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: '/bin/keep' } } }));
    fsControl.onRead = () => {
      reads++;
      if (reads === 2) writeFileSync(path, '{broken');
    };

    const report = ensureGatewayEntry(adapter(), entry);
    expect(report.state).toBe('adapter-required');
    expect(report.warning).toBeTruthy();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it('warns without overwriting the latest file when external writes keep conflicting', () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { keep: { command: '/bin/keep' } } }));
    fsControl.onRead = () => {
      reads++;
      if (reads >= 2) {
        writeFileSync(path, JSON.stringify({
          mcpServers: { keep: { command: `/bin/external-${reads}` } },
        }));
      }
    };

    const report = ensureGatewayEntry(adapter(), entry);
    expect(report.state).toBe('adapter-required');
    expect(report.warning).toBeTruthy();
    expect(reads).toBeGreaterThan(2);
    expect(reads).toBeLessThan(20);
    const attemptedReads = reads;
    fsControl.onRead = () => { reads++; };
    const latest = config();
    expect(latest.mcpServers.keep.command).toBe(`/bin/external-${attemptedReads}`);
    expect(latest.mcpServers).not.toHaveProperty('botmux');
  });
});
