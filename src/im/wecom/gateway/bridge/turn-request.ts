/**
 * The core turn a WeCom task becomes: the repository a new session starts in, and
 * the frozen TriggerRequest. Admission (inbound.ts) builds it for every new task;
 * the dispatch (tick.ts) builds it once more, for a new session, when the core no
 * longer has the session the task was admitted for.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { realpathSync } from 'node:fs';
import { nativePolicyRevision, type NativeCoreState } from '../native-core.js';
import { scanWecomRepositories, wecomRepositoryStillValid, type WecomRepository, type WecomRepositoryScan } from '../native-repos.js';
import { wecomTurnChannelInstruction } from '../presentation.js';
import { wecomPromptLine } from '../prompt-lines.js';
import type { TriggerRequest } from '../../../../services/trigger-types.js';
import type { WecomInboundMessage } from '../../protocol/types.js';
import type { WecomBridgePolicy } from './types.js';
import type { WecomBridge } from '../bridge.js';

type SelectedRepository = NativeCoreState['selectedRepos'][string];

/**
 * The bot's default role (Dashboard 「默认角色」) as it goes into the turn's task
 * instruction: the same `<role context="team">` block a Feishu session gets for its
 * bot-level role (core/session-manager.ts renderRoleContextBlock), without the chat
 * id — a WeCom role is per bot, and internal ids stay out of the prompt. Empty
 * (blank) content means no role.
 */
function wecomRoleBlock(content: string): string {
  const role = content.trim();
  return role ? `<role context="team">\n${role}\n</role>` : '';
}

/** The user's text as the core receives it: untrusted, never instructions. */
export function wecomTurnEnvelope(rawText: string): TriggerRequest['envelope'] {
  return { format: 'text', sourceName: '企业微信文字对话', trusted: false, rawText };
}

/**
 * The repository the route's turn runs in, or the reply that refuses the turn.
 *
 * A new session (no `sessionId`) of a route with no selection takes the
 * directory of a same-host connection that passes the peer trust rule, when it
 * is a repository this connection's own scan finds inside its working root.
 * A selection is persisted, and its revision covers no repository scope: a new
 * session is created in it only while it is still a repository inside the
 * current working root (the root may have changed, the directory may have been
 * replaced since it was selected). A selection that no longer holds is dropped.
 */
export async function turnRepository(
  this: WecomBridge,
  input: { route: string; message: WecomInboundMessage; key: string; policy: WecomBridgePolicy; sessionId?: string },
): Promise<{ selected?: SelectedRepository } | { refusal: string }> {
  const { route, message, key, policy, sessionId } = input;
  let selected = this.state.native!.selectedRepos[route];
  if (!selected && !sessionId && policy.botToBotSameDir !== false) {
    let scan: WecomRepositoryScan | undefined;
    const candidates = new Map<string, WecomRepository>();
    for (const peerId of this.localPeerIds()) {
      try {
        if (!this.peerAccepted(peerId, 'directory')) {
          continue;
        }
        const response = await this.sendPeer(
          peerId,
          this.peerBody(peerId, message, 'directory', `directory_${key.slice(0, 40)}`),
        );
        if (typeof response.directory === 'string') {
          const directory = realpathSync(response.directory);
          scan ??= scanWecomRepositories(policy.workingDirectory);
          const repo = scan.ok ? scan.repositories.find(item => item.directory === directory) : undefined;
          if (repo) {
            candidates.set(repo.directory, repo);
          }
        }
      } catch { /* unavailable or untrusted peers do not grant directories */ }
    }
    if (candidates.size > 1) {
      return { refusal: '多个受信任 Bot 的目录冲突，请用 /repo 明确选择。' };
    }
    const [repo] = candidates.values();
    if (repo) {
      selected = { name: repo.name, directory: repo.directory, revision: nativePolicyRevision(policy) };
      this.state.native!.selectedRepos[route] = selected;
    }
  }
  if (selected
    && (selected.revision !== nativePolicyRevision(policy)
      || (!sessionId && !wecomRepositoryStillValid(selected, policy.workingDirectory)))) {
    delete this.state.native!.selectedRepos[route];
    return { refusal: '选仓配置已变化，请重新使用 /repo 选择仓库。' };
  }
  return { selected };
}

/**
 * The frozen request of a task keyed `key`: a turn of `sessionId`, or of a new
 * session (in `selected`, when there is one) without it. Also the working
 * directory and model that turn runs with, which the task records.
 */
export function wecomTurnRequest(
  this: WecomBridge,
  input: {
    message: WecomInboundMessage;
    key: string;
    envelope: TriggerRequest['envelope'];
    policy: WecomBridgePolicy;
    sessionId?: string;
    selected?: SelectedRepository;
  },
): { request: TriggerRequest; workingDirectory?: string; model?: string } {
  const { message, key, envelope, policy, sessionId, selected } = input;
  const role = wecomRoleBlock(policy.role && (policy.role.injectMode !== 'once' || !sessionId) ? policy.role.content : '');
  const request: TriggerRequest = {
    source: { type: 'webhook', connectorId: `wecom:${this.options.botId}`, requestId: message.messageId },
    target: { kind: 'turn', ...(sessionId ? { sessionId } : {}) },
    envelope,
    payloadTrusted: true,
    instruction: [
      wecomPromptLine('wecom.task.delivery_auto'),
      wecomTurnChannelInstruction(message.chatType),
      role,
    ].filter(Boolean).join('\n\n'),
    presentation: { thinking: 'hidden', topicMessage: null },
    options: {
      asyncReturnSessionId: true,
      ...(!sessionId && selected ? { connectorWorkingDirectory: selected.directory } : {}),
      ...(sessionId ? { turnIdempotencyKey: key } : { idempotencyKey: key }),
    },
  };
  return { request, workingDirectory: selected?.directory ?? policy.workingDirectory, model: policy.model };
}
