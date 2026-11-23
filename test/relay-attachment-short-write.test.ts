import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const behavior = vi.hoisted(() => ({ maxWrite: Number.POSITIVE_INFINITY }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Emulate a real short write: persist only the first maxWrite bytes of the
    // requested range at the given position and report that partial count, the
    // way a pipe, a FUSE/network mount or a signal-interrupted write() behaves.
    writeSync(fd: number, buf: Buffer, offset?: number, length?: number, position?: number | null) {
      const start = offset ?? 0;
      const avail = length ?? (buf.length - start);
      const n = Math.min(avail, behavior.maxWrite);
      const slice = buf.subarray(start, start + n);
      if (position === undefined || position === null) {
        return (actual.writeSync as (...a: unknown[]) => number)(fd, slice);
      }
      return (actual.writeSync as (...a: unknown[]) => number)(fd, slice, 0, n, position);
    },
  };
});

import { materializeRelayedAttachments } from '../src/cli/relay-session-tool.js';

let root = '';
beforeEach(() => {
  behavior.maxWrite = Number.POSITIVE_INFINITY;
  root = mkdtempSync(join(tmpdir(), 'botmux-relay-short-write-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('materializeRelayedAttachments completes partial writes', () => {
  const placeholder = 'botmux-session-tool://attachment/0';
  // Non-repeating payload (period 251 > length), so an offset/slice mistake
  // cannot hide behind identical adjacent bytes — a full equals() catches it.
  const payload = Buffer.from(Array.from({ length: 100 }, (_, i) => (i * 7 + 3) % 251));
  const stdout = JSON.stringify({ attachments: [{ path: placeholder, name: 'a.bin', type: 'file' }] });
  const att = [{ placeholder, name: 'a.bin', type: 'file' as const, dataBase64: payload.toString('base64') }];

  it('loops until every byte is written when write() returns short', () => {
    behavior.maxWrite = 2; // every underlying write accepts only 2 bytes
    const dir = join(root, 'quoted-1');
    const out = materializeRelayedAttachments(stdout, att, dir);
    const parsed = JSON.parse(out) as { attachments: Array<{ path: string }> };
    const landed = readFileSync(parsed.attachments[0]!.path);
    expect(landed.length).toBe(payload.length);
    expect(landed.equals(payload)).toBe(true); // exact bytes, not just length
  });

  it('still writes the full file on the normal single-write path', () => {
    const dir = join(root, 'quoted-2');
    const out = materializeRelayedAttachments(stdout, att, dir);
    const parsed = JSON.parse(out) as { attachments: Array<{ path: string }> };
    expect(readFileSync(parsed.attachments[0]!.path).equals(payload)).toBe(true);
  });
});
