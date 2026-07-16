#!/usr/bin/env node

/** Fail the build if any deleted Workflow v2 executable/UI artifact survived. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDir = resolve(repoRoot, 'dist');
const retiredModules = [
  'workflows/attempt-resume',
  'workflows/blob',
  'workflows/cancel-run',
  'workflows/cancel',
  'workflows/catalog',
  'workflows/cold-attach',
  'workflows/cold-scan',
  'workflows/daemon-spawn',
  'workflows/effect-input',
  'workflows/events/append',
  'workflows/events/idempotency',
  'workflows/events/index',
  'workflows/fanout',
  'workflows/hostExecutors/protocol',
  'workflows/loader',
  'workflows/loop',
  'workflows/orchestrator',
  'workflows/output-binding',
  'workflows/params',
  'workflows/resume',
  'workflows/run-id',
  'workflows/run-init',
  'workflows/runs-dir',
  'workflows/runtime',
  'workflows/spawn-bot',
  'workflows/spawn-policy',
  'workflows/system',
  'workflows/trigger-from-envelope',
  'workflows/trigger-run',
  'workflows/wait',
  'im/lark/workflow-card-handler',
  'im/lark/workflow-cards',
  'im/lark/workflow-progress-card',
  'im/lark/workflows-card',
  'dashboard/workflow-api',
  'dashboard/workflow-card-model',
  'dashboard/workflows-action-helpers',
  'core/dashboard-command/workflows',
  'dashboard/web/legacy-workflow-link',
  'dashboard/web/legacy-workflow-page',
  'dashboard/web/workflow-version-switch',
  'dashboard/web/workflows',
];
const generatedSuffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const stale = retiredModules.flatMap((modulePath) =>
  generatedSuffixes
    .map((suffix) => `${modulePath}${suffix}`)
    .filter((relativePath) => existsSync(resolve(distDir, relativePath))),
);
if (existsSync(resolve(distDir, 'dashboard-web/terminal-replay.html'))) {
  stale.push('dashboard-web/terminal-replay.html');
}
if (stale.length > 0) {
  throw new Error(`retired Workflow v2 build artifacts survived:\n${stale.map((p) => `- ${p}`).join('\n')}`);
}
console.log('[build-audit] retired Workflow v2 artifacts absent');
