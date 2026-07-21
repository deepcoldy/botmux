import { test, expect } from './helpers/orca-botmux-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  orcaCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ orcaBotmuxPage }) => {
    await waitForSessionReady(orcaBotmuxPage)
    await waitForActiveWorktree(orcaBotmuxPage)
    await ensureTerminalVisible(orcaBotmuxPage)
  })

  test('terminal process receives the OrcaBotmux-managed Codex home', async ({ orcaBotmuxPage }) => {
    await waitForActiveTerminalManager(orcaBotmuxPage)
    const ptyId = await waitForActivePanePtyId(orcaBotmuxPage)
    const marker = `__ORCA_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, orcaCodexHome: process.env.ORCA_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(orcaBotmuxPage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(orcaBotmuxPage), marker)
          return Boolean(
            probe?.codexHome &&
            probe.orcaCodexHome &&
            probe.codexHome === probe.orcaCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose OrcaBotmux-managed Codex home env' }
      )
      .toBe(true)

    expect(probe?.codexHome).toBe(probe?.orcaCodexHome)
  })
})
