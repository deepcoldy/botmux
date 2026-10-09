import cn2026 from './cn-2026.json' with { type: 'json' };

/** A calendar's identity is its catalog key. Region and provenance describe it, not how it runs. */
export interface WorkCalendarEntity {
  calendar: unknown; // Validated by the same date-rule schema as user-defined profiles.
  displayNames?: Partial<Record<'zh' | 'en', string>>;
  region?: string;
  scope?: string;
  dataVersion?: string;
  source?: Record<string, string>;
}

/** Add an entity and its data here; scheduler admission and date evaluation stay unchanged. */
export const BUILTIN_WORK_CALENDARS: Readonly<Record<string, WorkCalendarEntity>> = {
  cn: cn2026,
};
