// Must stay the first import: the session store opened below writes under the data dir.
import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { buildUntrustedEventPrompt, buildExternalEventCodexAppContexts } from '../src/core/trigger-session.js';
import { buildFollowUpCliInput, buildNewTopicCliInput } from '../src/core/session-manager.js';
import {
  buildBotmuxSystemPromptText,
  nativeGatewayDisplayName,
} from '../src/adapters/cli/shared-hints.js';
import { builtinSkillBlockForInjectsSessionContext, nativeGatewayAskHintBlock } from '../src/skills/injection-mode.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { loadBotConfigs, registerBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { setPromptOverrideResolver } from '../src/i18n/index.js';
import { PROMPT_FRAGMENT_CATALOG, overridableFragmentKeys } from '../src/skills/prompt-fragments.js';

/**
 * What the CLI of a native IM gateway's dedicated core is told, against what any
 * other process is told for the same input. "Native" = the env the gateway's
 * managed-core launcher sets (core/runtime-mode.ts); "bare core" = a core-only
 * service without it (`serve --api-only`), whose prompt must stay as it is.
 */
const APP = 'local_wecom_promptfix';
const SID = '11111111-2222-4333-8444-555555555555';
const DELIVERY = 'botmux send --wecom-delivery eyJmYWtlIjoiZGVzY3JpcHRvciJ9 --text \'reply\'';

type Mode = 'native' | 'bare-core' | 'flag-only';
function enter(mode: Mode, cli = 'codex'): void {
  vi.unstubAllEnvs();
  if (mode !== 'flag-only') {
    vi.stubEnv('BOTMUX_CORE_ONLY', '1');
    vi.stubEnv('BOTMUX_API_ONLY_BOT', APP);
    vi.stubEnv('BOTMUX_CORE_BOT_CONFIG', '{}');
    vi.stubEnv('BOTMUX_CORE_CLI', cli);
    vi.stubEnv('BOTMUX_CORE_SKIP_DOTENV', '1');
  }
  if (mode !== 'bare-core') vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
}

function gatewayRequest(over: Partial<TriggerRequest> = {}, options: TriggerRequest['options'] = { asyncReturnSessionId: true }): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'wecom:promptfix', requestId: 'msg-1' },
    target: { kind: 'turn' },
    envelope: { format: 'text', sourceName: 'chat (fake)', trusted: false, rawText: '[user fake_alice]\nsummarise README (fake)' },
    payloadTrusted: true,
    instruction: `To send the final reply yourself, use ${DELIVERY}.\n\nReply in the current chat (fake connector line).`,
    presentation: { thinking: 'hidden', topicMessage: null },
    options,
    ...over,
  };
}

/** Sentences that mention `botmux send` together with a prohibition and with no
 *  exception ("other", "unless", "only when", …): an unconditional ban. */
