import { describe, expect, it } from 'vitest';
import { DURABLE_INBOX_LANE_SESSION_CONTROL, type InboxClaim } from '../src/services/durable-coordination.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';

function rawControl(action: 'close' | 'resume' | 'restart' = 'close') {
  return {
    event_id: 'evt_control_1',
    action: {
      value: {
        action,
        session_id: 'session-1',
        root_id: 'om_root',
      },
    },
    operator: { open_id: 'ou_operator' },
    context: { open_message_id: 'om_card' },
  };
}

function claim(event = durableLarkSessionControlEvent({
  larkAppId: 'cli_test',
  eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
  partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
  data: rawControl(),
  now: 10,
})): InboxClaim {
  return {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 100,
    attempts: 2,
  };
}

describe('durable Lark session control envelope', () => {
  it('pins one stable card interaction to the session-control lane and partition', () => {
    const parsed = parseDurableLarkSessionControlClaim(claim());
    expect(parsed).toMatchObject({
      operationId: 'card.action.trigger:cli_test:evt_control_1',
      partitionKey: 'lark-session-control:cli_test:session-1',
      larkAppId: 'cli_test',
      action: 'close',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'ou_operator',
      cardMessageId: 'om_card',
      attempts: 2,
    });
  });

  it('rejects lifecycle actions that are not in the first durable close/resume slice', () => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: rawControl('restart'),
      now: 10,
    })).toThrow(/close or resume/);
  });

  it('rejects missing stable interaction ids and mismatched durable identities', () => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: 'card.action.trigger:cli_test:evt_control_1',
      partitionKey: 'lark-session-control:cli_test:session-1',
      data: { ...rawControl(), event_id: undefined },
      now: 10,
    })).toThrow(/event id/);

    const event = durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: rawControl(),
      now: 10,
    });
    expect(() => parseDurableLarkSessionControlClaim(claim({
      ...event,
      eventId: 'card.action.trigger:cli_test:evt_other',
    }))).toThrow(/mismatched identity/);
    expect(() => parseDurableLarkSessionControlClaim(claim({
      ...event,
      lane: 'lark-message',
    }))).toThrow(/invalid envelope/);
    expect(event.lane).toBe(DURABLE_INBOX_LANE_SESSION_CONTROL);
  });
});
