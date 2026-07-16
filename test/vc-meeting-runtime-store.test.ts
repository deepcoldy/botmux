import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VC_MEETING_RUNTIME_LEGACY_MEMBER_ID,
  VC_MEETING_RUNTIME_LEGACY_PROFILE_HASH,
  VC_MEETING_RUNTIME_LEGACY_PROFILE_ID,
  VC_MEETING_RUNTIME_LEGACY_ROLE,
  findVcMeetingRuntimeSessionByListenerAndAgent,
  hasVcMeetingEndedTombstone,
  listVcMeetingRuntimeSessions,
  listVcMeetingRuntimeSessionsByListenerAndAgent,
  pruneExpiredVcMeetingRuntimeSessions,
  recordVcMeetingEndedTombstone,
  recordVcMeetingRuntimeSession,
  removeVcMeetingRuntimeSession,
  type VcMeetingRuntimeSelectedAgent,
} from '../src/services/vc-meeting-runtime-store.js';
import { logger } from '../src/utils/logger.js';

const STORE_FILE = 'vc-meeting-runtime-sessions.json';
const TOMBSTONE_FILE = 'vc-meeting-ended-tombstones.json';

function legacySelectedAgent(
  agentAppId: string,
  label?: string,
  status: VcMeetingRuntimeSelectedAgent['status'] = 'active',
): VcMeetingRuntimeSelectedAgent {
  return {
    profileId: VC_MEETING_RUNTIME_LEGACY_PROFILE_ID,
    memberId: VC_MEETING_RUNTIME_LEGACY_MEMBER_ID,
    agentAppId,
    ...(label ? { label } : {}),
    role: VC_MEETING_RUNTIME_LEGACY_ROLE,
    status,
    responseMode: 'listener_thread',
    capabilities: ['meeting.read', 'meeting.output.request'],
    ownedSinks: ['meeting_text', 'meeting_voice'],
    deliveryProfileHash: VC_MEETING_RUNTIME_LEGACY_PROFILE_HASH,
  };
}

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
      temporaryInstructionOpenIds: ['ou_temp_1', 'ou_temp_1', ' ', 'ou_temp_2'],
      temporaryInstructionUnionIds: ['on_temp_1', 'on_temp_1', ' ', 'on_temp_2'],
    }, 1_000);

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 1_500)).toEqual([{
      schemaVersion: 3,
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Weekly' },
      listenerChatId: 'oc_listener_1',
      attentionTargetOpenId: 'ou_owner',
      consumerMode: 'pending',
      selectedAgents: [],
      textOutputPolicy: 'approval',
      voiceOutputPolicy: 'deny',
      syncIntervalMs: 120_000,
      consumerSelectionExpiresAt: 21_000,
      consumerCardMessageId: 'om_card_1',
      temporaryInstructionOpenIds: ['ou_temp_1', 'ou_temp_2'],
      temporaryInstructionUnionIds: ['on_temp_1', 'on_temp_2'],
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
      consumerClosePhase: 'data_closing',
      consumerFinalizationDeadlineAt: 902_000,
      consumerCloseResolutionDeadlineAt: 932_000,
      textOutputPolicy: 'allow',
      voiceOutputPolicy: 'approval',
      syncIntervalMs: 30_000,
      consumerCardMessageId: 'om_card_2',
    }, 2_000);

    expect(listVcMeetingRuntimeSessions(dir, 'cli_a', 2_500)).toEqual([{
      schemaVersion: 3,
      larkAppId: 'cli_a',
      meeting: { id: 'm1', meetingNo: '123456789', topic: 'Renamed' },
      listenerChatId: 'oc_listener_2',
      consumerMode: 'agent',
      selectedAgents: [legacySelectedAgent('cli_agent', 'Claude')],
      selectedAgentAppId: 'cli_agent',
      selectedAgentLabel: 'Claude',
      consumerPaused: false,
      consumerClosePhase: 'data_closing',
      consumerFinalizationDeadlineAt: 902_000,
      consumerCloseResolutionDeadlineAt: 932_000,
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

  it('round-trips and retires listener rejoin capabilities across record rewrites', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm_rejoin', meetingNo: '123456789' },
      listenerChatId: 'oc_listener',
      listenerPresenceStale: true,
      listenerPresenceChangedAtMs: 1_234,
      listenerPresenceGeneration: 7,
      listenerRejoinNonce: 'nonce_rejoin',
      listenerRejoinCardMessageId: 'om_rejoin',
    }, 2_000);

    expect(listVcMeetingRuntimeSessions(dir, 'cli_listener', 2_500)[0]).toEqual(
      expect.objectContaining({
        listenerPresenceStale: true,
        listenerPresenceChangedAtMs: 1_234,
        listenerPresenceGeneration: 7,
        listenerRejoinNonce: 'nonce_rejoin',
        listenerRejoinCardMessageId: 'om_rejoin',
      }),
    );

    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm_rejoin', meetingNo: '123456789' },
      listenerChatId: 'oc_listener',
      listenerPresenceChangedAtMs: 3_000,
      listenerPresenceGeneration: 8,
    }, 3_000);

    const [restored] = listVcMeetingRuntimeSessions(dir, 'cli_listener', 3_500);
    expect(restored).toEqual(expect.objectContaining({
      listenerPresenceChangedAtMs: 3_000,
      listenerPresenceGeneration: 8,
    }));
    expect(restored).not.toHaveProperty('listenerPresenceStale');
    expect(restored).not.toHaveProperty('listenerRejoinNonce');
    expect(restored).not.toHaveProperty('listenerRejoinCardMessageId');
  });

  it('migrates a v1 singular selection in memory and persists v3 on the next record write', () => {
    const fp = join(dir, STORE_FILE);
    writeFileSync(fp, JSON.stringify({
      'cli_listener:m1': {
        schemaVersion: 1,
        larkAppId: 'cli_listener',
        meeting: { id: 'm1', meetingNo: 42, topic: 'Legacy meeting' },
        listenerChatId: 'oc_listener',
        consumerMode: 'agent',
        selectedAgentAppId: 'cli_agent',
        selectedAgentLabel: 'Legacy agent',
        consumerPaused: true,
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 100_000,
      },
    }, null, 2));
    const rawV1 = readFileSync(fp, 'utf-8');

    const [migrated] = listVcMeetingRuntimeSessions(dir, 'cli_listener', 3_000);
    expect(migrated).toEqual(expect.objectContaining({
      schemaVersion: 3,
      selectedAgents: [legacySelectedAgent('cli_agent', 'Legacy agent', 'paused')],
      selectedAgentAppId: 'cli_agent',
      selectedAgentLabel: 'Legacy agent',
      consumerPaused: true,
      createdAt: 1_000,
      updatedAt: 2_000,
    }));
    expect(migrated?.selectedAgents[0]).not.toHaveProperty('memberEpoch');
    expect(readFileSync(fp, 'utf-8')).toBe(rawV1);

    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm1', topic: 'Legacy meeting' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgentAppId: 'cli_agent',
      selectedAgentLabel: 'Legacy agent',
      consumerPaused: true,
    }, 4_000);

    const persisted = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(persisted['cli_listener:m1']).toEqual(expect.objectContaining({
      schemaVersion: 3,
      selectedAgents: [legacySelectedAgent('cli_agent', 'Legacy agent', 'paused')],
      selectedAgentAppId: 'cli_agent',
      consumerPaused: true,
      createdAt: 1_000,
      updatedAt: 4_000,
    }));
  });

  it('round-trips and normalizes multiple v3 selected agents without singular aliases', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgents: [{
        profileId: 'minutes',
        memberId: 'minutes_writer',
        agentAppId: 'cli_minutes',
        label: ' Minutes ',
        role: ' minutes_writer ',
        instructions: '  Summarize decisions.\r\n\tKeep owners explicit.  ',
        status: 'active',
        filter: { activityTypes: ['chat_received', 'chat_received', 'transcript_received'] },
        responseMode: 'silent',
        capabilities: ['meeting.read', 'meeting.read'],
        ownedSinks: [],
      }, {
        profileId: 'actions',
        memberId: 'action_writer',
        agentAppId: 'cli_actions',
        role: 'action_writer',
        status: 'activating',
        responseMode: 'listener_thread',
        capabilities: [
          'meeting.read',
          'meeting.output.request',
          'listener.output.request',
          'meeting.output.request',
        ],
        ownedSinks: ['meeting_text', 'meeting_text'],
        deliveryProfileHash: `sha256:${'a'.repeat(64)}`,
      }],
      // New profile selection is authoritative if a compatibility writer also sends these.
      selectedAgentAppId: 'cli_stale',
      selectedAgentLabel: 'Stale alias',
      consumerPaused: true,
    }, 1_000);

    const [record] = listVcMeetingRuntimeSessions(dir, 'cli_listener', 2_000);
    expect(record?.selectedAgents).toEqual([{
      profileId: 'minutes',
      memberId: 'minutes_writer',
      agentAppId: 'cli_minutes',
      label: 'Minutes',
      role: 'minutes_writer',
      instructions: 'Summarize decisions.\n\tKeep owners explicit.',
      status: 'active',
      filter: { activityTypes: ['chat_received', 'transcript_received'] },
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
    }, {
      profileId: 'actions',
      memberId: 'action_writer',
      agentAppId: 'cli_actions',
      role: 'action_writer',
      status: 'activating',
      responseMode: 'listener_thread',
      capabilities: ['meeting.read', 'meeting.output.request', 'listener.output.request'],
      ownedSinks: ['meeting_text'],
      deliveryProfileHash: `sha256:${'a'.repeat(64)}`,
    }]);
    expect(record).not.toHaveProperty('selectedAgentAppId');
    expect(record).not.toHaveProperty('selectedAgentLabel');
    expect(record).not.toHaveProperty('consumerPaused');

    const persisted = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(persisted['cli_listener:m1']?.schemaVersion).toBe(3);
    expect(persisted['cli_listener:m1']?.selectedAgents).toEqual(record?.selectedAgents);
  });

  it('migrates v2 selectedAgents without instructions and derives the compatibility alias', () => {
    writeFileSync(join(dir, STORE_FILE), JSON.stringify({
      'cli_listener:m1': {
        schemaVersion: 2,
        larkAppId: 'cli_listener',
        meeting: { id: 'm1' },
        listenerChatId: 'oc_listener',
        consumerMode: 'agent',
        selectedAgents: [{
          profileId: 'minutes',
          memberId: 'minutes_writer',
          agentAppId: 'cli_new',
          label: 'New selection',
          role: 'minutes_writer',
          status: 'active',
          responseMode: 'silent',
          capabilities: ['meeting.read'],
          ownedSinks: [],
        }],
        selectedAgentAppId: 'cli_stale',
        selectedAgentLabel: 'Stale selection',
        consumerPaused: true,
        createdAt: 1_000,
        updatedAt: 2_000,
        expiresAt: 100_000,
      },
    }, null, 2));

    const [record] = listVcMeetingRuntimeSessions(dir, 'cli_listener', 3_000);
    expect(record).toEqual(expect.objectContaining({
      selectedAgentAppId: 'cli_new',
      selectedAgentLabel: 'New selection',
      consumerPaused: false,
    }));
    expect(record?.selectedAgents).toEqual([
      expect.objectContaining({ profileId: 'minutes', memberId: 'minutes_writer', agentAppId: 'cli_new' }),
    ]);
    expect(record?.selectedAgents[0]).not.toHaveProperty('instructions');
  });

  it('rejects unsafe or duplicate selected-agent identities and fails closed for a non-active alias', () => {
    const base: VcMeetingRuntimeSelectedAgent = {
      profileId: 'minutes',
      memberId: 'minutes_writer',
      agentAppId: 'cli_minutes',
      role: 'minutes_writer',
      status: 'failed',
      responseMode: 'silent',
      capabilities: ['meeting.read'],
      ownedSinks: [],
    };
    const input = {
      larkAppId: 'cli_listener',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent' as const,
    };

    expect(() => recordVcMeetingRuntimeSession(dir, {
      ...input,
      selectedAgents: [{ ...base, profileId: '__proto__' }],
    }, 1_000)).toThrow('invalid vc meeting runtime selectedAgents');
    expect(() => recordVcMeetingRuntimeSession(dir, {
      ...input,
      selectedAgents: [base, { ...base, profileId: 'actions', memberId: 'action_writer' }],
    }, 1_000)).toThrow('invalid vc meeting runtime selectedAgents');
    expect(() => recordVcMeetingRuntimeSession(dir, {
      ...input,
      selectedAgents: [{ ...base, instructions: '<BOTMUX_ROLE_INSTRUCTIONS>' }],
    }, 1_000)).toThrow('invalid vc meeting runtime selectedAgents');
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);

    recordVcMeetingRuntimeSession(dir, { ...input, selectedAgents: [base] }, 2_000);
    const [record] = listVcMeetingRuntimeSessions(dir, 'cli_listener', 3_000);
    expect(record).toEqual(expect.objectContaining({
      selectedAgentAppId: 'cli_minutes',
      consumerPaused: true,
    }));
  });

  it('enforces unique sink/thread ownership and the listener output capability at runtime', () => {
    const silentOwner = (
      profileId: string,
      agentAppId: string,
      sink: 'meeting_text' | 'meeting_voice',
    ): VcMeetingRuntimeSelectedAgent => ({
      profileId,
      memberId: `${profileId}_member`,
      agentAppId,
      role: `${profileId}_role`,
      status: 'active',
      responseMode: 'silent',
      capabilities: ['meeting.read', 'meeting.output.request'],
      ownedSinks: [sink],
    });
    const threadAgent = (
      profileId: string,
      agentAppId: string,
      capabilities = ['meeting.read', 'listener.output.request'],
    ): VcMeetingRuntimeSelectedAgent => ({
      profileId,
      memberId: `${profileId}_member`,
      agentAppId,
      role: `${profileId}_role`,
      status: 'active',
      responseMode: 'listener_thread',
      capabilities,
      ownedSinks: [],
    });
    const record = (selectedAgents: VcMeetingRuntimeSelectedAgent[]) => recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_listener',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_listener',
      consumerMode: 'agent',
      selectedAgents,
    }, 1_000);

    expect(() => record([
      silentOwner('text-a', 'cli_text_a', 'meeting_text'),
      silentOwner('text-b', 'cli_text_b', 'meeting_text'),
    ])).toThrow('invalid vc meeting runtime selectedAgents');
    expect(() => record([
      threadAgent('thread-a', 'cli_thread_a'),
      threadAgent('thread-b', 'cli_thread_b'),
    ])).toThrow('invalid vc meeting runtime selectedAgents');
    expect(() => record([
      threadAgent('thread-a', 'cli_thread_a', ['meeting.read']),
    ])).toThrow('invalid vc meeting runtime selectedAgents');

    // The exact one-member P0 migration shape remains readable without the
    // new listener capability; arbitrary profiles do not inherit this escape.
    expect(() => record([legacySelectedAgent('cli_legacy')])).not.toThrow();
    expect(() => record([{
      ...legacySelectedAgent('cli_forged'),
      memberId: 'not_meeting_assistant',
    }])).toThrow('invalid vc meeting runtime selectedAgents');
  });

  it('lists active records without mutating expired records from other processes', () => {
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
      schemaVersion: 3,
      larkAppId: 'cli_b',
      meeting: { id: 'm_live', meetingNo: '987654321' },
      listenerChatId: 'oc_live',
      selectedAgents: [],
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 100_000,
    }]);

    const persisted = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf-8')) as Record<string, unknown>;
    expect(persisted).toHaveProperty('cli_a:m_old');
    expect(persisted).toHaveProperty('cli_b:m_live');
  });

  it('prunes expired records only through the explicit prune path', () => {
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

    expect(pruneExpiredVcMeetingRuntimeSessions(dir, 2_000)).toBe(1);

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

    expect(listVcMeetingRuntimeSessionsByListenerAndAgent(dir, {
      listenerChatId: 'oc_listener',
      agentAppId: 'cli_agent',
    }, 3_500).map(record => record.meeting.id)).toEqual(['m2', 'm1']);

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

  it('quarantines corrupt json and fails closed instead of reporting an empty store', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(dir, STORE_FILE), '{bad json', 'utf-8');

    expect(() => listVcMeetingRuntimeSessions(dir, 'cli_a', 1_000))
      .toThrow(/runtime session store is corrupt/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt runtime session store'));
    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
    expect(readdirSync(dir).some(name => name.startsWith(`${STORE_FILE}.corrupt.`))).toBe(true);

    expect(() => recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_a',
    }, 2_000)).toThrow(/runtime session store has quarantined evidence/);
  });

  it('quarantines the whole runtime store when one entry is malformed and preserves sibling evidence', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a', meeting: { id: 'm1' }, listenerChatId: 'oc_a',
    }, 1_000);
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_b', meeting: { id: 'm2' }, listenerChatId: 'oc_b',
    }, 2_000);
    const fp = join(dir, STORE_FILE);
    const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
    malformed['cli_a:m1'].listenerChatId = 42;
    writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

    expect(() => recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_c', meeting: { id: 'm3' }, listenerChatId: 'oc_c',
    }, 3_000)).toThrow(/runtime session store is corrupt/);
    expect(existsSync(fp)).toBe(false);
    const quarantined = readdirSync(dir).find(name => name.startsWith(`${STORE_FILE}.corrupt.`));
    expect(quarantined).toBeDefined();
    const evidence = JSON.parse(readFileSync(join(dir, quarantined!), 'utf8')) as Record<string, unknown>;
    expect(evidence).toHaveProperty('cli_a:m1');
    expect(evidence).toHaveProperty('cli_b:m2');
    expect(evidence).not.toHaveProperty('cli_c:m3');
  });

  it('requires v2/v3 selectedAgents and preserves a corrupted multi-agent v3 store on RMW', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_a',
      consumerMode: 'agent',
      selectedAgents: [{
        profileId: 'minutes',
        memberId: 'minutes_writer',
        agentAppId: 'cli_minutes',
        role: 'minutes_writer',
        status: 'active',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
        ownedSinks: [],
      }, {
        profileId: 'actions',
        memberId: 'actions_writer',
        agentAppId: 'cli_actions',
        role: 'actions_writer',
        status: 'active',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
        ownedSinks: [],
      }],
    }, 1_000);
    const fp = join(dir, STORE_FILE);
    const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
    delete malformed['cli_a:m1'].selectedAgents;
    writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

    expect(() => recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_b', meeting: { id: 'm2' }, listenerChatId: 'oc_b',
    }, 2_000)).toThrow(/runtime session store is corrupt/);
    expect(existsSync(fp)).toBe(false);
    const quarantined = readdirSync(dir).find(name => name.startsWith(`${STORE_FILE}.corrupt.`));
    expect(quarantined).toBeDefined();
    const evidence = JSON.parse(readFileSync(join(dir, quarantined!), 'utf8')) as Record<string, any>;
    expect(evidence['cli_a:m1']).not.toHaveProperty('selectedAgents');
    expect(evidence).not.toHaveProperty('cli_b:m2');

    const v2Dir = mkdtempSync(join(dir, 'v2-selection-'));
    const v2Fp = join(v2Dir, STORE_FILE);
    writeFileSync(v2Fp, JSON.stringify({
      'cli_v2:m2': {
        schemaVersion: 2,
        larkAppId: 'cli_v2',
        meeting: { id: 'm2' },
        listenerChatId: 'oc_v2',
        selectedAgentAppId: 'cli_legacy_alias',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 100_000,
      },
    }), { mode: 0o600 });
    expect(() => listVcMeetingRuntimeSessions(v2Dir, 'cli_v2', 2_000))
      .toThrow(/runtime session store is corrupt/);
    const v2Evidence = readdirSync(v2Dir).find(name => name.startsWith(`${STORE_FILE}.corrupt.`));
    expect(v2Evidence).toBeDefined();
    expect(JSON.parse(readFileSync(join(v2Dir, v2Evidence!), 'utf8'))['cli_v2:m2'])
      .toHaveProperty('selectedAgentAppId', 'cli_legacy_alias');
  });

  it('requires all current v3 timestamps and never rewrites defaulted values over corrupt evidence', () => {
    const corruptions: Array<[string, (record: Record<string, any>) => void]> = [
      ['missing-created', record => { delete record.createdAt; }],
      ['bad-created', record => { record.createdAt = 'bad'; }],
      ['missing-updated', record => { delete record.updatedAt; }],
      ['bad-updated', record => { record.updatedAt = -1; }],
      ['missing-expires', record => { delete record.expiresAt; }],
      ['bad-expires', record => { record.expiresAt = null; }],
    ];

    for (const [name, corrupt] of corruptions) {
      const caseDir = mkdtempSync(join(dir, `${name}-`));
      recordVcMeetingRuntimeSession(caseDir, {
        larkAppId: 'cli_a', meeting: { id: 'm1' }, listenerChatId: 'oc_a',
      }, 1_000);
      const fp = join(caseDir, STORE_FILE);
      const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
      corrupt(malformed['cli_a:m1']);
      writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

      expect(() => recordVcMeetingRuntimeSession(caseDir, {
        larkAppId: 'cli_b', meeting: { id: 'm2' }, listenerChatId: 'oc_b',
      }, 2_000), name).toThrow(/runtime session store is corrupt/);
      const quarantined = readdirSync(caseDir).find(file => file.startsWith(`${STORE_FILE}.corrupt.`));
      expect(quarantined, name).toBeDefined();
      const evidence = JSON.parse(readFileSync(join(caseDir, quarantined!), 'utf8')) as Record<string, unknown>;
      expect(evidence, name).toHaveProperty('cli_a:m1');
      expect(evidence, name).not.toHaveProperty('cli_b:m2');
    }
  });

  it('rejects invalid current v3 control and meeting fields before a sibling RMW can sanitize them', () => {
    const corruptions: Array<[string, (record: Record<string, any>) => void]> = [
      ['meeting-number', record => { record.meeting.meetingNo = 42; }],
      ['meeting-topic', record => { record.meeting.topic = { invalid: true }; }],
      ['consumer-mode', record => { record.consumerMode = 'agnt'; }],
      ['text-policy', record => { record.textOutputPolicy = 'yes'; }],
      ['voice-policy', record => { record.voiceOutputPolicy = false; }],
      ['close-phase', record => { record.consumerClosePhase = 'closed'; }],
      ['finalization-deadline', record => { record.consumerFinalizationDeadlineAt = 'soon'; }],
      ['resolution-deadline', record => { record.consumerCloseResolutionDeadlineAt = -1; }],
      ['selection-deadline', record => { record.consumerSelectionExpiresAt = null; }],
      ['instruction-open-ids', record => { record.temporaryInstructionOpenIds = ['ou_valid', 7]; }],
      ['instruction-union-ids', record => { record.temporaryInstructionUnionIds = ['on_dup', 'on_dup']; }],
    ];

    for (const [name, corrupt] of corruptions) {
      const caseDir = mkdtempSync(join(dir, `control-${name}-`));
      recordVcMeetingRuntimeSession(caseDir, {
        larkAppId: 'cli_a', meeting: { id: 'm1' }, listenerChatId: 'oc_a',
      }, 1_000);
      const fp = join(caseDir, STORE_FILE);
      const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
      corrupt(malformed['cli_a:m1']);
      writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

      expect(() => recordVcMeetingRuntimeSession(caseDir, {
        larkAppId: 'cli_b', meeting: { id: 'm2' }, listenerChatId: 'oc_b',
      }, 2_000), name).toThrow(/runtime session store is corrupt/);
      const quarantined = readdirSync(caseDir).find(file => file.startsWith(`${STORE_FILE}.corrupt.`));
      expect(quarantined, name).toBeDefined();
      const evidence = JSON.parse(readFileSync(join(caseDir, quarantined!), 'utf8')) as Record<string, unknown>;
      expect(evidence, name).toEqual(malformed);
      expect(evidence, name).not.toHaveProperty('cli_b:m2');
    }
  });

  it('creates no file for empty required fields', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: '   ' },
      listenerChatId: 'oc_listener',
    }, 1_000);

    expect(existsSync(join(dir, STORE_FILE))).toBe(false);
  });

  it('records short lived ended tombstones for restore and late push guards', () => {
    recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_a', meetingId: 'm1' }, 1_000, 500);

    expect(hasVcMeetingEndedTombstone(dir, 'cli_a', 'm1', 1_200)).toBe(true);
    expect(hasVcMeetingEndedTombstone(dir, 'cli_a', 'm1', 1_600)).toBe(false);
  });

  it('quarantines a malformed shared tombstone store and prevents replacement', () => {
    recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_a', meetingId: 'm1' }, 1_000);
    recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_b', meetingId: 'm2' }, 1_100);
    const fp = join(dir, TOMBSTONE_FILE);
    const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
    malformed['cli_a:m1'].meetingId = '';
    writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

    expect(() => recordVcMeetingEndedTombstone(
      dir,
      { larkAppId: 'cli_c', meetingId: 'm3' },
      1_200,
    )).toThrow(/ended tombstone store is corrupt/);
    expect(existsSync(fp)).toBe(false);
    const quarantined = readdirSync(dir).find(name => name.startsWith(`${TOMBSTONE_FILE}.corrupt.`));
    expect(quarantined).toBeDefined();
    const evidence = JSON.parse(readFileSync(join(dir, quarantined!), 'utf8')) as Record<string, unknown>;
    expect(evidence).toHaveProperty('cli_a:m1');
    expect(evidence).toHaveProperty('cli_b:m2');
    expect(evidence).not.toHaveProperty('cli_c:m3');
    expect(() => hasVcMeetingEndedTombstone(dir, 'cli_b', 'm2', 1_300))
      .toThrow(/ended tombstone store has quarantined evidence/);
  });

  it('requires current ended-tombstone timestamps and preserves malformed evidence', () => {
    const corruptions: Array<[string, (record: Record<string, any>) => void]> = [
      ['missing-ended', record => { delete record.endedAt; }],
      ['bad-ended', record => { record.endedAt = 'bad'; }],
      ['missing-expires', record => { delete record.expiresAt; }],
      ['bad-expires', record => { record.expiresAt = -1; }],
    ];

    for (const [name, corrupt] of corruptions) {
      const caseDir = mkdtempSync(join(dir, `tombstone-${name}-`));
      recordVcMeetingEndedTombstone(caseDir, { larkAppId: 'cli_a', meetingId: 'm1' }, 1_000);
      const fp = join(caseDir, TOMBSTONE_FILE);
      const malformed = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, any>;
      corrupt(malformed['cli_a:m1']);
      writeFileSync(fp, JSON.stringify(malformed), { mode: 0o600 });

      expect(() => recordVcMeetingEndedTombstone(
        caseDir,
        { larkAppId: 'cli_b', meetingId: 'm2' },
        2_000,
      ), name).toThrow(/ended tombstone store is corrupt/);
      const quarantined = readdirSync(caseDir).find(file => file.startsWith(`${TOMBSTONE_FILE}.corrupt.`));
      expect(quarantined, name).toBeDefined();
      const evidence = JSON.parse(readFileSync(join(caseDir, quarantined!), 'utf8')) as Record<string, unknown>;
      expect(evidence, name).toHaveProperty('cli_a:m1');
      expect(evidence, name).not.toHaveProperty('cli_b:m2');
    }
  });

  it('preserves other daemon records across runtime and tombstone RMW operations', () => {
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_a',
      meeting: { id: 'm1' },
      listenerChatId: 'oc_a',
    }, 1_000);
    recordVcMeetingRuntimeSession(dir, {
      larkAppId: 'cli_b',
      meeting: { id: 'm2' },
      listenerChatId: 'oc_b',
      consumerMode: 'agent',
      selectedAgents: [{
        profileId: 'minutes',
        memberId: 'minutes_writer',
        agentAppId: 'cli_minutes',
        role: 'minutes_writer',
        status: 'active',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
        ownedSinks: [],
      }],
    }, 2_000);

    const beforeRemove = JSON.parse(readFileSync(join(dir, STORE_FILE), 'utf-8')) as Record<string, unknown>;
    expect(beforeRemove).toHaveProperty('cli_a:m1');
    expect(beforeRemove).toHaveProperty('cli_b:m2');
    removeVcMeetingRuntimeSession(dir, 'cli_a', 'm1');

    expect(listVcMeetingRuntimeSessions(dir, 'cli_b', 2_500)).toEqual([
      expect.objectContaining({
        schemaVersion: 3,
        larkAppId: 'cli_b',
        meeting: { id: 'm2' },
        selectedAgents: [expect.objectContaining({ profileId: 'minutes', agentAppId: 'cli_minutes' })],
      }),
    ]);

    recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_a', meetingId: 'm1' }, 1_000, 500);
    recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_b', meetingId: 'm2' }, 1_200, 5_000);
    expect(hasVcMeetingEndedTombstone(dir, 'cli_a', 'm1', 2_000)).toBe(false);
    expect(hasVcMeetingEndedTombstone(dir, 'cli_b', 'm2', 2_000)).toBe(true);

    const tombstones = JSON.parse(readFileSync(join(dir, TOMBSTONE_FILE), 'utf-8')) as Record<string, unknown>;
    expect(tombstones).not.toHaveProperty('cli_a:m1');
    expect(tombstones).toHaveProperty('cli_b:m2');
  });

  it('uses reclaimable file locks for both shared RMW stores', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const deadPid = '99999999';
    for (const name of [STORE_FILE, TOMBSTONE_FILE]) {
      const lock = join(dir, `${name}.lock`);
      writeFileSync(lock, deadPid, 'utf-8');
      utimesSync(lock, new Date(0), new Date(0));
      if (name === STORE_FILE) {
        recordVcMeetingRuntimeSession(dir, {
          larkAppId: 'cli_a',
          meeting: { id: 'm1' },
          listenerChatId: 'oc_a',
        }, 1_000);
      } else {
        recordVcMeetingEndedTombstone(dir, { larkAppId: 'cli_a', meetingId: 'm1' }, 1_000);
      }
      expect(existsSync(lock)).toBe(false);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[file-lock] broke stale lock'));
  });
});
