#!/usr/bin/env node
/**
 * Mechanical product rebrand for the Orca vendor tree → Botmux Desktop.
 * Safe rules only: does NOT rename OrcaRuntimeService / orca-runtime file paths.
 *
 * Usage: node scripts/rebrand-from-orca.mjs [--dry-run]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dryRun = process.argv.includes('--dry-run')

const SKIP_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
])

const EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.yml',
  '.yaml',
  '.plist',
  '.txt',
])

/** Ordered replacements — longer / more specific first. */
const REPLACEMENTS = [
  // Pairing / deep links
  [/orca:\/\/pair/g, 'botmux://pair'],
  [/orca:\/\/pairing/g, 'botmux://pairing'],
  [/orca:\/\//g, 'botmux://'],
  [/protocol !== 'orca:'/g, "protocol !== 'botmux:'"],
  [/protocol === 'orca:'/g, "protocol === 'botmux:'"],
  [/'orca:'/g, "'botmux:'"],
  [/"orca:"/g, '"botmux:"'],
  // App ids / schemes already partially done — catch stragglers
  [/com\.stablyai\.orca/g, 'com.botmux.desktop'],
  // User-visible product name (avoid class OrcaRuntime*)
  [/\bOrca Desktop\b/g, 'Botmux Desktop'],
  [/\bWelcome to Orca\b/g, 'Welcome to Botmux'],
  [/\bopen Orca Desktop\b/g, 'open Botmux Desktop'],
  // i18n / short brand labels that are exact "Orca"
  [/"Orca"/g, '"Botmux"'],
  [/'Orca'/g, "'Botmux'"],
  // Docs / shell paths
  [/orca-dev/g, 'botmux-desktop-dev'],
  // CLI bin references in scripts/docs (keep code paths that still ship as orca-dev.mjs for now)
  [/\borca serve\b/g, 'botmux-desktop serve'],
]

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, files)
    else {
      const ext = name.includes('.') ? `.${name.split('.').pop()}` : ''
      if (EXT.has(ext) || name === 'electron-builder.config.cjs') files.push(p)
    }
  }
  return files
}

let changedFiles = 0
let totalSubs = 0

for (const file of walk(root)) {
  // Skip this script
  if (file.endsWith('rebrand-from-orca.mjs')) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  // Skip binary-looking
  if (text.includes('\0')) continue

  let next = text
  let fileSubs = 0
  for (const [re, rep] of REPLACEMENTS) {
    const before = next
    next = next.replace(re, rep)
    if (next !== before) {
      const m = before.match(re)
      fileSubs += m ? m.length : 1
    }
  }

  // Restore false positives: class/file identifiers we must keep
  // (OrcaRuntime*, orca-runtime paths in imports — if we only replaced word Orca in quotes we're fine)
  // If someone had "OrcaRuntime" as product string it's rare; class names use no quotes usually.

  if (next !== text) {
    changedFiles++
    totalSubs += fileSubs
    const rel = relative(root, file)
    if (dryRun) {
      console.log(`[dry-run] would update ${rel}`)
    } else {
      writeFileSync(file, next)
      console.log(`updated ${rel}`)
    }
  }
}

console.log(
  dryRun
    ? `dry-run complete: ~${changedFiles} files would change`
    : `rebrand complete: ${changedFiles} files, ~${totalSubs} substitution groups`
)
