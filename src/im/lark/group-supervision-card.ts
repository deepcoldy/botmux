import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { supervisionDecisionRef, type GroupSessionSupervision } from '../../core/group-session-supervision.js';
import { supervisionCriteria } from '../../core/group-session-supervision-assessment.js';
import { t, type Locale } from '../../i18n/index.js';
import type { Session } from '../../types.js';
import type { CardActionData } from './card-handler.js';

export const GROUP_SUPERVISION_CARD_ACTION = 'group_supervision_control';

type CardCommand = 'status' | 'on' | 'resume' | 'off' | `decide ${string} ${number}`;

interface CardBinding {
  appId: string;
  chatId: string;
  sessionId: string;
  requester: string;
}

interface CardControl extends CardBinding {
  secret: string;
  revision: string;
  commands: readonly ('on' | 'resume' | 'off' | 'status')[];
  canDecide?: boolean;
}

const inactiveStartTokens = new WeakMap<Session, string>();

export function groupSupervisionCardRevision(
  session: Session, lastInputId: string | undefined, currentTurnId: string | undefined,
): string {
  const task = session.groupSessionSupervision;
  let generation = task?.id ?? inactiveStartTokens.get(session);
  if (!generation) {
    generation = randomUUID();
    inactiveStartTokens.set(session, generation);
  }
  return createHash('sha256').update(JSON.stringify([
    generation, task?.turnId, task?.reviewEpoch, task?.state, task?.reason, task?.decision, lastInputId, currentTurnId,
  ])).digest('base64url');
}

/** A card opened while supervision was off must not start it again after an on/off cycle. */
export function invalidateGroupSupervisionStartCards(session: Session): void {
  inactiveStartTokens.delete(session);
}

function signControl(binding: CardBinding, command: string, revision: string, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([
    'botmux.group-supervision-card.v1', binding.appId, binding.chatId, binding.sessionId, binding.requester, command, revision,
  ])).digest('base64url');
}

export function readGroupSupervisionCardAction(data: CardActionData, appId: string, secret: string) {
  const value = data.action?.value;
  const requester = data.operator?.open_id;
  const chatId = data.context?.open_chat_id;
  const sessionId = value?.session_id;
  const { command, revision, signature } = value ?? {};
  if (value?.action !== GROUP_SUPERVISION_CARD_ACTION || !requester || !chatId || !secret
    || !(data.context?.open_message_id ?? data.open_message_id)
    || typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)
    || typeof command !== 'string' || !/^(?:status|on|resume|off|decide [\w-]{1,96} [1-4])$/.test(command)
    || typeof revision !== 'string' || !/^[\w-]{43}$/.test(revision)
    || typeof signature !== 'string' || !/^[\w-]{43}$/.test(signature)) return undefined;
  const expected = signControl({ appId, chatId, sessionId, requester }, command, revision, secret);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
  return { sessionId, requester, chatId, command, revision };
}

function controlButton(control: CardControl, command: CardCommand, label: string, type: string, locale: Locale) {
  const button = {
    tag: 'button', text: { tag: 'plain_text', content: label }, type,
    behaviors: [{ type: 'callback', value: {
      action: GROUP_SUPERVISION_CARD_ACTION, session_id: control.sessionId, command, revision: control.revision,
      signature: signControl(control, command, control.revision, control.secret),
    } }],
  };
  if (command !== 'off') return button;
  return { ...button, confirm: {
    title: { tag: 'plain_text', content: t('card.supervise.off', undefined, locale) },
    text: { tag: 'plain_text', content: t('card.supervise.confirm_off', undefined, locale) },
  } };
}

function textBlock(content: string) {
  return { tag: 'div', text: { tag: 'plain_text', content: content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ') } };
}

// Up to 20 criteria can carry separate evidence quotes. Leave room for the
// full criteria and controls in Feishu's 30 KB card request body.
function evidencePreview(quote: string): string {
  const maxChars = 240;
  return quote.length > maxChars ? `${quote.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : quote;
}

export function buildGroupSupervisionCard(input: {
  locale: Locale;
  status: string;
  feedback?: string;
  task?: GroupSessionSupervision;
  control?: CardControl;
}) {
  const { feedback, locale, status, task, control } = input;
  const tr = (key: string, params?: Record<string, string | number>) => t(key, params, locale);
  const elements: Record<string, unknown>[] = [textBlock(tr(status, { round: task?.round ?? 0 }))];
  if (feedback && feedback !== status) elements.push(textBlock(tr(feedback)));
  const criteria = task ? supervisionCriteria(task.criteria) : [];
  const assessment = task?.assessments?.at(-1)?.result;
  const evidence = task?.state === 'accepted' && assessment?.verdict === 'accepted' ? assessment.evidence : undefined;
  if (criteria.length) {
    elements.push({ tag: 'hr' }, textBlock(tr('cmd.supervise.criteria')));
    const missing = task?.reason === 'round_limit' && assessment?.verdict === 'rework' ? assessment.missing : [];
    for (const [i, criterion] of criteria.entries()) {
      const marker = evidence?.[i] ? '✓ ' : missing.includes(i + 1) ? '○ ' : '';
      const quote = evidence?.[i];
      elements.push(textBlock(`${marker}${i + 1}. ${criterion}${quote ? `\n${evidencePreview(quote)}` : ''}`));
    }
  }
  if (task?.state === 'waiting' && task.park) elements.push(textBlock(`${task.park.reason}\n${task.park.evidence}`));
  if (task?.state === 'waiting' && task.ownerDecision) {
    elements.push(textBlock(tr('card.supervise.selected', { choice: task.ownerDecision.choice })));
  }
  if ((task?.reason === 'needs_user' || task?.reason === 'round_limit') && assessment && 'reason' in assessment && assessment.reason) {
    elements.push(textBlock(assessment.reason));
  }
  if (task?.state === 'needs_user' && task.reason === 'needs_user' && task.decision) {
    const { question, options, recommended } = task.decision;
    const ref = supervisionDecisionRef(task);
    elements.push({ tag: 'hr' }, textBlock(question));
    for (const [i, option] of options.entries()) {
      const index = i + 1;
      elements.push(textBlock(`${index}. ${option}`));
      if (control?.canDecide) elements.push(controlButton(control, `decide ${ref} ${index}`,
        tr(index === recommended ? 'card.supervise.choose_recommended' : 'card.supervise.choose', { option: index }),
        index === recommended ? 'primary' : 'default', locale));
    }
    if (control?.canDecide) elements.push(textBlock(tr('cmd.supervise.decide_usage', { ref })));
  }
  if (control?.commands.length) {
    elements.push({ tag: 'hr' }, {
      tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small',
      columns: control.commands.map(command => ({
        tag: 'column', width: 'auto', elements: [controlButton(control, command, tr(`card.supervise.${command}`),
          command === 'off' ? 'danger' : command === 'status' ? 'default' : 'primary', locale)],
      })),
    });
  }
  const template = task?.state === 'accepted' ? 'green'
    : task?.state === 'needs_user' || status === 'cmd.supervise.session_changed' ? 'orange' : task ? 'blue' : 'grey';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { template, title: { tag: 'plain_text', content: tr('card.supervise.title') } },
    body: { direction: 'vertical', vertical_spacing: '8px', elements },
  };
}
