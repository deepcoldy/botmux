#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Dashboard favicon is the canonical botmux product mark. Desktop icons are
// derived from it so the two surfaces cannot drift apart again.
const dashboardLogo = join(root, 'src', 'dashboard', 'web', 'favicon.png');
await render(dashboardLogo, 1024, join(root, 'build', 'icon.png'));
await renderTemplate(dashboardLogo, 22, join(root, 'src', 'desktop', 'assets', 'trayTemplate.png'));
await renderTemplate(dashboardLogo, 44, join(root, 'src', 'desktop', 'assets', 'trayTemplate@2x.png'));

async function render(source, size, destination) {
  const image = await loadImage(source);
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, canvas.toBuffer('image/png'));
}

async function renderTemplate(source, size, destination) {
  const image = await loadImage(source);
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, size, size);
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = '#000000';
  context.fillRect(0, 0, size, size);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, canvas.toBuffer('image/png'));
}
