import type { Page, TestInfo } from '@stablyai/playwright-test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/botmux-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createBranchCommit,
  createStagedCommitMessageChange,
  openChecks,
  openSourceControl,
  seedCleanBranchEmptyState,
  seedCommitMessageComposer,
  seedCreatePrComposer
} from './helpers/source-control-ai-generation'
import {
  installDelayedCommitMessageGenerator,
  installDelayedPrGenerator
} from './helpers/source-control-ai-generators'

function readLog(pathname: string): string {
  try {
    return readFileSync(pathname, 'utf8')
  } catch {
    return ''
  }
}

async function waitForPrGenerationStored(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const records = window.__store?.getState().pullRequestGenerationRecords ?? {}
          const record = Object.values(records).find(
            (candidate) => candidate.context.worktreeId === worktreeId
          )
          return {
            status: record?.status ?? null,
            title: record?.result?.title ?? null
          }
        }, worktreeId),
      {
        timeout: 10_000,
        message: 'PR generation result was not stored before Source Control remount'
      }
    )
    .toMatchObject({
      status: 'succeeded',
      title: 'Generated PR title after switch'
    })
}

async function waitForPrGenerationHydrated(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const records = window.__store?.getState().pullRequestGenerationRecords ?? {}
          const record = Object.values(records).find(
            (candidate) => candidate.context.worktreeId === worktreeId
          )
          return {
            status: record?.status ?? null,
            title: record?.result?.title ?? null,
            hydrated: record?.hydrated ?? null
          }
        }, worktreeId),
      {
        timeout: 10_000,
        message: 'PR generation result was not hydrated into the Source Control form'
      }
    )
    .toMatchObject({
      status: 'succeeded',
      title: 'Generated PR title after switch',
      hydrated: true
    })
}

async function waitForCommitGenerationStored(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const records = window.__store?.getState().commitMessageGenerationRecords ?? {}
          const record = records[worktreeId]
          return {
            status: record?.status ?? null,
            message: record?.message ?? null
          }
        }, worktreeId),
      {
        timeout: 10_000,
        message: 'Commit message generation result was not stored before Source Control remount'
      }
    )
    .toMatchObject({
      status: 'succeeded',
      message: [
        'Generated commit message after switch',
        '',
        'Generated from staged e2e-commit-message-generation.txt after switching worktrees'
      ].join('\n')
    })
}

async function waitForCommitGenerationHydrated(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const records = window.__store?.getState().commitMessageGenerationRecords ?? {}
          const record = records[worktreeId]
          return {
            status: record?.status ?? null,
            message: record?.message ?? null,
            hydrated: record?.hydrated ?? null
          }
        }, worktreeId),
      {
        timeout: 10_000,
        message: 'Commit message generation result was not hydrated into the Source Control form'
      }
    )
    .toMatchObject({
      status: 'succeeded',
      message: [
        'Generated commit message after switch',
        '',
        'Generated from staged e2e-commit-message-generation.txt after switching worktrees'
      ].join('\n'),
      hydrated: true
    })
}

async function writeEvidence(
  testInfo: TestInfo,
  screenshotDir: string,
  filename: string,
  evidence: unknown
): Promise<void> {
  const evidencePath = path.join(screenshotDir, filename)
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  await testInfo.attach(filename, {
    path: evidencePath,
    contentType: 'application/json'
  })
}

