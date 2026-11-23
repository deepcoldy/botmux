import { hasAskForm } from '../../core/ask-form.js';
import { buildAskFormElements } from './ask-form-elements.js';
import type { ReplyCardAsk } from '../../services/turn-reply-card.js';
import { stripCardMarkdownImages } from './md-card.js';
import { t, type Locale } from '../../i18n/index.js';
import { permissionAskSettleStatus } from './ask-permission-status.js';
import {
  ASK_CARD_ELEMENT_LIMIT, askFooter, askReplyHint, buildAskChoiceBody, countCardElements, deadlineLine, escapeQuestion,
  type AskDensity, type AskElementRole,
} from './ask-card-look.js';

const safe = (text: string) => stripCardMarkdownImages(text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]'))
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An embedded prompt arrives by PATCH and never notifies: no mention survives, and no tag markup. */
const embeddedPrompt = (text: string) => escapeQuestion(text.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '[mention]'))
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Element IDs by role: the shared-context projection keeps questions, lists option labels and drops controls. */
function roleStamper(): (role: AskElementRole, element: Record<string, any>) => Record<string, any> {
  let next = 0;
  const prefix = { question: 'botmux_turn_question', options: 'botmux_turn_options', control: 'botmux_turn_control_ask' };
  return (role, element) => ({ ...element, element_id: `${prefix[role]}_${next++}` });
}

/** The same look and the same broker actions as the standalone Ask card, inside the reply card.
 * Option descriptions render in full: replyCardAskTarget only embeds asks whose whole questions
 * JSON fits in 3000 bytes and has at most 16 options, so they cannot crowd out the reply card.
 * `maxElements` is what the rest of the reply card leaves of Feishu's element limit. */
export function buildTurnReplyAskElements(entry: ReplyCardAsk, locale: Locale = 'zh',
  maxElements = ASK_CARD_ELEMENT_LIMIT): Array<Record<string, any>> {
  const { ask } = entry;
  if (hasAskForm(ask.questions)) return buildAskFormElements(ask, locale, entry.result);
  const densities: AskDensity[] = ['rows', 'compact'];
  let elements: Array<Record<string, any>> = [];
  for (const density of densities) {
    const stamp = roleStamper();
    const body = buildAskChoiceBody(ask, { locale, density, prompt: embeddedPrompt, descriptionCap: Infinity,
      confirmEmptyArmed: entry.confirmEmptyArmed, stamp });
    elements = [...body.elements, stamp('control', askFooter(deadlineLine(ask, locale), [askReplyHint(ask, locale) ?? '']))];
    if (countCardElements(elements) <= maxElements) break;
  }
  return elements;
}

export function turnReplyAskSummary(entry: ReplyCardAsk, locale: Locale = 'zh'): string {
  const { ask, result } = entry;
  const lines = ask.questions.map((q, i) => {
    const labels = result?.kind === 'answered'
      ? result.customAnswers?.[i] ?? result.inputs?.[i] ?? result.answers[i]?.map(key => q.options.find(o => o.key === key)?.label ?? key).join(', ') : '';
    return `🙋 ${safe(q.prompt)}${labels ? `\n✓ ${safe(labels)}` : ''}`;
  });
  const permission = result ? permissionAskSettleStatus(ask, result, locale) : undefined;
  if (result?.kind === 'answered') {
    if (result.comment) lines.push(`💬 ${safe(result.comment)}`);
    else if (!result.inputs?.some(Boolean) && !result.customAnswers?.some(Boolean) && result.answers.every(keys => keys.length === 0)) lines.push(locale === 'en' ? '✓ No options selected' : '✓ 未选择任何选项');
  } else if (permission) {
    lines.push(`${permission.headline}\n${permission.detail}`);
  } else {
    lines.push(result?.kind === 'timedOut' ? t('card.ask.timed_out', undefined, locale)
      : result?.kind === 'invalidated' ? t('card.ask.invalidated', undefined, locale)
        : locale === 'en' ? 'Waiting for your response' : '等待你回答');
  }
  return lines.join('\n');
}
