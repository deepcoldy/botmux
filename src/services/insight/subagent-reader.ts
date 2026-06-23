import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseClaudeInsight } from './claude-span-reader.js';
import { isInteractiveWaitTool, isReadPhase, isWritePhase } from './classify.js';
import { safeTextPreview } from './safe-detail.js';
import { INSIGHT_PHASES, type InsightPhase, type SafeSubagentLane } from './types.js';

const MAX_SUBAGENTS = 40;
const MAX_SUBAGENT_BYTES = 32 * 1024 * 1024;

interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

/** Claude stores each delegated sub-agent's transcript under
 *  `<project>/<sessionId>/subagents/agent-<id>.jsonl` (+ a sibling `.meta.json`
 *  with agentType / description / toolUseId). The main transcript lives at
 *  `<project>/<sessionId>.jsonl`, so the dir is the main path minus `.jsonl`. */
function subagentsDir(mainPath: string): string {
  return join(dirname(mainPath), basename(mainPath, '.jsonl'), 'subagents');
}

function readMeta(metaPath: string): SubagentMeta {
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as SubagentMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function emptyPhase(): Record<InsightPhase, { count: number; ms: number }> {
  const out = {} as Record<InsightPhase, { count: number; ms: number }>;
  for (const p of INSIGHT_PHASES) out[p] = { count: 0, ms: 0 };
  return out;
}

type LaneSpan = { phase: InsightPhase; tool: string; status: string; durationMs?: number };
/** Inject the caller's cached parser so repeated detail fetches of the same
 *  session don't re-read unchanged sub-agent transcripts. Defaults to a fresh
 *  parse for standalone use / tests. */
type SubagentParse = (path: string) => { spans?: LaneSpan[] } | null;

/** Roll up the delegated sub-agents for a Claude session into safe lanes.
 *  Returns [] when there is no subagents dir (most sessions). Detail-mode only —
 *  it parses one extra file per sub-agent, so never call it for the overview. */
export function buildSubagentLanes(
  mainPath: string,
  parse: SubagentParse = parseClaudeInsight,
): SafeSubagentLane[] {
  const dir = subagentsDir(mainPath);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // Stat is cheap (no content read); parse is not. Drop oversized files and pick
  // the MAX_SUBAGENTS most-recent transcripts BEFORE parsing — otherwise a session
  // that accumulated hundreds of sub-agent files would force hundreds of full
  // parses just to return the top 40 (the final cap bounds output, not work).
  const candidates: Array<{ jsonlPath: string; metaPath: string; mtimeMs: number }> = [];
  for (const file of files) {
    const jsonlPath = join(dir, file);
    try {
      const st = statSync(jsonlPath);
      if (st.size > MAX_SUBAGENT_BYTES) continue;
      candidates.push({ jsonlPath, metaPath: join(dir, file.replace(/\.jsonl$/, '.meta.json')), mtimeMs: st.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const lanes: SafeSubagentLane[] = [];
  for (const { jsonlPath, metaPath } of candidates.slice(0, MAX_SUBAGENTS)) {
    let spans: LaneSpan[];
    try {
      spans = parse(jsonlPath)?.spans ?? [];
    } catch {
      continue;
    }
    const meta = readMeta(metaPath);
    const phase = emptyPhase();
    let reads = 0;
    let edits = 0;
    let runs = 0;
    let failures = 0;
    let durationMs = 0;
    for (const s of spans) {
      const p: InsightPhase = INSIGHT_PHASES.includes(s.phase) ? s.phase : 'discuss';
      phase[p].count++;
      const waits = isInteractiveWaitTool(s.tool);
      if (s.durationMs !== undefined && !waits) {
        const d = Math.max(0, Math.round(s.durationMs));
        phase[p].ms += d;
        durationMs += d;
      }
      if (isReadPhase(p)) reads++;
      if (isWritePhase(p)) edits++;
      if (p === 'run') runs++;
      if (s.status === 'error') failures++;
    }
    lanes.push({
      agentType: safeTextPreview(meta.agentType ?? 'subagent', 48)?.text ?? 'subagent',
      task: safeTextPreview(meta.description, 200),
      spans: spans.length,
      reads,
      edits,
      runs,
      failures,
      durationMs,
      phase,
    });
  }
  return lanes.sort((a, b) => b.durationMs - a.durationMs || b.spans - a.spans).slice(0, MAX_SUBAGENTS);
}
