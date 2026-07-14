import { existsSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCommand } from './registry.js';
import { buildBotmuxSystemPromptText } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { discoverClaudeFamilySessions } from '../../services/resumable-session-discovery.js';
import { delay, scaleMs } from '../../utils/timing.js';
import { builtinSkillBlockForInjectsSessionContext } from '../../skills/injection-mode.js';
import { whiteboardEnabled } from '../../services/whiteboard-store.js';

const GENIUS_DATA_DIR = join(homedir(), '.genius');
const GENIUS_SKILLS_DIR = join(GENIUS_DATA_DIR, 'skills');
const GENIUS_AUTH_PATHS = ['~/.genius/.credentials.json', '~/.genius/auth.json'] as const;
const GENIUS_BOTMUX_SEND_TOOL = 'Bash(botmux send:*)';

function realpathCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

function geniusProjectDir(cwd: string): string {
  return join(GENIUS_DATA_DIR, 'projects', realpathCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
}

function geniusJsonlPathForSession(sessionId: string, cwd: string): string {
  return join(geniusProjectDir(cwd), `${sessionId}.jsonl`);
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function deltaHasUserEvent(path: string, fromByte: number, expectedText: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const delta = buf.toString('utf8');
  const lines = delta.endsWith('\n') ? delta.split('\n') : delta.split('\n').slice(0, -1);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'user'
        && typeof parsed?.message?.content === 'string'
        && parsed.message.content === expectedText) {
        return true;
      }
      if (parsed?.type === 'queue-operation'
        && parsed?.operation === 'enqueue'
        && typeof parsed?.content === 'string'
        && parsed.content === expectedText) {
        return true;
      }
    } catch {
      // Ignore partial / malformed trailing lines; a later poll sees the completed record.
    }
  }
  return false;
}

async function waitForUserEvent(path: string, fromByte: number, expectedText: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + scaleMs(timeoutMs);
  while (Date.now() < deadline) {
    if (deltaHasUserEvent(path, fromByte, expectedText)) return true;
    await delay(100);
  }
  return false;
}

export function createGeniusAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'genius';
  let cachedBin: string | undefined;
  return {
    id: 'genius',
    authPaths: GENIUS_AUTH_PATHS,
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    supportsTypeAhead: true,
    claudeDataDir: GENIUS_DATA_DIR,
    claudeStateJsonPath: join(GENIUS_DATA_DIR, '.claude.json'),

    checkResumeTargetExists({ sessionId, cliSessionId, workingDir }) {
      if (!workingDir) return undefined;
      const sid = cliSessionId ?? sessionId;
      if (!sid) return undefined;
      try {
        const p = geniusJsonlPathForSession(sid, workingDir);
        if (existsSync(p)) return true;
        if (!existsSync(geniusProjectDir(workingDir))) return false;
        return undefined;
      } catch {
        return undefined;
      }
    },

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId, larkAppId, locale, model, disableCliBypass, workingDir, skillPluginDir }) {
      const args: string[] = [];
      if (workingDir) args.push('--add-dir', workingDir);
      if (resume) {
        args.push('--resume', resumeSessionId ?? sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      if (model && model.trim()) args.push('--model', model.trim());
      if (!disableCliBypass) {
        // Genius is Claude-family: use the same approval-bypass posture as
        // Claude Code so routine `botmux send` replies do not block on terminal
        // confirmation, including shell-risk prompts such as backticks inside
        // the message text.
        args.push('--dangerously-skip-permissions');
        args.push('--settings', JSON.stringify({
          skipDangerousModePermissionPrompt: true,
          permissions: { defaultMode: 'bypassPermissions' },
        }));
      } else {
        // Hardened mode keeps normal approvals but still pre-authorizes the one
        // bridge command the model needs to reply into Feishu.
        args.push('--permission-mode', 'default');
        args.push('--allowedTools', GENIUS_BOTMUX_SEND_TOOL);
      }
      // Genius injects session context via --append-system-prompt (no inline
      // <botmux_routing> from session-manager), so the built-in skill catalog
      // for `prompt` mode (or the help pointer for `off`) must ride along here.
      // Catalog rides on system prompt (injectsSessionContext + global skillsDir).
      args.push('--append-system-prompt', buildBotmuxSystemPromptText({
        locale,
        botName,
        botOpenId,
        builtinSkillBlock: builtinSkillBlockForInjectsSessionContext(larkAppId, locale, {
          asksViaHook: false,
          whiteboardEnabled: whiteboardEnabled(),
        }),
      }));
      if (skillPluginDir) args.push('--plugin-dir', skillPluginDir);
      return args;
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      return `genius --resume ${cliSessionId ?? sessionId}`;
    },

    listResumableSessions({ limit, exclude }) {
      return discoverClaudeFamilySessions(GENIUS_DATA_DIR, limit, exclude);
    },

    async writeInput(pty: PtyHandle, content: string) {
      const cwd = pty.cliCwd;
      const sessionId = pty.claudeJsonlPath
        ? basename(pty.claudeJsonlPath, '.jsonl')
        : undefined;
      const transcriptPath = cwd && sessionId
        ? geniusJsonlPathForSession(sessionId, cwd)
        : undefined;
      const baseByte = transcriptPath ? currentFileSize(transcriptPath) : 0;

      try {
        if (pty.sendText) pty.sendText(content);
        else pty.write(content);
      } catch {
        return { submitted: false };
      }
      await delay(200);
      try {
        if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
        else pty.write('\r');
      } catch {
        return { submitted: false };
      }
      if (!transcriptPath) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForUserEvent(transcriptPath, baseByte, content, 800)) return;
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
        } catch {
          return { submitted: false };
        }
      }
      const recheck = () => deltaHasUserEvent(transcriptPath, baseByte, content);
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    busyPattern: /Working…|esc to interrupt/i,
    readyPattern: /⏵⏵\s+accept edits on|(?:^|[\n\r])[❯›]\s*/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: true,
    skillsDir: `~/${GENIUS_SKILLS_DIR.slice(homedir().length + 1)}`,
    modelChoices: ['gpt-5.5'],
  };
}

export const create = createGeniusAdapter;
