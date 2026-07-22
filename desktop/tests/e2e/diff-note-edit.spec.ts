import { test, expect } from './helpers/botmux-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test.describe('Diff note edit', () => {
  test.beforeEach(async ({ botmuxPage }) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
  })

  test('editing a saved inline note updates the open diff card', async ({ botmuxPage }) => {
    const worktreeId = await waitForActiveWorktree(botmuxPage)
    const seededBody = 'edit-me note'
    const editedBody = 'edited note from the inline card'

    // Why: create a real modified-file diff so Monaco mounts the saved-note
    // view zone on the same local surface that wires updateDiffComment.
    const { relativePath } = await botmuxPage.evaluate(async (wId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available - is the app in dev mode?')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error('active worktree not found')
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      const rel = `src${separator}index.ts`
      const absolutePath = `${worktree.path}${separator}${rel}`
      await window.api.fs.writeFile({
        filePath: absolutePath,
        content: 'export const hello = "note-edit-test"\n'
      })
      return { relativePath: rel }
    }, worktreeId)

    const addResult = await botmuxPage.evaluate(
      async ({ wId, rel, body }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        return store.getState().addDiffComment({
          worktreeId: wId,
          filePath: rel,
          source: 'diff',
          lineNumber: 1,
          body,
          side: 'modified'
        })
      },
      { wId: worktreeId, rel: relativePath, body: seededBody }
    )
    expect(addResult, 'addDiffComment returned null').not.toBeNull()
    const commentId = addResult!.id

    await botmuxPage.evaluate(
      ({ wId, rel }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === wId)
        if (!worktree) {
          throw new Error('active worktree not found')
        }
        const separator = worktree.path.includes('\\') ? '\\' : '/'
        state.openDiff(wId, `${worktree.path}${separator}${rel}`, rel, 'typescript', false)
      },
      { wId: worktreeId, rel: relativePath }
    )

    const card = botmuxPage.locator('.botmux-diff-comment-card').first()
    await expect(card, 'seeded inline note did not render').toBeVisible({ timeout: 15_000 })
    await expect(card.locator('.botmux-diff-comment-body')).toHaveText(seededBody)

    await card.getByTitle('Edit note').click()

    const textarea = card.locator('.botmux-diff-comment-popover-textarea')
    await expect(textarea).toBeVisible()
    await expect(textarea).toHaveValue(seededBody)

    const saveButton = card
      .locator('.botmux-diff-comment-popover-footer button')
      .filter({ hasText: 'Save' })
    await expect(saveButton, 'Save should be disabled before the body changes').toBeDisabled()

    await textarea.fill(editedBody)
    await expect(saveButton, 'Save should be enabled for a non-empty changed body').toBeEnabled()
    await saveButton.click()

    await expect(textarea, 'edit controls did not close after saving').toHaveCount(0, {
      timeout: 5_000
    })

    await expect
      .poll(
        async () =>
          botmuxPage.evaluate((id: string) => {
            const store = window.__store
            if (!store) {
              return null
            }
            const all = Object.values(store.getState().worktreesByRepo)
              .flat()
              .flatMap((w) => w.diffComments ?? [])
            const comment = all.find((c) => c.id === id)
            return comment?.body ?? null
          }, commentId),
        {
          timeout: 5_000,
          message: 'updateDiffComment did not persist the edited body in the store'
        }
      )
      .toBe(editedBody)

    const updatedCard = botmuxPage
      .locator('.botmux-diff-comment-card')
      .filter({ has: botmuxPage.locator('.botmux-diff-comment-body', { hasText: editedBody }) })
      .first()
    await expect(updatedCard, 'inline card did not update in the open diff').toBeVisible()
    await expect(updatedCard.locator('.botmux-diff-comment-body')).toHaveText(editedBody)
    await expect(updatedCard.locator('.botmux-diff-comment-body')).not.toHaveText(seededBody)
    await expect(updatedCard.getByTitle('Edit note')).toBeVisible()
  })
})
