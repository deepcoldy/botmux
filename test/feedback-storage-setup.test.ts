import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureFeedbackStorage } from '../src/setup/feedback-storage.js';
import { readFeedbackStorageConfig } from '../src/services/feedback-storage-config.js';
import { assertFeedbackAdmission } from '../src/services/feedback-maintenance.js';

const directories: string[] = [];
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const promptAnswers = vi.hoisted(() => [] as string[]);
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: async () => promptAnswers.shift() ?? '', close: () => {} }),
}));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  promptAnswers.splice(0);
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
describe('feedback storage initial setup', () => {
  it('saves a Supabase bootstrap candidate without freezing a new installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-setup-'));
    directories.push(directory);
    const path = join(directory, 'supabase.json');
    await writeFile(path, JSON.stringify({ backend: 'supabase', supabase: {
      url: 'https://example.supabase.co', keyRef: 'env:SUPABASE_KEY', schema: 'feedback', requestTimeoutMs: 100,
    } }));
    vi.stubEnv('BOTMUX_FEEDBACK_CONFIG_FILE', path);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await configureFeedbackStorage(directory);
    const config = await readFeedbackStorageConfig(directory);
    expect(config.active.backend).toBe('sqlite');
    expect(config.candidate?.backend).toBe('supabase');
    expect(existsSync(join(directory, 'feedback-maintenance.json'))).toBe(false);
    expect(existsSync(join(directory, 'feedback-supabase-migrations'))).toBe(false);
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
    output.mockRestore();
  });
  it('keeps interactive Supabase onboarding outside maintenance until bootstrap is installed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-setup-interactive-'));
    directories.push(directory);
    const path = join(directory, 'supabase.json');
    await writeFile(path, JSON.stringify({ backend: 'supabase', supabase: {
      url: 'https://example.supabase.co', keyRef: 'env:SUPABASE_KEY', schema: 'feedback', requestTimeoutMs: 100,
    } }));
    vi.stubEnv('BOTMUX_FEEDBACK_CONFIG_FILE', '');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    promptAnswers.push('supabase', path);
    await configureFeedbackStorage(directory);
    expect((await readFeedbackStorageConfig(directory)).candidate?.backend).toBe('supabase');
    expect(existsSync(join(directory, 'feedback-maintenance.json'))).toBe(false);
  });
  it('rejects a configuration for a different selected backend before initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-setup-mismatch-'));
    directories.push(directory);
    const path = join(directory, 'sqlite.json');
    await writeFile(path, '{"backend":"sqlite"}');
    vi.stubEnv('BOTMUX_FEEDBACK_CONFIG_FILE', '');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    promptAnswers.push('supabase', path);
    await expect(configureFeedbackStorage(directory)).rejects.toThrow('feedback_storage_target_invalid');
    expect(existsSync(join(directory, 'feedback-maintenance.json'))).toBe(false);
  });
});
