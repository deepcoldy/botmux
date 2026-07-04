import { describe, it, expect } from 'vitest';
import { redactGroupsForPublic, redactSchedulesForPublic } from '../src/dashboard/public-redact.js';

// A representative slice of the /api/groups `chats` payload that dashboard.ts
// builds (memberBots[].oncallChat = { chatId, workingDir } for bound bots).
function sampleChats() {
  return [
    {
      chatId: 'oc_chat1',
      name: '客户群 A',
      chatMode: 'group',
      avatar: 'https://avatar.example/chat1.png',
      description: 'private description',
      ownerId: 'ou_owner',
      memberBots: [
        {
          larkAppId: 'cli_a',
          botName: 'Claude',
          inChat: true,
          hasRole: true,
          oncallChat: { chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' },
        },
        {
          larkAppId: 'cli_b',
          botName: 'Codex',
          inChat: false,
          hasRole: false,
          oncallChat: null,
        },
      ],
    },
  ];
}

function sampleSchedules() {
  return [
    {
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      prompt: '部署到 /root/iserver/customer-secret 并通知客户',
      workingDir: '/root/iserver/customer-secret',
      chatId: 'oc_chat1',
    },
  ];
}

describe('redactGroupsForPublic', () => {
  it('drops ALL non-board fields for anonymous visitors (oncall/description/ownerId/hasRole)', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    // chat-level config/PII gone
    expect(out[0]).not.toHaveProperty('description');
    expect(out[0]).not.toHaveProperty('ownerId');
    // per-bot oncall binding + role-existence matrix gone
    for (const mb of out[0].memberBots) {
      expect(mb).not.toHaveProperty('oncallChat');
      expect(mb).not.toHaveProperty('hasRole');
    }
    const json = JSON.stringify(out);
    for (const leaked of ['workingDir', 'customer-secret', 'private description', 'ou_owner']) {
      expect(json).not.toContain(leaked);
    }
  });

  it('keeps exactly the board name-map / roster fields (explicit allow-list)', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    expect(out).toEqual([
      {
        chatId: 'oc_chat1',
        name: '客户群 A',
        chatMode: 'group',
        avatar: 'https://avatar.example/chat1.png',
        memberBots: [
          { larkAppId: 'cli_a', botName: 'Claude', inChat: true },
          { larkAppId: 'cli_b', botName: 'Codex', inChat: false },
        ],
      },
    ]);
  });

  it('does not mutate the input (authed callers keep the original oncallChat/description)', () => {
    const input = sampleChats();
    redactGroupsForPublic(input);
    expect(input[0].memberBots[0].oncallChat).toEqual({ chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' });
    expect(input[0].description).toBe('private description');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactGroupsForPublic([])).toEqual([]);
    // junk fields are dropped; only allow-listed keys survive
    expect(redactGroupsForPublic([{ chatId: 'x', secret: 'y' }] as unknown[])).toEqual([{ chatId: 'x' }]);
    expect(redactGroupsForPublic(null as unknown as unknown[])).toBeNull();
  });
});

describe('redactSchedulesForPublic', () => {
  it('strips prompt + workingDir for anonymous visitors', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).not.toHaveProperty('prompt');
    expect(out[0]).not.toHaveProperty('workingDir');
    expect(JSON.stringify(out)).not.toContain('customer-secret');
  });

  it('preserves name / timing / status fields', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).toEqual({
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      chatId: 'oc_chat1',
    });
  });

  it('does not mutate the input (authed callers keep prompt + workingDir)', () => {
    const input = sampleSchedules();
    redactSchedulesForPublic(input);
    expect(input[0]).toHaveProperty('prompt');
    expect(input[0].workingDir).toBe('/root/iserver/customer-secret');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactSchedulesForPublic([])).toEqual([]);
    expect(redactSchedulesForPublic([null] as unknown[])).toEqual([null]);
    expect(redactSchedulesForPublic(undefined as unknown as unknown[])).toBeUndefined();
  });
});
