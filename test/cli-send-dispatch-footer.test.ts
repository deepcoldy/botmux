import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { createDispatchReportBinding, loadOrCreateDispatchReportBindingSecret } from '../src/core/dispatch-report-binding.js';

/**
 * A dispatched sub-topic (opened by `botmux dispatch`) whose binding verifies
 * already returns results through `botmux report --dispatch-root`. Addressing
 * the dispatcher's bot here instead starts a second, context-free session in
 * that same sub-topic (#1887 / #2001 follow-up).
 *
 * These cases drive the real `botmux send` CLI, which is what appends the
 * footer `发送给：` line on the fallback reply card.
 */

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const APP = 'cli_test';
const SESSION = 'sid_dispatched';
const ROOT = 'om_dispatch_root';
const DISPATCHER = 'ou_dispatcher_bot';
const HUMAN = 'ou_human_reviewer';

interface FooterRun { card: any; raw: string }

function runSend(input: {
  args: string[];
  binding?: 'verified' | 'forged' | 'absent';
  humanSender?: string;
  ownerOpenId?: string;
  /** 'botOpenId' (bots-info) is the default; 'crossRef' models the real app-scoped
   *  routing file, where bots-info carries no open_id for the peer. */
  resolveVia?: 'botOpenId' | 'crossRef';
}): FooterRun {
  const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-footer-'));
  const dataDir = join(root, 'data');
  try {
    mkdirSync(dataDir, { recursive: true });
    // The fixture's parent process is this test process, so a marker keyed by
    // it is what the CLI's ancestor walk finds as the live turn context.
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
      sessionId: SESSION, turnId: 'om_turn_1',
    }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'dsh', replyCardMode: 'legacy',
      ...(input.ownerOpenId ? { allowedUsers: [input.ownerOpenId] } : {}),
    }]));
    // This bot app sees the dispatcher as a known bot. `crossRef` models the
    // real app-scoped routing file (`bot-openids-<app>.json`), where bots-info
    // carries no open_id for the peer at all.
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: APP, botName: 'Self', botOpenId: 'ou_self' },
      { larkAppId: 'cli_dispatcher', botName: 'Dispatcher',
        ...(input.resolveVia === 'crossRef' ? {} : { botOpenId: DISPATCHER }) },
    ]));
    if (input.resolveVia === 'crossRef') {
      writeFileSync(join(dataDir, `bot-openids-${APP}.json`),
        JSON.stringify({ Dispatcher: DISPATCHER }));
    }
    if (input.binding !== 'absent') {
      // Same secret the CLI child resolves for this dataDir (dirname(dataDir)
      // unless BOTMUX_CORE_ONLY), so the binding it loads verifies.
      const binding = createDispatchReportBinding(loadOrCreateDispatchReportBindingSecret(dataDir), {
        dispatchRoot: ROOT, targetLarkAppId: 'cli_dispatcher', targetSessionId: 'sid_orchestrator',
        targetChatId: 'oc_test', targetScope: 'thread', sourceName: 'review',
        issuedAt: '2026-10-18T00:00:00.000Z',
      });
      if (input.binding === 'forged') binding.signature = 'forged';
      writeFileSync(join(dataDir, 'orchestrate-dispatch.json'), JSON.stringify({ [ROOT]: { reportBinding: binding } }));
    }
    seedPersistedSessionRows(dataDir, APP, {
      [SESSION]: {
        sessionId: SESSION, larkAppId: APP, chatId: 'oc_test',
        scope: 'thread', rootMessageId: ROOT, status: 'active', cliId: 'dsh',
        chatType: 'group', workingDir: root, ownerOpenId: input.ownerOpenId,
        turnReplyContexts: {
          om_turn_1: {
            target: { mode: 'thread', rootMessageId: ROOT },
            sourceMessageId: 'om_turn_1',
            quoteTargetId: 'om_turn_1',
            replyTargetSenderOpenId: input.humanSender ?? DISPATCHER,
            replyTargetSenderIsBot: !input.humanSender,
          },
        },
        // The `--mention-back` gate reads this per-turn participant window.
        replyTargets: {
          om_turn_1: {
            updatedAt: '2026-10-18T00:00:00.000Z',
            senderOpenId: input.humanSender ?? DISPATCHER,
            participants: [{
              openId: input.humanSender ?? DISPATCHER,
              name: input.humanSender ? 'Reviewer' : 'Dispatcher',
              isBot: !input.humanSender,
            }],
            participantsIncomplete: false,
          },
        },
      },
    });
    const result = spawnSyncTsScript(fixture, ['send', '--response-kind', 'final', ...input.args], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: SESSION, BOTMUX_LARK_APP_ID: APP, BOTMUX_TURN_ID: 'om_turn_1',
        BOTMUX_TEST_CAPTURE_HTTP: '1',
      },
      encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    const captured = String(result.stdout).split('\n').find(line => line.startsWith('CAPTURE_REPLY='));
    expect(captured, String(result.stdout) + String(result.stderr)).toBeDefined();
    const body = JSON.parse(captured!.slice('CAPTURE_REPLY='.length)).body;
    const raw = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);
    return { card: JSON.parse(raw), raw };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function footerText(card: any): string {
  const elements: any[] = card?.body?.elements ?? [];
  const footer = elements.find(element => element?.element_id === 'botmux_reply_footer');
  return typeof footer?.content === 'string' ? footer.content : '';
}

