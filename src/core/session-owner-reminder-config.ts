import {
  DEFAULT_OWNER_REMINDER_QUIET_HOURS,
  type SessionOwnerReminderQuietHours,
} from './session-owner-reminder-quiet-hours.js';

/** Browser-safe owner-reminder config contracts and defaults (no Node runtime imports). */
export const SESSION_OWNER_REMINDER_STATES = [
  'idle',
  'dormant',
  'pending_repo',
  'tui_prompt',
  'agent_attention',
  'limited',
] as const;

export type SessionOwnerReminderState = typeof SESSION_OWNER_REMINDER_STATES[number];

export interface SessionOwnerReminderConfig {
  enabled: boolean;
  intervalMinutes: number;
  text: string;
  states: SessionOwnerReminderState[];
  quietHours?: SessionOwnerReminderQuietHours;
}

export const DEFAULT_SESSION_OWNER_REMINDER: SessionOwnerReminderConfig = {
  enabled: false,
  intervalMinutes: 30,
  text: '该会话已等待处理，请继续跟进。',
  states: [...SESSION_OWNER_REMINDER_STATES],
  quietHours: { ...DEFAULT_OWNER_REMINDER_QUIET_HOURS },
};
