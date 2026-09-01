import { describe, expect, it } from 'bun:test';
import { fillNativeTopicId, isNativeTopicId } from '../src/core/native-topic-id.js';

describe('native topic id persistence', () => {
  it('accepts only a native omt id', () => {
    expect(isNativeTopicId('omt_topic-1_2')).toBe(true);
    expect(isNativeTopicId('om_message_root')).toBe(false);
    expect(isNativeTopicId('omt_')).toBe(false);
    expect(isNativeTopicId(' omt_topic')).toBe(false);
    expect(isNativeTopicId(undefined)).toBe(false);
  });

  it('fills an empty thread session once and never overwrites its original topic', () => {
    const session: { larkThreadId?: string } = {};
    expect(fillNativeTopicId(session, 'thread', 'omt_original')).toBe(true);
    expect(session.larkThreadId).toBe('omt_original');
    expect(fillNativeTopicId(session, 'thread', 'omt_other')).toBe(false);
    expect(session.larkThreadId).toBe('omt_original');
  });

  it('rejects chat scope and non-native ids without mutating the session', () => {
    const chatSession: { larkThreadId?: string } = {};
    expect(fillNativeTopicId(chatSession, 'chat', 'omt_topic')).toBe(false);
    expect(chatSession.larkThreadId).toBeUndefined();

    const threadSession: { larkThreadId?: string } = {};
    expect(fillNativeTopicId(threadSession, 'thread', 'om_root')).toBe(false);
    expect(threadSession.larkThreadId).toBeUndefined();
  });
});
