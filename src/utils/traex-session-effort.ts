import { traexRestoredComposerReady, traexViewportFooterBusy } from '../adapters/cli/traex-footer.js';
import { stripAnsiScreenText } from './idle-detector.js';
import { sameModelIdentity } from './codex-effort-menu.js';
import { reasoningEffortsForCliModel, type CodexReasoningEffort } from '../services/codex-reasoning-effort.js';

export interface TraexTopicEffortRestart {
  model: string;
  effort: CodexReasoningEffort;
  nativeSessionId: string;
}

/** Native 0.213 footer. A MAX suffix belongs to the model, never its slug. */
export function readTraexEffortComposer(screen: string): { model: string; effort?: string; variant: 'standard' | 'max' } | undefined {
  const lines = stripAnsiScreenText(screen).split(/\r?\n/);
  // Native 0.213 with no permission badge has only the shortcut hint. Keep this
  // local to settings checks; do not widen the shared startup readiness gate.
  const readyLines = [...lines];
  let last = readyLines.length - 1;
  while (last >= 0 && !readyLines[last]!.trim()) last--;
  if (/^  \? for shortcuts\s*$/.test(readyLines[last] ?? '')) readyLines[last] = '  Default · ? for shortcuts';
  if (!traexRestoredComposerReady(readyLines.join('\n')) || traexViewportFooterBusy(screen)) return;
  let prompt = lines.length - 1;
  while (prompt >= 0 && !/^[›❯]/.test(lines[prompt]!)) prompt--;
  const footer = lines.slice(prompt + 1).find(line => / · Context /.test(line));
  if (!footer) return;
  let model = footer.trim().split(' · ')[0]!;
  const effort = /\s+(low|medium|high|xhigh|max|ultra)$/.exec(model)?.[1];
  if (effort) model = model.slice(0, -(effort.length + 1));
  const max = /\s*\(MAX\)$/.test(model);
  model = model.replace(/\s*\(MAX\)$/, '').trim();
  return model ? { model, effort, variant: max ? 'max' : 'standard' } : undefined;
}

export function validateTraexTopicEffortRestart(
  cfg: { cliId?: string; cliSessionId?: string; wrapperCli?: string; adoptMode?: boolean; workflowNodeSession?: boolean; traexAutoModel?: { enabled?: boolean } },
  requested: TraexTopicEffortRestart,
  screen: string,
): ReturnType<typeof readTraexEffortComposer> {
  if (cfg.cliId !== 'traex' || cfg.wrapperCli || cfg.adoptMode || cfg.workflowNodeSession || cfg.traexAutoModel?.enabled
    || !cfg.cliSessionId || cfg.cliSessionId !== requested.nativeSessionId
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(requested.model)) return;
  const current = readTraexEffortComposer(screen);
  if (!current || !sameModelIdentity(current.model, requested.model)
    || !reasoningEffortsForCliModel('traex', requested.model).includes(requested.effort)) return;
  return current;
}
