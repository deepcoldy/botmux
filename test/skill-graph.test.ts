import { describe, expect, it } from 'vitest';
import { buildSkillGraph, danglingSkillNames } from '../src/dashboard/web/skills/shared.js';

const installed = [{ name: 'deploy' }, { name: 'review' }, { name: 'release' }];

const packs = [
  { id: 'ops', name: 'Ops', include: ['skill:deploy', 'skill:release'] },
  { id: 'qa', name: 'QA', include: ['skill:review', 'skill:lint-missing'] },
];

const bots = [
  { larkAppId: 'bot-a', skills: { include: ['pack:ops', 'skill:review'] } },
  { larkAppId: 'bot-b', skills: { include: ['pack:qa', 'skill:ghost-skill'] } },
  { larkAppId: 'bot-c', skills: { include: [] } },
  { larkAppId: 'bot-d', skills: { include: ['pack:deleted-pack'] } },
];

describe('buildSkillGraph', () => {
  const graph = buildSkillGraph(installed, packs, bots);

  it('maps skill → containing packs and direct/via-pack bots', () => {
    const deploy = graph.skills.get('deploy')!;
    expect(deploy.installed).toBe(true);
    expect(deploy.packIds).toEqual(['ops']);
    expect(deploy.directBotIds).toEqual([]);
    expect(deploy.viaPackBotIds).toEqual(['bot-a']);

    const review = graph.skills.get('review')!;
    expect(review.packIds).toEqual(['qa']);
    expect(review.directBotIds).toEqual(['bot-a']);
    expect(review.viaPackBotIds).toEqual(['bot-b']);
  });

  it('includes referenced-but-not-installed skills as graph nodes', () => {
    // via pack include
    const lint = graph.skills.get('lint-missing')!;
    expect(lint.installed).toBe(false);
    expect(lint.packIds).toEqual(['qa']);
    expect(lint.viaPackBotIds).toEqual(['bot-b']);
    // via direct bot policy
    const ghost = graph.skills.get('ghost-skill')!;
    expect(ghost.installed).toBe(false);
    expect(ghost.directBotIds).toEqual(['bot-b']);
    // helper lists exactly the dangling set, sorted
    expect(danglingSkillNames(graph)).toEqual(['ghost-skill', 'lint-missing']);
  });

  it('maps pack → resolved/missing members and referencing bots', () => {
    const ops = graph.packs.get('ops')!;
    expect(ops.resolved).toEqual(['deploy', 'release']);
    expect(ops.missing).toEqual([]);
    expect(ops.botIds).toEqual(['bot-a']);

    const qa = graph.packs.get('qa')!;
    expect(qa.resolved).toEqual(['review']);
    expect(qa.missing).toEqual(['lint-missing']);
    expect(qa.botIds).toEqual(['bot-b']);
  });

  it('resolves bot policies with provenance and dedup (direct wins over pack)', () => {
    const botA = graph.bots.get('bot-a')!;
    expect(botA.finalCount).toBe(3);
    expect(botA.health).toBe('ok');
    const sources = Object.fromEntries(botA.resolved.map(r => [r.name, r.source]));
    expect(sources).toEqual({ deploy: 'pack:ops', release: 'pack:ops', review: 'direct' });
  });

  it('flags bots referencing missing skills without counting them as resolved', () => {
    const botB = graph.bots.get('bot-b')!;
    expect(botB.health).toBe('missing');
    expect(botB.missingSkills.sort()).toEqual(['ghost-skill', 'lint-missing']);
    expect(botB.finalCount).toBe(1); // only 'review' is installed
  });

  it('distinguishes empty policy (default) from broken pack reference', () => {
    expect(graph.bots.get('bot-c')!.health).toBe('default');
    const botD = graph.bots.get('bot-d')!;
    expect(botD.health).toBe('pack_missing');
    expect(botD.missingPacks).toEqual(['deleted-pack']);
  });

  it('keeps installed-but-unreferenced skills as isolated nodes', () => {
    // 'release' is only reachable via pack ops; ensure unreferenced installed
    // skills still appear so the library table can render usage=0.
    const graph2 = buildSkillGraph(installed, [], []);
    expect([...graph2.skills.keys()].sort()).toEqual(['deploy', 'release', 'review']);
    for (const node of graph2.skills.values()) {
      expect(node.packIds).toEqual([]);
      expect(node.directBotIds).toEqual([]);
    }
  });

  it('ignores unknown selector prefixes without breaking health', () => {
    const g = buildSkillGraph(installed, [], [
      { larkAppId: 'bot-x', skills: { include: ['workflow:custom', 'skill:deploy'] } },
    ]);
    const botX = g.bots.get('bot-x')!;
    expect(botX.health).toBe('ok');
    expect(botX.finalCount).toBe(1);
  });
});
