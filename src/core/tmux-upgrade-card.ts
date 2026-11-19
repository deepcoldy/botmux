/**
 * The tmux-upgrade owner card: one interactive DM that is patched in place as
 * the upgrade moves along (reminder → upgrading → result → server switch).
 *
 * Pure: (model, nonce, locale) → card JSON. Every user-facing string goes
 * through i18n; the version numbers and the "why" sentence come from
 * TMUX_RECOMMENDED_MIN via the model, never from literals here.
 */
import { t, type Locale } from '../i18n/index.js';
import type { TmuxManualReason } from '../setup/tmux-upgrade-plan.js';

/** Button `value.action`s. All share the `tmux_` core namespace. */
export const TMUX_UPGRADE_ACTION_RUN = 'tmux_upgrade_run';
export const TMUX_UPGRADE_ACTION_SWITCH_NOW = 'tmux_upgrade_switch_now';
export const TMUX_UPGRADE_ACTION_SWITCH_IDLE = 'tmux_upgrade_switch_idle';
export const TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL = 'tmux_upgrade_switch_idle_cancel';
/** Disabled / informational button fallback for clients that still call back. */
export const TMUX_UPGRADE_ACTION_NOOP = 'tmux_upgrade_noop';

export const TMUX_UPGRADE_ACTIONS: readonly string[] = [
  TMUX_UPGRADE_ACTION_RUN,
  TMUX_UPGRADE_ACTION_SWITCH_NOW,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL,
  TMUX_UPGRADE_ACTION_NOOP,
];

export type TmuxUpgradePhase =
  | 'needs_upgrade'
  | 'upgrading'
  | 'upgrade_failed'
  | 'pending_switch'
  | 'awaiting_idle'
  | 'switching'
  | 'switch_failed'
  | 'done';

/** Phases in which the card still asks the owner for something. */
export const OPEN_TMUX_UPGRADE_PHASES: ReadonlySet<TmuxUpgradePhase> = new Set([
  'needs_upgrade', 'upgrade_failed', 'pending_switch', 'awaiting_idle', 'switch_failed',
]);

export interface TmuxUpgradePlanView {
  auto: boolean;
  /** Command line the button runs (auto plans). */
  display?: string;
  tmuxPath?: string;
  reason?: TmuxManualReason;
  manualCommand?: string;
  hint?: string;
  /** Release the package source offers (best ≥ min for auto, best overall for no_candidate). */
  candidate?: string;
}

/** Everything the card renders. Persisted so a restarted daemon can re-render. */
export interface TmuxUpgradeCardModel {
  phase: TmuxUpgradePhase;
  /** Recommended minimum (TMUX_RECOMMENDED_MIN.version at render time). */
  min: string;
  /** TMUX_RECOMMENDED_MIN.why for the card's locale. */
  why: string;
  /** Installed tmux (what new servers start from); null = unknown. */
  client: string | null;
  /** Release of the running botmux tmux server; null = none running / unknown. */
  server: string | null;
  /** Sessions currently on the botmux tmux server. */
  serverSessions?: number;
  /** The server is the shared default one (user's own sessions live there too). */
  sharedServer?: boolean;
  plan?: TmuxUpgradePlanView;
  /** Last output lines of the running / finished installer. */
  log?: string[];
  error?: string;
  startedAt?: number;
  /** Rendering clock (elapsed time); omitted → no elapsed line. */
  now?: number;
  /** awaiting_idle: idle-ready sessions seen on the last check. */
  idleReady?: number;
  idleCheckedAt?: number;
  /** switch outcome */
  suspended?: number;
  interrupted?: number;
  /** A previous run was cut off by a daemon restart. */
  interruptedByRestart?: boolean;
}

/** Minutes a session must sit idle before the automatic switch takes it. */
export const TMUX_IDLE_SWITCH_MINUTES = 10;

const HEADER_TEMPLATE: Record<TmuxUpgradePhase, string> = {
  needs_upgrade: 'orange',
  upgrading: 'blue',
  upgrade_failed: 'red',
  pending_switch: 'turquoise',
  awaiting_idle: 'wathet',
  switching: 'blue',
  switch_failed: 'red',
  done: 'green',
};

const TITLE_KEY: Record<TmuxUpgradePhase, string> = {
  needs_upgrade: 'tmux_upgrade.title.needs_upgrade',
  upgrading: 'tmux_upgrade.title.upgrading',
  upgrade_failed: 'tmux_upgrade.title.upgrade_failed',
  pending_switch: 'tmux_upgrade.title.pending_switch',
  awaiting_idle: 'tmux_upgrade.title.awaiting_idle',
  switching: 'tmux_upgrade.title.switching',
  switch_failed: 'tmux_upgrade.title.switch_failed',
  done: 'tmux_upgrade.title.done',
};

