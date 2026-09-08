import {
  COMPANION_BOT_APP_ID_ENV,
  COMPANION_SECRET_FILE_ENV,
} from '../config.js';

export interface CompanionStartupBot {
  larkAppId?: string;
  sandbox?: boolean;
  cliId?: string;
}

export function applyCompanionStartupOptions(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  bots: readonly CompanionStartupBot[];
  validateSecret: (path: string) => unknown;
}): void {
  let secretFile = input.env[COMPANION_SECRET_FILE_ENV]?.trim();
  let botAppId = input.env[COMPANION_BOT_APP_ID_ENV]?.trim();
  for (let i = 0; i < input.argv.length; i += 1) {
    const arg = input.argv[i];
    if (arg === '--companion-secret-file') secretFile = input.argv[++i]?.trim();
    else if (arg.startsWith('--companion-secret-file=')) secretFile = arg.slice(arg.indexOf('=') + 1).trim();
    else if (arg === '--companion-bot') botAppId = input.argv[++i]?.trim();
    else if (arg.startsWith('--companion-bot=')) botAppId = arg.slice(arg.indexOf('=') + 1).trim();
  }
  if (!secretFile && !botAppId) return;
  if (!secretFile || !botAppId) {
    throw new Error('companion configuration requires both secret-file and bot selection');
  }
  input.validateSecret(secretFile);
  const matches = input.bots.filter(bot => bot.larkAppId === botAppId);
  if (matches.length !== 1 || matches[0].sandbox !== true
    || (matches[0].cliId !== 'codex' && matches[0].cliId !== 'traex')) {
    // Deliberately omit the selected app id and all config details: this is a
    // deterministic provisioning diagnostic, not a fleet inventory endpoint.
    throw new Error('companion bot selection must match exactly one isolated codex/traex Bot');
  }
  input.env[COMPANION_SECRET_FILE_ENV] = secretFile;
  input.env[COMPANION_BOT_APP_ID_ENV] = botAppId;
}
