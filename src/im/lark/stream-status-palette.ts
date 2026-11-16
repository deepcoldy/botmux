/**
 * Shared Lark visual palette for streaming session statuses.
 *
 * Keep every surface that presents a streaming status on this mapping so a
 * compact status marker cannot drift from the full streaming card header.
 */
export const STREAM_STATUS_TEMPLATE_MAP = {
  starting: 'yellow',
  working: 'blue',
  idle: 'green',
  analyzing: 'purple',
  stalled: 'red',
  limited: 'red',
  retry_ready: 'green',
  interrupted: 'orange',
} as const;

export type StreamStatusTemplate = typeof STREAM_STATUS_TEMPLATE_MAP[keyof typeof STREAM_STATUS_TEMPLATE_MAP];

/** Header for 「主回合已结束 · 后台子任务运行中（N）」. Not a status of its own (the
 *  session is `working` or `idle` underneath), so it stays out of the map and its
 *  icon set; one colour keeps the label looking the same over either. */
export const BACKGROUND_WAIT_TEMPLATE = 'wathet';

/** Header for 「⏳ 上游暂不可用 · 预计 HH:MM 自动续跑」: the session is `idle`
 *  underneath, but green would read as "done, waiting for you". */
export const RECOVERY_WAIT_TEMPLATE = 'orange';

export const STREAM_STATUS_TEMPLATE_ICON: Record<StreamStatusTemplate, string> = {
  yellow: '🟡',
  blue: '🔵',
  green: '🟢',
  purple: '🟣',
  red: '🔴',
  orange: '🟠',
};
