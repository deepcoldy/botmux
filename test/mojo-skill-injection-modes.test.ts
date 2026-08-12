/**
 * Built-in skill delivery for mojo across all three `skillInjection` modes.
 *
 * Why this file exists: adding `skillsDir` to MojoAdapter made the dashboard
 * expose global / prompt / off for mojo bots, but only `global` did anything —
 * that mode installs files on disk and needs no adapter cooperation, while
 * `prompt` (catalog) and `off` (help pointer) must ride on the prompt the
 * backend builds. mojo is `injectsSessionContext`, so session-manager
 * deliberately skips the per-message skill envelope for it; nothing else would
 * ever deliver them. Both controls therefore silently no-oped.
 *
 * These assertions go through the REAL argv the CLI receives (fake `mojo`
 * binary logging "$@"), not the config object, so a future refactor that keeps
 * the field but stops passing it to the CLI still fails.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import {
  MOJO_INTERNAL_CONFIG_KEYS,
  buildEffectiveMojoConfig,
  normalizeMojoConfig,
} from '../src/adapters/backend/mojo-types.js';

let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'mojo-skill-inject-'));
});
afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/** Fake mojo that logs its argv and closes the turn immediately. */
function fakeMojo(argvLog: string): string {
  const p = join(binDir, 'mojo');
  writeFileSync(
    p,
    `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> ${argvLog}\n`
    + `echo '{"type":"system","subtype":"init","session_id":"sid-1"}'\n`
    + `echo '{"type":"result","status":"ok","result":"ok","session_id":"sid-1","warnings":[]}'\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

/** Run one turn and return the positional prompt mojo actually received. */
async function promptSentToCli(extra: Record<string, unknown>): Promise<string> {
  const argvLog = join(binDir, `argv-${Math.random().toString(36).slice(2)}.log`);
  const bin = fakeMojo(argvLog);
  const backend = new MojoBackend({ bin, ...extra } as never, 'sid-under-test');
  await new Promise<void>((resolve) => {
    backend.onTaskDone(() => resolve());
    backend.spawn('', [], {} as never);
    backend.write('USER TURN TEXT');
  });
  const argv = readFileSync(argvLog, 'utf-8').split('\0').filter(Boolean);
  // The prompt is always last (buildCliArgs contract).
  return argv[argv.length - 1] ?? '';
}

describe('mojo built-in skill delivery — all three modes reach the CLI', () => {
  it('prompt mode: the catalog block is in the prompt mojo receives', async () => {
    const prompt = await promptSentToCli({
      builtinSkillBlock: '<botmux_builtin_skills>\nCATALOG-MARKER\n</botmux_builtin_skills>',
    });
    expect(prompt).toContain('<botmux_builtin_skills>');
    expect(prompt).toContain('CATALOG-MARKER');
    expect(prompt).toContain('USER TURN TEXT');
  });

  it('off mode: the help pointer is in the prompt mojo receives', async () => {
    const prompt = await promptSentToCli({
      builtinSkillBlock: '<botmux_builtin_skills>\nHELP-POINTER-MARKER\n</botmux_builtin_skills>',
    });
    expect(prompt).toContain('HELP-POINTER-MARKER');
  });

  it('global mode: nothing is injected (files already live on disk)', async () => {
    // buildBuiltinSkillBlockForInjectsSessionContext returns '' for global; the
    // builder drops empty strings, so the prompt must be untouched.
    const prompt = await promptSentToCli({ builtinSkillBlock: '' });
    expect(prompt).toBe('USER TURN TEXT');
    expect(prompt).not.toContain('botmux_builtin_skills');
  });

  it('an operator systemPrompt does NOT swallow skill discovery', async () => {
    // Regression guard for the trap riff documented for its routing rules:
    // folding the block into systemPrompt would mean a bot that sets its own
    // prompt silently loses the catalog.
    const prompt = await promptSentToCli({
      systemPrompt: 'OPERATOR-PROMPT',
      builtinSkillBlock: 'CATALOG-MARKER',
    });
    expect(prompt).toContain('OPERATOR-PROMPT');
    expect(prompt).toContain('CATALOG-MARKER');
    expect(prompt).toContain('USER TURN TEXT');
    // Operator prompt keeps precedence (first), turn text stays last.
    expect(prompt.indexOf('OPERATOR-PROMPT')).toBeLessThan(prompt.indexOf('CATALOG-MARKER'));
    expect(prompt.indexOf('CATALOG-MARKER')).toBeLessThan(prompt.indexOf('USER TURN TEXT'));
  });
});

describe('builtinSkillBlock is platform-owned, not operator input', () => {
  it('is listed as an internal key so a bots.json mojo block cannot set it', () => {
    expect(MOJO_INTERNAL_CONFIG_KEYS).toContain('builtinSkillBlock');
  });

  it('rejects it at the config door and strips it in the builder', () => {
    const validated = normalizeMojoConfig({ builtinSkillBlock: 'INJECTED-BY-OPERATOR' });
    // Either rejected outright, or accepted-then-stripped — assert the effect,
    // which is what actually protects the prompt.
    const built = buildEffectiveMojoConfig(
      validated.ok ? validated.value : {},
      { workingDir: '/tmp' },
    );
    expect(built.builtinSkillBlock).toBeUndefined();
  });

  it('is carried by the builder only when the caller resolved a mode block', () => {
    expect(buildEffectiveMojoConfig({}, { workingDir: '/tmp' }).builtinSkillBlock)
      .toBeUndefined();
    // global mode resolves to '' — must not become a stray empty preamble.
    expect(buildEffectiveMojoConfig({}, { workingDir: '/tmp', builtinSkillBlock: '' })
      .builtinSkillBlock).toBeUndefined();
    expect(buildEffectiveMojoConfig({}, { workingDir: '/tmp', builtinSkillBlock: 'BLOCK' })
      .builtinSkillBlock).toBe('BLOCK');
  });
});

describe('the worker actually resolves and passes the block', () => {
  it('wires builtinSkillBlockForInjectsSessionContext into the mojo launch config', () => {
    // Source-level guard: the whole fix is worthless if the worker stops
    // resolving the mode, and no unit test of the backend alone would notice.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const call = worker.slice(
      worker.indexOf('buildEffectiveMojoConfig('),
      worker.indexOf('buildEffectiveMojoConfig(') + 1600,
    );
    expect(call).toContain('builtinSkillBlock: builtinSkillBlockForInjectsSessionContext(');
    expect(call).toContain('cfg.larkAppId');
  });
});
