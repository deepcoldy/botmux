#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(repoRoot, 'public-api');
const declarationDir = join(repoRoot, '.observe-public-types');
const entries = ['session-observe', 'session-observe-fetch'];
const require = createRequire(join(repoRoot, 'package.json'));

await rm(outputDir, { recursive: true, force: true });
await rm(declarationDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const result = await build({
  absWorkingDir: repoRoot,
  bundle: true,
  entryPoints: Object.fromEntries(entries.map(name => [name, `src/services/${name}.ts`])),
  format: 'esm',
  legalComments: 'none',
  metafile: true,
  outdir: outputDir,
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
const bundledDependencies = Object.keys(result.metafile.inputs)
  .filter(path => path.includes('node_modules/'));
if (bundledDependencies.length > 0) {
  throw new Error(`observe public API bundled dependencies:\n${bundledDependencies.join('\n')}`);
}

try {
  const declarations = spawnSync(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '--declaration',
    '--emitDeclarationOnly',
    '--declarationMap', 'false',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--strict',
    '--esModuleInterop',
    '--skipLibCheck',
    '--forceConsistentCasingInFileNames',
    '--rootDir', join(repoRoot, 'src'),
    '--outDir', declarationDir,
    ...entries.map(name => join(repoRoot, 'src', 'services', `${name}.ts`)),
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (declarations.status !== 0) {
    process.stderr.write(declarations.stdout);
    process.stderr.write(declarations.stderr);
    process.exit(declarations.status ?? 1);
  }
  for (const name of entries) {
    await cp(
      join(declarationDir, 'services', `${name}.d.ts`),
      join(outputDir, `${name}.d.ts`),
    );
  }
} finally {
  await rm(declarationDir, { recursive: true, force: true });
}
