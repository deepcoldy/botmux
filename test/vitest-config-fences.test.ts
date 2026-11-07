/**
 * Every vitest config checked into the repo root must mount the tmux fence and
 * the per-file data-dir fence.
 *
 * The fences only exist where a config lists them: a config without
 * `tmux-fence-setup.ts` / `tmux-fence-global-setup.ts` lets the normal unit files
 * reach the host's tmux servers (the fleet's `-L botmux` server included), and
 * one without `unit-setup.ts` / `e2e-setup.ts` lets test stores inherit the
 * invoking shell's live SESSION_DATA_DIR. `vitest.non-linux-probe.config.ts`
 * shipped without the former. The configs are loaded as modules (not read as
 * text), so this checks what vitest actually gets.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(__dirname, '..');
const CONFIG_RE = /^vitest(?:\.[\w-]+)?\.config\.(?:ts|mts|cts|js|mjs|cjs)$/;

interface TestOptions { name?: string; setupFiles?: string | string[]; globalSetup?: string | string[] }

function asList(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function projectsOf(config: { test?: TestOptions & { projects?: Array<{ test?: TestOptions }> } }): TestOptions[] {
  const test = config.test ?? {};
  const projects = (test.projects ?? []).map(project => project.test ?? {});
  return projects.length > 0 ? projects : [test];
}

describe('repo vitest configs keep the tmux and data-dir fences', () => {
  const files = readdirSync(ROOT).filter(name => CONFIG_RE.test(name));

  it('finds the repo configs', () => {
    expect(files).toContain('vitest.config.ts');
  });

  it.each(files)('%s mounts the tmux fence in every project', async (file) => {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    for (const project of projectsOf(mod.default)) {
      const label = `${file} › ${project.name ?? '(root)'}`;
      expect(asList(project.setupFiles).map(p => p.replace(/^\.\//, '')), label)
        .toContain('test/tmux-fence-setup.ts');
      expect(asList(project.globalSetup).map(p => p.replace(/^\.\//, '')), label)
        .toContain('test/tmux-fence-global-setup.ts');
    }
  });

  it.each(files)('%s mounts the per-file data-dir fence in every project', async (file) => {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    for (const project of projectsOf(mod.default)) {
      const label = `${file} › ${project.name ?? '(root)'}`;
      // The disposable root comes from the globalSetup; without it the setup
      // file's inject() gets undefined and every test file crashes at import —
      // which PR CI does not catch for the e2e project (no e2e job runs on
      // pull_request).
      expect(asList(project.globalSetup).map(p => p.replace(/^\.\//, '')), label)
        .toContain('test/unit-global-setup.ts');
      // Each project must mount a per-file data-dir setup. Two shapes exist:
      // unit-setup.ts fences HOME as well as the data dir; e2e-setup.ts fences
      // only the data dir because e2e drives real CLIs that need the developer's
      // real credentials/config. Decide by what is MOUNTED, not by the project's
      // display name: a renamed/new project must not silently fall out of this
      // check, and an e2e-shaped project that mounts e2e-setup.ts stays covered.
      const mountedSetups = asList(project.setupFiles).map(p => p.replace(/^\.\//, ''));
      expect(
        mountedSetups.includes('test/unit-setup.ts')
          || mountedSetups.includes('test/e2e-setup.ts'),
        `${label}: setupFiles must include test/unit-setup.ts (full HOME + data fence) `
          + `or test/e2e-setup.ts (data-only fence for real-CLI e2e); got ${JSON.stringify(mountedSetups)}`,
      ).toBe(true);
    }
  });
});
