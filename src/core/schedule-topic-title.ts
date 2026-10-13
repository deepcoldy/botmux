const DATE_TOKEN = /\{\{date(?::([+-]\d+)d)?\}\}/g;
const DATE_TOKEN_PROBE = /\{\{date(?::[+-]\d+d)?\}\}/;
const OWNER_TOKEN = '{{owner}}';
const OWNER_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const MAX_DATE_OFFSET_DAYS = 366;
const MAX_RENDERED_TITLE_LENGTH = 200;

export function hasScheduleTopicTitleRuntimeTemplate(template: string): boolean {
  return template.includes(OWNER_TOKEN) || DATE_TOKEN_PROBE.test(template);
}

function formatLocalDate(value: Date, offsetDays: number): string {
  const shifted = new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + offsetDays,
    12,
  );
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Render the public schedule topic-title placeholders at fire time.
 *
 * - `{{date}}` uses the daemon's local calendar date.
 * - `{{date:+Nd}}` / `{{date:-Nd}}` shifts that calendar date by N days.
 * - `{{owner}}` becomes a native Lark text-message mention for the task owner.
 *
 * Literal titles remain byte-for-byte unchanged. Unknown placeholders remain
 * literal too, so older tasks that happened to use braces do not break.
 */
export function renderScheduleTopicTitle(
  template: string,
  options: { firedAt?: Date; ownerOpenId?: string } = {},
): string {
  const firedAt = options.firedAt ?? new Date();
  let rendered = template.replace(DATE_TOKEN, (_token, rawOffset: string | undefined) => {
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > MAX_DATE_OFFSET_DAYS) {
      throw new Error('topic_title_date_offset_invalid');
    }
    return formatLocalDate(firedAt, offset);
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
