import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const behavior = vi.hoisted(() => ({ short: false, failOnce: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      if (behavior.failOnce) {
        behavior.failOnce = false;
        throw new Error('injected write failure');
      }
      // Force the writer to make progress in short chunks; a single unchecked
      // write cannot produce the complete credential under this fixture.
      const nextLength = behavior.short ? Math.min(length, 3) : length;
      return actual.writeSync(fd, buffer, offset, nextLength, position);
    },
  };
});

import * as fs from 'node:fs';
import { writeSendCredFile } from '../src/adapters/cli/read-isolation.js';

let root = '';
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'botmux-send-cred-write-failure-')); });
afterEach(() => {
  behavior.short = false;
  behavior.failOnce = false;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('send-cred in-place writes complete or roll back', () => {
  it('loops until every byte is written', () => {
    const path = join(root, 'send-cred.json');
    const json = JSON.stringify({ larkAppSecret: 'x'.repeat(100), feedback: { enabled: true } });
    behavior.short = true;
    writeSendCredFile(path, json);
    expect(fs.readFileSync(path, 'utf8')).toBe(json);
  });

  it('restores the previous complete credential after a write failure', () => {
    const path = join(root, 'send-cred.json');
    const previous = JSON.stringify({ larkAppSecret: 'old-secret' });
    fs.writeFileSync(path, previous);
    behavior.failOnce = true;
    expect(() => writeSendCredFile(path, JSON.stringify({ larkAppSecret: 'new-secret' }))).toThrow('injected write failure');
    expect(fs.readFileSync(path, 'utf8')).toBe(previous);
  });
});
