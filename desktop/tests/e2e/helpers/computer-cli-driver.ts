import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'botmux-runtime.json'
let botmuxDevUserDataPath: string | null = null
let botmuxServeProcess: ChildProcess | null = null
let botmuxServeStdout = ''
let botmuxServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunBotmuxCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runBotmuxCli(
  args: string[],
  options: RunBotmuxCliOptions = {}
): Promise<CliResult> {
  try {
    return await runBotmuxCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensureBotmuxRuntimeLaunched()
      return await runBotmuxCliOnce(args)
    }
    throw error
  }
}

async function runBotmuxCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/botmux-desktop-dev.mjs')
  const command = process.env.BOTMUX_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.BOTMUX_COMPUTER_CLI ? args : [devCli, ...args]
  const env = { ...process.env }
  if (!process.env.BOTMUX_COMPUTER_CLI && !env.BOTMUX_DEV_USER_DATA_PATH) {
    env.BOTMUX_DEV_USER_DATA_PATH = await getComputerE2eBotmuxDevUserDataPath()
  }
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureBotmuxRuntimeLaunched(): Promise<void> {
  if (!process.env.BOTMUX_COMPUTER_CLI && process.platform === 'win32') {
    await ensureBotmuxRuntimeServed()
    return
  }
  await runBotmuxCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForBotmuxRuntimeReady()
}

export async function stopBotmuxRuntime(): Promise<void> {
  const processToStop = botmuxServeProcess
  if (!processToStop?.pid) {
    return
  }
  botmuxServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eBotmuxDevUserDataPath(): Promise<string> {
  if (!botmuxDevUserDataPath) {
    // Why: the shared botmux-desktop-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    botmuxDevUserDataPath = await mkdtemp(join(tmpdir(), 'botmux-computer-runtime-'))
  }
  return botmuxDevUserDataPath
}

async function waitForBotmuxRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eBotmuxDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runBotmuxCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    botmuxServeStdout.trim() ? `serve stdout: ${botmuxServeStdout.trim()}` : null,
    botmuxServeStderr.trim() ? `serve stderr: ${botmuxServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`Botmux runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureBotmuxRuntimeServed(): Promise<void> {
  if (!botmuxServeProcess || botmuxServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/botmux-desktop-dev.mjs')
    const env = {
      ...process.env,
      BOTMUX_DEV_USER_DATA_PATH: await getComputerE2eBotmuxDevUserDataPath()
    }
    botmuxServeStdout = ''
    botmuxServeStderr = ''
    botmuxServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    botmuxServeProcess.stdout?.on('data', (chunk) => {
      botmuxServeStdout += String(chunk)
    })
    botmuxServeProcess.stderr?.on('data', (chunk) => {
      botmuxServeStderr += String(chunk)
    })
    botmuxServeProcess.once('exit', () => {
      botmuxServeProcess = null
    })
    process.once('exit', () => {
      botmuxServeProcess?.kill()
    })
  }
  await waitForBotmuxRuntimeReady()
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read Botmux runtime metadata')
  )
}
