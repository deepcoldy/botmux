import { describe, expect, it } from 'vitest';

import {
  DONE_REACTION_EMOJI_TYPE,
  RECEIVED_REACTION_EMOJI_TYPE,
  SUBSTITUTE_RECEIVED_REACTION_EMOJI_TYPE,
} from '../src/core/pending-response.js';

// The placeholder「处理中」pending-response card (and its PATCH-delivery state
// machine) was removed — card-off answers now always go out as a fresh message
// (see test/turn-reactions.test.ts for the two-phase reaction behaviour that
// replaced the old completion emoji). All that survives here is the emoji enum.
describe('turn reaction emojis', () => {
  it('uses the Feishu GoGoGo/DONE emojis for the two-phase turn reaction', () => {
    expect(RECEIVED_REACTION_EMOJI_TYPE).toBe('GoGoGo');
    expect(SUBSTITUTE_RECEIVED_REACTION_EMOJI_TYPE).toBe('Get');
    expect(DONE_REACTION_EMOJI_TYPE).toBe('DONE');
  });
});
