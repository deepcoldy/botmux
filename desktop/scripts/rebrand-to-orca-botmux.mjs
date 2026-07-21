#!/usr/bin/env node
/**
 * Product branding: Orca / Botmux display names → orca_botmux.
 * Does NOT rewrite internal runtime class names (OrcaRuntimeService) or
 * synthetic host prefixes (botmux:agent:) used by the bridge protocol.
 *
 * Usage: node scripts/rebrand-to-orca-botmux.mjs [--dry-run]
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
  'test-results'
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
  '.txt'
])

/** Product-facing renames only. Longer patterns first. */
const REPLACEMENTS = [
  // App ids / schemes already partially botmux
  [/com\.botmux\.desktop/g, 'com.orca_botmux.desktop'],
  [/com\.stablyai\.orca/g, 'com.orca_botmux.desktop'],
  // Pairing schemes stay functional; brand display uses orca_botmux
  // User-visible product names
  [/\bBotmux Desktop\b/g, 'orca_botmux'],
  [/\bOrca Desktop\b/g, 'orca_botmux'],
  [/\bWelcome to Botmux\b/g, 'Welcome to orca_botmux'],
  [/\bWelcome to Orca\b/g, 'Welcome to orca_botmux'],
  [/\bopen Botmux Desktop\b/g, 'open orca_botmux'],
  [/\bopen Orca Desktop\b/g, 'open orca_botmux'],
  [/\bOpen Orca Mobile\b/g, 'Open orca_botmux Mobile'],
  [/\bOpen Orca\b/g, 'Open orca_botmux'],
  [/\bOpen Botmux\b/g, 'Open orca_botmux'],
  // Quoted brand labels in UI / i18n
  [/"Botmux"/g, '"orca_botmux"'],
  [/'Botmux'/g, "'orca_botmux'"],
  [/"Orca"/g, '"orca_botmux"'],
  [/'Orca'/g, "'orca_botmux'"],
  // electron-builder productName assignment variants
  [/productName:\s*'Botmux'/g, "productName: 'orca_botmux'"],
  [/productName:\s*"Botmux"/g, 'productName: "orca_botmux"'],
  [/executableName:\s*'Botmux'/g, "executableName: 'orca_botmux'"],
  [/artifactName:\s*'botmux-/g, "artifactName: 'orca_botmux-"],
  [/artifactName:\s*'orca-linux/g, "artifactName: 'orca_botmux-linux"],
  [/artifactName:\s*'orca-ide/g, "artifactName: 'orca_botmux-ide"],
  // package description
  [/Botmux Desktop \(Orca-class IDE vendor import\)/g, 'orca_botmux Desktop'],
  // tray / i18n keys text fallbacks
  [/translateMain\('tray\.openOrca',\s*'Open Orca'\)/g, "translateMain('tray.openOrca', 'Open orca_botmux')"]
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
  if (file.endsWith('rebrand-to-orca-botmux.mjs')) continue
  if (file.endsWith('rebrand-from-orca.mjs')) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue

  let next = text
  let fileSubs = 0
  for (const [re, rep] of REPLACEMENTS) {
    const before = next
    next = next.replace(re, rep)
    if (next !== before) {
      const m = before.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))
      fileSubs += m ? m.length : 1
    }
  }

  // Restore critical false positives if any
  next = next.replace(/OrcaRuntimeorca_botmux/g, 'OrcaRuntime')
  next = next.replace(/orca_botmuxRuntimeService/g, 'OrcaRuntimeService')

  if (next !== text) {
    changedFiles++
    totalSubs += fileSubs
    const rel = relative(root, file)
    if (dryRun) console.log(`[dry-run] ${rel}`)
    else {
      writeFileSync(file, next)
      console.log(`updated ${rel}`)
    }
  }
}

console.log(
  dryRun
    ? `dry-run: ~${changedFiles} files`
    : `rebrand complete: ${changedFiles} files, ~${totalSubs} groups`
)