/** Inline-code safe: Lark markdown has no escape inside backticks. */
function code(value: string): string {
  return `\`${value.replace(/`/g, "'").replace(/\n/g, ' ')}\``;
}

/** Fenced log tail. Control characters and fences are neutralised. */
function logBlock(lines: readonly string[] | undefined): string | undefined {
  const tail = (lines ?? []).filter(line => line.trim()).slice(-12);
  if (!tail.length) return undefined;
  const body = tail
    .map(line => line.replace(/```/g, "'''").slice(0, 200))
    .join('\n');
  return `\`\`\`\n${body}\n\`\`\``;
}

function elapsed(model: TmuxUpgradeCardModel, locale: Locale): string | undefined {
  if (model.startedAt === undefined || model.now === undefined) return undefined;
  const seconds = Math.max(0, Math.round((model.now - model.startedAt) / 1000));
  return t('tmux_upgrade.elapsed', { seconds: String(seconds) }, locale);
}

function button(
  text: string,
  action: string,
  nonce: string,
  type: 'primary' | 'default' | 'danger',
  confirm?: { title: string; text: string },
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    value: { action, nonce },
    ...(confirm ? {
      confirm: {
        title: { tag: 'plain_text', content: confirm.title },
        text: { tag: 'plain_text', content: confirm.text },
      },
    } : {}),
  };
}

function manualLines(plan: TmuxUpgradePlanView | undefined, model: TmuxUpgradeCardModel, locale: Locale): string[] {
  if (!plan || plan.auto) return [];
  const lines: string[] = [];
  const path = plan.tmuxPath ? code(plan.tmuxPath) : '';
  switch (plan.reason) {
    case 'unmanaged_binary':
      lines.push(t('tmux_upgrade.manual.unmanaged', { path: path || 'tmux', min: model.min }, locale));
      break;
    case 'needs_sudo':
      lines.push(t('tmux_upgrade.manual.needs_sudo', undefined, locale));
      break;
    case 'no_candidate':
      lines.push(t('tmux_upgrade.manual.no_candidate', {
        candidate: plan.candidate ?? model.client ?? '?', min: model.min,
      }, locale));
      break;
    case 'tmux_missing':
      lines.push(t('tmux_upgrade.manual.missing', undefined, locale));
      break;
    default:
      lines.push(t('tmux_upgrade.manual.unsupported', undefined, locale));
  }
  if (plan.manualCommand) lines.push(t('tmux_upgrade.manual.command', { command: code(plan.manualCommand) }, locale));
  if (plan.hint) lines.push(plan.hint);
  lines.push(t('tmux_upgrade.manual.auto_detect', undefined, locale));
  return lines;
}

/** Build the card JSON for `model`. `nonce` binds every button to this card. */
export function buildTmuxUpgradeCard(model: TmuxUpgradeCardModel, nonce: string, locale: Locale): string {
  const elements: Record<string, unknown>[] = [];
  const md = (content: string) => elements.push({ tag: 'markdown', content });
  const versions = t('tmux_upgrade.versions', {
    client: model.client ?? '?',
    min: model.min,
  }, locale);

  switch (model.phase) {
    case 'needs_upgrade': {
      md([versions, t('tmux_upgrade.why', { why: model.why }, locale)].join('\n'));
      if (model.interruptedByRestart) md(t('tmux_upgrade.interrupted_by_restart', undefined, locale));
      if (model.plan?.auto) {
        md([
          t('tmux_upgrade.plan.command', { command: code(model.plan.display ?? '') }, locale),
          ...(model.plan.tmuxPath ? [t('tmux_upgrade.plan.path', { path: code(model.plan.tmuxPath) }, locale)] : []),
          ...(model.plan.candidate ? [t('tmux_upgrade.plan.candidate', { candidate: model.plan.candidate }, locale)] : []),
          t('tmux_upgrade.plan.safe', undefined, locale),
        ].join('\n'));
        elements.push({
          tag: 'action',
          actions: [button(t('tmux_upgrade.btn.run', undefined, locale), TMUX_UPGRADE_ACTION_RUN, nonce, 'primary')],
        });
      } else {
        md(manualLines(model.plan, model, locale).join('\n'));
      }
      break;
    }
    case 'upgrading': {
      md([
        t('tmux_upgrade.upgrading', { min: model.min }, locale),
        ...(model.plan?.display ? [t('tmux_upgrade.plan.running', { command: code(model.plan.display) }, locale)] : []),
        ...(elapsed(model, locale) ? [elapsed(model, locale)!] : []),
      ].join('\n'));
      const log = logBlock(model.log);
      if (log) md(log);
      md(t('tmux_upgrade.upgrading_note', undefined, locale));
      break;
    }
    case 'upgrade_failed': {
      md([
        versions,
        t('tmux_upgrade.failed', { error: model.error ?? '?' }, locale),
      ].join('\n'));
      const log = logBlock(model.log);
      if (log) md(log);
      if (model.plan?.auto) {
        md(t('tmux_upgrade.failed_retry', undefined, locale));
        elements.push({
          tag: 'action',
          actions: [button(t('tmux_upgrade.btn.retry', undefined, locale), TMUX_UPGRADE_ACTION_RUN, nonce, 'primary')],
        });
      } else {
        md(manualLines(model.plan, model, locale).join('\n'));
      }
      break;
    }
    case 'pending_switch':
    case 'switch_failed':
    case 'awaiting_idle': {
      const lines = [
        t('tmux_upgrade.installed', { client: model.client ?? '?' }, locale),
        t('tmux_upgrade.server_old', {
          server: model.server ?? '?',
          sessions: String(model.serverSessions ?? 0),
        }, locale),
      ];
      if (model.phase === 'switch_failed') lines.push(t('tmux_upgrade.switch_failed', { error: model.error ?? '?' }, locale));
      if (model.interruptedByRestart) lines.push(t('tmux_upgrade.interrupted_by_restart', undefined, locale));
      md(lines.join('\n'));
      if (model.sharedServer) {
        md(t('tmux_upgrade.shared_server', undefined, locale));
        break;
      }
      if (model.phase === 'awaiting_idle') {
        md([
          t('tmux_upgrade.awaiting_idle', { minutes: String(TMUX_IDLE_SWITCH_MINUTES) }, locale),
          ...(model.idleCheckedAt !== undefined
            ? [t('tmux_upgrade.awaiting_idle_progress', {
                ready: String(model.idleReady ?? 0),
                total: String(model.serverSessions ?? 0),
              }, locale)]
            : []),
        ].join('\n'));
        elements.push({
          tag: 'action',
          actions: [
            button(
              t('tmux_upgrade.btn.switch_now', undefined, locale),
              TMUX_UPGRADE_ACTION_SWITCH_NOW,
              nonce,
              'danger',
              {
                title: t('tmux_upgrade.confirm.title', undefined, locale),
                text: t('tmux_upgrade.confirm.text', { sessions: String(model.serverSessions ?? 0) }, locale),
              },
            ),
            button(t('tmux_upgrade.btn.cancel_idle', undefined, locale), TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL, nonce, 'default'),
          ],
        });
        break;
      }
      md([
        t('tmux_upgrade.switch_explain', undefined, locale),
        t('tmux_upgrade.option.now', undefined, locale),
        t('tmux_upgrade.option.idle', { minutes: String(TMUX_IDLE_SWITCH_MINUTES) }, locale),
        t('tmux_upgrade.option.none', undefined, locale),
      ].join('\n'));
      elements.push({
        tag: 'action',
        actions: [
          button(t('tmux_upgrade.btn.switch_idle', undefined, locale), TMUX_UPGRADE_ACTION_SWITCH_IDLE, nonce, 'primary'),
          button(
            t('tmux_upgrade.btn.switch_now', undefined, locale),
            TMUX_UPGRADE_ACTION_SWITCH_NOW,
            nonce,
            'danger',
            {
              title: t('tmux_upgrade.confirm.title', undefined, locale),
              text: t('tmux_upgrade.confirm.text', { sessions: String(model.serverSessions ?? 0) }, locale),
            },
          ),
        ],
      });
      break;
    }
    case 'switching': {
      md([
        t('tmux_upgrade.switching', { client: model.client ?? '?' }, locale),
        ...(elapsed(model, locale) ? [elapsed(model, locale)!] : []),
      ].join('\n'));
      const log = logBlock(model.log);
      if (log) md(log);
      break;
    }
    case 'done': {
      const lines = [t('tmux_upgrade.done', { client: model.client ?? '?' }, locale)];
      if (model.suspended !== undefined || model.interrupted !== undefined) {
        lines.push(t('tmux_upgrade.done_counts', {
          suspended: String(model.suspended ?? 0),
          interrupted: String(model.interrupted ?? 0),
        }, locale));
      }
      lines.push(t('tmux_upgrade.done_note', undefined, locale));
      md(lines.join('\n'));
      break;
    }
  }

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: t('tmux_upgrade.footer', undefined, locale) }],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: HEADER_TEMPLATE[model.phase],
      title: { tag: 'plain_text', content: t(TITLE_KEY[model.phase], { min: model.min }, locale) },
    },
    elements,
  });
}
