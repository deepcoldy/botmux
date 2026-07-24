export interface BotmuxPm2App {
  name: string;
  online: boolean;
  /** Raw bots.json slot assigned by the generated PM2 ecosystem config. */
  botIndex?: string;
  /** Exact Feishu App identity assigned by the generated PM2 ecosystem config. */
  larkAppId?: string;
  /** App identity carried only by a gated managed-activation daemon. */
  activationAppId?: string;
  /** Durable activation receipt carried only by the exact gated PM2 process. */
  activationJobId?: string;
}

export type BotmuxPm2Inspection =
  | { ok: true; apps: BotmuxPm2App[] }
  | { ok: false; message: string };

export type ExactPm2StopResult =
  | { ok: true; state: 'stopped' | 'already-stopped'; processName: string }
  | { ok: false; reason: 'pm2_error'; message: string };

export function isExactPm2BotActivationReceipt(
  app: BotmuxPm2App,
  processName: string,
  index: number,
  appId: string,
  activationJobId?: string,
): boolean {
  return (
    app.name === processName
    && app.botIndex === String(index)
    && app.larkAppId === appId
    && (
      activationJobId === undefined
      || (
        app.activationAppId === appId
        && app.activationJobId === activationJobId
      )
    )
  );
}

export function managedActivationPm2Disposition(
  apps: BotmuxPm2App[],
  processName: string,
  index: number,
  appId: string,
  activationJobId: string,
): 'acknowledged' | 'replace' | 'identity_mismatch' {
  if (apps.some(app => (
    isExactPm2BotActivationReceipt(app, processName, index, appId, activationJobId)
    && app.online
  ))) {
    return 'acknowledged';
  }
  if (!apps.every(app => isExactPm2BotActivationReceipt(app, processName, index, appId))) {
    return 'identity_mismatch';
  }
  return 'replace';
}

/**
 * Parse the real `pm2 jlist` transport shape. PM2 may prefix stdout with log
 * lines, but a syntactically valid non-array JSON document is never process
 * absence.
 */
export function parsePm2JlistOutputStrict(output: string): any[] {
  let parsedWholeDocument = false;
  try {
    const parsed = JSON.parse(output);
    parsedWholeDocument = true;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // PM2 sometimes prefixes its JSON array with log lines; scan those below.
  }
  if (parsedWholeDocument) {
    throw new Error('pm2_jlist_json_not_found');
  }
  for (let start = output.lastIndexOf('['); start >= 0; start = output.lastIndexOf('[', start - 1)) {
    try {
      const parsed = JSON.parse(output.slice(start).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Try an earlier '['.
    }
  }
  throw new Error('pm2_jlist_json_not_found');
}

/** Keep PM2 transport/parse failures distinct from confirmed process absence. */
export function inspectBotmuxPm2Apps(load: () => unknown[]): BotmuxPm2Inspection {
  try {
    const apps = load();
    if (!Array.isArray(apps)) {
      return { ok: false, message: 'pm2 jlist result is not an array' };
    }
    if (apps.some(app => (
      !app
      || typeof app !== 'object'
      || typeof (app as any).name !== 'string'
      || !(app as any).name.trim()
    ))) {
      return {
        ok: false,
        message: 'pm2 jlist contains a malformed process row',
      };
    }
    return {
      ok: true,
      apps: apps.flatMap((app: any) => (
        app.name === 'botmux' || app.name.startsWith('botmux-')
          ? [{
              name: app.name,
              online: app?.pm2_env?.status === 'online',
              botIndex: typeof app?.pm2_env?.BOTMUX_BOT_INDEX === 'string'
                ? app.pm2_env.BOTMUX_BOT_INDEX
                : typeof app?.pm2_env?.env?.BOTMUX_BOT_INDEX === 'string'
                  ? app.pm2_env.env.BOTMUX_BOT_INDEX
                  : undefined,
              larkAppId: typeof app?.pm2_env?.BOTMUX_LARK_APP_ID === 'string'
                ? app.pm2_env.BOTMUX_LARK_APP_ID
                : typeof app?.pm2_env?.env?.BOTMUX_LARK_APP_ID === 'string'
                  ? app.pm2_env.env.BOTMUX_LARK_APP_ID
                  : undefined,
              activationAppId: typeof app?.pm2_env?.BOTMUX_MANAGED_ACTIVATION_APP_ID === 'string'
                ? app.pm2_env.BOTMUX_MANAGED_ACTIVATION_APP_ID
                : typeof app?.pm2_env?.env?.BOTMUX_MANAGED_ACTIVATION_APP_ID === 'string'
                  ? app.pm2_env.env.BOTMUX_MANAGED_ACTIVATION_APP_ID
                  : undefined,
              activationJobId: typeof app?.pm2_env?.BOTMUX_MANAGED_ACTIVATION_JOB_ID === 'string'
                ? app.pm2_env.BOTMUX_MANAGED_ACTIVATION_JOB_ID
                : typeof app?.pm2_env?.env?.BOTMUX_MANAGED_ACTIVATION_JOB_ID === 'string'
                  ? app.pm2_env.env.BOTMUX_MANAGED_ACTIVATION_JOB_ID
                  : undefined,
            }]
          : []
      )),
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Delete one exact row, then require a successful readback proving absence. */
export function stopExactPm2Process(
  processName: string,
  list: () => BotmuxPm2Inspection,
  remove: (processName: string) => void,
): ExactPm2StopResult {
  const before = list();
  if (!before.ok) {
    return { ok: false, reason: 'pm2_error', message: before.message };
  }
  if (!before.apps.some(app => app.name === processName)) {
    return { ok: true, state: 'already-stopped', processName };
  }
  try {
    remove(processName);
  } catch (err) {
    return {
      ok: false,
      reason: 'pm2_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const after = list();
  if (!after.ok) {
    return { ok: false, reason: 'pm2_error', message: after.message };
  }
  if (after.apps.some(app => app.name === processName)) {
    return {
      ok: false,
      reason: 'pm2_error',
      message: `pm2 process ${processName} is still present after delete`,
    };
  }
  return { ok: true, state: 'stopped', processName };
}
