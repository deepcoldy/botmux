/**
 * Every vitest config checked into the repo root must mount the tmux fence.
 *
 * The fence only exists where a config lists it: a config without
 * `tmux-fence-setup.ts` / `tmux-fence-global-setup.ts` lets the normal unit files
 * reach the host's tmux servers (the fleet's `-L botmux` server included).
 * `vitest.non-linux-probe.config.ts` shipped without it. The configs are loaded
 * as modules (not read as text), so this checks what vitest actually gets.
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

describe('repo vitest configs keep the tmux fence', () => {
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
});
