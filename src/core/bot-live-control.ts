export interface BotmuxPm2App {
  name: string;
  online: boolean;
}

export type BotmuxPm2Inspection =
  | { ok: true; apps: BotmuxPm2App[] }
  | { ok: false; message: string };

export type ExactPm2StopResult =
  | { ok: true; state: 'stopped' | 'already-stopped'; processName: string }
  | { ok: false; reason: 'pm2_error'; message: string };

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
