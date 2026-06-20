// 团队看板的 host 侧存储（申晗架构定稿：谁部署团队，团队数据存谁那儿）。
// 两类数据，都归团队 host（hub）持有：
//   1. 编排（entries）：每张卡片在团队看板上的列/排序——全团队共享同一份，
//      任何成员拖拽都写这里，与各部署私有的个人看板（Session.kanbanColumn）无关。
//   2. 成员部署上报的会话裁剪行（reports）：卡片的活内容（标题/状态/时间），
//      事实源仍在各部署，host 只存最近一次上报的快照。
// 文件：team-board-<teamId>.json / team-board-sessions-<teamId>.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { normalizeKanbanColumn, normalizeKanbanPosition, type SessionKanbanColumn } from '../core/session-board.js';

export interface TeamBoardEntry {
  column: SessionKanbanColumn;
  position: number;
  updatedAt: number;
}

/** 成员部署上报的会话裁剪行——字段白名单，不带终端端口/token/工作目录。 */
export interface ReportedTeamSession {
  sessionId: string;
  botName: string;
  cliId: string;
  status: string;
  title?: string;
  chatId: string;
  scope?: string;
  adopt?: boolean;
  lastMessageAt: number;
}

export interface DeploymentReport {
  deploymentId: string;
  deploymentName: string;
  reportedAt: number;
  sessions: ReportedTeamSession[];
}

/** 单部署单次上报的会话数上限——防失控 payload 撑爆 host 存储。 */
export const TEAM_REPORT_MAX_SESSIONS = 200;

function safeTeamId(teamId: string): string {
  return teamId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function boardPath(dataDir: string, teamId: string): string {
  return join(dataDir, `team-board-${safeTeamId(teamId)}.json`);
}

function reportsPath(dataDir: string, teamId: string): string {
  return join(dataDir, `team-board-sessions-${safeTeamId(teamId)}.json`);
}

function readJson<T>(fp: string, fallback: T): T {
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    if (raw && typeof raw === 'object') return raw as T;
  } catch {
    // 文件不存在/损坏 → fallback
  }
  return fallback;
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

export function readTeamBoard(dataDir: string, teamId: string): Record<string, TeamBoardEntry> {
  return readJson<Record<string, TeamBoardEntry>>(boardPath(dataDir, teamId), {});
}

export function setTeamBoardEntry(
  dataDir: string,
  teamId: string,
  sessionId: string,
  column: unknown,
  position: unknown,
  now: number = Date.now(),
): TeamBoardEntry | null {
  const col = normalizeKanbanColumn(column);
  const pos = normalizeKanbanPosition(position);
  if (!sessionId || !col || pos === null) return null;
  const board = readTeamBoard(dataDir, teamId);
  const entry: TeamBoardEntry = { column: col, position: pos, updatedAt: now };
  board[sessionId] = entry;
  atomicWriteFileSync(boardPath(dataDir, teamId), JSON.stringify(board, null, 2) + '\n');
  return entry;
}

// ── 成员部署的会话上报 ────────────────────────────────────────────────────────

/** 入站裁剪行白名单（host 不信任成员 payload 的多余字段/超长值）。 */
export function sanitizeReportedSessions(raw: unknown): ReportedTeamSession[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportedTeamSession[] = [];
  for (const r of raw.slice(0, TEAM_REPORT_MAX_SESSIONS)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId.slice(0, 64) : '';
    const chatId = typeof o.chatId === 'string' ? o.chatId.slice(0, 64) : '';
    if (!sessionId || !chatId) continue;
    out.push({
      sessionId,
      chatId,
      botName: typeof o.botName === 'string' ? o.botName.slice(0, 64) : '',
      cliId: typeof o.cliId === 'string' ? o.cliId.slice(0, 32) : 'unknown',
      status: typeof o.status === 'string' ? o.status.slice(0, 16) : 'unknown',
      title: typeof o.title === 'string' ? o.title.slice(0, 200) : undefined,
      scope: o.scope === 'chat' || o.scope === 'thread' ? o.scope : undefined,
      adopt: o.adopt === true ? true : undefined,
      lastMessageAt: typeof o.lastMessageAt === 'number' && Number.isFinite(o.lastMessageAt) ? o.lastMessageAt : 0,
    });
  }
  return out;
}

export function recordTeamSessions(
  dataDir: string,
  teamId: string,
  deploymentId: string,
  deploymentName: string,
  sessions: ReportedTeamSession[],
  now: number = Date.now(),
): void {
  if (!deploymentId) return;
  const reports = readJson<Record<string, DeploymentReport>>(reportsPath(dataDir, teamId), {});
  reports[deploymentId] = { deploymentId, deploymentName, reportedAt: now, sessions };
  atomicWriteFileSync(reportsPath(dataDir, teamId), JSON.stringify(reports, null, 2) + '\n');
}

export function listTeamReports(dataDir: string, teamId: string): DeploymentReport[] {
  const reports = readJson<Record<string, DeploymentReport>>(reportsPath(dataDir, teamId), {});
  return Object.values(reports);
}
