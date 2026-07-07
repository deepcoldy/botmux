import type { DispatchBot } from './dispatch.js';

export interface DispatchWorkerMetaBotConfig {
  larkAppId: string;
  cliId: string;
}

export interface DispatchWorkerMetaBotInfo {
  larkAppId: string;
  botName: string | null;
  cliId: string;
}

export interface DispatchWorkerMeta {
  larkAppId: string;
  cliId: string;
}

export interface DispatchWorkerUnionBot {
  larkAppId: string;
  cliId: string;
  name: string;
  botUnionId?: string;
}

export function normalizeDispatchBotsForSender(input: {
  bots: DispatchBot[];
  botInfoEntries: DispatchWorkerMetaBotInfo[];
  senderScopedBotOpenIds?: Record<string, string>;
}): DispatchBot[] {
  const senderOpenIdByLabel = new Map<string, string>();
  for (const [label, openId] of Object.entries(input.senderScopedBotOpenIds ?? {})) {
    if (typeof openId === 'string' && openId.trim()) senderOpenIdByLabel.set(label.trim().toLowerCase(), openId.trim());
  }
  if (senderOpenIdByLabel.size === 0) return input.bots;

  const extraLabelsByCliId = new Map<string, string[]>();
  for (const entry of input.botInfoEntries) {
    const cliId = entry.cliId?.trim().toLowerCase();
    const botName = entry.botName?.trim();
    if (cliId && botName) extraLabelsByCliId.set(cliId, [...(extraLabelsByCliId.get(cliId) ?? []), botName]);
  }

  return input.bots.map((bot) => {
    const labels = [bot.name, bot.openId, ...(extraLabelsByCliId.get(bot.openId.trim().toLowerCase()) ?? [])]
      .map((label) => label?.trim())
      .filter((label): label is string => !!label);
    for (const label of labels) {
      const scopedOpenId = senderOpenIdByLabel.get(label.toLowerCase());
      if (scopedOpenId) return { ...bot, openId: scopedOpenId };
    }
    return bot;
  });
}

export function resolveDispatchWorkerMetas(input: {
  openIds: string[];
  bots: DispatchBot[];
  workerNames?: string[];
  botConfigs: DispatchWorkerMetaBotConfig[];
  botInfoEntries: DispatchWorkerMetaBotInfo[];
  senderScopedBotOpenIds?: Record<string, string>;
}): DispatchWorkerMeta[] {
  const botSpecByOpenId = new Map(input.bots.map((bot) => [bot.openId, bot]));
  const workerNameByOpenId = new Map(input.openIds.map((openId, index) => [openId, input.workerNames?.[index] ?? openId]));
  const botConfigByAppId = new Map(input.botConfigs.map((cfg) => [cfg.larkAppId, cfg]));
  const botInfoByAppId = new Map(input.botInfoEntries.map((entry) => [entry.larkAppId, entry]));
  const botNameBySenderScopedOpenId = new Map<string, string>();
  for (const [botName, openId] of Object.entries(input.senderScopedBotOpenIds ?? {})) {
    if (typeof openId === 'string' && openId.trim()) botNameBySenderScopedOpenId.set(openId, botName);
  }
  const botInfoByName = new Map<string, DispatchWorkerMetaBotInfo>();
  for (const cfg of input.botConfigs) {
    const info = botInfoByAppId.get(cfg.larkAppId);
    const name = info?.botName?.trim().toLowerCase();
    if (name && info && !botInfoByName.has(name)) botInfoByName.set(name, info);
  }
  const botConfigsByCliId = new Map<string, DispatchWorkerMetaBotConfig[]>();
  for (const cfg of input.botConfigs) {
    const key = cfg.cliId.trim().toLowerCase();
    botConfigsByCliId.set(key, [...(botConfigsByCliId.get(key) ?? []), cfg]);
  }

  function resolveOne(openId: string): DispatchWorkerMeta {
    const spec = botSpecByOpenId.get(openId);
    const senderScopedName = botNameBySenderScopedOpenId.get(openId);
    const labels = [senderScopedName, spec?.openId, spec?.name, workerNameByOpenId.get(openId)]
      .map((label) => label?.trim())
      .filter((label): label is string => !!label);
    for (const label of labels) {
      const byApp = botConfigByAppId.get(label);
      if (byApp) return { larkAppId: byApp.larkAppId, cliId: byApp.cliId };
    }
    for (const label of labels) {
      const byName = botInfoByName.get(label.toLowerCase());
      if (byName) return { larkAppId: byName.larkAppId, cliId: byName.cliId };
    }
    for (const label of labels) {
      const matches = botConfigsByCliId.get(label.toLowerCase()) ?? [];
      if (matches.length === 1) return { larkAppId: matches[0].larkAppId, cliId: matches[0].cliId };
    }
    return { larkAppId: '', cliId: '' };
  }

  return input.openIds.map(resolveOne);
}