test.describe('Source Control AI PR generation worktree switching', () => {
  test.describe.configure({ mode: 'serial' })

  test('keeps checks-panel PR generation running after switching worktrees', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { primaryWorktreeId, prWorktreeId, prWorktreePath, primaryBranch } =
      await seedCreatePrComposer(botmuxPage)
    createBranchCommit(prWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `checks-pr-generation-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-checks-pr-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-checks-pr-generator.log')
    await installDelayedPrGenerator(botmuxPage, generatorScriptPath, callLogPath, primaryBranch)

    await openChecks(botmuxPage, prWorktreeId)
    const generate = botmuxPage.getByRole('button', {
      name: 'Generate pull request details with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toBeVisible()
    await expect.poll(() => readLog(callLogPath)).toContain('start')
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-checks-pr-generation-pending-on-a.png')
    })

    await openChecks(botmuxPage, primaryWorktreeId)
    await expect(botmuxPage.getByText('Generated PR title after switch')).toHaveCount(0)
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '02-checks-switched-to-b-no-generated-fields.png')
    })

    await expect.poll(() => readLog(callLogPath), { timeout: 10_000 }).toContain('finish')
    await openChecks(botmuxPage, prWorktreeId)
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
      'Generated PR title after switch',
      { timeout: 10_000 }
    )
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'Generated PR body after switch'
    )
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '03-checks-returned-to-a-generated-fields.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'checks-pr-generation-switch-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      generatorLog: readLog(callLogPath)
    })
  })

  test('keeps pending PR generation attached to its original worktree', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { primaryWorktreeId, prWorktreeId, prWorktreePath, primaryBranch } =
      await seedCreatePrComposer(botmuxPage)
    createBranchCommit(prWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `pr-generation-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-pr-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-pr-generator.log')
    await installDelayedPrGenerator(botmuxPage, generatorScriptPath, callLogPath, primaryBranch)

    await openSourceControl(botmuxPage, prWorktreeId)
    const generate = botmuxPage.getByRole('button', {
      name: 'Generate pull request details with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toBeVisible()
    await expect
      .poll(() => {
        return readLog(callLogPath)
      })
      .toContain('start')
    const pendingEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        rightSidebarTab: state?.rightSidebarTab
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-pr-generation-pending-on-a.png')
    })

    await openSourceControl(botmuxPage, primaryWorktreeId)
    await expect(botmuxPage.getByText('Generated PR title after switch')).toHaveCount(0)
    const switchedEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        visibleGeneratedTitle: document.body.textContent?.includes(
          'Generated PR title after switch'
        )
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '02-switched-to-b-no-generated-fields.png')
    })

    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await waitForPrGenerationStored(botmuxPage, prWorktreeId)
    await openSourceControl(botmuxPage, prWorktreeId)
    await waitForPrGenerationHydrated(botmuxPage, prWorktreeId)
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
      'Generated PR title after switch',
      { timeout: 10_000 }
    )
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'Generated PR body after switch'
    )
    const finalEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        title: (document.querySelector('[aria-label="Pull request title"]') as HTMLInputElement)
          ?.value,
        body: (
          document.querySelector('[aria-label="Pull request description"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '03-returned-to-a-generated-fields.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'pr-generation-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      generatorLog: readLog(callLogPath),
      pending: pendingEvidence,
      switchedAway: switchedEvidence,
      returned: finalEvidence
    })
  })

  test('keeps Create PR intent running after switching worktrees', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { primaryWorktreeId, prWorktreeId, prWorktreePath, primaryBranch } =
      await seedCreatePrComposer(botmuxPage)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `create-pr-intent-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await botmuxPage.evaluate(
      ({ prWorktreeId, primaryBranch }) => {
        const store =
          window.__store ??
          (() => {
            throw new Error('window.__store is not available')
          })()
        const state = store.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === prWorktreeId)
        if (!worktree) {
          throw new Error('Create PR intent worktree not found')
        }
        const repo = state.repos.find((entry) => entry.id === worktree.repoId)
        if (!repo) {
          throw new Error('Create PR intent repo not found')
        }
        const branch = worktree.branch.replace(/^refs\/heads\//, '')

        type CreatePrIntentHostedReviewCall = {
          repoPath: string
          input: {
            base?: string
            head?: string
            worktreePath?: string
          }
        }
        const testWindow = window as unknown as {
          __createPRIntentPayloads: CreatePrIntentHostedReviewCall[]
          __createPRIntentPushStarted: boolean
          __createPRIntentPushFinished: boolean
        }
        testWindow.__createPRIntentPayloads = []
        testWindow.__createPRIntentPushStarted = false
        testWindow.__createPRIntentPushFinished = false
        store.setState((current) => ({
          getHostedReviewCreationEligibility: async () => {
            // Why: eligibility stays blocked until the delayed push completes,
            // so this test exercises navigation during an in-flight intent run.
            if (!testWindow.__createPRIntentPushFinished) {
              return {
                provider: 'github' as const,
                review: null,
                canCreate: false,
                blockedReason: 'needs_push' as const,
                nextAction: 'push' as const,
                defaultBaseRef: primaryBranch,
                head: branch
              }
            }
            return {
              provider: 'github' as const,
              review: null,
              canCreate: true,
              blockedReason: null,
              nextAction: null,
              defaultBaseRef: primaryBranch,
              title: 'Create PR intent after switching worktrees',
              body: 'The intent flow should continue after navigation.',
              head: branch
            }
          },
          fetchHostedReviewForBranch: async () => null,
          fetchPRForBranch: async () => null,
          pushBranch: async (worktreeId) => {
            if (worktreeId !== prWorktreeId) {
              throw new Error(`Create PR intent pushed unexpected worktree ${worktreeId}`)
            }
            testWindow.__createPRIntentPushStarted = true
            await new Promise((resolve) => setTimeout(resolve, 1500))
            testWindow.__createPRIntentPushFinished = true
          },
          createHostedReview: async (repoPath, input) => {
            testWindow.__createPRIntentPayloads.push({ repoPath, input })
            return {
              ok: true as const,
              number: 74,
              url: 'https://github.com/acme/botmux/pull/74'
            }
          },
          gitStatusByWorktree: {
            ...current.gitStatusByWorktree,
            [worktree.id]: []
          },
          remoteStatusesByWorktree: {
            ...current.remoteStatusesByWorktree,
            [worktree.id]: {
              hasUpstream: true,
              upstreamName: `origin/${branch}`,
              ahead: 1,
              behind: 0
            }
          }
        }))
      },
      { prWorktreeId, primaryBranch }
    )

    await openSourceControl(botmuxPage, prWorktreeId)
    const createPr = botmuxPage.getByRole('button', { name: 'Create PR' }).first()
    await expect(createPr).toBeVisible({ timeout: 10_000 })
    await expect(createPr).toBeEnabled()
    await createPr.click()

    await expect
      .poll(
        () =>
          botmuxPage.evaluate(
            () =>
              (window as unknown as { __createPRIntentPushStarted: boolean })
                .__createPRIntentPushStarted
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    await openSourceControl(botmuxPage, primaryWorktreeId)

    await expect
      .poll(
        () =>
          botmuxPage.evaluate(
            () =>
              (window as unknown as { __createPRIntentPayloads: unknown[] })
                .__createPRIntentPayloads.length
          ),
        { timeout: 10_000 }
      )
      .toBe(1)

    const completedWhileSwitchedEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        rightSidebarTab: state?.rightSidebarTab
      }
    })
    expect(completedWhileSwitchedEvidence.activeWorktreeId).toBe(primaryWorktreeId)
    expect(completedWhileSwitchedEvidence.rightSidebarTab).toBe('source-control')

    await openSourceControl(botmuxPage, prWorktreeId)
    const payloads = await botmuxPage.evaluate(
      () =>
        (
          window as unknown as {
            __createPRIntentPayloads: {
              repoPath: string
              input: { base?: string; head?: string; worktreePath?: string }
            }[]
          }
        ).__createPRIntentPayloads
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      input: {
        base: primaryBranch,
        head: 'e2e-secondary',
        worktreePath: prWorktreePath
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-create-pr-intent-completed-after-switch.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'create-pr-intent-switch-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      completedWhileSwitched: completedWhileSwitchedEvidence,
      payloads
    })
  })

  test('hydrates pending PR generation after Source Control remounts', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { prWorktreeId, prWorktreePath, primaryBranch } = await seedCreatePrComposer(botmuxPage)
    createBranchCommit(prWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `pr-generation-remount-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-pr-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-pr-generator.log')
    await installDelayedPrGenerator(botmuxPage, generatorScriptPath, callLogPath, primaryBranch)

    await openSourceControl(botmuxPage, prWorktreeId)
    const generate = botmuxPage.getByRole('button', {
      name: 'Generate pull request details with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toBeVisible()
    await expect.poll(() => readLog(callLogPath)).toContain('start')

    await botmuxPage.evaluate(() => {
      window.__store?.getState().setRightSidebarTab('explorer')
    })
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating pull request details' })
    ).toHaveCount(0)
    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await waitForPrGenerationStored(botmuxPage, prWorktreeId)

    await openSourceControl(botmuxPage, prWorktreeId)
    await waitForPrGenerationHydrated(botmuxPage, prWorktreeId)
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
      'Generated PR title after switch',
      { timeout: 10_000 }
    )
    await expect(botmuxPage.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'Generated PR body after switch'
    )
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-remounted-source-control-hydrated-pr-fields.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'pr-generation-remount-evidence.json', {
      expectedOriginalWorktreeId: prWorktreeId,
      generatorLog: readLog(callLogPath)
    })
  })

  test('keeps pending commit message generation attached to its original worktree', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { primaryWorktreeId, commitWorktreeId, commitWorktreePath } =
      await seedCommitMessageComposer(botmuxPage)
    createStagedCommitMessageChange(commitWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `commit-message-generation-switch-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-commit-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-commit-generator.log')
    await installDelayedCommitMessageGenerator(botmuxPage, generatorScriptPath, callLogPath)

    await openSourceControl(botmuxPage, commitWorktreeId)
    await expect(botmuxPage.getByText('e2e-commit-message-generation.txt')).toBeVisible({
      timeout: 10_000
    })
    const generate = botmuxPage.getByRole('button', {
      name: 'Generate commit message with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toBeVisible()
    await expect
      .poll(() => {
        return readLog(callLogPath)
      })
      .toContain('start')
    const pendingEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        commitMessage: (
          document.querySelector('[aria-label="Commit message"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-commit-message-generation-pending-on-a.png')
    })

    await openSourceControl(botmuxPage, primaryWorktreeId)
    await expect(botmuxPage.getByText('Generated commit message after switch')).toHaveCount(0)
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toHaveCount(0)
    const switchedEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        visibleGeneratedMessage: document.body.textContent?.includes(
          'Generated commit message after switch'
        )
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '02-switched-to-b-no-generated-commit-message.png')
    })

    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await waitForCommitGenerationStored(botmuxPage, commitWorktreeId)
    await openSourceControl(botmuxPage, commitWorktreeId)
    await waitForCommitGenerationHydrated(botmuxPage, commitWorktreeId)
    await expect(botmuxPage.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
      'Generated commit message after switch\n\nGenerated from staged e2e-commit-message-generation.txt after switching worktrees',
      { timeout: 10_000 }
    )
    const finalEvidence = await botmuxPage.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeWorktreeId: state?.activeWorktreeId,
        commitMessage: (
          document.querySelector('[aria-label="Commit message"]') as HTMLTextAreaElement
        )?.value
      }
    })
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '03-returned-to-a-generated-commit-message.png')
    })
    await writeEvidence(testInfo, screenshotDir, 'commit-message-generation-evidence.json', {
      expectedOriginalWorktreeId: commitWorktreeId,
      expectedOtherWorktreeId: primaryWorktreeId,
      generatorLog: readLog(callLogPath),
      pending: pendingEvidence,
      switchedAway: switchedEvidence,
      returned: finalEvidence
    })
  })

  test('hydrates pending commit message generation after Source Control remounts', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const { commitWorktreeId, commitWorktreePath } = await seedCommitMessageComposer(botmuxPage)
    createStagedCommitMessageChange(commitWorktreePath)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `commit-message-generation-remount-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })
    const generatorScriptPath = path.join(screenshotDir, 'delayed-commit-generator.cjs')
    const callLogPath = path.join(screenshotDir, 'delayed-commit-generator.log')
    await installDelayedCommitMessageGenerator(botmuxPage, generatorScriptPath, callLogPath)

    await openSourceControl(botmuxPage, commitWorktreeId)
    const generate = botmuxPage.getByRole('button', {
      name: 'Generate commit message with AI'
    })
    await expect(generate).toBeVisible({ timeout: 10_000 })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toBeVisible()
    await expect.poll(() => readLog(callLogPath)).toContain('start')

    await botmuxPage.evaluate(() => {
      window.__store?.getState().setRightSidebarTab('explorer')
    })
    await expect(
      botmuxPage.getByRole('button', { name: 'Stop generating commit message' })
    ).toHaveCount(0)
    await expect
      .poll(() => readFileSync(callLogPath, 'utf8'), { timeout: 10_000 })
      .toContain('finish')
    await waitForCommitGenerationStored(botmuxPage, commitWorktreeId)

    await openSourceControl(botmuxPage, commitWorktreeId)
    await waitForCommitGenerationHydrated(botmuxPage, commitWorktreeId)
    await expect(botmuxPage.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
      [
        'Generated commit message after switch',
        '',
        'Generated from staged e2e-commit-message-generation.txt after switching worktrees'
      ].join('\n'),
      { timeout: 10_000 }
    )
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-remounted-source-control-hydrated-message.png')
    })
    await writeEvidence(
      testInfo,
      screenshotDir,
      'commit-message-generation-remount-evidence.json',
      {
        expectedOriginalWorktreeId: commitWorktreeId,
        generatorLog: readLog(callLogPath)
      }
    )
  })

  test('hides the commit AI composer on a clean branch empty state', async ({
    botmuxPage
  }, testInfo) => {
    await waitForSessionReady(botmuxPage)
    await waitForActiveWorktree(botmuxPage)
    const primaryWorktreeId = await seedCleanBranchEmptyState(botmuxPage)

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `clean-empty-state-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await openSourceControl(botmuxPage, primaryWorktreeId)
    await expect
      .poll(
        async () => {
          // Why: this full-suite spec shares the physical E2E repo with other
          // workers. Keep DOM assertions inside the reseeded poll instead of
          // racing unrelated real git-status refreshes after the poll settles.
          await seedCleanBranchEmptyState(botmuxPage, primaryWorktreeId)
          return botmuxPage.evaluate(() => {
            const emptyStateVisible =
              document.body.textContent?.includes('No changes on this branch') === true
            const commitMessageInput = document.querySelector('[aria-label="Commit message"]')
            const commitAiButton = document.querySelector(
              '[aria-label="Generate commit message with AI"]'
            )
            return {
              emptyStateVisible,
              hasCommitMessageInput: commitMessageInput !== null,
              hasCommitAiButton: commitAiButton !== null
            }
          })
        },
        {
          timeout: 10_000,
          message: 'Clean branch empty state did not render without the commit AI composer'
        }
      )
      .toEqual({
        emptyStateVisible: true,
        hasCommitMessageInput: false,
        hasCommitAiButton: false
      })
    await seedCleanBranchEmptyState(botmuxPage, primaryWorktreeId)
    await botmuxPage.screenshot({
      path: path.join(screenshotDir, '01-clean-branch-no-commit-ai-composer.png')
    })
  })
})
