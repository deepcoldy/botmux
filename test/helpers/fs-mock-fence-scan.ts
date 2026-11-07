/**
 * Finds test files that fake node:fs without importing the data-dir fence guard
 * (./require-fenced-data-dir.ts) as their FIRST import. See that helper for why.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const FS_MOCK_RE = /^\s*(?:vi\.mock|mock\.module)\(\s*['"](?:node:)?fs['"]/m;
const FIRST_IMPORT_RE = /^import\s[^;]*?['"]([^'"]+)['"]\s*;?/m;

export interface FsMockFenceViolation {
  file: string;
  reason: 'missing-guard' | 'guard-not-first';
}

export function checkFsMockFence(file: string, text: string): FsMockFenceViolation | undefined {
  if (!FS_MOCK_RE.test(text)) return undefined;
  const first = FIRST_IMPORT_RE.exec(text)?.[1];
  if (first && /\/helpers\/require-fenced-data-dir\.js$/.test(first)) return undefined;
  return { file, reason: text.includes('require-fenced-data-dir') ? 'guard-not-first' : 'missing-guard' };
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'fixtures' || name === 'helpers') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.ts$/.test(name)) out.push(full);
  }
}

export function scanRepoFsMockFence(repoRoot: string): FsMockFenceViolation[] {
  const files: string[] = [];
  walk(join(repoRoot, 'test'), files);
  return files
    .map(file => checkFsMockFence(relative(repoRoot, file), readFileSync(file, 'utf8')))
    .filter((v): v is FsMockFenceViolation => !!v);
}
