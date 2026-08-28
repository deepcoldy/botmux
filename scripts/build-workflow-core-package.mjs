#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'packages', 'workflow-core');
const sourceDir = join(packageDir, 'src');
const distDir = join(packageDir, 'dist');
const packageRequire = createRequire(join(packageDir, 'package.json'));
const { build } = packageRequire('esbuild');
const entryNames = [
  'index',
  'schema',
  'engine',
  'control',
  'gate-policy',
  'host-contract',
  'runtime',
  'events',
  'host-bindings',
];
const entryPoints = Object.fromEntries(
  entryNames.map((name) => [name, join(sourceDir, `${name}.ts`)]),
);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const common = {
  // Pin the working directory so esbuild's metafile input keys are deterministic
  // regardless of how this script is invoked (repoRoot via `pnpm workflow-core:build`
  // vs packages/workflow-core via npm's `prepare`). assertBundleInputsAllowed keys
  // its allowlist off these paths, so they must not shift with process.cwd().
  absWorkingDir: repoRoot,
  bundle: true,
  entryPoints,
  legalComments: 'none',
  logLevel: 'warning',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  treeShaking: true,
};

const [esmResult, cjsResult] = await Promise.all([
  build({
    ...common,
    format: 'esm',
    metafile: true,
    outdir: join(distDir, 'esm'),
  }),
  build({
    ...common,
    format: 'cjs',
    metafile: true,
    outdir: join(distDir, 'cjs'),
    outExtension: { '.js': '.cjs' },
  }),
]);

assertNoBundledThirdPartyModules(esmResult.metafile);
assertNoBundledThirdPartyModules(cjsResult.metafile);
assertBundleInputsAllowed(esmResult.metafile);
assertBundleInputsAllowed(cjsResult.metafile);

const tscPath = packageRequire.resolve('typescript/bin/tsc');
const declarations = spawnSync(
  process.execPath,
  [tscPath, '-p', join(packageDir, 'tsconfig.build.json')],
  { cwd: repoRoot, encoding: 'utf-8' },
);
if (declarations.status !== 0) {
  process.stderr.write(declarations.stdout);
  process.stderr.write(declarations.stderr);
  process.exit(declarations.status ?? 1);
}

await pruneTypeDeclarations();
await assertTypeBoundary();
await assertExportTargetsExist();
console.log(`[workflow-core] built ${entryNames.length} exports in ${distDir}`);

function assertNoBundledThirdPartyModules(metafile) {
  const bundled = Object.keys(metafile.inputs).filter((input) => input.includes('node_modules/'));
  if (bundled.length > 0) {
    throw new Error(
      `workflow-core must have zero bundled third-party runtime modules:\n${bundled.join('\n')}`,
    );
  }
}

function assertBundleInputsAllowed(metafile) {
  // Allowlist, not denylist: a new daemon-only module pulled in for VALUE
  // (not `import type`, which esbuild erases) must FAIL the build rather than
  // silently ride along. A denylist can only catch modules someone remembered
  // to enumerate; the pruned public `.d.ts` graph would also hide such a leak
  // from assertTypeBoundary. So every non-entry `src/` bundle input must be an
  // explicitly-blessed daemon-free module here. Adding a legitimately portable
  // module means adding it to this set on purpose — that review is the point.
  const allowedSourceInputs = new Set([
    'src/utils/canonical-input-hash.ts',
    'src/utils/file-lock.ts',
    'src/utils/fs-durability.ts',
    'src/utils/logger.ts',
    'src/utils/process-identity.ts',
    'src/workflows/shared/idempotency-key.ts',
    'src/workflows/v3/artifact-contract.ts',
    'src/workflows/v3/artifact-contract-declarations.ts',
    'src/workflows/v3/attempt-ledger.ts',
    'src/workflows/v3/contract.ts',
    'src/workflows/v3/core-control.ts',
    'src/workflows/v3/dag.ts',
    'src/workflows/v3/gate-policy.ts',
    'src/workflows/v3/gate-wait-store.ts',
    'src/workflows/v3/host-bindings.ts',
    'src/workflows/v3/host-effect-ledger.ts',
    'src/workflows/v3/host-execution.ts',
    'src/workflows/v3/in-process-attempt-lease.ts',
    'src/workflows/v3/journal.ts',
    'src/workflows/v3/orchestrator.ts',
    'src/workflows/v3/portable-artifact-snapshot.ts',
    'src/workflows/v3/portable-final-outputs.ts',
    'src/workflows/v3/portable-run-snapshot.ts',
    'src/workflows/v3/portable-runtime.ts',
    'src/workflows/v3/runtime-host-contract.ts',
    'src/workflows/v3/shared-node-runtime.ts',
    'src/workflows/v3/shared-runtime.ts',
    'src/workflows/v3/state.ts',
    'src/workflows/v3/template-bindings.ts',
  ]);
  const packageSourcePrefix = 'packages/workflow-core/src/';
  const unexpected = Object.keys(metafile.inputs)
    .map((input) => input.replaceAll('\\', '/'))
    .filter((input) => {
      // Package entry façades live under packages/workflow-core/src/; only
      // main-repo src/ inputs are gated by the allowlist.
      if (input.includes(packageSourcePrefix)) return false;
      const idx = input.indexOf('src/');
      if (idx < 0) return false;
      const relativeToSrc = input.slice(idx);
      return !allowedSourceInputs.has(relativeToSrc);
    });
  if (unexpected.length > 0) {
    throw new Error(
      'workflow-core bundled a main-repo module not on the daemon-free allowlist '
      + '(add it to allowedSourceInputs only after confirming it pulls no daemon, '
      + `Lark, session, or worker code):\n${unexpected.join('\n')}`,
    );
  }
}

