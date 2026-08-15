import { describe, expect, it } from 'vitest';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { registerBot } from '../src/bot-registry.js';
import { buildDocCommentTurnInput, buildDocWatchWarmupTurnInput } from '../src/core/doc-comment-prompt.js';
import {
  buildFollowUpCliInput,
  buildNewTopicCliInput,
  buildReforkCliInput,
} from '../src/core/session-manager.js';
import { buildExistingSessionContent } from '../src/core/trigger-session.js';
import type { DaemonSession } from '../src/core/types.js';

const OTHER_BOTS = [
  { name: 'helper-bot', displayName: 'Helper Bot', openId: 'ou_other_bot' },
];

function newTopicInput(opts: {
  candidateManagedDelivery?: boolean;
  cliId?: 'traex' | 'claude-code' | 'codex-app';
  locale?: 'zh' | 'en';
  availableBots?: Array<{ name: string; displayName: string; openId: string }>;
}) {
  return buildNewTopicCliInput(
    '报警上下文：panic rate elevated',
    'session-under-test',
    opts.cliId ?? 'traex',
    undefined,
    undefined,
    undefined,
    opts.availableBots,
    undefined,
    { name: 'Candidate RCA', openId: 'ou_candidate_bot' },
    opts.locale ?? 'zh',
    undefined,
    {
      larkAppId: 'cli_candidate',
      chatId: 'oc_shadow',
      ...(opts.candidateManagedDelivery ? { candidateManagedDelivery: true } : {}),
    },
  );
}

function newTopicContent(opts: Parameters<typeof newTopicInput>[0]): string {
  return newTopicInput(opts).content;
}

