import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBareBotmuxCliScript } from './linux-bare-botmux-dispatcher'

const SHIM_DIR_NAME = 'linux-botmux-cli-shim'

// Why: rewriting the shim on every PTY spawn is wasted fs work; the target only
// changes with the install itself, so one successful write per process is enough.
// Failures are NOT cached so a transient fs error retries on the next spawn.
const ensuredShimDirs = new Map<string, string>()

export type LinuxTerminalBotmuxCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Test seam — defaults to $APPIMAGE (set only when running from an AppImage). */
  appImagePath?: string | null
}

// Why: on Linux the packaged CLI is `botmux-ide`, but agent-facing surfaces
// (skills, dispatch preambles, CLI hints) invoke bare `botmux`. Prepending this
// userData-scoped shim dir to managed-PTY PATH makes bare `botmux` resolve to the
// Botmux CLI inside Botmux terminals only, without changing the user's other shells.
export function ensureLinuxTerminalBotmuxCliShimDir(
  options: LinuxTerminalBotmuxCliShimOptions
): string | null {
  const cached = ensuredShimDirs.get(options.userDataPath)
  if (cached !== undefined) {
    return cached
  }

  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) {
    return null
  }
  const resolved = buildBareBotmuxCliScript(
    resourcesPath,
    options.appImagePath ?? process.env.APPIMAGE ?? null
  )
  if (!resolved) {
    return null
  }

  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'botmux')
  try {
    if (readShim(shimPath) !== resolved.script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, resolved.script, 'utf8')
    }
    // Why: always re-assert the exec bit — a shim written by an older run (or
    // restored from backup) with mode stripped would fail every agent CLI call.
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  ensuredShimDirs.set(options.userDataPath, shimDir)
  return shimDir
}

function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
}
