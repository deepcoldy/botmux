# Plugin ByteCLI Presets Implementation Plan

> **For agentic workers:** Execute tasks in order with failing regression tests, implementation, verification and checkpoints. Existing user authorization covers this plugin configuration migration.

**Goal:** Load business ByteCLI policy templates from external plugin contributions and move MIX's template into its plugin.

**Architecture:** Scan a declarative JSON contribution at installation, revalidate installed metadata for the current bot, and apply a versioned template by reference through the existing authenticated configuration endpoint. Generic Dashboard controls replace the built-in business button; the executor remains unchanged.

**Tech Stack:** TypeScript, Bun/Vitest, React test renderer, Node.js plugin package tests.

**Spec:** `docs/design/2026-11-28-plugin-bytedcli-presets.md`

## Global Constraints

- Keep the CLI audit version 0.199.0 and catalog 2026-11-27.2; no executable catalog injection.
- Keep current saved policy and host actor/deny floors unchanged; applying presets requires an explicit authenticated action.
- Read only the known contribution field, never serialize plugin credentials or execute plugin JS for discovery.
- Maximum eight presets/plugin, 64 available presets, 256 KiB contribution, 128-byte titles and 512-byte descriptions.
- Use the current feature branches; builds and tests use isolated dependency snapshots and private HOME/tmux fences.

## Task 1: Validated contribution and discovery

**Files:** create `src/core/plugins/bytedcli-operation-presets.ts`, `test/plugin-bytedcli-operation-presets.test.ts`; modify `src/core/plugins/types.ts`, `src/core/plugins/convention-scanner.ts`.

**Interfaces:** `parsePluginBytedcliOperationPresets(raw)` returns immutable schema/presets; `readPluginBytedcliOperationPresets(bot, global?, registry?)` returns sanitized `{presets, issues}`; `selectPluginBytedcliOperationPreset(snapshot, reference)` validates source reference/revision.

- [ ] Add a failing scanner/install regression with a package containing only `bytedcli/operation-presets.json` and a policy such as:

```json
{"schema":"botmux.bytedcli-operation-presets.v1","presets":[{"id":"support","title":"Support policy","policy":{"schema":"botmux.bytedcli-operation-policy.v2","cliVersion":"0.199.0","catalogVersion":"2026-11-27.2","rules":{"codebase.mr.close":"machine","codebase.mr.list":"actor"}}}]}
```

- [ ] Implement strict declarative parsing, byte/count limits, scanner publication, effective-plugin filtering, corruption issues, deterministic revisions and reference rejection.
- [ ] Add and run tests for install rollback, unknown IDs, duplicates, invalid versions, malformed files, per-plugin/total limits, namespace collisions, source updates and inactive/uninstalled plugins: `bun run test test/plugin-bytedcli-operation-presets.test.ts test/plugin-manifest-store.test.ts`.
- [ ] Commit the validated contribution capability after verification.

## Task 2: Authenticated apply and generic Dashboard

**Files:** modify `src/core/dashboard-ipc-server.ts`, `src/dashboard/web/bot-defaults-page.tsx`, `src/dashboard/web/i18n.ts`, `test/bytedcli-operation-policy-dashboard.test.ts`, `test/bytedcli-skill-api-executor.test.ts`; delete `src/core/bytedcli-skill-machine-preset.ts`.

**Interfaces:** GET status adds the discovery snapshot. PUT accepts either existing `triggerUserAuth` or `{bytedcliOperationPreset:{pluginId,presetId,revision}}`, never both. The preset branch rereads installed/binding state under the lifecycle lock and retains the current settings.

- [ ] Add failing real HTTP tests and rendered-component tests for discovered templates, reference application, preservation of credentialSource/capabilities/dispatch fields, stale/disabled/uninstalled rejection, unchanged host restrictions and no built-in template without a contributing plugin.
- [ ] Implement the reference form, source revalidation, generic controls, server-response state update and safe refresh after rejection. Replace business executor fixtures with a generic exact write rule.
- [ ] Run `bun run test test/plugin-bytedcli-operation-presets.test.ts test/bytedcli-operation-policy-dashboard.test.ts test/bytedcli-skill-api-executor.test.ts test/trigger-user-auth.test.ts test/bytedcli-operation-policy-runtime.test.ts`.
- [ ] Commit and check that no business preset symbols/button strings remain in Botmux runtime source.

## Task 3: External business configuration and local rollout

**Files:** create devbox-mix `plugins/mix/bytedcli/operation-presets.json`; update `plugins/mix/scripts/build.cjs`, `plugins/mix/test/package-contract.test.cjs`, `plugins/mix/README.md`; move business template docs/examples out of Botmux and add `docs/plugin-bytedcli-operation-presets.md`.

- [ ] Add a failing published-package test that checks the contribution exists and selects the intended 40 machine/37 actor signatures, including explicit write exceptions and actor defaults.
- [ ] Move the reviewed template into the plugin contribution, copy it to dist, and document configuration/application, upgrade/reinstall behavior, generic host validation and saved-policy independence.
- [ ] Run the isolated MIX plugin test/build/validate and Botmux related regressions/full build/binary smoke. Verify the actual packaged contribution with Botmux's parser in a fenced installation fixture.
- [ ] Review code and validation, push both feature branches, retain private backups, install the new business plugin, deploy the verified local binary, and check two Lark connections/four online processes/Dashboard HTTP200. Read back the live policy, confirm 40/37 unchanged and discover the external MIX template.
