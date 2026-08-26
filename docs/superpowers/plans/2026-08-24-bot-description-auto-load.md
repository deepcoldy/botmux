# Bot Description Auto-Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load and display the selected bot's primary-language Feishu description automatically, without issuing a duplicate read when the editor opens.

**Architecture:** Keep `BotDescriptionControl` as the single owner of the snapshot, drafts, loading state, and errors. Add one mount effect that calls the existing bounded loader, and reduce `openEditor` to a local UI state change; existing login, language-change, and publish reload paths remain unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright browser acceptance, pnpm.

---

### Task 1: Auto-load the selected bot description

**Files:**
- Modify: `src/dashboard/web/bot-defaults-page.tsx:1613-1670`
- Test: `test/dashboard-bot-description-ui.test.ts`

- [ ] **Step 1: Write the failing wiring test**

Add this test inside `describe('dashboard bot description editor wiring', ...)`:

```ts
it('loads descriptions on mount and opens the editor without a duplicate read', () => {
  expect(page).toContain(`useEffect(() => {
    void loadDescriptions();
  }, [loadDescriptions]);`);

  const openEditor = page.match(/const openEditor = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] ?? '';
  expect(openEditor).toContain('setOpen(true);');
  expect(openEditor).not.toContain('loadDescriptions');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run --project unit test/dashboard-bot-description-ui.test.ts
```

Expected: the new test fails because the mount effect is absent and `openEditor` still calls `loadDescriptions(...)`.

- [ ] **Step 3: Implement the minimal lifecycle change**

Immediately after the existing `loadDescriptions` callback, add:

```tsx
useEffect(() => {
  void loadDescriptions();
}, [loadDescriptions]);
```

Replace the existing editor callback with:

```tsx
const openEditor = useCallback(() => {
  setOpen(true);
}, []);
```

Do not change the login-success reload, `languages_changed` reload, publish flow, error mapping, or description schema.

- [ ] **Step 4: Run automated verification and verify GREEN**

Run:

```bash
pnpm vitest run --project unit \
  test/dashboard-bot-description-ui.test.ts \
  test/dashboard-bot-description-proxy.test.ts \
  test/open-platform-description.test.ts \
  test/bot-description-schema.test.ts
npx tsc --noEmit --pretty false
pnpm build
git diff --check
```

Expected: all selected tests pass, TypeScript exits 0, the build completes, and `git diff --check` prints no errors.

- [ ] **Step 5: Verify the real Dashboard flow without publishing**

Open the current feature Dashboard with Playwright and count GET requests whose path matches `/api/bots/<appId>/description`.

Acceptance checks:

```text
1. Navigate directly to #/bot-defaults.
2. Do not click the description icon.
3. Wait until the preview is neither the loading state nor “—”.
4. Assert exactly one description GET occurred for the selected bot.
5. Click the edit icon and wait for the textarea.
6. Assert the GET count is unchanged.
7. Fill the first textarea with its current value plus one character.
8. Assert the textarea remains mounted and editable, and no page error occurred.
9. Close the browser without clicking “Publish descriptions”.
```

- [ ] **Step 6: Commit and refresh the recovery bundle**

```bash
git add src/dashboard/web/bot-defaults-page.tsx test/dashboard-bot-description-ui.test.ts
git commit -m "fix(profile): load bot descriptions on selection"
git bundle create \
  /Users/bytedance/botmux-recovery/lark-description/feat-lark-multilingual-description-final-auto-load.bundle \
  feat/lark-multilingual-description origin/master
git bundle verify \
  /Users/bytedance/botmux-recovery/lark-description/feat-lark-multilingual-description-final-auto-load.bundle
```

Expected: the commit succeeds and bundle verification reports a complete history containing the feature branch and `origin/master`.
