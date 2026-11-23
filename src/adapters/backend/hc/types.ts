/**
 * herdr-core API shapes as they appear on the wire (snake_case, as the core
 * serialises them; crates/herdr-core/src/api/types.rs, terminals.rs).
 */

export interface HcHello {
  generation: number;
  version: string;
  core: { id: string; name: string };
  framed: boolean;
  methods: string[];
  features: string[];
}

export interface HcInitialSize {
  cols: number;
  rows: number;
}

export interface HcDisplay {
  /** `#rrggbb` */
  fg?: string;
  bg?: string;
  cursor?: string;
  /** Cell size in pixels: [width, height]. */
  cell?: [number, number];
}

/** Why a program ended: `exited`, `killed`, `server_stop`, `host_shutdown`, `signaled`, `holder_lost`, `stopped_by_restart`, `spawn_failed`. */
export type HcFinishReason = string;

/** Carried by a core CLOSE frame and by `finished` / `lost` events. */
export interface HcEnd {
  reason: HcFinishReason;
  exit_code: number | null;
  signal: number | null;
  finished_ms: number | null;
}

export interface HcTerminalRecord {
  /** `t7`, never reused by the same core state. */
  address: string;
  name: string | null;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  keep: boolean;
  state: 'live' | 'finished';
  pid: number | null;
  exit_code: number | null;
  signal: number | null;
  reason: HcFinishReason | null;
  created_ms: number;
  finished_ms: number | null;
  /** `exact`, or `inexact` after a core crash. */
  screen: string;
  cols: number;
  rows: number;
  title: string;
  parent: string | null;
  [field: string]: unknown;
}

/** A terminal record from hc, or null for anything without an address and a known state. */
export function asHcTerminalRecord(value: unknown): HcTerminalRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as HcTerminalRecord;
  if (typeof record.address !== 'string' || (record.state !== 'live' && record.state !== 'finished')) return null;
  return record;
}

/**
 * `terminal.run`. botmux must not pass `keep` (a lost program comes back as a
 * bare shell), `parent` or `caller`; those are deliberately absent.
 */
export interface HcRunParams {
  argv?: string[];
  line?: string;
  size?: HcInitialSize;
  display?: HcDisplay;
  name?: string;
  /** Joined onto the core's cwd when relative. */
  cwd?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  no_parent?: boolean;
  no_notify?: boolean;
  rm?: boolean;
  wait?: boolean;
  timeout?: number;
}

export interface HcAttachParams {
  /** `t7` or a terminal name. */
  terminal: string;
  cols: number;
  rows: number;
  /** Watch only: input and resizes from this viewer are ignored. */
  observe?: boolean;
  /** Observer only: a RESIZE frame precedes each replacement paint. */
  resizeNotifications?: boolean;
  /** Scrollback lines to include in the first paint (main screen only). */
  history?: number;
  /** Take the size only once this viewer is next active. */
  resumed?: boolean;
  display?: HcDisplay;
}

export interface HcSubscribeParams {
  terminal?: string;
  children_of?: string;
  labels?: Record<string, string>;
}

export interface HcSnapshot {
  seq: number;
  terminals: HcTerminalRecord[];
}

/**
 * One `event` notification. `type` is created, restarted, lost, finished,
 * removed, keep, labels, status, turn, title, size, foreground or doc; when a
 * terminal newly matches the filter, `data.record` carries its whole record.
 */
export interface HcEvent {
  type: string;
  terminal?: string;
  /** null for `foreground` with no foreground process. */
  data: Record<string, unknown> | null;
  seq: number;
}

export function isHcEnd(value: unknown): value is HcEnd {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.reason === 'string'
    && (v.exit_code === null || typeof v.exit_code === 'number')
    && (v.signal === null || typeof v.signal === 'number');
}

/** Normalises CLOSE payloads and finished/lost event data; null when it carries no end. */
export function parseHcEnd(value: unknown): HcEnd | null {
  if (!isHcEnd(value)) return null;
  const v = value as unknown as Record<string, unknown>;
  return {
    reason: v.reason as string,
    exit_code: v.exit_code as number | null,
    signal: v.signal as number | null,
    finished_ms: typeof v.finished_ms === 'number' ? v.finished_ms : null,
  };
}
