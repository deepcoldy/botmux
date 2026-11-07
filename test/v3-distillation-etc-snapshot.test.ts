/**
 * The child's frozen /etc view binds every top-level /etc entry read-only, and
 * bwrap refuses to start at all when one bind source does not exist (a dangling
 * symlink such as `/etc/vconsole.conf -> default/keyboard` on some cloud
 * images). /etc is hard-coded, so the listing is mocked to add one entry that
 * does not resolve; everything else is the real filesystem.
 */
import './helpers/require-fenced-data-dir.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  runV3DistillationModel,
  type V3DistillationStructuredInvocation,
} from '../src/workflows/v3/distillation-runner.js';

const DANGLING = 'botmux-test-dangling-entry';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((path: unknown, ...rest: unknown[]) => {
    const entries = (actual.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    return path === '/etc' && Array.isArray(entries) ? [...entries, 'botmux-test-dangling-entry'] : entries;
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

const AMBIENT_PROVIDER_KEY = /^(?:ANTHROPIC_|AWS_|GOOGLE_|AZURE_|CLOUD_ML_REGION|VERTEX_REGION|CLAUDE_CODE_)/;
const stripped: Record<string, string> = {};
let root: string;

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (AMBIENT_PROVIDER_KEY.test(key)) {
      stripped[key] = process.env[key]!;
      delete process.env[key];
    }
  }
  process.env.ANTHROPIC_API_KEY = 'synthetic-test-api-key';
  root = mkdtempSync(join(tmpdir(), 'v3-distill-etc-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  for (const [key, value] of Object.entries(stripped)) {
    process.env[key] = value;
    delete stripped[key];
  }
});

it.skipIf(process.platform !== 'linux')('does not bind an /etc entry whose source path does not exist', async () => {
  const scratchParent = join(root, 'scratch');
  mkdirSync(scratchParent);
  const path = '/dagTemplate/nodes/0/goal';
  let invocation: V3DistillationStructuredInvocation | undefined;
  await runV3DistillationModel({
    fields: [{ ref: 'field-001', path, category: 'goal', nodeOrdinal: 1, text: 'Create report for Alpha' }],
    botSnapshot: { larkAppId: 'cli_test_distiller', cliId: 'claude-code', model: 'test-model', workingDir: '/private/project' },
  }, {
    scratchParent,
    platform: 'linux',
    adapterBin: process.execPath,
    invokeStructuredModel: async (value) => {
      invocation = value;
      return JSON.stringify({ structured_output: { schemaVersion: 1, candidates: [
        { path, literal: 'Alpha', occurrence: 0, type: 'string' },
      ] } });
    },
  });
  expect(invocation).toBeDefined();
  expect(invocation!.args).not.toContain(join('/etc', DANGLING));
  expect(invocation!.args).toContain('/etc/hosts');
});
