import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { buildUntrustedEventPrompt } from '../src/core/trigger-session.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';

/**
 * The WeCom bot's default role (Dashboard 「默认角色」, the connection's `role`) as the
 * gateway puts it into each turn's task, across the moments of a chat route: the
 * first message, a follow-up, the next message after the gateway (and its core)
 * restarted, and the first message after `/restart` opened a new session.
 */
const ROLE = 'Answer as the fake support desk.\nKeep it short (fake role).';
const ROLE_BLOCK = `<role context="team">\n${ROLE}\n</role>`;
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Role = { content: string; injectMode: 'every' | 'once' } | undefined;

/** Drive the real bridge through the four moments; returns the request of each. */
async function requestsAcrossMoments(role: Role): Promise<Record<'first' | 'followUp' | 'afterRestart' | 'newSession', TriggerRequest>> {
  const root = mkdtempSync(join(tmpdir(), 'wecom-role-block-'));
  roots.push(root);
  const stateFile = join(root, 'bridge.json');
  const requests: TriggerRequest[] = [];
  let sessions = 0;
  const core = {
    trigger: async (request: TriggerRequest) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      return { ok: true, triggerId: `turn-${requests.length}`, target: { kind: 'turn' as const, sessionId: request.target.sessionId ?? `session-${++sessions}` } };
    },
    result: async () => ({ ok: true, state: 'completed' as const, output: { content: 'fake answer' } }),
    interrupt: async () => {},
  };
  const create = () => new WecomBridge({
    botId: 'role-fixture', allowedUsers: ['alice'], stateFile,
    policy: () => ({ allowedUsers: ['alice'], ...(role ? { role } : {}) }),
    core, transport: { reply: async () => {}, send: async () => {} },
  } as any);
  const message = (messageId: string, text: string): WecomInboundMessage => ({
    messageId, userId: 'alice', conversationId: 'group-1', chatType: 'group', text, replyContext: { requestId: messageId }, attachments: [],
  });
  let bridge = create();
  const say = async (id: string, text: string) => { await bridge.receive(message(id, text)); await bridge.tick(); };
  await say('m1', 'first (fake)');
  await say('m2', 'follow-up (fake)');
  bridge = create(); // restarted gateway: the route to session-1 is persisted
  await say('m3', 'after restart (fake)');
  await say('m4', '/restart');
  await say('m5', 'new session (fake)');
  expect(requests.map(r => r.target.sessionId)).toEqual([undefined, 'session-1', 'session-1', undefined]);
  const [first, followUp, afterRestart, newSession] = requests;
  return { first: first!, followUp: followUp!, afterRestart: afterRestart!, newSession: newSession! };
}

const roleBlocks = (instruction: string | undefined) => (instruction ?? '').match(/<role\b[^>]*>[\s\S]*?<\/role>/g) ?? [];

describe('WeCom role in the task instruction', () => {
  it('every-turn role: one delimited role block on every turn, including after a restart', async () => {
    const r = await requestsAcrossMoments({ content: `  ${ROLE}\n`, injectMode: 'every' });
    for (const request of Object.values(r)) expect(roleBlocks(request.instruction)).toEqual([ROLE_BLOCK]);
  });

  it('once role: only on the first message of a session, as Feishu sends it only on the opening turn', async () => {
    const r = await requestsAcrossMoments({ content: ROLE, injectMode: 'once' });
    expect(roleBlocks(r.first.instruction)).toEqual([ROLE_BLOCK]);
    expect(roleBlocks(r.followUp.instruction)).toEqual([]);
    expect(roleBlocks(r.afterRestart.instruction)).toEqual([]);
    expect(roleBlocks(r.newSession.instruction)).toEqual([ROLE_BLOCK]);
  });

  it('no role, or a blank one, adds no role block', async () => {
    for (const role of [undefined, { content: ' \n ', injectMode: 'every' as const }]) {
      const r = await requestsAcrossMoments(role);
      for (const request of Object.values(r)) expect(request.instruction).not.toContain('<role');
    }
  });

  it('reaches the CLI of the native gateway core as one role block inside the task block', async () => {
    const { first } = await requestsAcrossMoments({ content: ROLE, injectMode: 'every' });
    vi.stubEnv('BOTMUX_CORE_ONLY', '1');
    vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
    const prompt = buildUntrustedEventPrompt(first, 'trg_fake');
    const task = /<botmux_task trusted="true">\n([\s\S]*?)\n<\/botmux_task>/.exec(prompt)?.[1] ?? '';
    expect(roleBlocks(task)).toEqual([ROLE_BLOCK]);
    expect(roleBlocks(prompt)).toEqual([ROLE_BLOCK]);
  });
});
