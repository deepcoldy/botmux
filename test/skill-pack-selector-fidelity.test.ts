import { describe, expect, it } from 'vitest';
import { attachSkillPolicy, detachSkillPolicy } from '../src/core/skills/im-command.js';
import { readBotSkillPolicy } from '../src/bot-registry.js';
import type { BotSkillPolicy } from '../src/core/skills/types.js';
import { mergeBotAssignmentSelectors } from '../src/dashboard/web/skills/shared.js';

describe('selector fidelity regression (pack: must survive round-trips)', () => {
  it('readBotSkillPolicy reads pack: selectors alongside skill:', () => {
    const policy = readBotSkillPolicy({ include: ['skill:a', 'pack:p1', 'skill:b'] });
    expect(policy?.include).toEqual(['skill:a', 'pack:p1', 'skill:b']);
  });

  it('readBotSkillPolicy rejects malformed selectors (empty body, unknown prefix)', () => {
    // 'pack:' with empty body is dropped; 'tag:x' is an unknown prefix and dropped
    const policy = readBotSkillPolicy({ include: ['skill:a', 'pack:', 'tag:x', 'pack:p1'] });
    expect(policy?.include).toEqual(['skill:a', 'pack:p1']);
  });

  it('round-trip: write a policy containing pack: and read it back equal', () => {
    // This is the critical assertion: the API must actually STORE pack:
    // selectors, not just return ok:true. We simulate the write→read path by
    // serialising the policy to a plain object (as applyConfigField does) and
    // re-parsing it with readBotSkillPolicy.
    const original: BotSkillPolicy = { include: ['skill:a', 'pack:p1', 'pack:p2', 'skill:b'] };
    const serialized = JSON.parse(JSON.stringify(original));
    const roundTripped = readBotSkillPolicy(serialized);
    expect(roundTripped).toEqual(original);
  });

  it('attachSkillPolicy preserves pack: items and their order', () => {
    const current: BotSkillPolicy = { include: ['skill:a', 'pack:p1', 'pack:p2'] };
    const next = attachSkillPolicy(current, 'b');
    // pack: items stay in their original positions; skill:b is appended
    expect(next.include).toEqual(['skill:a', 'pack:p1', 'pack:p2', 'skill:b']);
  });

  it('attachSkillPolicy does not duplicate an existing skill: selector', () => {
    const current: BotSkillPolicy = { include: ['skill:a', 'pack:p1'] };
    const next = attachSkillPolicy(current, 'a');
    expect(next.include).toEqual(['skill:a', 'pack:p1']);
  });

  it('detachSkillPolicy preserves pack: items and their order', () => {
    const current: BotSkillPolicy = { include: ['skill:a', 'pack:p1', 'skill:b', 'pack:p2'] };
    const next = detachSkillPolicy(current, 'a');
    expect(next?.include).toEqual(['pack:p1', 'skill:b', 'pack:p2']);
  });

  it('detachSkillPolicy keeps the policy when only pack: items remain', () => {
    const current: BotSkillPolicy = { include: ['skill:a', 'pack:p1'] };
    const next = detachSkillPolicy(current, 'a');
    expect(next?.include).toEqual(['pack:p1']);
  });

  it('detachSkillPolicy drops unknown-prefix selectors (not skill: or pack:)', () => {
    const current: BotSkillPolicy = { include: ['skill:a', 'tag:sre'] as any };
    const next = detachSkillPolicy(current, 'a');
    expect(next).toBeUndefined();
  });

  it('builds one complete selector payload for direct Skills and Skill Packs', () => {
    const currentPolicy: BotSkillPolicy = { include: ['skill:old', 'pack:p1'] };
    const merged = mergeBotAssignmentSelectors(currentPolicy, ['a', 'b'], ['p2']);

    expect(merged).toEqual(['skill:a', 'skill:b', 'pack:p2']);

    // And the round-trip must still hold:
    const reparsed = readBotSkillPolicy({ include: merged });
    expect(reparsed?.include).toEqual(merged);
  });
});
