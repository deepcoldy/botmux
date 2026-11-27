/**
 * The WeCom customization catalog: every piece of built-in copy that really
 * reaches the model in a WeCom session, as the Dashboard's WeCom 「自定义」 tab
 * lists it and the WeCom store (services/customization-scope.ts `wecom`) keys it.
 *
 *  1. The gateway's own per-turn lines — the fixed text the gateway writes into
 *     every turn's <botmux_task> (delivery instruction, channel / audience
 *     line). They are registered HERE, with their factory text, because they
 *     are WeCom copy: the gateway renders them (gateway/prompt-lines.ts),
 *     always in Chinese, exactly as before they became editable. Lines of
 *     retired features (explicit send delivery, private delivery from a group,
 *     first-contact initialisation, reply style) are gone; an override a
 *     store still holds for one of them is never rendered.
 *     The response-mode block and the "Chat message from a user
 *     of this channel" lines are a machine contract of the core
 *     (core/trigger-session.ts, BOTMUX_NOTHING_TO_SEND) and are NOT editable.
 *  2. The core-side catalog fragments a native gateway's dedicated core renders
 *     (skills/prompt-fragments.ts nativeGatewayCatalogFragments): its own
 *     `channel: 'native-gateway'` entries plus the measured shared ones.
 *
 * Shared by the gateway (renders 1.) and the Dashboard (lists 1. + 2.), so it
 * holds data only and loads no gateway process code.
 */
import type { Locale } from '../../../i18n/types.js';
import { shippedText } from '../../../i18n/index.js';
import {
  BLOCK_META,
  PROMPT_STAGES,
  nativeGatewayCatalogFragments,
  type PromptFragmentSpec,
  type PromptStage,
} from '../../../skills/prompt-fragments.js';

/** The gateway lines are Chinese copy and are rendered only in this locale. */
export const WECOM_GATEWAY_LINE_LOCALE: Locale = 'zh';

export const WECOM_GATEWAY_LINE_KEYS = [
  'wecom.task.delivery_auto',
  'wecom.task.channel_private',
  'wecom.task.channel_group',
] as const;
export type WecomGatewayLineKey = typeof WECOM_GATEWAY_LINE_KEYS[number];

const CHANNEL_HEAD = '通过企业微信回复当前用户的请求。';
const CHANNEL_TAIL = '结果由通道网关发送；不要调用飞书消息、历史或文档工具。';

/** Factory text of each gateway line (byte-identical to the pre-catalog gateway). */
export const WECOM_GATEWAY_LINE_FACTORY: Readonly<Record<WecomGatewayLineKey, string>> = {
  'wecom.task.delivery_auto': '结果通过当前通道的自动最终回包发送。',
  'wecom.task.channel_private': `${CHANNEL_HEAD}这是私聊，回复只发给当前用户。${CHANNEL_TAIL}`,
  'wecom.task.channel_group': `${CHANNEL_HEAD}这是群聊，回复会发到群里，群成员都能看到。${CHANNEL_TAIL}`,
};

const EVERY_TURN: Pick<PromptFragmentSpec, 'stage' | 'stages'> = { stage: 'new', stages: ['followup'] };
const line = (spec: Omit<PromptFragmentSpec, 'channel' | 'fixedLocale'> & { key: WecomGatewayLineKey }): PromptFragmentSpec => ({
  ...spec,
  channel: 'native-gateway',
  fixedLocale: WECOM_GATEWAY_LINE_LOCALE,
});

/** The gateway's per-turn lines as catalog entries (see the module header). */
export const WECOM_GATEWAY_PROMPT_FRAGMENTS: readonly PromptFragmentSpec[] = [
  line({
    key: 'wecom.task.delivery_auto', block: 'wecom_delivery', ...EVERY_TURN, kind: 'editable',
    label: '回复方式：自动回包',
    gateLabel: '每轮都有：结果由网关自动回包',
  }),
  line({
    key: 'wecom.task.channel_private', block: 'wecom_channel', ...EVERY_TURN, kind: 'editable',
    label: '通道与受众：私聊',
    gateLabel: '私聊消息',
  }),
  line({
    key: 'wecom.task.channel_group', block: 'wecom_channel', ...EVERY_TURN, kind: 'editable',
    label: '通道与受众：群聊',
    gateLabel: '群聊消息，回复发回群里',
  }),
];

/** Block labels of the gateway lines (the core-side blocks use BLOCK_META). */
export const WECOM_GATEWAY_BLOCK_META: Readonly<Record<string, { label: string; hint?: string }>> = {
  wecom_delivery: { label: '<botmux_task> 回复发送方式', hint: '企业微信网关每轮写进任务块；固定按中文渲染' },
  wecom_channel: { label: '<botmux_task> 通道与受众', hint: '每轮一条，按私聊 / 群聊二选一；固定按中文渲染' },
};

/** Stage blurbs on the WeCom tab (the Feishu ones describe Feishu delivery). */
const WECOM_STAGE_BLURBS: Partial<Record<PromptStage, string>> = {
  new: '企业微信会话的首轮：网关写进 <botmux_task> 的说明，以及专用 core 注入的系统提示 / 首轮片段。',
  followup: '企业微信会话里每条后续消息：网关每轮附带的说明，以及 core 注入的续轮提醒、白板等。',
};

/** Every fragment of the WeCom tab: gateway lines first, then the core-side ones. */
export function wecomCustomizationFragments(): PromptFragmentSpec[] {
  return [...WECOM_GATEWAY_PROMPT_FRAGMENTS, ...nativeGatewayCatalogFragments()];
}

export function isWecomGatewayLineKey(key: string): key is WecomGatewayLineKey {
  return (WECOM_GATEWAY_LINE_KEYS as readonly string[]).includes(key);
}

/** Factory text of a WeCom-tab fragment in `locale` (gateway lines: always their Chinese text). */
export function wecomFragmentFactory(key: string, locale: Locale): string {
  return isWecomGatewayLineKey(key) ? WECOM_GATEWAY_LINE_FACTORY[key] : shippedText(key, locale);
}

/** Block metadata the WeCom tab needs: the gateway's own blocks, then the catalog's. */
export function wecomCustomizationBlocks(): Record<string, { label: string; hint?: string }> {
  return { ...WECOM_GATEWAY_BLOCK_META, ...BLOCK_META };
}

/** Stages that have at least one WeCom fragment, in display order, with WeCom blurbs. */
export function wecomCustomizationStages(): Array<{ id: PromptStage; label: string; blurb: string }> {
  const used = new Set(wecomCustomizationFragments().flatMap((f) => [f.stage, ...(f.stages ?? [])]));
  return PROMPT_STAGES.filter((s) => used.has(s.id)).map((s) => ({ ...s, blurb: WECOM_STAGE_BLURBS[s.id] ?? s.blurb }));
}