async function pruneTypeDeclarations() {
  const typeRoot = join(distDir, 'types');
  const queue = entryNames.map((name) =>
    join(typeRoot, 'packages', 'workflow-core', 'src', `${name}.d.ts`)
  );
  const reachable = new Set();
  while (queue.length > 0) {
    const declaration = queue.pop();
    if (!declaration || reachable.has(declaration)) continue;
    const content = await readFile(declaration, 'utf-8');
    reachable.add(declaration);
    for (const specifier of relativeDeclarationSpecifiers(content)) {
      const target = resolveDeclarationSpecifier(declaration, specifier);
      if (!target.startsWith(`${typeRoot}${sep}`)) {
        throw new Error(`workflow-core declaration escapes type root: ${target}`);
      }
      queue.push(target);
    }
  }
  for (const file of await walk(typeRoot)) {
    if (file.endsWith('.d.ts') && !reachable.has(file)) {
      await rm(file);
    }
  }
  await rm(join(distDir, 'workflow-core.tsbuildinfo'), { force: true });
}

function relativeDeclarationSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g,
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,
    /<reference\s+path=['"](\.[^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function resolveDeclarationSpecifier(importer, specifier) {
  if (specifier.endsWith('.js')) {
    return resolve(dirname(importer), `${specifier.slice(0, -3)}.d.ts`);
  }
  if (specifier.endsWith('.d.ts')) return resolve(dirname(importer), specifier);
  return resolve(dirname(importer), `${specifier}.d.ts`);
}

async function assertTypeBoundary() {
  const typeRoot = join(distDir, 'types');
  const allowedSourceDeclarations = new Set([
    'src/workflows/v3/artifact-contract.d.ts',
    'src/workflows/v3/artifact-contract-declarations.d.ts',
    'src/workflows/v3/core-control.d.ts',
    'src/workflows/v3/dag.d.ts',
    'src/workflows/v3/event-contract.d.ts',
    'src/workflows/v3/gate-policy.d.ts',
    'src/workflows/v3/host-bindings.d.ts',
    'src/workflows/v3/in-process-attempt-lease.d.ts',
    'src/workflows/v3/orchestrator.d.ts',
    'src/workflows/v3/portable-final-outputs.d.ts',
    'src/workflows/v3/portable-runtime.d.ts',
    'src/workflows/v3/runtime-host-contract.d.ts',
    'src/workflows/v3/shared-runtime.d.ts',
  ]);
  const unexpected = (await walk(typeRoot))
    .filter((file) => file.endsWith('.d.ts'))
    .map((file) => relative(typeRoot, file).replaceAll('\\', '/'))
    .filter((file) =>
      file.startsWith('src/') && !allowedSourceDeclarations.has(file)
    );
  if (unexpected.length > 0) {
    throw new Error(
      `workflow-core public declarations crossed the supported boundary:\n${unexpected.join('\n')}`,
    );
  }
}

async function assertExportTargetsExist() {
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf-8'));
  const targets = [];
  for (const value of Object.values(packageJson.exports)) {
    if (typeof value === 'string') continue;
    targets.push(value.types, value.import, value.require);
  }
  const files = new Set(await walk(distDir));
  const missing = targets
    .filter(Boolean)
    .map((target) => resolve(packageDir, target))
    .filter((target) => !files.has(target));
  if (missing.length > 0) {
    throw new Error(`workflow-core export target(s) missing:\n${missing.join('\n')}`);
  }
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
