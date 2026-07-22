#!/usr/bin/env node
/**
 * Inventory-driven product brand residue gate.
 *
 * Fails if product-facing Orca / orca_botmux branding reappears.
 * Allowed exceptions (not scanned / allowlisted):
 *   - NOTICE, LICENSE, LICENSE.md
 *   - This gate file and rebrand tooling scripts
 *
 * Exit 0 = clean; exit 1 = residue.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Broad product patterns (would catch preamble snapshot, packaging, skills, i18n).
const contentPatterns = [
  // Transitional brand
  'orca_botmux',
  'OrcaBotmux',
  'orca-botmux',
  // Runtime / packaging product names
  'OrcaRuntime',
  'OrcaCliLauncher',
  'OrcaComputerUse',
  'orca-botmux-desktop',
  'orca-mobile',
  'com\\.stably\\.orca',
  'com\\.orca_botmux',
  // Schemes / mint
  'orca_botmux://',
  'return `orca://',
  'return `orca_botmux://',
  // Env
  '\\bORCA_',
  '__ORCA_',
  'DEFAULT_LOCAL_ORCA',
  // Packaging binaries / paths
  'MacOS/Orca\\b',
  'Contents/MacOS/Orca',
  'Orca\\.exe',
  'Orca\\.app',
  // User-facing product phrases (preamble / CLI / UI)
  'inside Orca',
  'You are working inside Orca',
  'orca orchestration',
  'Orca is not running',
  'the Orca CLI',
  'Orca CLI',
  'Orca Desktop',
  'Welcome to Orca',
  'onOrca\\.dev',
  'onorca\\.dev',
  '@orca_build',
  'stablyai/orca',
  'github\\.com/stablyai/orca',
  // UI / skill tokens
  'OrcaIDE',
  'OrcaId\\b',
  'OrcaID\\b',
  'SCHEME = "Orca"',
  "SCHEME = 'Orca'",
  'Get-Orca',
  'Send-Orca',
  'installRemoteOrca',
  'openInOrca',
  'InOrca',
  'localOrca',
  'runtimeOrca',
  'isRestartingOrca'
]

const globs = [
  '--glob', '!**/node_modules/**',
  '--glob', '!**/out/**',
  '--glob', '!**/dist/**',
  '--glob', '!**/Pods/**',
  '--glob', '!**/pnpm-lock.yaml',
  '--glob', '!**/.git/**',
  '--glob', '!**/NOTICE',
  '--glob', '!**/LICENSE',
  '--glob', '!**/LICENSE.md',
  '--glob', '!**/rebrand-full-botmux.mjs',
  '--glob', '!**/rebrand-to-botmux.mjs',
  '--glob', '!**/rebrand-from-botmux.mjs',
  '--glob', '!**/rebrand-to-botmux-final.mjs',
  '--glob', '!**/check-botmux-brand-gate.mjs',
  '--glob', '!**/docs/branding.md',
  '--glob', '!**/.build/**'
]

const args = [
  '-n',
  ...globs,
  ...contentPatterns.flatMap((p) => ['-e', p]),
  'desktop',
  'mobile',
  'docs',
  'scripts'
]

const result = spawnSync('rg', args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
})

const contentHits = (result.status === 0 ? result.stdout || '' : '').trim()

// Filename residue
const badNameRe = /orca-botmux|orca_botmux|OrcaBotmux|OrcaRuntime|orca-mobile|OrcaCliLauncher|OrcaComputerUse/i
const skipDir = new Set(['node_modules', 'out', 'dist', '.git', 'Pods', '.build', 'coverage'])
const badPaths = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (skipDir.has(name)) continue
    if (name === 'NOTICE' || name === 'LICENSE' || name === 'LICENSE.md') continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    const rel = relative(root, p)
    if (badNameRe.test(name)) {
      if (!rel.includes('check-botmux-brand-gate') && !rel.includes('rebrand-to-botmux-final')) {
        badPaths.push(rel)
      }
    }
    if (st.isDirectory()) walk(p)
  }
}

for (const top of ['desktop', 'mobile', 'docs', 'scripts']) {
  const p = join(root, top)
  if (existsSync(p)) walk(p)
}

const contentBad = Boolean(contentHits.trim())
const pathBad = badPaths.length > 0

if (!contentBad && !pathBad) {
  console.log('brand-gate: clean (no product Orca residue)')
  process.exit(0)
}

console.error('brand-gate: product Orca residue found:\n')
if (contentBad) {
  console.error('--- content ---')
  console.error(contentHits)
}
if (pathBad) {
  console.error('--- paths/filenames ---')
  for (const p of badPaths.slice(0, 200)) console.error(p)
  if (badPaths.length > 200) console.error(`… and ${badPaths.length - 200} more`)
}
process.exit(1)
