import { stripAnsiScreenText } from './idle-detector.js';
import { readTraexEffortComposer } from './traex-session-effort.js';
import { isNativeReasoningEffort } from '../services/native-reasoning-observation.js';

/** Passive read of the live native footer, never a highlighted menu choice.
 * Unknown/custom footers fail closed. No keys are sent by this observer. */
export function readNativeReasoningFooter(cliId: 'codex' | 'traex', screen: string): string | null | undefined {
  if (cliId === 'traex') {
    const current = readTraexEffortComposer(screen);
    return current ? current.effort ?? null : undefined;
  }
  const lines = stripAnsiScreenText(screen).split(/\r?\n/);
  let prompt = lines.length - 1;
  while (prompt >= 0 && !/^\s*[›»]/.test(lines[prompt]!)) prompt--;
  if (prompt < 0 || lines.length - prompt > 8) return;
  if (!/^\s*[›»]\s*(?:Ask Codex to do anything)?\s*$/.test(lines[prompt]!)) return;
  if (lines.slice(Math.max(0, prompt - 4)).some(line => /esc to interrupt/i.test(line))) return;
  const footer = lines.slice(prompt + 1).filter(line => line.trim());
  if (!footer.some(line => /\b\d{1,3}% context (?:left|remaining)\b/.test(line))) return;
  for (const line of footer) {
    const match = /^\s*[A-Za-z0-9][A-Za-z0-9._/:[\]-]*\s+(low|medium|high|xhigh|max|ultra)(?:\s*·|\s*$)/.exec(line);
    if (match && isNativeReasoningEffort(match[1])) return match[1];
  }
}
