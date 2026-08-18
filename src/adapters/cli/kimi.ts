import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const KIMI_FIRST_WRITE_SETTLE_MS = 250;
const kimiFirstWriteSeen = new WeakSet<PtyHandle>();

export function createKimiAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kimi';
  let cachedBin: string | undefined;
  return {
    id: 'kimi',
    authPaths: ['~/.kimi-code/credentials', '~/.kimi-code/oauth'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, model, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) {
        args.push('--yolo');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!resume) return args;
      if (resumeSessionId) return [...args, '--resume', resumeSessionId];
      // No persisted session id: start FRESH, never `--continue`. Kimi's
      // `--continue` resumes the most recent session, which is shared across
      // every botmux session of this bot (same Kimi config home). A worker
      // restart whose cliSessionId was never captured would then silently load
      // a SIBLING session's conversation — e.g. a topic group's context
      // leaking into a private chat. Losing this session's context is the
      // lesser evil; matches reasonix/antigravity, which reject `--continue`
      // for the same "most recent is racy" reason.
      //
      // 已知回退：Kimi 适配器目前没有任何 cliSessionId 捕获机制（无 bridge、
      // 无 observation、无 output capture），「缺 id」是常态而非边角。移除
      // `--continue` 后，Kimi 会话在每次 worker 重启（崩溃 / idle 回收 /
      // 部署）后都新起干净会话，丧失跨重启恢复能力——`--continue` 曾是唯一的
      // 跨重启恢复路径。后续需补 session id 捕获才能恢复精确 resume。
      return args;
    },

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `kimi --resume ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      try {
        if (!kimiFirstWriteSeen.has(pty)) {
          kimiFirstWriteSeen.add(pty);
          await delay(KIMI_FIRST_WRITE_SETTLE_MS);
        }
        if (pty.pasteText && pty.sendSpecialKeys) {
          pty.pasteText(content);
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          const pasted = `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
          pty.write(pasted);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return;
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    modelChoices: [
      'kimi-k2.5',
      'kimi-k2.5-code',
      'kimi-k2.7-code',
    ],
  };
}

export const create = createKimiAdapter;
