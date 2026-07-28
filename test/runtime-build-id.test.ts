import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeRuntimeBuildId, resolveRuntimeBuildIdentity } from '../src/utils/runtime-build-id.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe('runtime build identity', () => {
  it('is order independent and content sensitive', () => {
    const entries = [{ path: 'b.js', content: 'b' }, { path: 'a.js', content: 'a' }];
    expect(computeRuntimeBuildId(entries)).toBe(computeRuntimeBuildId([...entries].reverse()));
    expect(computeRuntimeBuildId(entries)).not.toBe(computeRuntimeBuildId([
      entries[0],
      { path: 'a.js', content: 'changed' },
    ]));
  });

  it('accepts only a valid generated artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-id-'));
    dirs.push(root);
    const artifactPath = join(root, '.runtime-build-id');
    writeFileSync(artifactPath, `${'a'.repeat(64)}\n`);
    expect(resolveRuntimeBuildIdentity({ artifactPath }).status).toBe('known');
    writeFileSync(artifactPath, 'invalid\n');
    expect(resolveRuntimeBuildIdentity({ artifactPath })).toEqual({
      status: 'unknown',
      reason: 'artifact_invalid',
    });
  });
});
