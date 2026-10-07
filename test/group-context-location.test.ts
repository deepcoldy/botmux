import { describe, expect, it } from 'vitest';
import { groupContextConversationForTurn } from '../src/services/group-context-location.js';

describe('group context conversation location', () => {
  it('keeps ordinary lobby quote replies in main scope', () => {
    expect(groupContextConversationForTurn({ message_id: 'om_quote', root_id: 'om_quoted' }, { scope: 'chat', anchor: 'oc_room' })).toEqual({ scope: 'main' });
  });
  it('uses native topic location even if reply-mode folds it into a chat session', () => {
    expect(groupContextConversationForTurn({ message_id: 'om_reply', root_id: 'om_topic', thread_id: 'omt_native' }, { scope: 'chat', anchor: 'oc_room' })).toEqual({ scope: 'thread', rootId: 'om_topic', threadId: 'omt_native' });
  });
  it('recognizes a native topic seed with no reply root', () => {
    expect(groupContextConversationForTurn({ message_id: 'om_seed', thread_id: 'omt_native' }, { scope: 'chat', anchor: 'oc_room' })).toEqual({ scope: 'thread', rootId: 'om_seed', threadId: 'omt_native' });
  });
  it('keeps explicit thread routes scoped to their visible topic root', () => {
    expect(groupContextConversationForTurn({ message_id: 'om_now' }, { scope: 'thread', anchor: 'om_topic' })).toEqual({ scope: 'thread', rootId: 'om_topic' });
  });
});
