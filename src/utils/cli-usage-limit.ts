export type CliUsageLimitKind = 'usage' | 'rate';

export interface CliUsageLimitState {
  limited: true;
  kind: CliUsageLimitKind;
  retryAtMs: number;
  retryLabel: string;
  retryReady: boolean;
}

export interface CliUsageLimitNotDetected {
  limited: false;
}

export type CliUsageLimitDetection = CliUsageLimitState | CliUsageLimitNotDetected;

const USAGE_LIMIT_PATTERNS = [
  /\bhit (?:your )?(?:usage )?limits?\b/i,
  /\busage limits?.*(?:reached|exceeded|try again)\b/i,
  /\b(?:quota|limit) (?:reached|exceeded)\b/i,
  /\b(?:reached|exceeded) (?:your )?(?:usage )?(?:limit|quota)\b/i,
];

const RATE_LIMIT_PATTERNS = [
  /\brate limits?.*(?:reached|exceeded)\b/i,
  /\brate limited\b/i,
];

const RETRY_TIME_PATTERNS = [
  /\btry\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
  /\bresets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i,
];

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function parseMeridiemTime(text: string, now: Date): { retryAtMs: number; retryLabel: string } | null {
  for (const pattern of RETRY_TIME_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const rawHour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3].toLowerCase().replace(/\./g, '');
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

    let hour = rawHour % 12;
    if (meridiem === 'pm') hour += 12;

    const retryAt = new Date(now);
    retryAt.setHours(hour, minute, 0, 0);
    if (retryAt.getTime() < now.getTime() && hour < 12) {
      retryAt.setDate(retryAt.getDate() + 1);
    }

    return {
      retryAtMs: retryAt.getTime(),
      retryLabel: match[0].replace(/^(?:try\s+again\s+at|resets?(?:\s+at)?)\s+/i, '').trim(),
    };
  }
  return null;
}

export function detectCliUsageLimit(text: string, now = new Date()): CliUsageLimitDetection {
  const time = parseMeridiemTime(text, now);
  if (!time) return { limited: false };

  const kind: CliUsageLimitKind | null = hasPattern(text, RATE_LIMIT_PATTERNS)
    ? 'rate'
    : hasPattern(text, USAGE_LIMIT_PATTERNS)
      ? 'usage'
      : null;

  if (!kind) return { limited: false };

  return {
    limited: true,
    kind,
    retryAtMs: time.retryAtMs,
    retryLabel: time.retryLabel,
    retryReady: now.getTime() >= time.retryAtMs,
  };
}

export function usageLimitStateKey(state: CliUsageLimitState): string {
  return `${state.kind}:${state.retryAtMs}:${state.retryLabel}`;
}
