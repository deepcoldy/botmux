#!/usr/bin/env node
/**
 * Final product rebrand → Botmux / botmux-desktop / botmux-mobile.
 * Does NOT touch NOTICE/LICENSE legal attribution files by default.
 *
 * Usage: node scripts/rebrand-to-botmux-final.mjs [--dry-run] [--root desktop|mobile|.]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const dryRun = process.argv.includes('--dry-run')
const rootArg = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length)
const scanRoots = rootArg
  ? [join(repoRoot, rootArg === '.' ? '' : rootArg)].filter(Boolean)
  : [join(repoRoot, 'desktop'), join(repoRoot, 'mobile'), join(repoRoot, 'docs'), join(repoRoot, 'scripts')]

const SKIP_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'Pods',
  'build',
  'DerivedData',
  '.expo',
  'ios' // generated; mobile source of truth is app.json
])

const SKIP_FILES = new Set(['NOTICE', 'LICENSE', 'LICENSE.md'])

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
  '.swift',
  '.kt',
  '.gradle',
  '.rb',
  '.sh',
  '.cmd',
  '.svg'
])

/** Longer / more specific first. */
const REPLACEMENTS = [
  // packages / bins / ids
  [/orca-botmux-desktop-dev/g, 'botmux-desktop-dev'],
  [/orca-botmux-desktop/g, 'botmux-desktop'],
  [/orca-botmux-ide/g, 'botmux-ide'],
  [/orca-botmux-term-relay/g, 'botmux-term-relay'],
  [/orca-botmux-notification-status/g, 'botmux-notification-status'],
  [/orca-botmux-cli/g, 'botmux-cli'],
  [/orca-botmux-linear/g, 'botmux-linear'],
  [/orca-botmux-serve/g, 'botmux-serve'],
  [/orca-botmux-vm/g, 'botmux-vm'],
  [/orca-botmux-recipe/g, 'botmux-recipe'],
  [/orca-botmux-emulator/g, 'botmux-emulator'],
  [/orca-botmux-base/g, 'botmux-base'],
  [/orca-botmux-built/g, 'botmux-built'],
  [/orca-botmux-pairing/g, 'botmux-pairing'],
  [/orca-botmux-per-workspace/g, 'botmux-per-workspace'],
  [/orca-botmux-docker/g, 'botmux-docker'],
  [/orca-botmux-browser/g, 'botmux-browser'],
  [/orca-botmux-computer/g, 'botmux-computer'],
  [/orca-botmux-format/g, 'botmux-format'],
  [/orca-botmux-agent/g, 'botmux-agent'],
  [/orca-botmux-data/g, 'botmux-data'],
  [/orca-botmux-user-data/g, 'botmux-user-data'],
  [/orca-botmux-hook/g, 'botmux-hook'],
  [/orca-botmux-status/g, 'botmux-status'],
  [/orca-botmux-env/g, 'botmux-env'],
  [/orca-botmux-test/g, 'botmux-test'],
  [/orca-botmux-worktree/g, 'botmux-worktree'],
  [/orca-botmux-runtime/g, 'botmux-runtime'],
  [/orca-botmux-profiles/g, 'botmux-profiles'],
  [/orca-botmux-bridge/g, 'botmux-bridge'],
  [/orca-botmux-startup/g, 'botmux-startup'],
  [/orca-botmux-yaml/g, 'botmux-yaml'],
  [/orca-botmux-shim/g, 'botmux-shim'],
  [/orca-botmux-server/g, 'botmux-server'],
  [/orca-botmux-main/g, 'botmux-main'],
  [/orca-botmux-dev/g, 'botmux-dev'],
  [/com\.orca_botmux\.desktop/g, 'com.botmux.desktop'],
  [/com\.stably\.orca\.mobile/g, 'com.botmux.mobile'],
  [/com\.stablyai\.orca/g, 'com.botmux.desktop'],
  [/com\.stably\.orca/g, 'com.botmux'],

  // symbols — long forms first
  [/OrcaRuntimeService/g, 'BotmuxRuntimeService'],
  [/OrcaRuntimeRpcServer/g, 'BotmuxRuntimeRpcServer'],
  [/OrcaRuntime/g, 'BotmuxRuntime'],
  [/orcaBotmuxBridge/g, 'botmuxBridge'],
  [/orcaBotmuxProfiles/g, 'botmuxProfiles'],
  [/OrcaBotmuxBridge/g, 'BotmuxBridge'],
  [/OrcaBotmux/g, 'Botmux'],
  [/orcaBotmux/g, 'botmux'],

  // profiles / cloud types
  [/CreateLocalOrcaProfile/g, 'CreateLocalBotmuxProfile'],
  [/CreateCloudLinkedOrcaProfile/g, 'CreateCloudLinkedBotmuxProfile'],
  [/ConnectCurrentOrcaProfile/g, 'ConnectCurrentBotmuxProfile'],
  [/FindOrcaProfile/g, 'FindBotmuxProfile'],
  [/RefreshCurrentOrcaProfile/g, 'RefreshCurrentBotmuxProfile'],
  [/SelectOrcaProfile/g, 'SelectBotmuxProfile'],
  [/SignOutCurrentOrcaProfile/g, 'SignOutCurrentBotmuxProfile'],
  [/SwitchOrcaProfile/g, 'SwitchBotmuxProfile'],
  [/TransferOrcaProfile/g, 'TransferBotmuxProfile'],
  [/OrcaProfile/g, 'BotmuxProfile'],
  [/OrcaCloud/g, 'BotmuxCloud'],
  [/OrcaOrg/g, 'BotmuxOrg'],
  [/OrcaHooks/g, 'BotmuxHooks'],
  [/OrcaDefaultTabTemplate/g, 'BotmuxDefaultTabTemplate'],
  [/OrcaVmRecipe/g, 'BotmuxVmRecipe'],
  [/OrcaWorkspaceLayout/g, 'BotmuxWorkspaceLayout'],
  [/OrcaLogo/g, 'BotmuxLogo'],
  [/ensureActiveOrcaProfile/g, 'ensureActiveBotmuxProfile'],
  [/initOrcaProfilePaths/g, 'initBotmuxProfilePaths'],
  [/getOrcaCloudAuthConfig/g, 'getBotmuxCloudAuthConfig'],
  [/configureOrcaUserDataPathEnv/g, 'configureBotmuxUserDataPathEnv'],
  [/installLinuxBareOrcaDispatcher/g, 'installLinuxBareBotmuxDispatcher'],
  [/canRenameOrcaCreatedBranch/g, 'canRenameBotmuxCreatedBranch'],
  [/registerOrcaBotmuxBridgeIpc/g, 'registerBotmuxBridgeIpc'],
  [/linux-bare-orca-botmux/g, 'linux-bare-botmux'],

  // schemes / urls / files
  [/orca_botmux:\/\/pair/g, 'botmux://pair'],
  [/orca_botmux:\/\//g, 'botmux://'],
  [/orca:\/\/pair/g, 'botmux://pair'],
  [/orca:\/\//g, 'botmux://'],
  [/['"]orca_botmux:['"]/g, (m) => m.replace('orca_botmux:', 'botmux:')],
  [/['"]orca:['"]/g, (m) => m.replace('orca:', 'botmux:')],
  [/orca_botmux\.yaml/g, 'botmux.yaml'],
  [/\.orca_botmux\b/g, '.botmux'],
  [/orca_botmux_dashboard_token/g, 'botmux_dashboard_token'],
  [/orca_botmux_telemetry/g, 'botmux_telemetry'],
  [/orca_botmux/g, 'botmux'],

  // kebab leftovers
  [/orca-botmux/g, 'botmux'],
  [/orca-mobile/g, 'botmux-mobile'],
  [/@orca\//g, '@botmux/'],

  // env
  [/\bORCA_/g, 'BOTMUX_'],

  // product strings
  [/\bOrca Desktop\b/g, 'Botmux'],
  [/\bWelcome to Orca\b/g, 'Welcome to Botmux'],
  [/\bopen Botmux\b/g, 'open Botmux'],
  [/Allow Orca to /g, 'Allow Botmux to '],
  [/Orca connects to/g, 'Botmux connects to'],
  [/"name": "Orca"/g, '"name": "Botmux"'],
  [/"slug": "orca-mobile"/g, '"slug": "botmux-mobile"'],
  [/"scheme": "orca"/g, '"scheme": "botmux"'],
  [/orca-dev\b/g, 'botmux-desktop-dev'],
  [/\borca serve\b/g, 'botmux-desktop serve'],

  // storage keys mobile
  [/"orca:hosts"/g, '"botmux:hosts"'],
  [/'orca:hosts'/g, "'botmux:hosts'"],
  [/orca:home-snapshot/g, 'botmux:home-snapshot'],
  [/orca:pushNotifications/g, 'botmux:pushNotifications'],
  [/"orca:/g, '"botmux:'],
  [/'orca:/g, "'botmux:"],

  // executable productName leftovers
  [/productName: 'orca_botmux'/g, "productName: 'Botmux'"],
  [/productName: "orca_botmux"/g, 'productName: "Botmux"'],
  [/executableName: 'orca_botmux'/g, "executableName: 'botmux'"],
  [/executableName: "orca_botmux"/g, 'executableName: "botmux"'],
  [/StartupWMClass: 'orca_botmux'/g, "StartupWMClass: 'Botmux'"],

  // Computer Use helper display
  [/OrcaBotmux Computer Use/g, 'Botmux Computer Use'],
  [/Botmux Computer Use/g, 'Botmux Computer Use'], // no-op guard if already done

  // generic word Orca as product (quoted labels) — careful, after OrcaRuntime etc.
  [/"Orca"/g, '"Botmux"'],
  [/'Orca'/g, "'Botmux'"],
  [/\bOrca\b/g, 'Botmux']
]

const LEGAL_NAME = /NOTICE|LICENSE/

function walk(dir, files = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    if (LEGAL_NAME.test(name) && SKIP_FILES.has(name)) continue
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
      if (
        EXT.has(ext) ||
        name === 'electron-builder.config.cjs' ||
        name.endsWith('.config.cjs') ||
        name.endsWith('.config.ts')
      ) {
        // Skip legal attribution content files
        if (name === 'NOTICE' || name === 'LICENSE' || name === 'LICENSE.md') continue
        files.push(p)
      }
    }
  }
  return files
}

let changedFiles = 0
let totalSubs = 0

for (const root of scanRoots) {
  if (!existsSync(root)) continue
  for (const file of walk(root)) {
    // Don't rewrite this script or reverse-rebrand scripts content mid-flight incorrectly
    if (file.includes('rebrand-to-botmux-final.mjs')) continue
    if (file.includes('rebrand-full-orca-botmux.mjs')) continue
    if (file.includes('rebrand-to-orca-botmux.mjs')) continue

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

    if (next !== text) {
      changedFiles++
      totalSubs += fileSubs
      const rel = relative(repoRoot, file)
      if (dryRun) {
        console.log(`[dry-run] ${rel} (~${fileSubs})`)
      } else {
        writeFileSync(file, next)
        console.log(`updated ${rel}`)
      }
    }
  }
}

// Directory / file renames (post content rewrite so imports already say botmux-*)
const RENAMES = [
  // desktop runtime
  ['desktop/src/main/runtime/orca-botmux-runtime.ts', 'desktop/src/main/runtime/botmux-runtime.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime.test.ts', 'desktop/src/main/runtime/botmux-runtime.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-automations.test.ts', 'desktop/src/main/runtime/botmux-runtime-automations.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-browser.ts', 'desktop/src/main/runtime/botmux-runtime-browser.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-browser.test.ts', 'desktop/src/main/runtime/botmux-runtime-browser.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-emulator.ts', 'desktop/src/main/runtime/botmux-runtime-emulator.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-files.ts', 'desktop/src/main/runtime/botmux-runtime-files.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-files.test.ts', 'desktop/src/main/runtime/botmux-runtime-files.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-files-watch.test.ts', 'desktop/src/main/runtime/botmux-runtime-files-watch.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-git.ts', 'desktop/src/main/runtime/botmux-runtime-git.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-git.test.ts', 'desktop/src/main/runtime/botmux-runtime-git.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-path-candidate-history.test.ts', 'desktop/src/main/runtime/botmux-runtime-path-candidate-history.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-tail-wait-memo.test.ts', 'desktop/src/main/runtime/botmux-runtime-tail-wait-memo.test.ts'],
  ['desktop/src/main/runtime/orca-botmux-runtime-terminal-cwd.test.ts', 'desktop/src/main/runtime/botmux-runtime-terminal-cwd.test.ts'],
  // dirs last via recursive rename of known trees
  ['desktop/src/main/orca-botmux-bridge', 'desktop/src/main/botmux-bridge'],
  ['desktop/src/main/orca-botmux-profiles', 'desktop/src/main/botmux-profiles'],
  ['desktop/src/shared/orca-botmux-profiles.ts', 'desktop/src/shared/botmux-profiles.ts'],
  ['desktop/src/shared/orca-botmux-main-terminal-host.ts', 'desktop/src/shared/botmux-main-terminal-host.ts'],
  ['desktop/src/renderer/src/store/slices/orca-botmux-profiles.ts', 'desktop/src/renderer/src/store/slices/botmux-profiles.ts'],
  ['desktop/src/renderer/src/store/slices/orca-botmux-profiles-auth-actions.ts', 'desktop/src/renderer/src/store/slices/botmux-profiles-auth-actions.ts'],
  ['desktop/src/renderer/src/components/orca-botmux', 'desktop/src/renderer/src/components/botmux'],
  ['desktop/config/scripts/orca-botmux-dev.mjs', 'desktop/config/scripts/botmux-dev.mjs'],
  ['mobile/src/components/OrcaLogo.tsx', 'mobile/src/components/BotmuxLogo.tsx'],
  ['mobile/packages/expo-two-way-audio', 'mobile/packages/expo-two-way-audio'] // package.json name fixed by content
]

function renamePath(fromRel, toRel) {
  const from = join(repoRoot, fromRel)
  const to = join(repoRoot, toRel)
  if (!existsSync(from)) {
    console.log(`[skip-missing] ${fromRel}`)
    return
  }
  if (existsSync(to)) {
    console.log(`[skip-exists] ${toRel}`)
    return
  }
  if (dryRun) {
    console.log(`[dry-run rename] ${fromRel} → ${toRel}`)
    return
  }
  // ensure parent
  const parent = dirname(to)
  // recursive mkdir not imported — parents should exist
  renameSync(from, to)
  console.log(`renamed ${fromRel} → ${toRel}`)
}

// Also rename any remaining orca-botmux* files under desktop/src
function walkRename(dir, pred) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      walkRename(p, pred)
      // rename dir after children
      if (/orca-botmux|OrcaBotmux|orca_botmux|OrcaLogo|orca-botmux/.test(name)) {
        const nextName = name
          .replace(/orca-botmux/g, 'botmux')
          .replace(/OrcaBotmux/g, 'Botmux')
          .replace(/orca_botmux/g, 'botmux')
          .replace(/OrcaLogo/g, 'BotmuxLogo')
        if (nextName !== name) {
          const dest = join(dir, nextName)
          if (!existsSync(dest)) {
            if (dryRun) console.log(`[dry-run rename-dir] ${relative(repoRoot, p)} → ${nextName}`)
            else {
              renameSync(p, dest)
              console.log(`renamed-dir ${relative(repoRoot, p)} → ${nextName}`)
            }
          }
        }
      }
    } else if (/orca-botmux|OrcaBotmux|orca_botmux|OrcaLogo|OrcaRuntime|open-orca|sync-orca|ensure-orca|load-orca/.test(name)) {
      const nextName = name
        .replace(/orca-botmux/g, 'botmux')
        .replace(/OrcaBotmux/g, 'Botmux')
        .replace(/orca_botmux/g, 'botmux')
        .replace(/OrcaLogo/g, 'BotmuxLogo')
        .replace(/OrcaRuntime/g, 'BotmuxRuntime')
        .replace(/open-orca/g, 'open-botmux')
        .replace(/sync-orca/g, 'sync-botmux')
        .replace(/ensure-orca/g, 'ensure-botmux')
        .replace(/load-orca/g, 'load-botmux')
      if (nextName !== name) {
        const dest = join(dir, nextName)
        if (!existsSync(dest)) {
          if (dryRun) console.log(`[dry-run rename-file] ${relative(repoRoot, p)} → ${nextName}`)
          else {
            renameSync(p, dest)
            console.log(`renamed-file ${relative(repoRoot, p)} → ${nextName}`)
          }
        }
      }
    }
  }
}

for (const [from, to] of RENAMES) {
  renamePath(from, to)
}

if (!dryRun) {
  walkRename(join(repoRoot, 'desktop/src'), () => true)
  walkRename(join(repoRoot, 'desktop/config'), () => true)
  walkRename(join(repoRoot, 'desktop/scripts'), () => true)
  walkRename(join(repoRoot, 'mobile/src'), () => true)
  walkRename(join(repoRoot, 'mobile/app'), () => true)
}

console.log(
  dryRun
    ? `dry-run complete: ~${changedFiles} files would change, ~${totalSubs} subs`
    : `rebrand complete: ${changedFiles} files, ~${totalSubs} substitution groups`
)
