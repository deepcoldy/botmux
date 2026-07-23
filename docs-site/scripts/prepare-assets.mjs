#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardLogo = join(siteRoot, '..', 'src', 'dashboard', 'web', 'favicon.png');
const docsLogo = join(siteRoot, 'docs', 'public', 'botmux-logo.png');

await mkdir(dirname(docsLogo), { recursive: true });
await copyFile(dashboardLogo, docsLogo);
