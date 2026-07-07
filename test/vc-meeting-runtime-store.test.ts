import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findVcMeetingRuntimeSessionByListenerAndAgent,
  listVcMeetingRuntimeSessions,
  recordVcMeetingRuntimeSession,
  removeVcMeetingRuntimeSession,
} from '../src/services/vc-meeting-runtime-store.js';
import { logger } from '../src/utils/logger.js';

const STORE_FILE = 'vc-meeting-runtime-sessions.json';

describe('vc meeting runtime store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-vc-runtime-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records, updates, lists, and removes runtime listener routes', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Weekly' },
      listenerChatId: 'oc_listener_1',
      attentionTargetOpenId: 'ou_owner',
      consumerMode: 'pending',
      textOutputPolicy: 'approval',
      voiceOutputPolicy: 'deny',
      syncIntervalMs: 120_000,
      consumerSelectionExpiresAt: 21_000,
      consumerCardMessageId: 'om_card_1',
    }, 1_000);

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 1_500)).toEqual([{
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Weekly' },
      listenerChatId: 'oc_listener_1',
      attentionTargetOpenId: 'ou_owner',
      consumerMode: 'pending',
      textOutputPolicy: 'approval',
      voiceOutputPolicy: 'deny',
      syncIntervalMs: 120_000,
      consumerSelectionExpiresAt: 21_000,
      consumerCardMessageId: 'om_card_1',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 86_401_000,
    }]);

    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Renamed' },
      listenerChatId: 'oc_listener_2',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
      selectedAgentLabel: 'Claude',
      consumerPaused: false,
      textOutputPolicy: 'allow',
      voiceOutputPolicy: 'approval',
      syncIntervalMs: 30_000,
      consumerCardMessageId: 'om_card_2',
    }, 2_000);

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 2_500)).toEqual([{
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Renamed' },
      listenerChatId: 'oc_listener_2',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
      selectedAgentLabel: 'Claude',
      consumerPaused: false,
      textOutputPolicy: 'allow',
      voiceOutputPolicy: 'approval',
      syncIntervalMs: 30_000,
      consumerCardMessageId: 'om_card_2',
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 86_402_000,
    }]);

    removeVcMeetingRuntimeSession(dir, 'cli_a', 'm1');

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 3_000)).toEqual([]);
  });

  it('prunes expired records across apps while listing one app', () => {
    writeFileSync(join(dir, STORE_FILE), JSON.stringify({
      'cli_a:m_old': {
        larkAppId: 'cli_a',
        meeting: { id: 'm_old' },
        listenerChatId: 'oc_old',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 1_500,
      },
      'cli_b:m_live': {
        larkAppId: 'cli_b',
        meeting: { id: 'm_live', meetingNo: '987654321' },
        listenerChatId: 'oc_live',
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 100_000,
      },
    }, null, 2));

    expect(listVcMeetingRuntimeSessions(dir, 'cli_b', 2_000)).toEqual([{
      larkAppId: 'cli_b',
      meeting: { id: 'm_live', meetingNo: '987654321' },
      listenerChatId: 'oc_live',
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 100_000,
    }]);

    const persisted = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf-8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('cli_a:m_old');
    expect(persisted).toHaveProperty('cli_b:m_live');
  });

  it('finds the latest active listener route for a selected agent', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_meeting_a',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
    }, 1_000);
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_meeting_b',
      meeting: { id: 'm2' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
    }, 2_000);
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_meeting_c',
      meeting: { id: 'm3' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
      consumerPaused: true,
    }, 3_000);

    expect(findVcMeetingRuntimeSessionByListenerAndAgent(dir, {
      listenerChatId: 'oc_listener',
      selectedAgentAppId: 'cli_agent',
    }, 2_500)?.meeting.id).toBe('m2');
    expect(findVcMeetingRuntimeSessionByListenerAndAgent(dir, {
      listenerChatId: 'oc_listener',
      selectedAgentAppId: 'cli_other',
    }, 2_500)).toBeUndefined();

    removeVcMeetingRuntimeSession(dir, 'cli_meeting_b', 'm2');
    expect(findVcMeetingRuntimeSessionByListenerAndAgent(dir, {
      listenerChatId: 'oc_listener',
      selectedAgentAppId: 'cli_agent',
    }, 2_600)?.meeting.id).toBe('m1');

    removeVcMeetingRuntimeSession(dir, 'cli_meeting_a', 'm1');
    expect(findVcMeetingRuntimeSessionByListenerAndAgent(dir, {
      listenerChatId: 'oc_listener',
      selectedAgentAppId: 'cli_agent',
    }, 2_700)).toBeUndefined();
  });

  it('warns and returns empty routes when the store json is corrupt', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(dir, STORE_FILE), '{bad json', 'utf-8');

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 1_000)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[vc-meeting-runtime-store] failed to read'));
  });

  it('creates no file for empty required fields', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: '   ' },
      listenerChatId: 'oc_listener',
    }, 1_000);

    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
  });
});
