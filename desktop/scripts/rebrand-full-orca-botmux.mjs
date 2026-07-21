#!/usr/bin/env node
/**
 * FULL rebrand: Orca / Botmux → orca_botmux (product + identifiers + paths).
 *
 * Content rules (order matters):
 *  1. Protect already-renamed orca_botmux / OrcaBotmux / orca-botmux
 *  2. Long compounds first
 *  3. Botmux → OrcaBotmux ; botmux → orca_botmux
 *  4. Remaining Orca product/runtime → OrcaBotmux / orca_botmux
 *  5. Restore accidental double prefixes
 *
 * File rename: *botmux* / *orca* (not already orca-botmux/orca_botmux) → *orca-botmux*
 *
 * Usage: node scripts/rebrand-full-orca-botmux.mjs [--dry-run] [--content-only] [--rename-only]
 */
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dryRun = process.argv.includes('--dry-run')
const contentOnly = process.argv.includes('--content-only')
const renameOnly = process.argv.includes('--rename-only')

const SKIP_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  '.smoke-user-data',
  '.build'
])

const TEXT_EXT = new Set([
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
  '.sh',
  '.svg',
  '.cmd'
])

const PROTECT = '___ORCA_BOTMUX_PROTECT___'
const PROTECT_PASCAL = '___ORCA_BOTMUX_PASCAL___'
const PROTECT_KEBAB = '___ORCA_BOTMUX_KEBAB___'
const PROTECT_CAMEL = '___ORCA_BOTMUX_CAMEL___'

