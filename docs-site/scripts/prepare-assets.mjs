#!/usr/bin/env node
// Populate docs/public before rspress builds: that directory is rspress's public
// root (`root: 'docs'` in rspress.config.ts) and is gitignored, so anything the
// docs reference as `/…` has to be copied in here first.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardLogo = join(siteRoot, '..', 'src', 'dashboard', 'web', 'favicon.png');
const docsLogo = join(siteRoot, 'docs', 'public', 'botmux-logo.png');

await mkdir(dirname(docsLogo), { recursive: true });
await copyFile(dashboardLogo, docsLogo);

// Screenshots live in static/img/ (committed), but a doc referencing
// `/img/foo.png` makes rspress look in docs/public/img/ — and with
// `checkDeadLinks` on, a missing one fails the whole build, which is what took
// docs-deploy red for every run since #1194. Copy the directory wholesale so
// adding a screenshot never needs this script touched again.
const imgFrom = join(siteRoot, 'static', 'img');
const imgTo = join(siteRoot, 'docs', 'public', 'img');
await mkdir(imgTo, { recursive: true });
// Tolerate the directory being absent rather than failing the prebuild: a build
// with no screenshots at all is legitimate, and rspress's own checkDeadLinks is
// what must complain about an image a doc actually references.
let entries = [];
try {
  entries = await readdir(imgFrom, { withFileTypes: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const entry of entries) {
  if (entry.isFile()) await copyFile(join(imgFrom, entry.name), join(imgTo, entry.name));
}
