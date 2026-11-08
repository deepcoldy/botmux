import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeRiffStdinReader,
  prepareRiffHostRequest,
  RiffSendPreflightError,
} from '../src/cli/riff-host-tools.js';
import { parseRiffHostRequest } from '../src/services/riff-host-tools.js';

function upload(name: string, text: string) {
  return { name, dataBase64: Buffer.from(text).toString('base64') };
}

describe('riff client send preflight', () => {
  it('rejects extra attachment paths before uploading or rewriting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      const b = join(dir, 'b.sql');
      writeFileSync(a, 'a');
      writeFileSync(b, 'b');
      await expect(prepareRiffHostRequest(
        ['send', '--files', a, b, '--no-mention'],
        async () => 'BODY',
      )).rejects.toBeInstanceOf(RiffSendPreflightError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a single attachment and keeps stdin body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      writeFileSync(a, 'a');
      const request = await prepareRiffHostRequest(
        ['send', '--files', a, '--no-mention'],
        async () => 'BODY',
      );
      expect(request.files).toHaveLength(1);
      expect(request.argv).toContain('riff-upload:0');
      expect(request.stdin).toBe('BODY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the underlying stdin at most once when the preflight cached it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      writeFileSync(a, 'a');
      const underlying = vi.fn(async () => 'LATE');
      const reader = makeRiffStdinReader('BODY', underlying);
      let readerCalls = 0;
      const countingReader = async () => {
        readerCalls++;
        return reader();
      };
      const request = await prepareRiffHostRequest(['send', '--files', a, '--no-mention'], countingReader);
      expect(readerCalls).toBe(1);
      expect(underlying).not.toHaveBeenCalled();
      expect(request.stdin).toBe('BODY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to reading stdin when no cached body exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-riff-preflight-'));
    try {
      const a = join(dir, 'a.sql');
      writeFileSync(a, 'a');
      const underlying = vi.fn(async () => 'BODY');
      const reader = makeRiffStdinReader(undefined, underlying);
      const request = await prepareRiffHostRequest(['send', '--files', a, '--no-mention'], reader);
      expect(underlying).toHaveBeenCalledTimes(1);
      expect(request.stdin).toBe('BODY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects hand-written placeholders and --content-file -', async () => {
    await expect(prepareRiffHostRequest(
      ['send', '--files', 'riff-upload:0', '--no-mention'],
      async () => 'BODY',
    )).rejects.toBeInstanceOf(RiffSendPreflightError);
    await expect(prepareRiffHostRequest(
      ['send', '--content-file', '-'],
      async () => 'BODY',
    )).rejects.toBeInstanceOf(RiffSendPreflightError);
  });
});

describe('riff host request placeholder contract', () => {
  it('accepts canonical indexes and rejects malformed or out-of-range ones', () => {
    const valid = parseRiffHostRequest({
      operationId: 'op_12345678',
      argv: ['send', '--files', 'riff-upload:0', '--no-mention'],
      files: [upload('a.sql', 'a')],
    });
    expect(valid.files).toHaveLength(1);

    for (const value of ['riff-upload:99', 'riff-upload:00', 'riff-upload:+1', 'riff-upload:-1', 'riff-upload:1.0', 'riff-upload:0 ', ' riff-upload:0', 'riff-upload:0\n']) {
      expect(() => parseRiffHostRequest({
        operationId: 'op_12345678',
        argv: ['send', '--files', value, '--no-mention'],
        files: [upload('a.sql', 'a')],
      })).toThrow();
    }
  });
});