describe('Candidate managed-delivery prompt hygiene', () => {
  it('candidate first-turn prompt contains no botmux send guidance and explains managed delivery', () => {
    const content = newTopicContent({ candidateManagedDelivery: true });
    expect(content).toContain('<user_message>');
    expect(content).toContain('报警上下文：panic rate elevated');
    expect(content).not.toContain('botmux send');
    expect(content).not.toContain('--mention');
    expect(content).toMatch(/受管投递|自动送达/);
  });

  it('candidate first-turn prompt forbids delivery-failure claims', () => {
    const content = newTopicContent({ candidateManagedDelivery: true });
    expect(content).toMatch(/未成功投递|投递失败|发送失败/);
    expect(content).toMatch(/不要|禁止/);
  });

  it('normal bot first-turn prompt keeps the existing botmux send routing', () => {
    const content = newTopicContent({});
    expect(content).toContain('botmux send');
    expect(content).toContain('<botmux_routing>');
    expect(content).not.toMatch(/受管投递/);
  });

  it('candidate follow-up prompt swaps the send reminder for managed delivery', () => {
    const input = buildFollowUpCliInput('继续排查这个报警', 'session-under-test', {
      cliId: 'traex',
      locale: 'zh',
      larkAppId: 'cli_candidate',
      chatId: 'oc_shadow',
      candidateManagedDelivery: true,
    });
    expect(input.content).toContain('<botmux_reminder>');
    expect(input.content).toContain('<user_message>');
    expect(input.content).not.toContain('botmux send');
  });

  it('normal follow-up prompt keeps the existing send reminder', () => {
    const input = buildFollowUpCliInput('普通追问', 'session-normal', {
      cliId: 'traex',
      locale: 'zh',
      larkAppId: 'cli_normal',
      chatId: 'oc_normal',
    });
    expect(input.content).toContain('回复必须 botmux send');
  });

  it('refork prompt derives managed delivery from the session candidate contract', () => {
    const candidateDs = {
      session: {
        sessionId: 'session-under-test',
        chatId: 'oc_shadow',
        candidateRuntimeContract: { runtimeName: 'coco' },
      },
      larkAppId: 'cli_candidate',
    } as unknown as DaemonSession;
    const candidate = buildReforkCliInput(candidateDs, '重启后的追问', {
      cliId: 'traex',
      locale: 'zh',
    });
    expect(candidate.content).toContain('重启后的追问');
    expect(candidate.content).not.toContain('botmux send');

    const normalDs = {
      session: { sessionId: 'session-normal', chatId: 'oc_normal' },
      larkAppId: 'cli_normal',
    } as unknown as DaemonSession;
    const normal = buildReforkCliInput(normalDs, '普通重启追问', {
      cliId: 'traex',
      locale: 'zh',
    });
    expect(normal.content).toContain('回复必须 botmux send');
  });

  it('candidate first-turn prompt stays clean when the shadow chat has other bots', () => {
    const content = newTopicContent({ candidateManagedDelivery: true, availableBots: OTHER_BOTS });
    expect(content).not.toContain('botmux send');
    expect(content).not.toContain('--mention');
    expect(content).not.toContain('<available_bots');
  });

  it('normal bot first-turn prompt keeps the available-bots mention guidance', () => {
    const content = newTopicContent({ availableBots: OTHER_BOTS });
    expect(content).toContain('<available_bots');
    expect(content).toContain('--mention');
  });

  it('codex-app sidecar input is send-free for candidate sessions with other bots present', () => {
    const input = newTopicInput({
      candidateManagedDelivery: true,
      cliId: 'codex-app',
      availableBots: OTHER_BOTS,
    });
    expect(input.codexAppInput).toBeDefined();
    const serialized = JSON.stringify(input.codexAppInput);
    expect(serialized).not.toContain('botmux send');
    expect(serialized).not.toContain('--mention');

    const normal = newTopicInput({ cliId: 'codex-app', availableBots: OTHER_BOTS });
    expect(JSON.stringify(normal.codexAppInput)).toContain('--mention');
  });

  it('doc-comment and doc-watch live follow-ups derive managed delivery from the candidate contract', () => {
    const candidateDs = {
      larkAppId: 'cli_candidate',
      adoptedFrom: undefined,
      session: {
        sessionId: 'sess_candidate_doc',
        chatId: 'oc_shadow',
        cliId: 'traex',
        candidateRuntimeContract: { runtimeName: 'coco' },
      },
    } as unknown as DaemonSession;

    const docComment = buildDocCommentTurnInput({
      ds: candidateDs,
      promptInput: {
        fileToken: 'doc_candidate_1',
        fileType: 'docx',
        question: '这段结论的依据？',
        author: '值班同学',
        brand: 'feishu',
        locale: 'zh',
      },
      botCliId: 'traex',
      mode: 'live',
    });
    expect(docComment.cliInput.content).not.toContain('botmux send');

    const warmup = buildDocWatchWarmupTurnInput({
      ds: candidateDs,
      promptInput: {
        fileToken: 'doc_candidate_1',
        fileType: 'docx',
        brand: 'feishu',
        locale: 'zh',
      },
      botCliId: 'traex',
      mode: 'live',
    });
    expect(warmup.cliInput.content).not.toContain('botmux send');
  });

  it('existing-session redispatch (launch retry / restart continuation) is send-free for candidates', () => {
    registerBot({
      larkAppId: 'cli_trigger_gate',
      larkAppSecret: 'test',
      cliId: 'traex',
      allowedUsers: ['ou_owner'],
    } as never);

    const candidateDs = {
      larkAppId: 'cli_trigger_gate',
      adoptedFrom: undefined,
      session: {
        sessionId: 'sess_candidate_redispatch',
        chatId: 'oc_shadow',
        cliId: 'traex',
        whiteboardId: 'wb_candidate',
        candidateRuntimeContract: { runtimeName: 'coco' },
      },
    } as unknown as DaemonSession;
    const candidate = buildExistingSessionContent(
      candidateDs,
      '重投递的候选首轮 prompt',
      'cli_trigger_gate',
      'oc_shadow',
      '',
      '',
      '',
    );
    expect(candidate.content).toContain('重投递的候选首轮 prompt');
    expect(candidate.content).not.toContain('botmux send');
    expect(candidate.content).not.toContain('<whiteboard');

    const normalDs = {
      larkAppId: 'cli_trigger_gate',
      adoptedFrom: undefined,
      session: {
        sessionId: 'sess_normal_redispatch',
        chatId: 'oc_normal',
        cliId: 'traex',
      },
    } as unknown as DaemonSession;
    const normal = buildExistingSessionContent(
      normalDs,
      '普通会话重投递',
      'cli_trigger_gate',
      'oc_normal',
      '',
      '',
      '',
    );
    expect(normal.content).toContain('回复必须 botmux send');
  });

  it('claude-code system prompt swaps to managed delivery for candidate sessions only', () => {
    const adapter = createCliAdapterSync('claude-code');
    const systemPromptOf = (candidateManagedDelivery: boolean): string => {
      const args = adapter.buildArgs({
        sessionId: 'session-under-test',
        resume: false,
        locale: 'zh',
        botName: 'Candidate RCA',
        botOpenId: 'ou_candidate_bot',
        ...(candidateManagedDelivery ? { candidateManagedDelivery: true } : {}),
      });
      const flagIndex = args.indexOf('--append-system-prompt');
      expect(flagIndex).toBeGreaterThan(-1);
      return args[flagIndex + 1]!;
    };

    const candidate = systemPromptOf(true);
    expect(candidate).not.toContain('botmux send');
    expect(candidate).not.toContain('--mention');
    expect(candidate).toMatch(/受管投递|自动送达/);
    expect(candidate).toMatch(/未成功投递|投递失败|发送失败/);

    const normal = systemPromptOf(false);
    expect(normal).toContain('botmux send');
    expect(normal).toContain('<botmux_routing>');
  });
});
