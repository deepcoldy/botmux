import { describe, expect, it } from 'vitest';
import { DURABLE_INBOX_LANE_SESSION_CONTROL, type InboxClaim } from '../src/services/durable-coordination.js';
import {
  durableDirectSessionControlEvent,
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
  parseDurableSessionControlClaim,
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

  it.each(['lark-command', 'trusted-host'] as const)(
    'parses a %s lifecycle request without weakening the card envelope',
    source => {
      const event = durableDirectSessionControlEvent({
        source,
        larkAppId: 'cli_test',
        operationId: `${source}.session-control:cli_test:om_command`,
        action: 'close',
        sessionId: 'session-1',
        rootId: 'om_root',
        ...(source === 'lark-command' ? { operatorOpenId: 'ou_operator' } : {}),
        cardMessageId: 'om_card',
        now: 10,
      });
      expect(parseDurableSessionControlClaim(claim(event))).toMatchObject({
        source,
        operationId: `${source}.session-control:cli_test:om_command`,
        partitionKey: 'lark-session-control:cli_test:session-1',
        action: 'close',
        sessionId: 'session-1',
        rootId: 'om_root',
        operatorOpenId: source === 'trusted-host' ? 'trusted-host' : 'ou_operator',
        cardMessageId: 'om_card',
      });
      expect(() => parseDurableLarkSessionControlClaim(claim(event)))
        .toThrow(/invalid envelope/);
    },
  );

  it('rejects a command control without a Lark user principal', () => {
    expect(() => durableDirectSessionControlEvent({
      source: 'lark-command',
      larkAppId: 'cli_test',
      operationId: 'lark-command.session-control:cli_test:om_command',
      action: 'close',
      sessionId: 'session-1',
      rootId: 'om_root',
      operatorOpenId: 'trusted-host',
      now: 10,
    })).toThrow(/operator identity/);
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

  it.each([
    [{ operator: { open_id: 'on_operator' } }, /principal\/card identity/],
    [{ context: { open_message_id: 'oc_card' } }, /principal\/card identity/],
    [{ action: { value: { action: 'close', session_id: 'session-1', root_id: 'ou_root' } } }, /root identity/],
  ])('rejects invalid operator/card/root identity prefixes', (patch, error) => {
    expect(() => durableLarkSessionControlEvent({
      larkAppId: 'cli_test',
      eventId: durableLarkSessionControlEventId('cli_test', 'evt_control_1'),
      partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
      data: { ...rawControl(), ...patch },
      now: 10,
    })).toThrow(error);
  });
});