/** Content replacements applied after protect step. */
const CONTENT_RULES = [
  // Already product-named strings
  [/com\.orca_botmux\.desktop/g, 'com.orca_botmux.desktop'],

  // Long Pascal compounds involving Botmux first
  [/\bBotmuxDesktop\b/g, 'OrcaBotmuxDesktop'],
  [/\bBotmuxBridge\b/g, 'OrcaBotmuxBridge'],
  [/\bBotmuxSession\b/g, 'OrcaBotmuxSession'],
  [/\bBotmuxSessions\b/g, 'OrcaBotmuxSessions'],
  [/\bBotmuxHost\b/g, 'OrcaBotmuxHost'],
  [/\bBotmuxOpen\b/g, 'OrcaBotmuxOpen'],
  [/\bBotmuxSsh\b/g, 'OrcaBotmuxSsh'],
  [/\bBotmuxAgent\b/g, 'OrcaBotmuxAgent'],
  [/\bBotmuxMain\b/g, 'OrcaBotmuxMain'],
  [/\bBotmuxTab\b/g, 'OrcaBotmuxTab'],
  [/\bBotmuxAsk\b/g, 'OrcaBotmuxAsk'],
  [/\bBotmuxControl\b/g, 'OrcaBotmuxControl'],
  [/\bBotmuxWorkspace\b/g, 'OrcaBotmuxWorkspace'],
  [/\bBotmuxAttach\b/g, 'OrcaBotmuxAttach'],
  [/\bBotmuxSurface\b/g, 'OrcaBotmuxSurface'],
  [/\bBotmuxSidebar\b/g, 'OrcaBotmuxSidebar'],
  [/\bBotmuxTerm\b/g, 'OrcaBotmuxTerm'],
  [/\bBotmux\b/g, 'OrcaBotmux'],

  // Long Orca compounds (runtime, profiles, …) before bare Orca
  [/\bOrcaRuntime\b/g, 'OrcaBotmuxRuntime'],
  [/\bOrcaProfile\b/g, 'OrcaBotmuxProfile'],
  [/\bOrcaProfiles\b/g, 'OrcaBotmuxProfiles'],
  [/\bOrcaCloud\b/g, 'OrcaBotmuxCloud'],
  [/\bOrcaUser\b/g, 'OrcaBotmuxUser'],
  [/\bOrcaHook\b/g, 'OrcaBotmuxHook'],
  [/\bOrcaCli\b/g, 'OrcaBotmuxCli'],
  [/\bOrcaDev\b/g, 'OrcaBotmuxDev'],
  [/\bOrcaApp\b/g, 'OrcaBotmuxApp'],
  [/\bOrcaPage\b/g, 'OrcaBotmuxPage'],
  [/\bOrcaServe\b/g, 'OrcaBotmuxServe'],
  [/\bOrcaIde\b/g, 'OrcaBotmuxIde'],
  [/\bOrcaComputer\b/g, 'OrcaBotmuxComputer'],
  [/\bOrcaNotification\b/g, 'OrcaBotmuxNotification'],
  [/\bOrcaCreated\b/g, 'OrcaBotmuxCreated'],
  [/\bOrcaManaged\b/g, 'OrcaBotmuxManaged'],
  [/\bOrcaLaunched\b/g, 'OrcaBotmuxLaunched'],
  [/\bOrcaConfig\b/g, 'OrcaBotmuxConfig'],
  [/\bOrcaData\b/g, 'OrcaBotmuxData'],
  [/\bOrcaStats\b/g, 'OrcaBotmuxStats'],
  [/\bOrcaLogo\b/g, 'OrcaBotmuxLogo'],
  [/\bOrcaAccount\b/g, 'OrcaBotmuxAccount'],
  [/\bOrca\b/g, 'OrcaBotmux'],

  // lowercase / snake / kebab for botmux
  [/\bbotmux-desktop-dev\b/g, 'orca-botmux-desktop-dev'],
  [/\bbotmux-desktop\b/g, 'orca-botmux-desktop'],
  [/\bbotmux-term-relay\b/g, 'orca-botmux-term-relay'],
  [/\bbotmux-bridge\b/g, 'orca-botmux-bridge'],
  [/\bbotmux-main-terminal-host\b/g, 'orca-botmux-main-terminal-host'],
  [/\bbotmux-open-guard\b/g, 'orca-botmux-open-guard'],
  [/\bbotmux-open-file-surface\b/g, 'orca-botmux-open-file-surface'],
  [/\bbotmux-session\b/g, 'orca-botmux-session'],
  [/\bbotmux-sessions\b/g, 'orca-botmux-sessions'],
  [/\bbotmux-sidebar\b/g, 'orca-botmux-sidebar'],
  [/\bbotmux-native\b/g, 'orca-botmux-native'],
  [/\bbotmux-workspace\b/g, 'orca-botmux-workspace'],
  [/\bbotmux-ssh\b/g, 'orca-botmux-ssh'],
  [/\bbotmux-cdp\b/g, 'orca-botmux-cdp'],
  [/\bbotmux\//g, 'orca_botmux/'],
  [/\bbotmux:/g, 'orca_botmux:'],
  [/\bbotmux_/g, 'orca_botmux_'],
  [/\bbotmux\./g, 'orca_botmux.'],
  [/\bbotmux-/g, 'orca-botmux-'],
  [/\bbotmux\b/g, 'orca_botmux'],

  // lowercase orca leftovers (not already orca_botmux / orca-botmux)
  [/\borca-desktop-dev\b/g, 'orca-botmux-desktop-dev'],
  [/\borca-dev\b/g, 'orca-botmux-dev'],
  [/\borca-cli\b/g, 'orca-botmux-cli'],
  [/\borca-ide\b/g, 'orca-botmux-ide'],
  [/\borca-runtime\b/g, 'orca-botmux-runtime'],
  [/\borca-profiles\b/g, 'orca-botmux-profiles'],
  [/\borca-profile\b/g, 'orca-botmux-profile'],
  [/\borca-hook\b/g, 'orca-botmux-hook'],
  [/\borca-app\b/g, 'orca-botmux-app'],
  [/\borca-data\b/g, 'orca-botmux-data'],
  [/\borca-stats\b/g, 'orca-botmux-stats'],
  [/\borca-notification\b/g, 'orca-botmux-notification'],
  [/\borca-computer\b/g, 'orca-botmux-computer'],
  [/\borca-linear\b/g, 'orca-botmux-linear'],
  [/\borca-emulator\b/g, 'orca-botmux-emulator'],
  [/\borca-per-workspace\b/g, 'orca-botmux-per-workspace'],
  [/\borca-menu\b/g, 'orca-botmux-menu'],
  [/\borca-blue\b/g, 'orca-botmux-blue'],
  [/\borca-watercolor\b/g, 'orca-botmux-watercolor'],
  [/\borca-logo\b/g, 'orca-botmux-logo'],
  [/\borca-account\b/g, 'orca-botmux-account'],
  [/\borca-e2ee\b/g, 'orca-botmux-e2ee'],
  [/\borca-config\b/g, 'orca-botmux-config'],
  [/\borca-browser\b/g, 'orca-botmux-browser'],
  [/orca:\/\//g, 'orca_botmux://'],
  [/protocol === 'orca:'/g, "protocol === 'orca_botmux:'"],
  [/protocol !== 'orca:'/g, "protocol !== 'orca_botmux:'"],
  [/'orca:'/g, "'orca_botmux:'"],
  [/"orca:"/g, '"orca_botmux:"'],
  [/\borca\//g, 'orca_botmux/'],
  [/\borca_/g, 'orca_botmux_'],
  [/\borca\./g, 'orca_botmux.'],
  [/\borca-/g, 'orca-botmux-'],
  [/\borca\b/g, 'orca_botmux'],

  // camelCase leftovers
  [/\borcaProfiles\b/g, 'orcaBotmuxProfiles'],
  [/\borcaProfile\b/g, 'orcaBotmuxProfile'],
  [/\borcaRuntime\b/g, 'orcaBotmuxRuntime'],
  [/\borcaApp\b/g, 'orcaBotmuxApp'],
  [/\borcaPage\b/g, 'orcaBotmuxPage'],
  [/\bbotmuxBridge\b/g, 'orcaBotmuxBridge'],
  [/\bbotmuxSurface\b/g, 'orcaBotmuxSurface'],
  [/\bbotmuxSession\b/g, 'orcaBotmuxSession'],
  [/\bbotmuxHost\b/g, 'orcaBotmuxHost'],
  [/\bbotmuxOpen\b/g, 'orcaBotmuxOpen']
]

function walkFiles(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(p, files)
    else files.push(p)
  }
  return files
}

function walkDirsDeepestFirst(dir, dirs = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkDirsDeepestFirst(p, dirs)
      dirs.push(p)
    }
  }
  return dirs
}