export function resolveDispatchWorkerBotUnionIds(input: {
  openIds: string[];
  bots: DispatchBot[];
  workerNames?: string[];
  workerMetas?: DispatchWorkerMeta[];
  /** Authoritative platform team roster. Checked before learned/legacy rosters. */
  platformTeamBots?: DispatchWorkerUnionBot[];
  learnedBotUnionIdsByName?: Record<string, string>;
  federationBots: DispatchWorkerUnionBot[];
  senderScopedBotOpenIds?: Record<string, string>;
}): string[] {
  const botSpecByOpenId = new Map(input.bots.map((bot) => [bot.openId, bot]));
  const workerNameByOpenId = new Map(input.openIds.map((openId, index) => [openId, input.workerNames?.[index] ?? openId]));
  const nameBySenderScopedOpenId = new Map<string, string>();
  for (const [botName, openId] of Object.entries(input.senderScopedBotOpenIds ?? {})) {
    if (typeof openId === 'string' && openId.trim()) nameBySenderScopedOpenId.set(openId, botName);
  }
  const learnedUnionByName = new Map<string, string>();
  for (const [name, unionId] of Object.entries(input.learnedBotUnionIdsByName ?? {})) {
    const n = name?.trim().toLowerCase();
    const u = unionId?.trim();
    if (n && u) learnedUnionByName.set(n, u);
  }

  function indexRoster(bots: DispatchWorkerUnionBot[]): {
    byAppId: Map<string, DispatchWorkerUnionBot>;
    byCliId: Map<string, DispatchWorkerUnionBot[]>;
    byName: Map<string, DispatchWorkerUnionBot[]>;
  } {
    const byAppId = new Map<string, DispatchWorkerUnionBot>();
    const byCliId = new Map<string, DispatchWorkerUnionBot[]>();
    const byName = new Map<string, DispatchWorkerUnionBot[]>();
    for (const bot of bots) {
      if (!bot.botUnionId?.trim()) continue;
      if (bot.larkAppId) byAppId.set(bot.larkAppId, bot);
      const cliKey = bot.cliId?.trim().toLowerCase();
      if (cliKey) byCliId.set(cliKey, [...(byCliId.get(cliKey) ?? []), bot]);
      const nameKey = bot.name?.trim().toLowerCase();
      if (nameKey) byName.set(nameKey, [...(byName.get(nameKey) ?? []), bot]);
    }
    return { byAppId, byCliId, byName };
  }

  const platform = indexRoster(input.platformTeamBots ?? []);
  const federation = indexRoster(input.federationBots);

  function resolveFromRoster(roster: ReturnType<typeof indexRoster>, labels: string[], meta?: DispatchWorkerMeta): string {
    if (meta?.larkAppId) {
      const byMeta = roster.byAppId.get(meta.larkAppId)?.botUnionId?.trim();
      if (byMeta) return byMeta;
    }
    for (const label of labels) {
      const byApp = roster.byAppId.get(label)?.botUnionId?.trim();
      if (byApp) return byApp;
    }
    for (const label of labels) {
      const union = uniqueUnion(roster.byName.get(label.toLowerCase()));
      if (union) return union;
    }
    for (const label of labels) {
      const union = uniqueUnion(roster.byCliId.get(label.toLowerCase()));
      if (union) return union;
    }
    return '';
  }

  function uniqueUnion(match: DispatchWorkerUnionBot[] | undefined): string {
    const unionIds = [...new Set((match ?? []).map((bot) => bot.botUnionId?.trim()).filter((id): id is string => !!id))];
    return unionIds.length === 1 ? unionIds[0] : '';
  }

  return input.openIds.map((openId, index) => {
    const spec = botSpecByOpenId.get(openId);
    const senderScopedName = nameBySenderScopedOpenId.get(openId);
    const meta = input.workerMetas?.[index];
    const labels = [senderScopedName, spec?.openId, spec?.name, workerNameByOpenId.get(openId), meta?.cliId, meta?.larkAppId]
      .map((label) => label?.trim())
      .filter((label): label is string => !!label);

    const platformUnion = resolveFromRoster(platform, labels, meta);
    if (platformUnion) return platformUnion;

    for (const label of labels) {
      const learned = learnedUnionByName.get(label.toLowerCase());
      if (learned) return learned;
    }

    const federationUnion = resolveFromRoster(federation, labels, meta);
    if (federationUnion) return federationUnion;

    return '';
  });
}
