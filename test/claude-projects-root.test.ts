import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectsRootForLaunch,
  isInClaudeProjectsRoot,
  pinClaudeProjectsRoot,
} from '../src/services/claude-projects-root.js';

const SID = '85b23608-1234-4abc-9def-0123456789ab';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-projects-root-'));
  dirs.push(dir);
  return dir;
}

/** `<base>/claude/projects/cwd-key/<sid>.jsonl`, the layout Claude Code writes. */
function configWithTranscript(base = temp()) {
  const config = join(base, 'claude');
  const transcript = join(config, 'projects', 'cwd-key', `${SID}.jsonl`);
  mkdirSync(join(config, 'projects', 'cwd-key'), { recursive: true });
  writeFileSync(transcript, '{}\n');
  return { base, config, transcript };
}

/** Somewhere else holding a file at the same relative path. */
function elsewhere() {
  const other = temp();
  mkdirSync(join(other, 'projects', 'cwd-key'), { recursive: true });
  writeFileSync(join(other, 'projects', 'cwd-key', `${SID}.jsonl`), '{}\n');
  return other;
}

describe('isInClaudeProjectsRoot', () => {
  it('accepts the transcript under the pinned config dir', () => {
    const { config, transcript } = configWithTranscript();
    const root = pinClaudeProjectsRoot(config)!;
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(true);
  });

  it('rejects a path not named under the root, even one that resolves into it', () => {
    const { base, config, transcript } = configWithTranscript();
    const root = pinClaudeProjectsRoot(config)!;
    const alias = join(base, 'alias');
    symlinkSync(join(config, 'projects'), alias);
    expect(isInClaudeProjectsRoot(join(alias, 'cwd-key', `${SID}.jsonl`), root)).toBe(false);
    expect(isInClaudeProjectsRoot(join(config, 'projects'), root)).toBe(false);
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(true);
  });

  it('rejects the transcript once `projects` was swapped for a link after launch', () => {
    const { config, transcript } = configWithTranscript();
    const root = pinClaudeProjectsRoot(config)!;
    renameSync(join(config, 'projects'), join(config, 'projects.aside'));
    symlinkSync(join(elsewhere(), 'projects'), join(config, 'projects'));
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(false);
  });

  it('rejects the transcript once the config dir itself was swapped for a link after launch', () => {
    const { base, config, transcript } = configWithTranscript();
    const root = pinClaudeProjectsRoot(config)!;
    renameSync(config, join(base, 'claude.aside'));
    symlinkSync(elsewhere(), config);
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(false);
  });

  it('rejects a project directory that links out of the root', () => {
    const { config } = configWithTranscript();
    const root = pinClaudeProjectsRoot(config)!;
    symlinkSync(join(elsewhere(), 'projects', 'cwd-key'), join(config, 'projects', 'linked-key'));
    expect(isInClaudeProjectsRoot(join(config, 'projects', 'linked-key', `${SID}.jsonl`), root)).toBe(false);
  });

  it('a config dir reached through a link at launch keeps working', () => {
    const { base, config, transcript } = configWithTranscript();
    const viaLink = join(base, 'dot-claude');
    symlinkSync(config, viaLink);
    const root = pinClaudeProjectsRoot(viaLink)!;
    expect(root.real).toBe(join(realpathSync(config), 'projects'));
    expect(isInClaudeProjectsRoot(join(viaLink, 'projects', 'cwd-key', `${SID}.jsonl`), root)).toBe(true);
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(false);
  });

  it('`projects` created after launch, as a directory, is inside', () => {
    const config = join(temp(), 'claude');
    mkdirSync(config);
    const root = pinClaudeProjectsRoot(config)!;
    mkdirSync(join(config, 'projects', 'cwd-key'), { recursive: true });
    const transcript = join(config, 'projects', 'cwd-key', `${SID}.jsonl`);
    writeFileSync(transcript, '{}\n');
    expect(isInClaudeProjectsRoot(transcript, root)).toBe(true);
  });
});

describe('pinClaudeProjectsRoot', () => {
  it('noFollow: refuses a config dir or `projects` that is a link', () => {
    const { base, config } = configWithTranscript();
    expect(pinClaudeProjectsRoot(config, { noFollow: true })).toBeDefined();

    const linkedConfig = join(base, 'linked-claude');
    symlinkSync(config, linkedConfig);
    expect(pinClaudeProjectsRoot(linkedConfig, { noFollow: true })).toBeUndefined();
    expect(pinClaudeProjectsRoot(linkedConfig)).toBeDefined();

    renameSync(join(config, 'projects'), join(config, 'projects.aside'));
    symlinkSync(join(elsewhere(), 'projects'), join(config, 'projects'));
    expect(pinClaudeProjectsRoot(config, { noFollow: true })).toBeUndefined();
  });

  it('is undefined when the config dir does not exist', () => {
    expect(pinClaudeProjectsRoot(join(temp(), 'missing'))).toBeUndefined();
  });
});

describe('claudeProjectsRootForLaunch', () => {
  it('a later launch of the same config dir keeps the first root', () => {
    const { config, transcript } = configWithTranscript();
    const first = claudeProjectsRootForLaunch(config, undefined)!;
    // The previous CLI swapped `projects` for a link before the relaunch.
    renameSync(join(config, 'projects'), join(config, 'projects.aside'));
    symlinkSync(join(elsewhere(), 'projects'), join(config, 'projects'));
    const relaunch = claudeProjectsRootForLaunch(config, first);
    expect(relaunch).toBe(first);
    expect(isInClaudeProjectsRoot(transcript, relaunch!)).toBe(false);
  });

  it('a different config dir is resolved afresh', () => {
    const a = configWithTranscript();
    const b = configWithTranscript();
    const first = claudeProjectsRootForLaunch(a.config, undefined)!;
    const second = claudeProjectsRootForLaunch(b.config, first)!;
    expect(second).not.toBe(first);
    expect(isInClaudeProjectsRoot(b.transcript, second)).toBe(true);
  });
});