function isTextFile(file) {
  const base = file.split('/').pop() || ''
  if (base === 'electron-builder.config.cjs') return true
  const i = base.lastIndexOf('.')
  if (i < 0) return false
  return TEXT_EXT.has(base.slice(i))
}

function protectAlreadyRenamed(text) {
  return text
    .replace(/orca_botmux/g, PROTECT)
    .replace(/OrcaBotmux/g, PROTECT_PASCAL)
    .replace(/orca-botmux/g, PROTECT_KEBAB)
    .replace(/orcaBotmux/g, PROTECT_CAMEL)
}

function unprotect(text) {
  return text
    .replace(new RegExp(PROTECT, 'g'), 'orca_botmux')
    .replace(new RegExp(PROTECT_PASCAL, 'g'), 'OrcaBotmux')
    .replace(new RegExp(PROTECT_KEBAB, 'g'), 'orca-botmux')
    .replace(new RegExp(PROTECT_CAMEL, 'g'), 'orcaBotmux')
}

function fixDoublePrefixes(text) {
  let t = text
  // Collapse accidental doubles
  const pairs = [
    [/orca_botmux_botmux/g, 'orca_botmux'],
    [/orca-botmux-botmux/g, 'orca-botmux'],
    [/OrcaBotmuxBotmux/g, 'OrcaBotmux'],
    [/orcaBotmuxBotmux/g, 'orcaBotmux'],
    [/orca_botmux_orca_botmux/g, 'orca_botmux'],
    [/orca-botmux-orca-botmux/g, 'orca-botmux'],
    [/OrcaBotmuxOrcaBotmux/g, 'OrcaBotmux'],
    [/orca_botmux:orca_botmux:/g, 'orca_botmux:'],
    [/com\.orca_botmux\.orca_botmux/g, 'com.orca_botmux'],
    // orca_botmux_botmux from botmux after orca_ prefix
    [/ORCA_BOTMUX_BOTMUX/g, 'ORCA_BOTMUX'],
    [/BOTMUX_BOTMUX/g, 'BOTMUX'] // leave if any; cleaned later
  ]
  for (const [re, rep] of pairs) t = t.replace(re, rep)
  return t
}

function transformContent(text) {
  let next = protectAlreadyRenamed(text)
  for (const [re, rep] of CONTENT_RULES) {
    next = next.replace(re, rep)
  }
  next = unprotect(next)
  next = fixDoublePrefixes(next)
  return next
}

