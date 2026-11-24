/**
 * collab per-chat gate 准入（PR-3b-1 §8.1/§8.3）：checkCollabGateAdmission + 命令豁免白名单。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCollabGateAdmission, collabCommandExempt } from '../src/core/collab-gate-admission.js';
import { buildInitialCollabGate, writeCollabGate, patchCollabGate } from '../src/services/collab-gate-store.js';
import { readCollabChatQueue } from '../src/services/collab-chat-queue-store.js';
import type { CollabGateFile } from '../src/services/collab-group-config.js';
import type { TalkEvaluation } from '../src/im/lark/event-dispatcher.js';
import type { SlashRouteDecision } from '../src/core/command-router.js';

let dataDir: string;
const APP = 'cli_target';
const CHAT = 'oc_chat';
const CREATOR = 'cli_creator';

const allowedTalk: TalkEvaluation = { allowed: true, reason: 'chatGrant', quotaKey: 'chat:oc_chat:ou_u' } as TalkEvaluation;
const deniedTalk: TalkEvaluation = { allowed: false, reason: 'none' } as TalkEvaluation;

function gate(overrides: Partial<CollabGateFile> = {}): CollabGateFile {
  return {
    ...buildInitialCollabGate({ initId: 'i'.repeat(64), configVersion: 'cv', creatorAppId: CREATOR, chatId: CHAT, participantAppIds: [APP] }),
    ...overrides,
  };
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'collab-gate-admission-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('checkCollabGateAdmission', () => {
  it('无 gate → not-collab', () => {
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk });
    expect(r.kind).toBe('not-collab');
  });

  it('本 bot 非 participant → not-collab', () => {
    const g = gate({ participants: { cli_other: { roleReady: false, kickoffState: 'pending', acceptingUserTasks: false } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('not-collab');
  });

  it('acceptingUserTasks=true → open', () => {
    const g = gate({ phase: 'active', participants: { [APP]: { roleReady: true, kickoffState: 'started', acceptingUserTasks: true } } });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('open');
  });

  it('未授权 → reject(not_allowed)', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: deniedTalk, gate: g });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('not_allowed');
  });

  it('initializing + gatePolicy=queue → queue（入队去重）', () => {
    const g = gate({ phase: 'initializing' });
    const enqueued: string[] = [];
    const enqueueImpl = (_d: string, _c: string, item: any) => { enqueued.push(item.sourceMessageId); return true; };
    const opts = { dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, sourceMessageId: 'om_1', enqueueImpl };
    const r1 = checkCollabGateAdmission(opts);
    expect(r1.kind).toBe('queue');
    // 同 sourceMessageId 再入队不重复（由 enqueueCollabChatItem 去重，此处 seam 只记录调用）
    expect(enqueued).toEqual(['om_1']);
  });

  it('initializing + gatePolicy=reject → reject', () => {
    const g = gate({ phase: 'initializing' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g, config: { enabled: true, agents: [], kickoff: [], gatePolicy: 'reject' } as any });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('gate_not_open');
  });

  it('awaiting-input → awaiting-input', () => {
    const g = gate({ phase: 'awaiting-input' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('awaiting-input');
  });

  it('failed → awaiting-input（不新增排队）', () => {
    const g = gate({ phase: 'failed' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('awaiting-input');
  });

  it('cancelled → cancelled', () => {
    const g = gate({ phase: 'cancelled' });
    const r = checkCollabGateAdmission({ dataDir, chatId: CHAT, botAppId: APP, talk: allowedTalk, gate: g });
    expect(r.kind).toBe('cancelled');
  });
});

describe('collabCommandExempt 白名单', () => {
  it('special / daemon(sessionless) / forward(bot_gated) 豁免', () => {
    expect(collabCommandExempt({ kind: 'special', cmd: '/help', content: '', handler: {} as any })).toBe(true);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/status', content: '', sessionPolicy: 'sessionless' })).toBe(true);
    expect(collabCommandExempt({ kind: 'forward', reason: 'bot_gated' })).toBe(true);
  });

  it('passthrough / delegated_turn / daemon(precreate|existing) / forward(unknown_slash) 不豁免', () => {
    expect(collabCommandExempt({ kind: 'passthrough', cmd: '/goal', content: '', delivery: 'cold_start' })).toBe(false);
    expect(collabCommandExempt({ kind: 'delegated_turn', cmd: '/adopt', content: '', sessionPolicy: 'precreate' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/close', content: '', sessionPolicy: 'existing' })).toBe(false);
    expect(collabCommandExempt({ kind: 'daemon', cmd: '/t', content: '', sessionPolicy: 'precreate' })).toBe(false);
    expect(collabCommandExempt({ kind: 'forward', reason: 'unknown_slash', cmd: '/foo' })).toBe(false);
    expect(collabCommandExempt({ kind: 'forward', reason: 'no_slash' })).toBe(false);
  });
});
