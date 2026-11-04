/**
 * Tests for transcript-image-purge: the recovery that strips API-rejected
 * undersized image blocks from a Claude Code session transcript so the
 * session can come back via `claude --resume` instead of `/clear`.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicReplaceTranscript,
  measureImage,
  purgeUndersizedImages,
  resolvePurgeResumeTarget,
  MIN_IMAGE_DIMENSION,
} from '../src/services/transcript-image-purge.js';

const SID = '85b23608-1234-4abc-9def-0123456789ab';

function png(width: number, height: number): Buffer {
  // 8-byte signature + 4-byte length + 'IHDR' + width/height at bytes 16..23.
  const buf = Buffer.alloc(25);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  // SOF0 segment: FFC0, Lf=17, P=8, then height/height (big-endian).
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function imageRecord(b64: string, mediaType = 'image/png'): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: b64 },
        }],
      }],
    },
  });
}

let dirs: string[] = [];
function makeTemp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-purge-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) {
    try { readdirSync(d); } catch { continue; }
  }
  dirs = [];
});

describe('measureImage', () => {
  it('reads PNG/JPEG/GIF dimensions', () => {
    expect(measureImage(png(1, 1))).toEqual({ width: 1, height: 1 });
    expect(measureImage(png(1024, 17))).toEqual({ width: 1024, height: 17 });
    expect(measureImage(jpeg(1, 1))).toEqual({ width: 1, height: 1 });
    expect(measureImage(jpeg(320, 240))).toEqual({ width: 320, height: 240 });
    expect(measureImage(gif(1, 1))).toEqual({ width: 1, height: 1 });
    expect(measureImage(gif(64, 64))).toEqual({ width: 64, height: 64 });
  });

  it('returns null for unparseable buffers instead of guessing', () => {
    expect(measureImage(Buffer.from('not an image'))).toBeNull();
  });
});

describe('resolvePurgeResumeTarget', () => {
  it('prefers the active bridge transcript and resumes its rotated session id', () => {
    const active = `/scratch/.claude/projects/x/${SID}.jsonl`;
    expect(resolvePurgeResumeTarget(active, '/host/old-session.jsonl')).toEqual({
      jsonlPath: active,
      sessionId: SID,
    });
  });

  it('fails closed for a path without a UUID session id', () => {
    expect(resolvePurgeResumeTarget('/tmp/scratch.jsonl', undefined)).toBeUndefined();
  });
});

describe('atomicReplaceTranscript', () => {
  it('keeps the live transcript present when replacement fails', () => {
    const root = makeTemp();
    const live = join(root, 'live.jsonl');
    const tmp = join(root, 'tmp.jsonl');
    writeFileSync(live, 'original');
    writeFileSync(tmp, 'replacement');

    expect(() => atomicReplaceTranscript(tmp, live, () => {
      expect(readFileSync(live, 'utf8')).toBe('original');
      throw new Error('simulated rename failure');
    })).toThrow('simulated rename failure');
    expect(readFileSync(live, 'utf8')).toBe('original');
    expect(() => readFileSync(tmp)).toThrow();
  });

  it('checks the snapshot immediately before replacement and preserves a concurrent append', () => {
    const root = makeTemp();
    const live = join(root, 'live.jsonl');
    const tmp = join(root, 'tmp.jsonl');
    writeFileSync(live, 'original');
    writeFileSync(tmp, 'replacement');

    expect(() => atomicReplaceTranscript(tmp, live, renameSync, () => {
      writeFileSync(live, 'original\nconcurrent append');
      throw new Error('transcript changed while purging');
    })).toThrow('transcript changed while purging');
    expect(readFileSync(live, 'utf8')).toContain('concurrent append');
    expect(() => readFileSync(tmp)).toThrow();
  });
});

describe('purgeUndersizedImages', () => {
  it('replaces undersized image blocks with text and backs up the original file', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    const before = `${imageRecord(png(1, 1).toString('base64'))}\n`;
    writeFileSync(main, before);

    const results = purgeUndersizedImages(main);
    expect(results).toHaveLength(1);
    expect(results[0].removed).toBe(1);
    expect(results[0].backup).toBeTruthy();

    const after = JSON.parse(readFileSync(main, 'utf8').trim());
    const block = after.message.content[0].content[0];
    expect(block.type).toBe('text');
    expect(block.text).toContain('1x1');
    expect(block.text).toContain(String(MIN_IMAGE_DIMENSION));
    // The poisoned base64 must be gone from both live and backup-present.
    expect(readFileSync(main, 'utf8')).not.toContain('"type":"image"');
    expect(readFileSync(results[0].backup!, 'utf8')).toBe(before);
  });

  it('leaves files untouched when every image meets the minimum', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    const original = `${imageRecord(png(14, 14).toString('base64'))}\n`;
    writeFileSync(main, original);

    expect(purgeUndersizedImages(main)).toEqual([]);
    expect(readFileSync(main, 'utf8')).toBe(original);
    expect(readdirSync(root).filter(n => n.includes('bak'))).toHaveLength(0);
  });

  it('purges subagent transcripts next to the session file', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    writeFileSync(main, `${imageRecord(png(1024, 1024).toString('base64'))}\n`);
    const subDir = join(root, SID, 'subagents');
    mkdirSync(subDir, { recursive: true });
    const sub = join(subDir, 'agent-deadbeef.jsonl');
    writeFileSync(sub, `${imageRecord(png(1, 1).toString('base64'))}\n`);

    const results = purgeUndersizedImages(main);
    expect(results.map(r => r.file)).toEqual([sub]);
    expect(JSON.parse(readFileSync(sub, 'utf8').trim())
      .message.content[0].content[0].type).toBe('text');
  });

  it('does not descend directories that are not session-uuid folders', () => {
    const root = makeTemp();
    const main = join(root, 'scratch.jsonl');
    writeFileSync(main, `${imageRecord(png(1024, 1024).toString('base64'))}\n`);
    const fake = join(root, 'scratch', 'subagents');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'agent-x.jsonl'), imageRecord(png(1, 1).toString('base64')));

    expect(purgeUndersizedImages(main)).toEqual([]);
  });

  it('rejects an ancestor alias that escapes an independently trusted projects root', () => {
    const root = makeTemp();
    const projects = join(root, 'projects');
    mkdirSync(projects);
    const outside = makeTemp();
    const outsideFile = join(outside, `${SID}.jsonl`);
    const before = `${imageRecord(png(1, 1).toString('base64'))}\n`;
    writeFileSync(outsideFile, before);
    const alias = join(projects, 'aliased-project');
    symlinkSync(outside, alias);

    expect(purgeUndersizedImages(join(alias, `${SID}.jsonl`), {
      trustedProjectsRoot: projects,
    })).toEqual([]);
    expect(readFileSync(outsideFile, 'utf8')).toBe(before);
  });

  it('does not follow a main transcript symlink', () => {
    const root = makeTemp();
    const outside = join(root, 'outside.jsonl');
    const before = `${imageRecord(png(1, 1).toString('base64'))}\n`;
    writeFileSync(outside, before);
    const main = join(root, `${SID}.jsonl`);
    symlinkSync(outside, main);

    expect(purgeUndersizedImages(main)).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe(before);
  });

  it('does not follow a subagents directory or transcript symlink', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    writeFileSync(main, `${imageRecord(png(1024, 1024).toString('base64'))}\n`);
    const outsideDir = join(root, 'outside');
    mkdirSync(outsideDir);
    const outside = join(outsideDir, 'agent-x.jsonl');
    const before = `${imageRecord(png(1, 1).toString('base64'))}\n`;
    writeFileSync(outside, before);
    mkdirSync(join(root, SID));
    symlinkSync(outsideDir, join(root, SID, 'subagents'));

    expect(purgeUndersizedImages(main)).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe(before);

    mkdirSync(join(root, SID, 'subagents-real'));
    const linked = join(root, SID, 'subagents-real', 'agent-linked.jsonl');
    symlinkSync(outside, linked);
    // Rename the real directory into the expected location after removing the symlink.
    rmSync(join(root, SID, 'subagents'));
    renameSync(join(root, SID, 'subagents-real'), join(root, SID, 'subagents'));
    expect(purgeUndersizedImages(main)).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe(before);
  });

  it('preserves unparseable lines verbatim', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    const garbage = 'this is not json\n' + JSON.stringify({ trailing: true });
    writeFileSync(main, garbage);
    expect(purgeUndersizedImages(main)).toEqual([]);
    expect(readFileSync(main, 'utf8')).toBe(garbage);
  });

  it('purges multiple offending blocks across lines and reports the total', () => {
    const root = makeTemp();
    const main = join(root, `${SID}.jsonl`);
    const tinyGif = imageRecord(gif(1, 1).toString('base64'), 'image/gif');
    const ok = imageRecord(jpeg(64, 64).toString('base64'), 'image/jpeg');
    const tinyJpeg = imageRecord(jpeg(3, 400).toString('base64'), 'image/jpeg');
    writeFileSync(main, [tinyGif, ok, tinyJpeg].join('\n') + '\n');

    const results = purgeUndersizedImages(main);
    expect(results).toHaveLength(1);
    expect(results[0].removed).toBe(2);
    const lines = readFileSync(main, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].message.content[0].content[0].type).toBe('text');
    expect(lines[1].message.content[0].content[0].type).toBe('image');
    expect(lines[2].message.content[0].content[0].type).toBe('text');
  });
});