function transformPathSegment(name) {
  if (name.includes('orca-botmux') || name.includes('orca_botmux') || name.includes('OrcaBotmux')) {
    // still run botmux/orca remnants
  }
  let n = protectAlreadyRenamed(name)
  n = n
    .replace(/Botmux/g, 'OrcaBotmux')
    .replace(/botmux/g, 'orca-botmux')
    .replace(/Orca(?!Botmux)/g, 'OrcaBotmux')
    .replace(/(?<![a-zA-Z0-9_])orca(?!-botmux|_botmux)/g, 'orca-botmux')
  n = unprotect(n)
  n = n
    .replace(/orca-botmux-botmux/g, 'orca-botmux')
    .replace(/OrcaBotmuxBotmux/g, 'OrcaBotmux')
    .replace(/orca_botmux_botmux/g, 'orca_botmux')
  // Normalize mixed: orca-botmux_ → orca_botmux for some cases keep kebab for files
  return n
}

// ─── content ───────────────────────────────────────────────────────────
let contentFiles = 0
let contentSubs = 0

if (!renameOnly) {
  for (const file of walkFiles(root)) {
    if (file.includes('/scripts/rebrand-full-orca-botmux.mjs')) continue
    if (file.includes('/scripts/rebrand-to-orca-botmux.mjs')) continue
    if (file.includes('/scripts/rebrand-from-orca.mjs')) continue
    if (!isTextFile(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    const next = transformContent(text)
    if (next !== text) {
      contentFiles++
      // rough count
      contentSubs++
      const rel = relative(root, file)
      if (dryRun) console.log(`[content] ${rel}`)
      else {
        writeFileSync(file, next)
        console.log(`[content] ${rel}`)
      }
    }
  }
  console.log(
    dryRun
      ? `content dry-run: ~${contentFiles} files`
      : `content done: ${contentFiles} files touched`
  )
}

// ─── renames (files then dirs deepest-first) ───────────────────────────
function needsRename(name) {
  if (name.includes('orca-botmux') && !name.includes('botmux') && !/(^|[^a-z])orca([^a-z-]|$)/i.test(name.replace(/orca-botmux/g, ''))) {
    // may still have bare orca
  }
  const transformed = transformPathSegment(name)
  return transformed !== name
}

let renameCount = 0
if (!contentOnly) {
  // files first
  const files = walkFiles(root).sort((a, b) => b.length - a.length)
  for (const file of files) {
    const base = file.split('/').pop()
    if (!base || !needsRename(base)) continue
    // skip build artifacts binaries
    if (file.includes('/.build/')) continue
    const newBase = transformPathSegment(base)
    const dest = join(dirname(file), newBase)
    if (dest === file) continue
    if (existsSync(dest)) {
      console.warn(`[skip rename exists] ${relative(root, file)} -> ${newBase}`)
      continue
    }
    renameCount++
    if (dryRun) console.log(`[rename file] ${relative(root, file)} -> ${newBase}`)
    else {
      renameSync(file, dest)
      console.log(`[rename file] ${relative(root, file)} -> ${newBase}`)
    }
  }

  // directories deepest first
  const dirs = walkDirsDeepestFirst(root)
  for (const dir of dirs) {
    const base = dir.split('/').pop()
    if (!base || !needsRename(base)) continue
    const newBase = transformPathSegment(base)
    const dest = join(dirname(dir), newBase)
    if (dest === dir) continue
    if (existsSync(dest)) {
      console.warn(`[skip dir exists] ${relative(root, dir)} -> ${newBase}`)
      continue
    }
    renameCount++
    if (dryRun) console.log(`[rename dir] ${relative(root, dir)} -> ${newBase}`)
    else {
      try {
        mkdirSync(dirname(dest), { recursive: true })
        renameSync(dir, dest)
        console.log(`[rename dir] ${relative(root, dir)} -> ${newBase}`)
      } catch (e) {
        console.warn(`[rename dir fail] ${relative(root, dir)}: ${e.message}`)
      }
    }
  }
  console.log(dryRun ? `rename dry-run: ~${renameCount}` : `rename done: ${renameCount}`)
}

console.log('full rebrand finished')
