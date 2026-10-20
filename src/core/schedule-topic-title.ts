import type { ScheduleExecutionPosition } from '../types.js';
import { scheduleTimeZone, zonedDateParts } from '../utils/timezone.js';

const DATE_TOKEN = /\{\{date(?::([+-]\d+)d)?\}\}/g;
const DATE_TOKEN_PROBE = /\{\{date(?::[+-]\d+d)?\}\}/;
const OWNER_TOKEN = '{{owner}}';
const OWNER_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const MAX_DATE_OFFSET_DAYS = 366;
// Authored templates stay capped at 200 code points. Runtime expansion can be
// longer (especially a native owner mention), so keep a separate delivery
// budget and validate it before a task is persisted as well as at fire time.
const MAX_RENDERED_TITLE_LENGTH = 300;

export function hasScheduleTopicTitleRuntimeTemplate(template: string): boolean {
  return template.includes(OWNER_TOKEN) || DATE_TOKEN_PROBE.test(template);
}

function formatScheduleDate(value: Date, offsetDays: number, timeZone: string): string {
  const base = zonedDateParts(timeZone, value.getTime());
  // Date.UTC is used only as a calendar normalizer. It avoids applying the
  // daemon host's timezone or crossing a DST gap/fall-back via setDate().
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + offsetDays));
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Render the public schedule topic-title placeholders at fire time.
 *
 * - `{{date}}` uses the configured schedule timezone's calendar date.
 * - `{{date:+Nd}}` / `{{date:-Nd}}` shifts that calendar date by N days.
 * - `{{owner}}` becomes a native Lark text-message mention for the task owner.
 *
 * Literal titles remain byte-for-byte unchanged. Unknown placeholders remain
 * literal too, so older tasks that happened to use braces do not break.
 */
export function renderScheduleTopicTitle(
  template: string,
  options: { firedAt?: Date; ownerOpenId?: string; timeZone?: string } = {},
): string {
  const firedAt = options.firedAt ?? new Date();
  const timeZone = options.timeZone ?? scheduleTimeZone();
  let rendered = template.replace(DATE_TOKEN, (_token, rawOffset: string | undefined) => {
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > MAX_DATE_OFFSET_DAYS) {
      throw new Error('topic_title_date_offset_invalid');
    }
    return formatScheduleDate(firedAt, offset, timeZone);
  });

  if (rendered.includes(OWNER_TOKEN)) {
    const ownerOpenId = options.ownerOpenId?.trim();
    if (!ownerOpenId || !OWNER_OPEN_ID.test(ownerOpenId)) {
      throw new Error('topic_title_owner_unavailable');
    }
    rendered = rendered.replaceAll(OWNER_TOKEN, `<at user_id="${ownerOpenId}"></at>`);
  }

  if (Array.from(rendered).length > MAX_RENDERED_TITLE_LENGTH) {
    throw new Error('topic_title_rendered_too_long');
  }
  return rendered;
}

/** Reject dynamic templates that cannot ever execute successfully in their
 * persisted delivery shape. Hidden titles on top-level/topic tasks remain
 * untouched for backwards compatibility because those positions do not render
 * or consume the title. */
export function assertScheduleTopicTitleTemplateValid(
  template: string,
  options: {
    executionPosition?: ScheduleExecutionPosition;
    rootMessageId?: string;
    silent?: boolean;
    ownerOpenId?: string;
    timeZone?: string;
  },
): void {
  if (!hasScheduleTopicTitleRuntimeTemplate(template)) return;
  const createsOwnTopic = options.executionPosition === 'new-topic'
    || (options.executionPosition === 'task' && !options.rootMessageId?.trim());
  if (!createsOwnTopic) return;
  if (options.silent === true) {
    throw new Error('topic_title_template_silent_unsupported');
  }
  // Placeholder output length is invariant across dates. Rendering one fixed
  // instant catches invalid offsets, unavailable owners and expansion beyond
  // the delivery budget before the task can be saved.
  renderScheduleTopicTitle(template, {
    firedAt: new Date(0),
    ownerOpenId: options.ownerOpenId,
    timeZone: options.timeZone,
  });
}