function unconditionalSendBans(text: string): string[] {
  return text
    .split(/\n|(?<=[.;。；])/)
    .filter(s => /botmux send/.test(s))
    .filter(s => /\b(do not|don't|never)\b|不要|禁止|不得/i.test(s))
    .filter(s => !/\b(other|unless|except)\b|其它|其他|除非|只有/i.test(s));
}

function block(text: string, tag: string): string {
  const start = text.search(new RegExp(`<${tag}[ >]`));
  const end = text.indexOf(`</${tag}>`, start);
  expect(start, `${tag} present`).toBeGreaterThanOrEqual(0);
  return text.slice(start, end + tag.length + 3);
}

function eventJson(text: string): Record<string, any> {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(m, 'event JSON present').toBeTruthy();
  return JSON.parse(m![1]);
}

/** Lines between the response-mode block and the event block: the caller framing. */
function framing(text: string): string[] {
  const from = text.indexOf('</botmux_http_response_mode>');
  const to = text.indexOf('<botmux_external_event');
  return text.slice(from, to).split('\n').slice(1).filter(Boolean);
}

beforeAll(() => {
  enter('native');
  for (const cfg of loadBotConfigs()) {
    const st = registerBot(cfg);
    // The daemon seeds the same synthetic identity for an apiOnly bot.
    st.botOpenId ||= `bot_${cfg.larkAppId}`;
    st.botName ||= cfg.displayName ?? cfg.larkAppId;
  }
  sessionStore.init(APP);
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe('native gateway trigger prompt', () => {
  it('does not ban botmux send outright while the task hands over a delivery command', () => {
    enter('native');
    const native = buildUntrustedEventPrompt(gatewayRequest(), 'trg_1');
    expect(native).toContain(DELIVERY);
    expect(unconditionalSendBans(native)).toEqual([]);
    // The same request outside a native gateway core keeps the program contract,
    // which does ban it — the property above is the native gate's doing.
    enter('bare-core');
    expect(unconditionalSendBans(buildUntrustedEventPrompt(gatewayRequest(), 'trg_1'))).not.toEqual([]);
  });

  it('keeps the BOTMUX_NOTHING_TO_SEND sentinel inside the response-mode block', () => {
    enter('native');
    for (const options of [{ asyncReturnSessionId: true }, { waitForFinalOutput: true }] as const) {
      const mode = block(buildUntrustedEventPrompt(gatewayRequest({}, options), 'trg_1'), 'botmux_http_response_mode');
      expect(mode.split('\n').some(line => /single token BOTMUX_NOTHING_TO_SEND\b/.test(line))).toBe(true);
    }
  });

  it('does not tell the model its reply goes to a program instead of a chat', () => {
    enter('bare-core');
    const programDestination = block(buildUntrustedEventPrompt(gatewayRequest(), 'trg_1'), 'botmux_http_response_mode').split('\n')[1];
    enter('native');
    const native = block(buildUntrustedEventPrompt(gatewayRequest(), 'trg_1'), 'botmux_http_response_mode');
    expect(native).not.toContain(programDestination);
    expect(native).toMatch(/chat/);
  });

  it('frames the payload as a relayed chat message, not a token/HMAC webhook caller', () => {
    enter('bare-core');
    const webhookFraming = framing(buildUntrustedEventPrompt(gatewayRequest(), 'trg_1'));
    enter('native');
    const nativeFraming = framing(buildUntrustedEventPrompt(gatewayRequest(), 'trg_1'));
    const shared = nativeFraming.filter(line => webhookFraming.includes(line));
    // Only the precedence rule is common; every caller-identity line is replaced.
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/precedence/);
    expect(nativeFraming.length).toBeGreaterThan(1);
    // The gateway authenticates nobody by token or HMAC; only a webhook connector does.
    expect(webhookFraming.join(' ')).toMatch(/HMAC/);
    expect(nativeFraming.join(' ')).not.toMatch(/HMAC|token/i);
  });

  it('does not render the gateway turn key in the event JSON, and only in a native core', () => {
    const followUp = gatewayRequest({ target: { kind: 'turn', sessionId: SID } }, { asyncReturnSessionId: true, turnIdempotencyKey: 'a'.repeat(64) });
    enter('native');
    const nativeEvent = eventJson(buildUntrustedEventPrompt(followUp, 'trg_2'));
    expect(nativeEvent.options).toEqual({ asyncReturnSessionId: true });
    expect(JSON.stringify(buildExternalEventCodexAppContexts(followUp, 'trg_2'))).not.toContain('a'.repeat(64));
    enter('bare-core');
    expect(eventJson(buildUntrustedEventPrompt(followUp, 'trg_2')).options.turnIdempotencyKey).toBe('a'.repeat(64));
  });

  it.each([
    ['trusted async', gatewayRequest()],
    ['untrusted wait', { ...gatewayRequest({}, { waitForFinalOutput: true }), payloadTrusted: undefined }],
    ['async follow-up with key', gatewayRequest({ target: { kind: 'turn', sessionId: SID } }, { asyncReturnSessionId: true, turnIdempotencyKey: 'k' })],
  ])('needs the core-only flag too: the native flag alone renders exactly what a bare core does (%s)', (_label, req) => {
    enter('bare-core');
    const bare = buildUntrustedEventPrompt(req as TriggerRequest, 'trg_3');
    vi.unstubAllEnvs();
    const plain = buildUntrustedEventPrompt(req as TriggerRequest, 'trg_3');
    enter('flag-only');
    expect(buildUntrustedEventPrompt(req as TriggerRequest, 'trg_3')).toBe(plain);
    expect(bare).toBe(plain);
  });
});

describe('native gateway session input', () => {
  const opening = (cli: string) => buildNewTopicCliInput(
    'hello (fake)', SID, cli as any, undefined, [], [], undefined, undefined,
    { name: APP, openId: `bot_${APP}` }, 'zh', undefined,
    { larkAppId: APP, chatId: 'http_async_fake-1', larkToolResume: false },
  ).content;
  const followUp = (cli: string, locale: 'zh' | 'en') => buildFollowUpCliInput('next (fake)', SID, {
    isAdoptMode: false, cliId: cli as any, locale, larkAppId: APP, chatId: 'http_async_fake-1', sessionBackendType: 'pty', turnId: 'turn_2',
  }).content;

  it('opens without the built-in skill catalog and without internal ids', () => {
    enter('bare-core');
    expect(opening('codex')).toContain('<botmux_builtin_skills>');
    enter('native');
    const native = opening('codex');
    expect(native).not.toContain('<botmux_builtin_skills>');
    expect(native).not.toContain('<open_id>');
    expect(native).not.toContain(APP);
  });

  it.each(['zh', 'en'] as const)('follow-up reminder [%s] does not ban botmux send outright, unlike the program reminder', (locale) => {
    enter('bare-core');
    const program = block(followUp('codex', locale), 'botmux_reminder');
    expect(unconditionalSendBans(program)).not.toEqual([]);
    enter('native');
    const native = block(followUp('codex', locale), 'botmux_reminder');
    expect(native).not.toBe(program);
    expect(unconditionalSendBans(native)).toEqual([]);
    expect(native).toContain('botmux_http_response_mode');
  });

  it('copy only a native core renders is registered for that channel and stays off the Feishu listing', () => {
    // Find the keys from what is rendered, through an override marker on every key.
    setPromptOverrideResolver((key) => `@@${key}@@`);
    try {
      enter('native');
      const rendered = [block(followUp('codex', 'zh'), 'botmux_reminder'), nativeGatewayAskHintBlock('zh')].join('\n');
      const keys = [...rendered.matchAll(/@@([\w.]+)@@/g)].map(m => m[1]);
      expect(keys).toHaveLength(2);
      const listed = new Set(overridableFragmentKeys());
      for (const key of keys) {
        expect(PROMPT_FRAGMENT_CATALOG.find(f => f.key === key)?.channel, key).toBe('native-gateway');
        expect(listed.has(key), key).toBe(false);
      }
    } finally {
      setPromptOverrideResolver(undefined);
    }
  });

  it('offers no built-in skill catalog on the system-prompt path either, only the ask hint', () => {
    enter('bare-core');
    const catalog = builtinSkillBlockForInjectsSessionContext(APP, 'zh', { asksViaHook: false });
    const skillNames = [...catalog.matchAll(/^- (botmux-[\w-]+):/gm)].map(m => m[1]);
    expect(skillNames.length).toBeGreaterThan(1);
    enter('native');
    const native = builtinSkillBlockForInjectsSessionContext(APP, 'zh', { asksViaHook: false });
    expect(native).not.toContain('<botmux_builtin_skills>');
    for (const name of skillNames) expect(native, name).not.toContain(name);
    expect(native).toBe(nativeGatewayAskHintBlock('zh'));
    // A CLI that takes questions through its own hook gets nothing at all.
    expect(builtinSkillBlockForInjectsSessionContext(APP, 'zh', { asksViaHook: true })).toBe('');
  });
});

describe('native gateway identity', () => {
  it('tells a configured display name from the id-shaped fallback', () => {
    expect(nativeGatewayDisplayName(APP, APP)).toBeUndefined();
    expect(nativeGatewayDisplayName(`bot_${APP}`, APP)).toBeUndefined();
    expect(nativeGatewayDisplayName('local_wecom_other', APP)).toBeUndefined();
    expect(nativeGatewayDisplayName('  ', APP)).toBeUndefined();
    expect(nativeGatewayDisplayName('客服小助手', undefined)).toBeUndefined();
    expect(nativeGatewayDisplayName(' 客服小助手 ', APP)).toBe('客服小助手');
  });

  it('system prompt shows only a display name, never an open_id', () => {
    const base = { locale: 'zh' as const, botOpenId: `bot_${APP}`, larkAppId: APP, noTransport: true, hideLocalAddresses: false, cliId: 'claude-code' as const };
    enter('bare-core');
    expect(buildBotmuxSystemPromptText({ ...base, botName: APP })).toContain('<open_id>');
    enter('native');
    const fallback = buildBotmuxSystemPromptText({ ...base, botName: APP });
    expect(fallback).not.toContain('<identity>');
    expect(fallback).not.toContain(APP);
    const named = buildBotmuxSystemPromptText({ ...base, botName: '客服<小助手>' });
    expect(named).toContain('<name>客服&lt;小助手&gt;</name>');
    expect(named).not.toContain('<open_id>');
    expect(named).not.toContain(APP);
  });

  it.each(['codex-app', 'mir', 'mira', 'dsh'])('%s runner gets no internal id and no open_id', (cli) => {
    const args = (botName: string) => createCliAdapterSync(cli as any).buildArgs({
      sessionId: SID, resume: false, workingDir: '/tmp', botName, botOpenId: `bot_${APP}`, larkAppId: APP, locale: 'zh',
    } as any) as string[];
    enter('bare-core');
    expect(args(APP)).toContain('--bot-open-id');
    enter('native');
    expect(args(APP)).not.toContain('--bot-open-id');
    expect(args(APP)).not.toContain('--bot-name');
    const named = args('客服小助手');
    expect(named[named.indexOf('--bot-name') + 1]).toBe('客服小助手');
    expect(named.join(' ')).not.toContain(APP);
  });
});
