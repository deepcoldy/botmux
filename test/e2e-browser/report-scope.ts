/**
 * Connect agents created inside a `feishu.runScenario` step to that step's
 * Midscene report entry. The phased nodes (feishu-report-phases.ts) wire their
 * own agent; scenario modules create agents deep inside helpers, so
 * `createAgent` registers each one with the scope of the step it runs in.
 *
 * Without this the unified report holds no executions for scenario steps, and
 * the Pages index / Summary show no screenshot or step link for those cases.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { PlaywrightAgent } from '@midscene/web/playwright';

interface ReportHooks {
  addDumpUpdateListener?(
    listener: (dump: string, execution?: { id?: string }) => void,
  ): () => void;
  flushReport?(): Promise<string | undefined>;
  _prepareForTestRunner?(): void;
  _createReportSource?(scopeId: string): Promise<unknown>;
}

interface ReportScope {
  runId: string;
  addTrace(executionId: string): void;
  pending: Set<() => Promise<void>>;
  reportPaths: string[];
  reportSources: unknown[];
}

export interface ReportScopeContext {
  case: { runId: string };
  report: { addTrace(trace: { type: 'midscene-execution'; executionId: string }): void };
  onTeardown(teardown: () => unknown): void;
}

const scopes = new AsyncLocalStorage<ReportScope>();

/** Run a scenario step so every agent it creates reports into this step. */
export function runWithReportScope<T>(ctx: ReportScopeContext, run: () => Promise<T>): Promise<T> {
  const scope: ReportScope = {
    runId: ctx.case.runId,
    addTrace: (executionId) => ctx.report.addTrace({ type: 'midscene-execution', executionId }),
    pending: new Set(),
    reportPaths: [],
    reportSources: [],
  };
  ctx.onTeardown(async () => {
    // Agents a scenario forgot to destroy still contribute their report.
    for (const finalize of [...scope.pending]) await finalize();
    return {
      ...(scope.reportPaths.length ? { reportPaths: scope.reportPaths } : {}),
      ...(scope.reportSources.length ? { reportSources: scope.reportSources } : {}),
    };
  });
  return scopes.run(scope, run);
}

/** Called by `createAgent`; a no-op outside a scenario step. */
export function attachAgentToReportScope(agent: PlaywrightAgent): void {
  const scope = scopes.getStore();
  if (!scope) return;
  const hooks = agent as PlaywrightAgent & ReportHooks;
  hooks._prepareForTestRunner?.();
  const remove = hooks.addDumpUpdateListener?.((_dump, execution) => {
    if (execution?.id) scope.addTrace(execution.id);
  });
  let finalized = false;
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    scope.pending.delete(finalize);
    remove?.();
    try {
      const flushed = await hooks.flushReport?.();
      if (flushed) scope.reportPaths.push(path.resolve(flushed));
    } catch (error) {
      console.error('Feishu agent report flush failed:', error);
    }
    try {
      const source = await hooks._createReportSource?.(scope.runId);
      if (source) scope.reportSources.push(source);
    } catch (error) {
      console.error('Feishu agent report source failed:', error);
    }
  };
  scope.pending.add(finalize);
  // The report has to be collected before destroy() tears the agent down.
  const destroy = agent.destroy.bind(agent);
  agent.destroy = async (...args: Parameters<PlaywrightAgent['destroy']>) => {
    await finalize();
    return destroy(...args);
  };
}
