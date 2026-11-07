/** Per-bot card reminders for turns that have actually started executing. */
export interface LongTaskReminderConfig {
  /** Explicit opt-in; existing bots remain quiet until enabled. */
  enabled: boolean;
  /** Execution minutes before the first reminder, inclusive; 1–10080. */
  thresholdMinutes: number;
  /** Minutes between successful reminders; 1–10080. */
  intervalMinutes: number;
}

/** Initial values shown by the console before a bot saves its preferences. */
export const DEFAULT_LONG_TASK_REMINDER: Readonly<LongTaskReminderConfig> = {
  enabled: false,
  thresholdMinutes: 10,
  intervalMinutes: 10,
};

/** Validate persisted settings and API input without coercing invalid values. */
export function normalizeLongTaskReminderConfig(raw: unknown): LongTaskReminderConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  /** Untrusted fields must pass the same checks in registry and write paths. */
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') {
    return undefined;
  }
  // Both user-facing minute windows share the same positive-integer range.
  for (const field of ['thresholdMinutes', 'intervalMinutes'] as const) {
    if (typeof value[field] !== 'number' || !Number.isInteger(value[field])
      || value[field] < 1 || value[field] > 10_080) {
      return undefined;
    }
  }
  return {
    enabled: value.enabled,
    thresholdMinutes: value.thresholdMinutes as number,
    intervalMinutes: value.intervalMinutes as number,
  };
}
