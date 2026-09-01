/**
 * Unit tests for dashboard's creator-selection logic for the "Create new
 * group" flow. Critical because:
 *  - The creator bot is the implicit first member of the chat, so it MUST be
 *    one the user explicitly selected — otherwise we silently pull an extra
 *    bot into the new group.
 *  - Lark open_ids are app-scoped, so the auto-invited operator open_id must
 *    come from the SAME bot we use as creator.
 */
import { describe, it, expect } from 'bun:test';
import { pickCreatorForGroup, type DaemonInfoForPick } from '../src/dashboard/operator-selector.js';

function lookupFrom(daemons: DaemonInfoForPick[]) {
  const map = new Map(daemons.map(d => [d.larkAppId, d]));
  return (id: string) => map.get(id);
}

describe('pickCreatorForGroup', () => {
  it('returns null when nothing is selected', () => {
    expect(pickCreatorForGroup([], lookupFrom([]))).toBeNull();
  });

  it('returns null when none of the selected bots are online', () => {
    const lookup = lookupFrom([
      { larkAppId: 'cli_other', resolvedAllowedUsers: ['ou_op'] },
    ]);
    expect(pickCreatorForGroup(['cli_a', 'cli_b'], lookup)).toBeNull();
  });

  it('picks the (single) selected online bot and surfaces its allowlist', () => {
    const lookup = lookupFrom([
      { larkAppId: 'cli_a', resolvedAllowedUsers: ['ou_op'] },
    ]);
    expect(pickCreatorForGroup(['cli_a'], lookup)).toEqual({
      creatorLarkAppId: 'cli_a',
      userOpenIds: ['ou_op'],
    });
  });

  it('prefers the first selected online bot that has an allowlist', () => {
    // cli_a is online but has no allowlist — we'd rather use cli_b so the
    // operator can be auto-invited. Selection order is "user clicked these".
    const lookup = lookupFrom([
      { larkAppId: 'cli_a', resolvedAllowedUsers: [] },
      { larkAppId: 'cli_b', resolvedAllowedUsers: ['ou_op'] },
    ]);
    expect(pickCreatorForGroup(['cli_a', 'cli_b'], lookup)).toEqual({
      creatorLarkAppId: 'cli_b',
      userOpenIds: ['ou_op'],
    });
  });

  it('falls back to first selected online bot when none have an allowlist', () => {
    // All selected bots are online but none have a configured allowlist (rare
    // — bare bots with no operators). Frontend will surface the warn branch.
    const lookup = lookupFrom([
      { larkAppId: 'cli_a', resolvedAllowedUsers: [] },
      { larkAppId: 'cli_b', resolvedAllowedUsers: [] },
    ]);
    expect(pickCreatorForGroup(['cli_a', 'cli_b'], lookup)).toEqual({
      creatorLarkAppId: 'cli_a',
      userOpenIds: [],
    });
  });

  it('skips offline bots when picking', () => {
    // cli_a is offline (lookup returns undefined), cli_b is online with an
    // allowlist — cli_b wins.
    const lookup = lookupFrom([
      { larkAppId: 'cli_b', resolvedAllowedUsers: ['ou_op'] },
    ]);
    expect(pickCreatorForGroup(['cli_a', 'cli_b'], lookup)).toEqual({
      creatorLarkAppId: 'cli_b',
      userOpenIds: ['ou_op'],
    });
  });

  it('preserves selection order — earlier-selected bot with allowlist wins over later one', () => {
    const lookup = lookupFrom([
      { larkAppId: 'cli_a', resolvedAllowedUsers: ['ou_a'] },
      { larkAppId: 'cli_b', resolvedAllowedUsers: ['ou_b'] },
    ]);
    expect(pickCreatorForGroup(['cli_a', 'cli_b'], lookup)).toEqual({
      creatorLarkAppId: 'cli_a',
      userOpenIds: ['ou_a'],
    });
  });
});
