import { test, expect } from './helpers/botmux-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  botmuxCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    await ensureTerminalVisible(botmuxPage)
  })

  test('terminal process receives the Botmux-managed Codex home', async ({ botmuxPage }) => {
    await waitForActiveTerminalManager(botmuxPage)
    const ptyId = await waitForActivePanePtyId(botmuxPage)
    const marker = `__BOTMUX_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, botmuxCodexHome: process.env.BOTMUX_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(botmuxPage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(botmuxPage), marker)
          return Boolean(
            probe?.codexHome &&
            probe.botmuxCodexHome &&
            probe.codexHome === probe.botmuxCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose Botmux-managed Codex home env' }
      )
      .toBe(true)

    expect(probe?.codexHome).toBe(probe?.botmuxCodexHome)
  })
})
