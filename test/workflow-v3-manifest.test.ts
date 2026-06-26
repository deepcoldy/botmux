import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ManifestValidationError,
  readAndValidateManifest,
  validateManifest,
} from '../src/workflows/v3/manifest.js';

let dir: string;
let outputDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-v3-manifest-'));
  outputDir = join(dir, 'work');
  mkdirSync(outputDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v3 manifest validator', () => {
  it('accepts an ok manifest with a relative file path and verified metadata', async () => {
    const content = 'hello v3\n';
    writeFileSync(join(outputDir, 'result.md'), content, 'utf-8');

    const manifest = await validateManifest({
      schemaVersion: 1,
      status: 'ok',
      summary: 'done',
      files: [{
        name: 'result',
        path: 'result.md',
        kind: 'markdown',
        bytes: Buffer.byteLength(content),
        sha256: sha(content),
        mime: 'text/markdown',
        preview: 'hello',
      }],
    }, outputDir);

    expect(manifest.files[0]?.path).toBe('result.md');
    expect(manifest.files[0]?.sha256).toBe(sha(content));
  });

  it('accepts a fail manifest with an error and no files', async () => {
    await expect(validateManifest({
      schemaVersion: 1,
      status: 'fail',
      summary: 'failed',
      error: { code: 'GoalFailed', message: 'agent failed', retryable: true },
      files: [],
    }, outputDir)).resolves.toMatchObject({
      status: 'fail',
      error: { code: 'GoalFailed', retryable: true },
    });
  });

  it('rejects ok without files and fail without error', async () => {
    await expect(validateManifest({
      schemaVersion: 1,
      status: 'ok',
      summary: 'bad',
      files: [],
    }, outputDir)).rejects.toThrow(/status "ok" requires at least one file/);

    await expect(validateManifest({
      schemaVersion: 1,
      status: 'fail',
      summary: 'bad',
      files: [],
    }, outputDir)).rejects.toThrow(/status "fail" requires error/);
  });

  it('rejects absolute paths and path traversal outside outputDir', async () => {
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'secret', 'utf-8');

    await expect(validateManifest(baseFile('/etc/passwd'), outputDir)).rejects.toThrow(/path must be relative/);
    await expect(validateManifest(baseFile('../secret.txt'), outputDir)).rejects.toThrow(/escapes outputDir/);
  });

  it('rejects a symlink inside outputDir that resolves outside it', async () => {
    // The relativePath itself is clean ("escape.md") — `path.resolve` alone would
    // accept it. Only the `fs.realpath` + isPathInside check catches that the
    // symlink target escapes outputDir. This guards against anyone "simplifying"
    // realpath back to resolve (codex test-gap #9).
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'secret', 'utf-8');
    symlinkSync(outside, join(outputDir, 'escape.md'));

    await expect(validateManifest(baseFile('escape.md'), outputDir)).rejects.toThrow(/escapes outputDir/);
  });

  it('rejects mismatched bytes and sha256', async () => {
    writeFileSync(join(outputDir, 'x.txt'), 'abc', 'utf-8');

    await expect(validateManifest({
      schemaVersion: 1,
      status: 'ok',
      summary: 'bad',
      files: [{
        name: 'x',
        path: 'x.txt',
        kind: 'text',
        bytes: 999,
        sha256: 'wrong',
        mime: 'text/plain',
      }],
    }, outputDir)).rejects.toThrow(/bytes mismatch.*sha256 mismatch/s);
  });

  it('accepts directory entries only with empty sha256', async () => {
    mkdirSync(join(outputDir, 'assets'));

    const manifest = await validateManifest({
      schemaVersion: 1,
      status: 'ok',
      summary: 'dir',
      files: [{
        name: 'assets',
        path: 'assets',
        kind: 'directory',
        bytes: 0,
        sha256: '',
        mime: 'inode/directory',
      }],
    }, outputDir);

    expect(manifest.files[0]?.kind).toBe('directory');

    await expect(validateManifest({
      ...manifest,
      files: [{ ...manifest.files[0]!, sha256: 'not-empty' }],
    }, outputDir)).rejects.toThrow(/sha256 must be "" for directory/);
  });

  it('truncates summary and preview by utf-8 byte budget', async () => {
    writeFileSync(join(outputDir, 'x.txt'), 'x', 'utf-8');
    const long = '好'.repeat(3000);

    const manifest = await validateManifest({
      schemaVersion: 1,
      status: 'ok',
      summary: long,
      files: [{
        name: 'x',
        path: 'x.txt',
        kind: 'text',
        bytes: 1,
        sha256: sha('x'),
        mime: 'text/plain',
        preview: long,
      }],
    }, outputDir);

    expect(Buffer.byteLength(manifest.summary)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(manifest.files[0]!.preview!)).toBeLessThanOrEqual(4096);
  });

  it('reads and validates manifest.json from disk', async () => {
    writeFileSync(join(outputDir, 'x.txt'), 'x', 'utf-8');
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(baseFile('x.txt', { bytes: 1, sha256: sha('x') })), 'utf-8');

    await expect(readAndValidateManifest(manifestPath, outputDir)).resolves.toMatchObject({
      status: 'ok',
      files: [{ path: 'x.txt' }],
    });
  });

  it('surfaces all shape problems together', async () => {
    try {
      await validateManifest({ schemaVersion: 2, status: 'maybe', summary: 1, files: 'nope' }, outputDir);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain('schemaVersion must be 1');
      expect(msg).toContain('status must be one of ok | fail');
      expect(msg).toContain('summary must be a string');
      expect(msg).toContain('files must be an array');
    }
  });
});

function baseFile(path: string, overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: 1,
    status: 'ok',
    summary: 'ok',
    files: [{
      name: 'file',
      path,
      kind: 'text',
      bytes: 0,
      sha256: '',
      mime: 'text/plain',
      ...overrides,
    }],
  };
}

function sha(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}
