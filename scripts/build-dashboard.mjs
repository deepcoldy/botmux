#!/usr/bin/env node
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const webSrc = 'src/dashboard/web';
const outDir = 'dist/dashboard-web';

async function copyIfExists(from, to, options = {}) {
  if (!existsSync(from)) return;
  await cp(from, to, options);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: { app: join(webSrc, 'app.ts') },
  bundle: true,
  outdir: outDir,
  platform: 'browser',
  format: 'esm',
  splitting: true,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  minify: true,
  sourcemap: false,
  target: 'es2022',
  logLevel: 'info',
});

await Promise.all([
  cp(join(webSrc, 'index.html'), join(outDir, 'index.html')),
  cp(join(webSrc, 'style.css'), join(outDir, 'style.css')),
  cp(join(webSrc, 'favicon.png'), join(outDir, 'favicon.png')),
  cp(join(webSrc, 'apple-touch-icon.png'), join(outDir, 'apple-touch-icon.png')),
  cp(join(webSrc, 'terminal-replay.html'), join(outDir, 'terminal-replay.html')),
  copyIfExists(join(webSrc, 'skins'), join(outDir, 'skins'), { recursive: true }),
  copyIfExists(join(webSrc, 'game'), join(outDir, 'game'), { recursive: true }),
]);
