import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  prepareV3HostInputArtifact,
  readAndVerifyV3PreparedHostInput,
  readAndVerifyV3HostSuccessResult,
  writeV3HostSuccessArtifacts,
} from '../src/workflows/v3/host-execution.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import type { RegisteredHostExecutor } from '../src/workflows/hostExecutors/registry.js';

const registered: RegisteredHostExecutor<{ content: string }, { messageId: string }> = {
  parseInput(input) {
    if (!input || typeof input !== 'object' || typeof (input as any).content !== 'string') throw new Error('bad input');
    return { content: (input as any).content };
  },
  executor: {
    provider: 'fake-provider',
    idempotencyTtlMs: 1_000,
    canonicalInput: (input) => ({ content: input.content }),
    invoke: async () => ({ output: { messageId: 'm' }, externalRefs: { messageId: 'm' } }),
  },
};

function temp() {
  const runDir = mkdtempSync(join(tmpdir(), 'v3-host-artifact-'));
  const attemptDir = join(runDir, 'send#001', 'attempts', '001');
  mkdirSync(attemptDir, { recursive: true });
  return { runDir, attemptDir };
}

describe('v3 host execution artifacts', () => {
  it('freezes parsed/canonical input durably and verifies it on replay', () => {
    const { runDir, attemptDir } = temp();
    try {
      const artifact = prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      });
      expect(artifact.inputRef.path).toBe('send#001/attempts/001/host-input.json');
      expect(artifact.prepared.inputHash).toMatch(/^sha256:/);
      expect(artifact.prepared.idempotencyKey).toMatch(/^wf3_/);
      expect(readAndVerifyV3PreparedHostInput({
        runDir,
        inputRef: artifact.inputRef,
        expected: artifact.prepared,
        registered,
      }).prepared.parsedInput).toEqual({ content: 'hello' });
      expect((readFileSync(artifact.absolutePath).length)).toBe(artifact.inputRef.bytes);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('reuses identical crash-left preparation but refuses different bytes', () => {
    const { runDir, attemptDir } = temp();
    try {
      const common = {
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send', registered,
      };
      const first = prepareV3HostInputArtifact({ ...common, resolvedInput: { content: 'one' } });
      expect(prepareV3HostInputArtifact({ ...common, resolvedInput: { content: 'one' } }).inputRef)
        .toEqual(first.inputRef);
      expect(() => prepareV3HostInputArtifact({ ...common, resolvedInput: { content: 'two' } }))
        .toThrow(/refusing to overwrite/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('rejects payloads too large to render completely in the approval card', () => {
    const { runDir, attemptDir } = temp();
    try {
      expect(() => prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'x'.repeat(8_100) }, registered,
      })).toThrow(/exceeds 8000 bytes/);
      expect(existsSync(join(attemptDir, 'host-input.json'))).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('fails closed on content tamper and symlink input', () => {
    const { runDir, attemptDir } = temp();
    try {
      const artifact = prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      });
      chmodSync(artifact.absolutePath, 0o600);
      writeFileSync(artifact.absolutePath, readFileSync(artifact.absolutePath, 'utf-8').replace('hello', 'hullo'));
      expect(() => readAndVerifyV3PreparedHostInput({
        runDir, inputRef: artifact.inputRef, expected: artifact.prepared, registered,
      })).toThrow(/bytes\/hash mismatch/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('fails closed when provider registration or TTL drifts after approval', () => {
    const { runDir, attemptDir } = temp();
    try {
      const artifact = prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      });
      const providerDrift = {
        ...registered,
        executor: { ...registered.executor, provider: 'other-provider' },
      } satisfies RegisteredHostExecutor<{ content: string }, { messageId: string }>;
      expect(() => readAndVerifyV3PreparedHostInput({
        runDir, inputRef: artifact.inputRef, expected: artifact.prepared, registered: providerDrift,
      })).toThrow(/provider registration changed/);
      const ttlDrift = {
        ...registered,
        executor: { ...registered.executor, idempotencyTtlMs: 999 },
      } satisfies RegisteredHostExecutor<{ content: string }, { messageId: string }>;
      expect(() => readAndVerifyV3PreparedHostInput({
        runDir, inputRef: artifact.inputRef, expected: artifact.prepared, registered: ttlDrift,
      })).toThrow(/TTL changed/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('rejects crash-left host artifacts that are group/world readable', () => {
    const { runDir, attemptDir } = temp();
    try {
      const artifact = prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      });
      chmodSync(artifact.absolutePath, 0o644);
      expect(() => readAndVerifyV3PreparedHostInput({
        runDir, inputRef: artifact.inputRef, expected: artifact.prepared, registered,
      })).toThrow(/group\/world accessible/);
      expect(() => prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      })).toThrow(/group\/world accessible/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects final-file and parent-directory symlinks without touching outside paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'v3-host-symlink-'));
    const runDir = join(root, 'run');
    const outside = join(root, 'outside');
    mkdirSync(runDir, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    try {
      const attemptDir = join(runDir, 'send#001', 'attempts', '001');
      const artifact = prepareV3HostInputArtifact({
        runDir, attemptDir, runId: 'run', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executorName: 'fake-send',
        resolvedInput: { content: 'hello' }, registered,
      });
      const externalInput = join(outside, 'host-input.json');
      writeFileSync(externalInput, readFileSync(artifact.absolutePath), { mode: 0o600 });
      unlinkSync(artifact.absolutePath);
      symlinkSync(externalInput, artifact.absolutePath);
      expect(() => readAndVerifyV3PreparedHostInput({
        runDir, inputRef: artifact.inputRef, expected: artifact.prepared, registered,
      })).toThrow(/regular file/);
      expect(readFileSync(externalInput, 'utf-8')).toContain('hello');

      rmSync(join(runDir, 'send#001'), { recursive: true, force: true });
      symlinkSync(outside, join(runDir, 'send#001'));
      expect(() => prepareV3HostInputArtifact({
        runDir,
        attemptDir,
        runId: 'run',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/001',
        executorName: 'fake-send',
        resolvedInput: { content: 'again' },
        registered,
      })).toThrow(/real directory/);
      expect(existsSync(join(outside, 'attempts'))).toBe(false);

      rmSync(join(runDir, 'send#001'), { force: true });
      mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      symlinkSync(outside, join(attemptDir, 'work'));
      expect(() => writeV3HostSuccessArtifacts({
        runDir,
        attemptDir,
        runId: 'run',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/001',
        executor: 'fake-send',
        provider: 'fake-provider',
        idempotencyKey: 'wf3_test',
        inputHash: `sha256:${createHash('sha256').update('x').digest('hex')}`,
        approvalDigest: `sha256:${'d'.repeat(64)}`,
        output: { messageId: 'om_1' },
        externalRefs: { messageId: 'om_1' },
      })).toThrow(/real directory/);
      expect(existsSync(join(outside, 'result.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a manifest-valid trusted result for downstream consumers', async () => {
    const { runDir, attemptDir } = temp();
    try {
      const { manifestPath, resultPath } = writeV3HostSuccessArtifacts({
        runDir,
        attemptDir,
        runId: 'run',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/001',
        executor: 'fake-send',
        provider: 'fake-provider',
        idempotencyKey: 'wf3_test',
        inputHash: `sha256:${createHash('sha256').update('x').digest('hex')}`,
        approvalDigest: `sha256:${'d'.repeat(64)}`,
        output: { messageId: 'om_1' },
        externalRefs: { messageId: 'om_1' },
      });
      const manifest = await readAndValidateManifest(manifestPath, join(attemptDir, 'work'));
      expect(manifest.files[0]?.name).toBe('result');
      expect(JSON.parse(readFileSync(resultPath, 'utf-8')).output).toEqual({ messageId: 'om_1' });
      expect(readAndVerifyV3HostSuccessResult({
        runDir,
        attemptDir,
        manifest,
        runId: 'run',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/001',
        executor: 'fake-send',
        provider: 'fake-provider',
        idempotencyKey: 'wf3_test',
        inputHash: `sha256:${createHash('sha256').update('x').digest('hex')}`,
        approvalDigest: `sha256:${'d'.repeat(64)}`,
      }).output).toEqual({ messageId: 'om_1' });

      // Copying a byte-valid result/manifest into another attempt must not
      // become close proof for that attempt: the trusted wrapper binds the
      // complete execution identity, not just the output hash.
      expect(() => readAndVerifyV3HostSuccessResult({
        runDir,
        attemptDir,
        manifest,
        runId: 'run',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/002',
        executor: 'fake-send',
        provider: 'fake-provider',
        idempotencyKey: 'wf3_other',
        inputHash: `sha256:${createHash('sha256').update('other').digest('hex')}`,
        approvalDigest: `sha256:${'e'.repeat(64)}`,
      })).toThrow(/attemptId mismatch/);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
