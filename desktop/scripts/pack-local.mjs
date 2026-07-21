#!/usr/bin/env node
/**
 * Local unpackaged OrcaBotmux.app for dogfood (ad-hoc sign on macOS).
 * Does not require Apple Developer ID.
 *
 *   node scripts/pack-local.mjs
 *   node scripts/pack-local.mjs --install   # copy to /Applications/OrcaBotmux.app
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const install = process.argv.includes('--install')
const skipBuild = process.argv.includes('--skip-build')

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!skipBuild) {
  run('pnpm', ['exec', 'electron-vite', 'build'])
  // CLI + relay improve packaged serve/pairing; best-effort.
  try {
    run('pnpm', ['run', 'build:relay'])
  } catch {
    console.warn('[pack-local] build:relay failed; continuing')
  }
  try {
    run('pnpm', ['run', 'build:cli'])
  } catch {
    console.warn('[pack-local] build:cli failed; continuing')
  }
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
run('pnpm', [
  'exec',
  'electron-builder',
  '--mac',
  'dir',
  '--config',
  'config/electron-builder.config.cjs',
  `-c.mac.identity=null`,
  process.arch === 'arm64' ? '--arm64' : '--x64',
])

const appOut =
  process.arch === 'arm64'
    ? join(root, 'dist', 'mac-arm64', 'OrcaBotmux.app')
    : join(root, 'dist', 'mac', 'OrcaBotmux.app')

if (!existsSync(appOut)) {
  console.error(`[pack-local] expected app not found at ${appOut}`)
  process.exit(1)
}

// Ad-hoc sign so Gatekeeper allows local launch.
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appOut], { stdio: 'inherit' })
} catch (e) {
  console.warn('[pack-local] codesign ad-hoc failed', e)
}

console.log(`[pack-local] built ${appOut}`)

if (install) {
  const dest = '/Applications/OrcaBotmux.app'
  rmSync(dest, { recursive: true, force: true })
  cpSync(appOut, dest, { recursive: true })
  try {
    execFileSync('xattr', ['-cr', dest], { stdio: 'inherit' })
  } catch {
    /* ignore */
  }
  console.log(`[pack-local] installed ${dest}`)
}
