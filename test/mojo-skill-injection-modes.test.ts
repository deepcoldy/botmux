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

/**
 * Drive the REAL mode resolver rather than hand-feeding a block. The first
 * version of this file passed synthetic `builtinSkillBlock` values, so it proved
 * only that MojoBackend concatenates a string it was given — swapping the off/
 * global branches inside the resolver left every case green.
 */
let botSkillInjection: string | undefined;
vi.mock('../src/bot-registry.js', () => ({
  loadBotConfigs: () => [{ larkAppId: 'app-under-test', skillInjection: botSkillInjection }],
}));
vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: () => ({}),
  config: {},
}));
vi.mock('../src/services/whiteboard-store.js', () => ({ whiteboardEnabled: () => false }));

import { MojoBackend } from '../src/adapters/backend/mojo-backend.js';
import {
  MOJO_INTERNAL_CONFIG_KEYS,
  buildEffectiveMojoConfig,
  normalizeMojoConfig,
} from '../src/adapters/backend/mojo-types.js';
import { builtinSkillBlockForInjectsSessionContext } from '../src/skills/injection-mode.js';

/** What the worker actually computes for a mojo session in the given mode. */
function resolvedBlockForMode(mode: string | undefined): string {
  botSkillInjection = mode;
  return builtinSkillBlockForInjectsSessionContext('app-under-test', 'en', {
    asksViaHook: false,
    whiteboardEnabled: false,
    hasRoutingBlock: false,
  });
}

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

describe('mojo built-in skill delivery — the real resolver distinguishes all three modes', () => {
  it('prompt mode yields a catalog, off yields a help pointer, global yields nothing', () => {
    const prompt = resolvedBlockForMode('prompt');
    const off = resolvedBlockForMode('off');
    const global = resolvedBlockForMode('global');

    // global must be empty — files are installed on disk by ensureCliSkills.
    expect(global).toBe('');
    // The other two are non-empty AND different from each other. Swapping the
    // off/global branches in the resolver now breaks this.
    expect(prompt).not.toBe('');
    expect(off).not.toBe('');
    expect(prompt).not.toBe(off);
    // Catalog lists skills; the pointer does not.
    expect(prompt).toMatch(/- botmux-send:/);
    expect(off).not.toMatch(/- botmux-send:/);
    expect(off).toContain('botmux --help');
  });

  it('keeps the routing-covered skills for mojo, which emits no <botmux_routing>', () => {
    // These are filtered out for genius/grok because routing teaches them. mojo
    // has no routing block, so dropping them documents them NOWHERE.
    const prompt = resolvedBlockForMode('prompt');
    for (const name of ['botmux-history', 'botmux-quoted', 'botmux-bots', 'botmux-send']) {
      expect(prompt, `${name} must stay in the mojo catalog`).toContain(`- ${name}:`);
    }
  });

  it('never cites a <botmux_routing> block that mojo does not emit', () => {
    // The shared prose says "<botmux_routing> covers basic communication only",
    // which is simply false for mojo and would send the agent looking for it.
    expect(resolvedBlockForMode('prompt')).not.toContain('botmux_routing');
    expect(resolvedBlockForMode('off')).not.toContain('botmux_routing');
  });

  it('still filters them out for a CLI that DOES emit routing (genius/grok)', () => {
    botSkillInjection = 'prompt';
    const withRouting = builtinSkillBlockForInjectsSessionContext('app-under-test', 'en', {
      asksViaHook: false, whiteboardEnabled: false, hasRoutingBlock: true,
    });
    expect(withRouting).not.toContain('- botmux-history:');
    expect(withRouting).toContain('botmux_routing');
  });
});

describe('mojo built-in skill delivery — the block reaches the CLI', () => {
  it('prompt mode: the resolved catalog is in the prompt mojo receives', async () => {
    const block = resolvedBlockForMode('prompt');
    const prompt = await promptSentToCli({ builtinSkillBlock: block });
    expect(prompt).toContain('<botmux_builtin_skills>');
    expect(prompt).toContain('- botmux-send:');
    expect(prompt).toContain('USER TURN TEXT');
  });

  it('off mode: the resolved help pointer is in the prompt mojo receives', async () => {
    const prompt = await promptSentToCli({ builtinSkillBlock: resolvedBlockForMode('off') });
    expect(prompt).toContain('botmux --help');
  });

  it('global mode: no skill block is injected (files already live on disk)', async () => {
    const prompt = await promptSentToCli({ builtinSkillBlock: resolvedBlockForMode('global') });
    // No SKILL catalog — but host execution always carries the isolated-cwd
    // guidance preamble (see hostGuidanceBlock), so the assertion is about the
    // skill block's absence, not about a bare prompt.
    expect(prompt).toContain('USER TURN TEXT');
    expect(prompt).not.toContain('botmux_builtin_skills');
    expect(prompt).toContain('--session-id');
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