describe('a dispatched sub-topic must not @-address the dispatcher bot', () => {
  it('keeps the dispatcher out of the footer for an explicit --mention-back', () => {
    const { card, raw } = runSend({ args: ['--mention-back', '结果已交回原会话。'], binding: 'verified' });
    expect(footerText(card)).not.toContain(`<at id=${DISPATCHER}>`);
    expect(raw).not.toContain(`<at id=${DISPATCHER}>`);
  });

  it('keeps the dispatcher out of the footer for an explicit --mention', () => {
    const { raw } = runSend({ args: ['--mention', `${DISPATCHER}:Dispatcher`, '结果已交回原会话。'], binding: 'verified' });
    expect(raw).not.toContain(`<at id=${DISPATCHER}>`);
  });

  it('still addresses a human sender in a dispatched topic', () => {
    const { raw } = runSend({
      args: ['--mention-back', '结果已交回原会话。'],
      binding: 'verified', humanSender: HUMAN,
    });
    expect(raw).toContain(`<at id=${HUMAN}>`);
  });

  it('keeps a dispatcher that is also the session owner out of the footer', () => {
    // `/repo`-primed dispatch records the dispatching bot as the owner, so the
    // footer's default `发送给：owner` would name the dispatcher even without any
    // --mention. `buildFooterAddressing` already suppresses a bot owner, so this
    // pins that the @ stays gone when the two rules meet.
    const { raw } = runSend({
      args: ['--mention-back', '结果已交回原会话。'],
      binding: 'verified', ownerOpenId: DISPATCHER,
    });
    expect(raw).not.toContain(`<at id=${DISPATCHER}>`);
  });

  it('keeps the dispatcher @ when the message goes to another topic', () => {
    // `--into <other topic>` / `--top-level` are different destinations: the
    // dispatched-topic rule must not silently strip legitimate addressing
    // there (mentioning the lead from the main conversation is supported).
    const { raw } = runSend({
      args: ['--into', 'om_other_topic', '--mention', `${DISPATCHER}:Dispatcher`, '看下这个'],
      binding: 'verified',
    });
    expect(raw).toContain(`<at id=${DISPATCHER}>`);
  });

  it('resolves the dispatcher through the app-scoped cross-ref, not bots-info', () => {
    // The real routing file is `bot-openids-<app>.json`; bots-info need not carry
    // the peer's open_id. Same outcome must hold on that path.
    const { raw } = runSend({
      args: ['--mention-back', '结果已交回原会话。'],
      binding: 'verified', resolveVia: 'crossRef',
    });
    expect(raw).not.toContain(`<at id=${DISPATCHER}>`);
  });

  it('keeps the dispatcher @ when an explicit --chat-id overrides the destination', () => {
    const { raw } = runSend({
      args: ['--chat-id', 'oc_elsewhere', '--mention', `${DISPATCHER}:Dispatcher`, '看下这个'],
      binding: 'verified',
    });
    expect(raw).toContain(`<at id=${DISPATCHER}>`);
  });

  it('keeps the dispatcher @ for a top-level publish', () => {
    const { raw } = runSend({
      args: ['--top-level', '--mention', `${DISPATCHER}:Dispatcher`, '看下这个'],
      binding: 'verified',
    });
    expect(raw).toContain(`<at id=${DISPATCHER}>`);
  });

  it('still addresses the dispatcher when the topic binding does not verify', () => {
    const { raw } = runSend({ args: ['--mention-back', '结果已交回原会话。'], binding: 'forged' });
    expect(raw).toContain(`<at id=${DISPATCHER}>`);
  });

  it('still addresses the dispatcher when the topic has no binding', () => {
    const { raw } = runSend({ args: ['--mention-back', '结果已交回原会话。'], binding: 'absent' });
    expect(raw).toContain(`<at id=${DISPATCHER}>`);
  });
});
