import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonSource = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf8');

describe('daemon per-turn reply sender + participant wiring', () => {
  it('computes a turn window per path and binds participants + incomplete', () => {
    // passthrough (raw command → sender-only window)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, turn.senderOpenId, turn.senderIsBot, undefined)');
    expect(daemonSource).toMatch(/participants: passthroughWindow\.participants,\s*participantsIncomplete: passthroughWindow\.incomplete/);
    // initial passthrough (raw command → tri-state is-bot for the label, best-effort name)
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOpenId, resolvedSenderIsBotTriState, undefined, initialPassthroughSender?.name)');
    expect(daemonSource).toMatch(/participants: initialWindow\.participants, participantsIncomplete: initialWindow\.incomplete/);
    // new-topic (business message → tri-state sender + parsed.mentions + resolved
    // name + post @s pre-extracted from current & forward-seed messages)
    expect(daemonSource).toContain('const newTopicPostAt = collectPostAtMentions(data?.message, ctx.forwardSeedData?.message);');
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOpenId, senderIsBotTriState(parsed.senderType, isForeignBotSender), parsed.mentions, newTopicSender?.name, newTopicPostAt)');
    expect(daemonSource).toMatch(/participants: newTopicWindow\.participants, participantsIncomplete: newTopicWindow\.incomplete/);
    // existing-session: prepared (race-loser) handoff uses the COMPLETE pre-extracted
    // set; otherwise extract from this message AND the forward-seed message (a
    // CAS loser routes back through handleThreadReplyAdmitted without re-passing
    // prepared.postParticipantMentions, so the seed's post @s must be recovered
    // from ctx.forwardSeedData here — see the double-race guard test below).
    expect(daemonSource).toContain('const existingPostAt = prepared?.postParticipantMentions ?? collectPostAtMentions(data?.message, ctx.forwardSeedData?.message);');
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, callerOpenId, senderIsBotTriState(parsed.senderType, isForeignBot), parsed.mentions, undefined, existingPostAt)');
    expect(daemonSource).toMatch(/participants: existingWindow\.participants, participantsIncomplete: existingWindow\.incomplete/);
    // auto-create: same prepared-vs-fresh post-@ resolution (also folds forward seed)
    expect(daemonSource).toContain('const autoCreatePostAt = prepared?.postParticipantMentions ?? collectPostAtMentions(data?.message, ctx.forwardSeedData?.message);');
    expect(daemonSource).toContain('buildTurnParticipants(larkAppId, senderOId, senderIsBotTriState(parsed.senderType, isForeignBot), parsed.mentions, autoCreateSender?.name, autoCreatePostAt)');
    expect(daemonSource).toMatch(/participants: autoCreateWindow\.participants, participantsIncomplete: autoCreateWindow\.incomplete/);
  });

  it('每条 inbound 路径都把「消息是否来自话题内」如实记进 per-turn 记录', () => {
    // chatSessionAnsweredRootAtTopLevel 靠 inThread 区分「顶层 @ 之后才被开成
    // 话题」与「用户真正开的原生话题」——两者的 target 都是 mode='plain'，只有
    // 这一位能分开。任何一条路径把它写死成常量（而不是照实读 parsed.threadId），
    // 判据就会在那条路径上重新退化成只看 mode，真话题里的回复又会被平铺出去。
    // 所以逐条钉住「值来自 inbound 本身」，而不是只钉「字段存在」。
    const inThreadFromInbound = /inThread: !!parsed\.threadId/g;
    // initial passthrough / new-topic / existing-session / auto-create 四条
    // beginReplyTargetTurn 直连路径，外加 passthrough 经 turn 结构体的透传。
    expect(daemonSource.match(inThreadFromInbound) ?? []).toHaveLength(5);
    expect(daemonSource).toMatch(/participants: initialWindow\.participants, participantsIncomplete: initialWindow\.incomplete, inThread: !!parsed\.threadId/);
    expect(daemonSource).toMatch(/participants: newTopicWindow\.participants, participantsIncomplete: newTopicWindow\.incomplete, inThread: !!parsed\.threadId/);
    expect(daemonSource).toMatch(/participants: existingWindow\.participants, participantsIncomplete: existingWindow\.incomplete, inThread: !!parsed\.threadId/);
    expect(daemonSource).toMatch(/participants: autoCreateWindow\.participants, participantsIncomplete: autoCreateWindow\.incomplete, inThread: !!parsed\.threadId/);
    // passthrough 走 turn 结构体：调用方读 inbound，helper 原样转交。
    expect(daemonSource).toMatch(/substitute: !!substituteTrigger,\s*inThread: !!parsed\.threadId,/);
    expect(daemonSource).toMatch(/participantsIncomplete: passthroughWindow\.incomplete,\s*inThread: turn\.inThread,/);
  });

  it('BOTH registration-race loser handoffs preserve the pre-extracted seed+follow-up post @s', () => {
    // Two CAS-loser handoffs (new-topic loser and the auto-create loser) must EACH
    // preserve the complete seed's post inline @s, or a double-race drops them.
    // #597 merge: the losers route back through the canonical owner via
    // handleThreadReplyAdmitted(data, ctx) rather than passing an explicit
    // `postParticipantMentions`. That handler recomputes the window from
    // `prepared?.postParticipantMentions ?? collectPostAtMentions(data, forwardSeed)`,
    // so it MUST read ctx.forwardSeedData?.message too — otherwise the seed's post
    // @s vanish on the loser path (the exact double-race #750 guarded). Assert the
    // recompute in both admitted branches carries the forward seed.
    expect(daemonSource).toMatch(/postParticipantMentions\?: LarkMention\[\];/);   // on the prepared type
    // Both admitted recompute points fold the forward-seed message into the post @s.
    expect(
      daemonSource.match(/collectPostAtMentions\(data\?\.message, ctx\.forwardSeedData\?\.message\)/g),
    ).toHaveLength(3); // new-topic primary + existing-thread loser + auto-create loser
  });

  it('buildTurnParticipants concats pre-extracted post @s (extractPostAtParticipants) into the window', () => {
    // post rich-text @s live outside message.mentions[]; collectPostAtMentions
    // extracts them, buildTurnParticipants concats (not key/name-merged) so a post
    // "@self + @OtherBot" turn is not under-counted.
    expect(daemonSource).toContain('function collectPostAtMentions(');
    expect(daemonSource).toContain('return messages.flatMap(m => extractPostAtParticipants(m));');
    expect(daemonSource).toMatch(/\[\.\.\.\(mentions \?\? \[\]\), \.\.\.\(postAtMentions \?\? \[\]\)\]/);
  });

  it('senderIsBotTriState maps unknown → undefined (not human) and keeps routing boolean separate', () => {
    expect(daemonSource).toContain('function senderIsBotTriState(');
    expect(daemonSource).toMatch(/if \(isForeignBot \|\| senderType === 'app' \|\| senderType === 'bot'\) return true;/);
    expect(daemonSource).toMatch(/if \(senderType === 'user'\) return false;/);
    expect(daemonSource).toMatch(/return undefined;/);
  });

  it('buildTurnParticipants wraps the pure helper with live deps (self open_id + self app_id + peer predicate)', () => {
    // The self-exclusion / app_id-incomplete / three-state logic lives in the
    // pure buildTurnParticipantsFrom (behaviorally tested in reply-target-fallback);
    // the daemon wrapper supplies botOpenId + isKnownPeerBot + self larkAppId
    // (so an app_id-form self @ is excluded, not mis-counted as unresolved).
    expect(daemonSource).toContain('function buildTurnParticipants(');
    expect(daemonSource).toMatch(/return buildTurnParticipantsFrom\(\s*\{ openId: senderOpenId, isBot: senderIsBot, name: senderName \},/);
    expect(daemonSource).toContain('selfBot.botOpenId,');
    expect(daemonSource).toContain('(openId) => isKnownPeerBot(config.session.dataDir, larkAppId, openId)');
    expect(daemonSource).toContain('selfBot.config.larkAppId,');
  });

  it('cold-start passthrough resolves is-bot from the caller (cross-ref), falling back to sender_type only when absent', () => {
    expect(daemonSource).toMatch(/const resolvedSenderIsBot = senderIsBot \?\? \(parsed\.senderType === 'app' \|\| parsed\.senderType === 'bot'\);/);
    // Both callers pass a cross-ref-resolved is-bot, kept separate from quota's botSender.
    expect(daemonSource).toMatch(/botSender: isBotSenderType,\n[\s\S]{0,400}senderIsBot: isForeignBotSender,/);
    expect(daemonSource).toMatch(/botSender: isBotSenderType \|\| isForeignBot,\n[\s\S]{0,400}senderIsBot: isBotSenderType \|\| isForeignBot,/);
  });

  it('does not invent a sender for scheduled or system-created turns', () => {
    expect(daemonSource).toContain('beginReplyTargetTurn(ds, sharedReplyRootId, sharedReplyRootId, new Date(now).toISOString());');
  });
});
