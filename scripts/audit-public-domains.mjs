#!/usr/bin/env node

/**
 * Keep private deployment hostnames out of the public repository and package.
 * Riff is a documented, intentional public integration; every other
 * Other corporate deployment hostnames must be supplied at runtime instead
 * of committed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['src', 'test', 'scripts', 'docs', 'docs-site', '.github'];
const rootFiles = ['README.md', 'README.en.md', 'package.json'];
const textExtensions = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.html', '.css', '.sh', '.kdl',
]);
const allowedHosts = new Set([
  // Documented public integrations (keep intentional).
  'riff.bytedance.net',
  'riff-infra-boe.bytedance.net',
  'code.byted.org',
  'tosv.byted.org',
]);
// Require at least one label so bare corporate TLD mentions in assertions/comments
// do not trip the gate; catch accidental private subdomains under either suffix.
const hostnamePattern = /\b(?:[a-z0-9-]+\.)+(?:bytedance\.net|byted\.org)\b/gi;
const allowedHostSuffixes = [
  '.ai-sandbox-boe.byted.org',
];
const generatedDirectories = new Set(['node_modules', 'dist', 'doc_build']);
const selfPath = fileURLToPath(import.meta.url);

function* walk(path) {
  const stats = statSync(path);
  if (stats.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (generatedDirectories.has(entry.name) || entry.name === '.git') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) yield child;
  }
}

const files = [
  ...rootFiles.map(file => join(repoRoot, file)),
  ...roots.flatMap(root => [...walk(join(repoRoot, root))]),
].filter(file => resolve(file) !== selfPath);
const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(hostnamePattern)) {
    const hostname = match[0].toLowerCase();
    if (allowedHosts.has(hostname)) continue;
    if (allowedHostSuffixes.some(suffix => hostname.endsWith(suffix))) continue;
    const line = source.slice(0, match.index).split('\n').length;
    violations.push(`${relative(repoRoot, file)}:${line}: ${hostname}`);
  }
}

if (violations.length > 0) {
  throw new Error(
    `private deployment hostname(s) found; inject them at runtime:\n${violations.map(v => `- ${v}`).join('\n')}`,
  );
}
console.log('[domain-audit] no private deployment hostnames found');
