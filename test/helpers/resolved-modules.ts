/**
 * Which repo modules a child process loads, for tests that prove a code path
 * does NOT load some part of the tree (e.g. no WeCom gateway module behind
 * `botmux wecom identify`, no WeCom module behind a Feishu-only `botmux status`).
 *
 * `resolvedModulesPrelude(output)` is source to put at the top of an inline
 * snippet run with spawnTsEvalWithRepoImports, before it imports anything from
 * the repo: it records every module the child resolves — a Node module hook
 * (`module.registerHooks`), a Bun runtime plugin — and writes the `/src/`
 * entries to `output` as a JSON array when the child exits. On Node without
 * `module.registerHooks` the child exits 97 instead of observing nothing.
 *
 * A test that asserts an EMPTY selection must also show the same observer
 * finding the modules on a path that does load them: an empty list from a
 * blind observer proves nothing.
 */
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnTsEvalWithRepoImports } from './ts-runner.js';

export function resolvedModulesPrelude(output: string): string {
  return `
    const seen = new Set();
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (typeof Bun !== 'undefined') {
      Bun.plugin({
        name: 'resolved-modules',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            seen.add(args.path.startsWith('.') && args.importer ? path.resolve(path.dirname(args.importer), args.path) : args.path);
            return undefined;
          });
        },
      });
    } else {
      const mod = await import('node:module');
      if (typeof mod.registerHooks !== 'function') {
        console.error('module.registerHooks is not available');
        process.exit(97);
      }
      mod.registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          seen.add(result.url);
          return result;
        },
      });
    }
    process.on('exit', () => {
      fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify([...seen].filter(item => item.includes('/src/'))));
    });
  `;
}

/** The modules a child recorded with resolvedModulesPrelude. */
export function readResolvedModules(output: string): string[] {
  return JSON.parse(readFileSync(output, 'utf8')) as string[];
}

/** Run an inline snippet from the repo root with only PATH, HOME and `env`; at most 90 s. */
export async function runRepoSnippet(
  source: string,
  home: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnTsEvalWithRepoImports(source, {
    cwd: resolve('.'),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const [code] = await once(child, 'exit') as [number | null];
  clearTimeout(timer);
  return { code, stdout, stderr };
}
