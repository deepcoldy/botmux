import { describe, expect, it } from 'vitest';
import { getBot, getOwnerOpenId, registerBot } from '../src/bot-registry.js';
import { resolveWorkerAdmissionOwner } from '../src/core/worker-admission-owner-alert.js';

describe('worker admission runtime owner resolution', () => {
  it('never reuses a revoked setup owner while a replacement is unresolved', () => {
    const appId = 'worker_admission_owner_resolution';
    const bot = registerBot({
      larkAppId: appId, larkAppSecret: 'fixture', cliId: 'claude-code',
      ownerOpenId: 'ou_old_owner', allowedUsers: ['ou_old_owner'],
    });
    bot.resolvedAllowedUsers = ['ou_old_owner'];
    expect(resolveWorkerAdmissionOwner(appId, { getBot, getOwnerOpenId })).toBe('ou_old_owner');
    bot.config.allowedUsers = ['new.owner@example.com'];
    bot.resolvedAllowedUsers = [];
    expect(resolveWorkerAdmissionOwner(appId, { getBot, getOwnerOpenId })).toBeUndefined();
    bot.resolvedAllowedUsers = ['ou_new_owner'];
    expect(resolveWorkerAdmissionOwner(appId, { getBot, getOwnerOpenId })).toBe('ou_new_owner');
  });

  it('does not route a host DM through an API-only bot', () => {
    const appId = 'worker_admission_api_only';
    const bot = registerBot({ larkAppId: appId, larkAppSecret: 'fixture',
      cliId: 'claude-code', apiOnly: true, allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    expect(resolveWorkerAdmissionOwner(appId, { getBot, getOwnerOpenId })).toBeUndefined();
  });
});
