#!/usr/bin/env node
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const webSrc = 'src/dashboard/web';
const outDir = 'dist/dashboard-web';
const watchMode = process.argv.includes('--watch') || process.argv.includes('-w') || process.env.BOTMUX_DASHBOARD_WATCH === '1';
const devMarker = join(outDir, '.botmux-dashboard-dev');
const reloadMarker = join(outDir, '.botmux-dashboard-reload');

async function ensureDevReloadMarkers() {
  await mkdir(outDir, { recursive: true });
  await writeFile(devMarker, `pid=${process.pid}\n`);
  if (!existsSync(reloadMarker)) {
    await writeFile(reloadMarker, `${Date.now()}\n`);
  }
}

async function bumpDevReload() {
  await ensureDevReloadMarkers();
  await writeFile(reloadMarker, `${Date.now()}\n`);
}

async function copyIfExists(from, to, options = {}) {
  if (!existsSync(from)) return;
  await cp(from, to, options);
}

async function copyStatic() {
  await Promise.all([
    cp(join(webSrc, 'index.html'), join(outDir, 'index.html')),
    cp(join(webSrc, 'style.css'), join(outDir, 'style.css')),
    cp(join(webSrc, 'brand-logo.png'), join(outDir, 'brand-logo.png')),
    cp(join(webSrc, 'favicon.png'), join(outDir, 'favicon.png')),
    cp(join(webSrc, 'apple-touch-icon.png'), join(outDir, 'apple-touch-icon.png')),
    cp(join(webSrc, 'terminal-replay.html'), join(outDir, 'terminal-replay.html')),
    copyIfExists(join(webSrc, 'skins'), join(outDir, 'skins'), { recursive: true }),
    copyIfExists(join(webSrc, 'game'), join(outDir, 'game'), { recursive: true }),
  ]);
}

async function buildDashboard({ clean = false } = {}) {
  if (clean) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: { app: join(webSrc, 'app.tsx') },
    bundle: true,
    outdir: outDir,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    minify: !watchMode,
    sourcemap: watchMode ? 'inline' : false,
    target: 'es2022',
    logLevel: 'info',
  });
  await copyStatic();
  if (watchMode) {
    await bumpDevReload();
  }
}

async function listDirs(root) {
  const out = [root];
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    out.push(...await listDirs(join(root, entry.name)));
  }
  return out;
}

async function startWatcher(onChange) {
  const watchers = [];
  for (const dir of await listDirs(webSrc)) {
    watchers.push(watch(dir, { persistent: true }, (_event, filename) => {
      if (filename && String(filename).startsWith('.')) return;
      onChange();
    }));
  }
  return () => {
    for (const w of watchers) w.close();
  };
}

if (!watchMode) {
  await buildDashboard({ clean: true });
} else {
  let timer;
  let building = false;
  let pending = false;

  async function rebuild(reason = 'initial') {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      const started = Date.now();
      await buildDashboard({ clean: reason === 'initial' });
      console.log(`[dashboard:watch] built ${reason} in ${Date.now() - started}ms`);
    } catch (err) {
      console.error('[dashboard:watch] build failed');
      console.error(err);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild('pending-change');
      }
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild('change'), 120);
  };

  await rebuild('initial');
  const closeWatchers = await startWatcher(schedule);
  console.log('[dashboard:watch] watching src/dashboard/web');
  const markerTimer = setInterval(() => {
    void ensureDevReloadMarkers().catch((err) => {
      console.error('[dashboard:watch] failed to refresh dev marker');
      console.error(err);
    });
  }, 1000);
  markerTimer.unref?.();

  const stop = () => {
    clearInterval(markerTimer);
    closeWatchers();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
}
