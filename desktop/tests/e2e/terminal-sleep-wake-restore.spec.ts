import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-botmux-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type SleepWakeTerminalDebug = {
  activeTabId: string | null
  activeWorktreeId: string | null
  tabs: {
    id: string
    ptyId?: string
    generation?: number
    pendingActivationSpawn?: boolean | number
  }[]
  ptyIdsByTabId: Record<string, string[]>
  ptyIdsByLeafIdByTabId: Record<string, Record<string, string>>
}

async function sleepWorktreeTerminals(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const state = store.getState()
    await state.shutdownWorktreeBrowsers(id)
    await state.shutdownWorktreeTerminals(id, { keepIdentifiers: true })
  }, worktreeId)
}

async function readLivePtyCountForWorktree(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return 0
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    return tabs.reduce((count, tab) => count + (state.ptyIdsByTabId[tab.id]?.length ?? 0), 0)
  }, worktreeId)
}

async function readSleepWakeTerminalDebug(
  page: Page,
  worktreeId: string
): Promise<SleepWakeTerminalDebug> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return {
        activeTabId: null,
        activeWorktreeId: null,
        tabs: [],
        ptyIdsByTabId: {},
        ptyIdsByLeafIdByTabId: {}
      }
    }
    const state = store.getState()
    const tabs = state.tabsByWorktree[id] ?? []
    return {
      activeTabId: state.activeTabId,
      activeWorktreeId: state.activeWorktreeId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        ptyId: tab.ptyId,
        generation: tab.generation,
        pendingActivationSpawn: tab.pendingActivationSpawn
      })),
      ptyIdsByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, state.ptyIdsByTabId[tab.id] ?? []])
      ),
      ptyIdsByLeafIdByTabId: Object.fromEntries(
        tabs.map((tab) => [tab.id, state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}])
      )
    }
  }, worktreeId)
}

async function mainSnapshotContains(page: Page, ptyId: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ targetPtyId, expectedText }) => {
      const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
        scrollbackRows: 200
      })
      return snapshot?.data.includes(expectedText) ?? false
    },
    { targetPtyId: ptyId, expectedText: text }
  )
}

function richSleepWakePayload(runId: string): string {
  const shortId = runId.slice(0, 8)
  return [
    '\x1b[?2026h',
    '\x1b[2J\x1b[H',
    '╭────────────────────────────────────────────╮',
    `│ sleep wake restore ${shortId} 😀             │`,
    '├────────────┬───────────────┬───────────────┤',
    '│ agent      │ status        │ output        │',
    '├────────────┼───────────────┼───────────────┤',
    `│ codex-${shortId.slice(0, 4)} │ thinking      │ box/table ok  │`,
    '│ opencode   │ streaming     │ unicode ✓     │',
    '│ shell      │ idle          │ prompt ready  │',
    '╰────────────┴───────────────┴───────────────╯',
    `SLEEP_WAKE_RESTORE_${runId}`,
    `SLEEP_WAKE_TABLE_${runId}`,
    '\x1b[?2026l'
  ].join('\r\n')
}

function sleepWakeExpectedMarkers(runId: string): string[] {
  return [
    `SLEEP_WAKE_RESTORE_${runId}`,
    `SLEEP_WAKE_TABLE_${runId}`,
    'box/table ok',
    'unicode ✓',
    'prompt ready'
  ]
}

function writeSleepWakePayloadScript(scriptPath: string, payload: string): void {
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64')
  writeFileSync(
    scriptPath,
    `process.stdout.write(Buffer.from(${JSON.stringify(encodedPayload)}, 'base64').toString('utf8'))\n`,
    'utf8'
  )
}

test.describe('Terminal sleep wake restore', () => {
  test('restores slept terminal output and accepts fresh input after wake', async ({
    orcaBotmuxPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaBotmuxPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaBotmuxPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaBotmuxPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'sleep wake restore needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await switchToWorktree(orcaBotmuxPage, secondWorktreeId)
    await ensureTerminalVisible(orcaBotmuxPage)
    await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaBotmuxPage)
    const runId = randomUUID()
    const restoreMarker = `SLEEP_WAKE_RESTORE_${runId}`
    const freshMarker = `SLEEP_WAKE_FRESH_${runId}`
    const expectedMarkers = sleepWakeExpectedMarkers(runId)
    const scriptPath = path.join(testRepoPath, `.orca-botmux-sleep-wake-restore-${runId}.mjs`)
    writeSleepWakePayloadScript(scriptPath, richSleepWakePayload(runId))
    try {
      await sendToTerminal(orcaBotmuxPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      await waitForTerminalOutput(orcaBotmuxPage, restoreMarker, 10_000, 20_000)
      const beforeSleepDebug = await readSleepWakeTerminalDebug(orcaBotmuxPage, secondWorktreeId)
      for (const marker of expectedMarkers) {
        expect(await mainSnapshotContains(orcaBotmuxPage, ptyId, marker)).toBe(true)
      }

      await switchToWorktree(orcaBotmuxPage, firstWorktreeId)
      await sleepWorktreeTerminals(orcaBotmuxPage, secondWorktreeId)
      const afterSleepDebug = await readSleepWakeTerminalDebug(orcaBotmuxPage, secondWorktreeId)
      await expect
        .poll(() => readLivePtyCountForWorktree(orcaBotmuxPage, secondWorktreeId), {
          timeout: 10_000,
          message: 'sleep did not release live PTYs for the background worktree'
        })
        .toBe(0)

      await switchToWorktree(orcaBotmuxPage, secondWorktreeId)
      await ensureTerminalVisible(orcaBotmuxPage)
      await waitForActiveTerminalManager(orcaBotmuxPage, 30_000)
      const awakePtyId = await waitForActivePanePtyId(orcaBotmuxPage)
      const afterWakeDebug = await readSleepWakeTerminalDebug(orcaBotmuxPage, secondWorktreeId)
      const awakeTerminalContent = await getTerminalContent(orcaBotmuxPage, 20_000)
      for (const marker of expectedMarkers) {
        expect
          .soft(awakeTerminalContent.includes(marker), {
            message: JSON.stringify(
              {
                missingMarker: marker,
                ptyId,
                awakePtyId,
                beforeSleepDebug,
                afterSleepDebug,
                afterWakeDebug,
                terminalTail: awakeTerminalContent.slice(-2000)
              },
              null,
              2
            )
          })
          .toBe(true)
      }
      await waitForTerminalOutput(orcaBotmuxPage, restoreMarker, 15_000, 20_000)
      await sendToTerminal(orcaBotmuxPage, awakePtyId, `printf '\\n${freshMarker}\\n'\r`)
      await waitForTerminalOutput(orcaBotmuxPage, freshMarker, 10_000, 20_000)
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
