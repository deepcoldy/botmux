import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIVATE_REPLY_REVIEW,
  normalizePrivateReplyReviewConfig,
  resolvedPrivateReplyReviewConfig,
} from '../src/services/private-reply-review-config.js';
import { pluginCardActionSelectorOverlapsBotmux } from '../src/core/card-action-namespace.js';

describe('private reply review config', () => {
  it('defaults to disabled requester review with DM fallback', () => {
    expect(resolvedPrivateReplyReviewConfig(undefined)).toEqual(DEFAULT_PRIVATE_REPLY_REVIEW);
  });

  it('normalizes valid sparse config', () => {
    expect(normalizePrivateReplyReviewConfig({
      enabled: true,
      audience: 'allowedUsers',
      fallback: 'drop',
      expireHours: 3.8,
    })).toEqual({
      enabled: true,
      audience: 'allowedUsers',
      fallback: 'drop',
      expireHours: 3,
    });
  });

  it('drops a fully default disabled config to keep bots.json sparse', () => {
    expect(normalizePrivateReplyReviewConfig({
      enabled: false,
      audience: 'requester',
      fallback: 'dm',
      expireHours: 24,
    })).toBeUndefined();
  });

  it('reserves private_reply_ for built-in card actions', () => {
    expect(pluginCardActionSelectorOverlapsBotmux('private_reply_publish', 'action')).toBe(true);
    expect(pluginCardActionSelectorOverlapsBotmux('private_reply_', 'prefix')).toBe(true);
  });
});
