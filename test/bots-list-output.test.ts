import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  collaborationHelp,
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
} from '../src/cli/bots-list-output.js';

describe('botmux bots list CLI output mapping', () => {
  it('includes larkAppId and workflowBot for chat-member results', () => {
    const rows = formatChatBotsForCli([
      {
        larkAppId: 'cli_self',
        openId: 'ou_self',
        name: 'codex',
        displayName: 'Codex Loopy',
        source: 'configured',
        capability: '后端排查; workspace:required',
        hasTeamRole: true,
        mentionable: true,
        mentionSource: 'cross-ref',
      },
      {
        larkAppId: 'cli_peer',
        openId: 'ou_peer',
        name: 'claude',
        displayName: 'Claude Loopy',
        source: 'configured',
        capability: 'writing; workspace: none',
        hasTeamRole: false,
        mentionable: false,
        mentionSource: 'self',
      },
      {
        larkAppId: '',
        openId: 'ou_external',
        name: 'external-loopy',
        displayName: 'External Loopy',
        source: 'introduce',
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'observed',
      },
    ], 'cli_self');

    expect(rows).toMatchObject([
      {
        name: 'Codex Loopy',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
        capability: '后端排查; workspace:required',
        hasTeamRole: true,
        mentionable: true,
        mentionSource: 'cross-ref',
        dispatch: { trigger: 'mention', workspace: 'required' },
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
        capability: 'writing; workspace: none',
        hasTeamRole: false,
        mentionable: false,
        mentionSource: 'self',
        dispatch: { trigger: 'mention', workspace: 'none' },
      },
      {
        name: 'External Loopy',
        openId: 'ou_external',
        isSelf: false,
        source: 'introduce',
        larkAppId: '',
        workflowBot: null,
        capability: null,
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'observed',
        dispatch: { trigger: 'mention', workspace: 'unknown' },
      },
    ]);
  });

  it('includes larkAppId and workflowBot for bots-info fallback rows', () => {
    const rows = formatBotInfoEntriesForCli([
      {
        larkAppId: 'cli_self',
        botOpenId: 'ou_self',
        botName: null,
        cliId: 'codex',
      },
      {
        larkAppId: 'cli_peer',
        botOpenId: 'ou_peer',
        botName: 'Claude Loopy',
        cliId: 'claude',
      },
      {
        larkAppId: 'cli_missing_openid',
        botOpenId: null,
        botName: 'Missing',
        cliId: 'codex',
      },
    ], 'cli_self');

    expect(rows).toMatchObject([
      {
        name: 'codex',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
        capability: null,
        hasTeamRole: false,
        mentionable: true,
        mentionSource: 'self',
        dispatch: { trigger: 'mention', workspace: 'unknown' },
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
        capability: null,
        hasTeamRole: false,
        mentionable: false,
        mentionSource: 'fallback',
        dispatch: { trigger: 'mention', workspace: 'unknown' },
      },
    ]);
  });

  it('S-1 gives a mentionable local peer actionable config-backed dispatch evidence', () => {
    const [row] = formatChatBotsForCli([{
      larkAppId: 'cli_peer',
      openId: 'ou_peer',
      name: 'codex',
      displayName: 'Codex Peer',
      source: 'configured',
      capability: 'code; workspace:required',
      hasTeamRole: true,
      mentionable: true,
      mentionSource: 'cross-ref',
    }], 'cli_self', {
      cli_peer: {
        workspaceSource: 'oncall',
        mentionMode: 'topic',
        replyMode: 'shared',
        transport: true,
      },
    });

    expect(row.dispatch).toEqual({ trigger: 'mention', workspace: 'required' });
    expect(row.collaboration).toMatchObject({
      reachability: 'ready',
      workspace: { requirement: 'required', source: 'oncall' },
      authorization: { talk: 'preflight-required', operate: false },
      session: { mentionMode: 'topic', replyMode: 'shared' },
      runtime: { transport: true, deployment: 'local', stale: 'unknown' },
    });

    const [defaulted] = formatChatBotsForCli([{
      larkAppId: 'cli_api_only',
      openId: 'ou_api_only',
      name: 'headless',
      displayName: 'Headless Peer',
      source: 'configured',
      capability: 'workspace:optional',
      hasTeamRole: false,
      mentionable: false,
      mentionSource: 'fallback',
    }], 'cli_self', {
      cli_api_only: {
        workspaceSource: 'default',
        mentionMode: 'always',
        replyMode: 'chat-topic',
        transport: false,
      },
    });
    expect(defaulted.collaboration).toMatchObject({
      workspace: { requirement: 'optional', source: 'default' },
      session: { mentionMode: 'always', replyMode: 'chat-topic' },
      runtime: { transport: false },
    });
  });

  it('S-1 reads peer facts from authoritative BotConfig rather than the transient registry', () => {
    const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const factsBuilder = cliSource.match(/const collaborationFactsFor[\s\S]*?\n  };/)?.[0] ?? '';

    expect(factsBuilder).toContain('loadBotConfigs()');
    expect(factsBuilder).not.toContain('getBot(');
    expect(factsBuilder).not.toContain('registerBot(');
    expect(factsBuilder).toContain('catch');
    for (const sensitive of ['ownerOpenId', 'allowedUsers', 'chatGrants', 'globalGrants', 'sandboxPaths', 'env', 'larkAppSecret']) {
      expect(factsBuilder).not.toContain(sensitive);
    }
  });

  it('S-2 keeps unsupported fallback and external conclusions unknown without leaking sensitive config', () => {
    const [fallback] = formatBotInfoEntriesForCli([{
      larkAppId: 'cli_peer',
      botOpenId: 'ou_peer',
      botName: 'Peer',
      cliId: 'codex',
    }], 'cli_self');
    const [external] = formatChatBotsForCli([{
      larkAppId: '',
      openId: 'ou_external',
      name: 'external',
      displayName: 'External',
      source: 'introduce',
      hasTeamRole: false,
      mentionable: true,
      mentionSource: 'observed',
    }], 'cli_self');
    const [configuredWithoutFacts] = formatChatBotsForCli([{
      larkAppId: 'cli_unreadable',
      openId: 'ou_unreadable',
      name: 'unreadable',
      displayName: 'Unreadable Config',
      source: 'configured',
      hasTeamRole: false,
      mentionable: true,
      mentionSource: 'cross-ref',
    }], 'cli_self');

    expect(fallback.collaboration).toMatchObject({
      reachability: 'unknown',
      workspace: { requirement: 'unknown', source: 'unknown' },
      authorization: { talk: 'unknown', operate: 'unknown' },
      session: { mentionMode: 'unknown', replyMode: 'unknown' },
      runtime: { transport: 'unknown', deployment: 'unknown', stale: 'unknown' },
    });
    expect(external.collaboration).toMatchObject({
      workspace: { requirement: 'unknown', source: 'unknown' },
      authorization: { talk: 'unknown', operate: 'unknown' },
      session: { mentionMode: 'unknown', replyMode: 'unknown' },
      runtime: { transport: 'unknown', deployment: 'unknown', stale: 'unknown' },
    });
    expect(configuredWithoutFacts.collaboration).toMatchObject({
      workspace: { requirement: 'unknown', source: 'unknown' },
      session: { mentionMode: 'unknown', replyMode: 'unknown' },
      runtime: { transport: 'unknown', stale: 'unknown' },
    });

    const serialized = JSON.stringify({ bots: [fallback, external, configuredWithoutFacts], collaborationHelp });
    for (const key of ['ownerOpenId', 'allowedUsers', 'chatGrants', 'globalGrants', 'oncallChats', 'defaultWorkingDir', 'workingDir', 'sandboxPaths', 'env', 'larkAppSecret', 'secret']) {
      expect(serialized).not.toContain(`\"${key}\"`);
    }
  });

  it('S-2b gates talk/operate on source===configured, not just a non-empty larkAppId', () => {
    // Today the sole producers guarantee introduce rows carry larkAppId='' (so
    // non-empty ⇒ configured). This locks in the defense for a HYPOTHETICAL
    // future introduce producer that carries a remote stable app id: talk/operate
    // promise a --bot-app dispatch that requires LOCAL config, so a non-configured
    // row — even with a non-empty larkAppId — must fall to unknown, never silently
    // flip to preflight-required. (deployment already gates the same way.)
    const [introduceWithAppId] = formatChatBotsForCli([{
      larkAppId: 'cli_remote_future',
      openId: 'ou_remote',
      name: 'remote',
      displayName: 'Remote Introduced',
      source: 'introduce',
      hasTeamRole: false,
      mentionable: true,
      mentionSource: 'observed',
    }], 'cli_self');
    expect(introduceWithAppId.collaboration.authorization).toEqual({ talk: 'unknown', operate: 'unknown' });
    expect(introduceWithAppId.collaboration.runtime.deployment).toBe('unknown');

    // A locally-configured peer with the same non-empty larkAppId DOES preflight.
    const [configuredPeer] = formatChatBotsForCli([{
      larkAppId: 'cli_local',
      openId: 'ou_local',
      name: 'local',
      displayName: 'Local Peer',
      source: 'configured',
      hasTeamRole: false,
      mentionable: true,
      mentionSource: 'cross-ref',
    }], 'cli_self');
    expect(configuredPeer.collaboration.authorization).toEqual({ talk: 'preflight-required', operate: false });
  });

  it('S-3 documents every collaboration value and wires one top-level help object per output path', () => {
    const expectedValues: Record<string, string[]> = {
      reachability: ['ready', 'needs-introduce', 'offline', 'unknown'],
      'workspace.requirement': ['required', 'optional', 'none', 'unknown'],
      'workspace.source': ['default', 'oncall', 'inherited', 'explicit', 'none', 'unknown'],
      'authorization.talk': ['ready', 'preflight-required', 'unknown'],
      'authorization.operate': ['true', 'false', 'unknown'],
      'session.mentionMode': ['always', 'topic', 'never', 'ambient', 'unknown'],
      'session.replyMode': ['chat', 'chat-topic', 'new-topic', 'shared', 'unknown'],
      'runtime.transport': ['true', 'false', 'unknown'],
      'runtime.deployment': ['local', 'remote', 'unknown'],
      'runtime.stale': ['true', 'false', 'unknown'],
    };

    expect(Object.keys(collaborationHelp.fields)).toEqual(Object.keys(expectedValues));
    for (const [field, values] of Object.entries(expectedValues)) {
      const help = collaborationHelp.fields[field as keyof typeof collaborationHelp.fields];
      expect(help.description.length).toBeGreaterThan(0);
      expect(Object.keys(help.values)).toEqual(values);
      expect(Object.values(help.values).every(value => value.length > 0)).toBe(true);
    }
    expect(collaborationHelp.general).toContain('不等于不可用');
    expect(collaborationHelp.fields['authorization.talk'].values['preflight-required']).toContain('talk-only');
    expect(collaborationHelp.fields['authorization.operate'].values.false).toContain('/repo');
    expect(collaborationHelp.fields['authorization.operate'].values.false).toContain('/restart');
    expect(collaborationHelp.fields['workspace.source'].description).toContain('候选');
    expect(collaborationHelp.fields['workspace.source'].description).toContain('最终 cwd');
    expect(collaborationHelp.fields['session.mentionMode'].description).toContain('普通群');
    expect(collaborationHelp.fields['session.replyMode'].description).toContain('普通群');
    expect(collaborationHelp.fields['session.mentionMode'].values.topic).toContain('shared');
    expect(collaborationHelp.fields['session.replyMode'].values['chat-topic']).toContain('chat-scope');
    expect(collaborationHelp.fields['session.replyMode'].values.shared).toContain('cwd');
    expect(collaborationHelp.fields['runtime.transport'].description).toContain('不是在线健康状态');
    expect(collaborationHelp.fields['runtime.transport'].values.true).toContain('不证明 daemon');
    expect(collaborationHelp.fields['runtime.transport'].values.false).toContain('apiOnly');

    const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const outputLines = cliSource.split('\n').filter(line => line.includes('console.log(JSON.stringify({ sessionId: sid') && line.includes('collaborationHelp'));
    expect(outputLines).toHaveLength(2);
    expect(outputLines.every(line => (line.match(/collaborationHelp/g) ?? []).length === 1)).toBe(true);
  });
});
