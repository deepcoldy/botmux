/**
 * E2E tests for opening files and markdown preview from the right sidebar.
 *
 * User Prompt:
 * - you can open files (from the right sidebar)
 * - you can open .md files and they show up as preview (from the right sidebar)
 */

import { test, expect } from './helpers/orca-botmux-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

async function switchToTerminal(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal')
  }, worktreeId)
}

async function switchToEditor(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((targetFileId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    if (state.openFiles.some((file) => file.id === targetFileId)) {
      state.setActiveFile(targetFileId)
      state.setActiveTabType('editor')
    }
  }, fileId)
}

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaBotmuxPage }) => {
    await waitForSessionReady(orcaBotmuxPage)
    await waitForActiveWorktree(orcaBotmuxPage)
    await ensureTerminalVisible(orcaBotmuxPage)
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('opening the right sidebar shows file explorer', async ({ orcaBotmuxPage }) => {
    await openFileExplorer(orcaBotmuxPage)

    // Why: the load-bearing check is that `FileExplorer` actually mounted.
    // `data-orca-botmux-explorer-shell` is the stable marker the component renders
    // on its root shell div — a store-only `rightSidebarTab === 'explorer'`
    // check would pass even if the explorer crashed on mount and the panel
    // painted empty.
    await expect(orcaBotmuxPage.locator('[data-orca-botmux-explorer-shell]')).toBeVisible({ timeout: 5_000 })
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('clicking a file in the file explorer opens it in an editor tab', async ({ orcaBotmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaBotmuxPage))!
    await openFileExplorer(orcaBotmuxPage)

    const filesBefore = await getOpenFiles(orcaBotmuxPage, worktreeId)

    // Click a known non-directory file
    const clickedFile = await clickFileInExplorer(orcaBotmuxPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md'
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for the file to be opened in the editor
    await expect.poll(async () => getActiveTabType(orcaBotmuxPage), { timeout: 5_000 }).toBe('editor')

    // There should be a new open file
    await expect
      .poll(async () => (await getOpenFiles(orcaBotmuxPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)

    // Why: the load-bearing check is that the editor panel actually rendered
    // the opened file. `.editor-header-path` is emitted by EditorPanel's
    // header row and contains the file's full absolute path (which ends in
    // the clicked file's name); a store-only `activeTabType === 'editor'`
    // check would pass even if EditorPanel crashed on mount and the surface
    // is blank. Timeout is generous (20s) because EditorPanel is lazy-loaded
    // the first time the editor opens in a session — headless Electron runs
    // routinely take 10s+ to hydrate that chunk plus the inner Monaco/Rich
    // Markdown chunks, during which the outer Suspense shows "Loading
    // editor…" and `.editor-header-path` is not yet in the DOM.
    await expect(orcaBotmuxPage.locator('.editor-header-path').first()).toContainText(clickedFile!, {
      timeout: 20_000
    })
  })

  /**
   * User Prompt:
   * - you can open .md files and they show up as preview (from the right sidebar)
   */
  test('opening a .md file shows markdown content', async ({ orcaBotmuxPage }) => {
    await openFileExplorer(orcaBotmuxPage)
    const clickedFile = await clickFileInExplorer(orcaBotmuxPage, ['README.md', 'CLAUDE.md'])
    expect(clickedFile).not.toBeNull()

    // Wait for the editor tab to become active
    await expect.poll(async () => getActiveTabType(orcaBotmuxPage), { timeout: 5_000 }).toBe('editor')

    // The seeded README.md starts with `# OrcaBotmux E2E Test Repo`, so the rich
    // markdown editor should render a real <h1> with that text. Asserting on
    // the rendered heading (not `markdownViewMode` in the store) is the whole
    // point of this spec — a store-only check passes even if
    // RichMarkdownEditor failed to mount and the editor surface is blank.
    // Fall back to CLAUDE.md's first heading when that file was opened
    // instead: the seeded `CLAUDE.md` starts with `# CLAUDE.md`.
    const expectedHeading = clickedFile?.endsWith('README.md')
      ? /OrcaBotmux E2E Test Repo/i
      : /CLAUDE\.md/i
    // Why 25s: first-time markdown open in a headless Electron session waits
    // on two lazy chunks (EditorPanel → RichMarkdownEditor) plus ProseMirror
    // boot + file read. Real-run traces show the heading reliably paints
    // within ~10-15s but with enough variance that a 15s bound flakes. The
    // user-facing guarantee is just "the rich markdown surface eventually
    // paints the file's first heading" — giving it 25s keeps the assertion
    // meaningful without turning every run into a flake risk.
    await expect(orcaBotmuxPage.getByRole('heading', { name: expectedHeading, level: 1 })).toBeVisible({
      timeout: 25_000
    })
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   * - files retain state when switching tabs
   */
  test('editor tab retains state when switching to terminal and back', async ({ orcaBotmuxPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaBotmuxPage))!
    await openFileExplorer(orcaBotmuxPage)

    // Click a file to open it
    const clickedFile = await clickFileInExplorer(orcaBotmuxPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore'
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for editor to become active
    await expect.poll(async () => getActiveTabType(orcaBotmuxPage), { timeout: 5_000 }).toBe('editor')

    // Record what files are open
    const openFilesBefore = await getOpenFiles(orcaBotmuxPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    const editorFileId = openFilesBefore[0].id

    // Switch to a terminal tab
    await switchToTerminal(orcaBotmuxPage, worktreeId)
    await expect.poll(async () => getActiveTabType(orcaBotmuxPage), { timeout: 3_000 }).not.toBe('editor')

    // Switch back to the same editor tab
    await switchToEditor(orcaBotmuxPage, editorFileId)
    await expect.poll(async () => getActiveTabType(orcaBotmuxPage), { timeout: 3_000 }).toBe('editor')

    // The same files should still be open
    const openFilesAfter = await getOpenFiles(orcaBotmuxPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
