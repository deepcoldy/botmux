import { describe, expect, it } from 'vitest';
import {
  analyzeSkillReferences,
  packIdsInPolicy,
  packsContainingSkill,
} from '../src/core/skills/references.js';
import type { SkillPack } from '../src/core/skills/types.js';

function pack(id: string, skills: string[]): SkillPack {
  return {
    id,
    name: id,
    include: skills.map((s) => `skill:${s}` as `skill:${string}`),
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('skill references with packs', () => {
  const packs: Record<string, SkillPack> = {
    p1: pack('p1', ['a', 'b']),
    p2: pack('p2', ['b', 'c']),
  };

  it('packIdsInPolicy extracts pack ids from a policy', () => {
    expect(packIdsInPolicy({ include: ['skill:a', 'pack:p1', 'pack:p2'] })).toEqual(['p1', 'p2']);
    expect(packIdsInPolicy({ include: ['skill:a'] })).toEqual([]);
    expect(packIdsInPolicy(undefined)).toEqual([]);
  });

  it('packsContainingSkill returns packs that directly include the skill', () => {
    expect(packsContainingSkill('b', packs)).toEqual(['p1', 'p2']);
    expect(packsContainingSkill('a', packs)).toEqual(['p1']);
    expect(packsContainingSkill('z', packs)).toEqual([]);
    expect(packsContainingSkill('a', undefined)).toEqual([]);
  });

  it('analyzeSkillReferences finds direct and via-pack bot references', () => {
    const bots = [
      { larkAppId: 'bot1', botName: 'Bot1', skills: { include: ['skill:a'] } },
      { larkAppId: 'bot2', botName: 'Bot2', skills: { include: ['pack:p1'] } },
      { larkAppId: 'bot3', botName: 'Bot3', skills: { include: ['pack:p2'] } },
      { larkAppId: 'bot4', botName: 'Bot4', skills: { include: ['skill:c'] } },
    ];
    const result = analyzeSkillReferences('b', { bots, packs });
    // bot2 (via p1) and bot3 (via p2) reference b indirectly; no direct refs
    expect(result.bots.map((b) => b.botName).sort()).toEqual(['Bot2', 'Bot3']);
    expect(result.bots.every((b) => b.direct === false)).toBe(true);
    expect(result.packs).toEqual(['p1', 'p2']);
  });

  it('analyzeSkillReferences marks direct references as direct=true', () => {
    const bots = [
      { larkAppId: 'bot1', botName: 'Bot1', skills: { include: ['skill:a', 'pack:p1'] } },
    ];
    const result = analyzeSkillReferences('a', { bots, packs });
    expect(result.bots).toHaveLength(1);
    expect(result.bots[0].direct).toBe(true);
  });

  it('analyzeSkillReferences works without a packs registry (direct only)', () => {
    const bots = [
      { larkAppId: 'bot1', botName: 'Bot1', skills: { include: ['skill:a'] } },
      { larkAppId: 'bot2', botName: 'Bot2', skills: { include: ['pack:p1'] } },
    ];
    const result = analyzeSkillReferences('a', { bots });
    expect(result.bots.map((b) => b.botName)).toEqual(['Bot1']);
    expect(result.packs).toEqual([]);
  });
});
