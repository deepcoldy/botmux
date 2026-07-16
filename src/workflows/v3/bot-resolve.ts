/**
 * Shared v3 bot resolution — selector → BotConfig → BotSnapshot.
 *
 * The daemon-driven run path (`daemon-run.ts`) and the standalone CLI path
 * (`cli-run.ts`) both turn a `--bot`/node.bot selector into the `BotSnapshot`
 * the runtime freezes per node.  This module is the single source of that
 * matching + working-dir fallback so the two entries can't drift.
 *
 * (cli-run.ts currently keeps equivalent local copies — codex's runtime file,
 * which this feature doesn't touch; dedupe it to this module next time that
 * file is edited.)
 */

import { effectiveDefaultWorkingDir, type BotConfig } from '../../bot-registry.js';
import { isGoalNode, isLoopNode, type V3Dag } from './dag.js';
import {
  V3_SUPPORTED_CLIS,
  isV3SupportedCli,
  type BotSnapshot,
} from './contract.js';

export function resolveBotConfig(selector: string | undefined, bots: BotConfig[]): BotConfig {
  if (!selector) {
    if (bots.length === 0) throw new Error('v3: bots.json has no bots — run `botmux setup` first');
    return bots[0]!;
  }
  // Stable identity always wins over a display-name collision. Saved Workflow
  // templates persist larkAppId; a bot named like another bot's app id must
  // never hijack that selector.
  const match = bots.find((b) => b.larkAppId === selector)
    ?? bots.find((b) => b.name === selector);
  if (!match) {
    const known = bots.map((b) => b.name ?? b.larkAppId).join(', ') || '(none)';
    throw new Error(`v3: no bot matches "${selector}" (known: ${known})`);
  }
  return match;
}

/** The configured working dir for a bot, before `~` expansion (the pool
 *  expands).  An explicit override wins over the bot's configured value. */
export function botWorkingDir(bot: BotConfig, override?: string): string {
  return override
    ?? effectiveDefaultWorkingDir(bot)
    ?? bot.workingDir
    ?? bot.workingDirs?.[0]
    ?? '~';
}

/** BotConfig → BotSnapshot (the runtime-frozen, secret-free per-node identity). */
export function botToSnapshot(bot: BotConfig, workingDirOverride?: string): BotSnapshot {
  if (bot.disableCliBypass === true) {
    throw new Error(
      `v3 workflow requires CLI bypass permissions, but bot "${bot.name ?? bot.larkAppId}" ` +
      'has disableCliBypass=true. Use a workflow bot with bypass enabled, or remove/set this bot option to false',
    );
  }
  return {
    larkAppId: bot.larkAppId,
    cliId: bot.cliId,
    ...(bot.cliPathOverride ? { cliPathOverride: bot.cliPathOverride } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    ...(bot.sandbox === true ? { sandbox: true } : {}),
    ...(bot.sandboxHidePaths?.length ? { sandboxHidePaths: [...bot.sandboxHidePaths] } : {}),
    ...(bot.sandboxReadonlyPaths?.length ? { sandboxReadonlyPaths: [...bot.sandboxReadonlyPaths] } : {}),
    ...(bot.sandboxNetwork === false ? { sandboxNetwork: false } : {}),
    workingDir: botWorkingDir(bot, workingDirOverride),
  };
}

/**
 * Resolve every selector used by a DAG exactly once. Keys intentionally mirror
 * the runtime contract (`''` means the DAG's default bot); loop-body nodes use
 * their own selector or inherit the loop selector.
 */
export function freezeDagBotSnapshots(
  dag: V3Dag,
  bots: BotConfig[],
  opts: { defaultSelector?: string; workingDirOverride?: string } = {},
): Map<string, BotSnapshot> {
  const snapshots = new Map<string, BotSnapshot>();
  const freeze = (selector: string | undefined): void => {
    const key = selector ?? '';
    if (snapshots.has(key)) return;
    const bot = resolveBotConfig(selector ?? opts.defaultSelector, bots);
    const snapshot = botToSnapshot(bot, opts.workingDirOverride);
    if (!isV3SupportedCli(snapshot.cliId)) {
      throw new Error(
        `v3 workflow bot "${bot.name ?? bot.larkAppId}" uses unsupported CLI "${snapshot.cliId}" ` +
        `(supported: ${V3_SUPPORTED_CLIS.join(', ')})`,
      );
    }
    snapshots.set(key, snapshot);
  };

  for (const node of dag.nodes) {
    if (isGoalNode(node)) freeze(node.bot);
    if (isLoopNode(node)) {
      for (const bodyNode of node.body.nodes) freeze(bodyNode.bot ?? node.bot);
    }
  }
  return snapshots;
}

/** JSON-safe persisted shape used by `bots.snapshot.json`. */
export function serializeFrozenBotSnapshots(
  snapshots: ReadonlyMap<string, BotSnapshot>,
): Record<string, BotSnapshot> {
  return Object.fromEntries(snapshots);
}

/**
 * Validate the secret-free pinned bot snapshot artifact before a retry/resume
 * can hand it to the runtime. Unknown keys fail closed so credentials or
 * mutable permission flags cannot quietly creep into this run contract.
 */
export function parseFrozenBotSnapshots(raw: unknown, dag?: V3Dag): Map<string, BotSnapshot> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('bots.snapshot.json must be an object keyed by DAG bot selector');
  }
  const allowed = new Set([
    'larkAppId',
    'cliId',
    'cliPathOverride',
    'model',
    'sandbox',
    'sandboxHidePaths',
    'sandboxReadonlyPaths',
    'sandboxNetwork',
    'workingDir',
  ]);
  const snapshots = new Map<string, BotSnapshot>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`bots.snapshot.json[${JSON.stringify(key)}] must be an object`);
    }
    const obj = value as Record<string, unknown>;
    const extra = Object.keys(obj).filter((field) => !allowed.has(field));
    if (extra.length > 0) {
      throw new Error(`bots.snapshot.json[${JSON.stringify(key)}] has unsupported key(s): ${extra.join(', ')}`);
    }
    if (typeof obj.larkAppId !== 'string' || obj.larkAppId.length === 0) {
      throw new Error(`bots.snapshot.json[${JSON.stringify(key)}].larkAppId must be a non-empty string`);
    }
    if (typeof obj.cliId !== 'string' || !isV3SupportedCli(obj.cliId as BotSnapshot['cliId'])) {
      throw new Error(
        `bots.snapshot.json[${JSON.stringify(key)}].cliId must be one of ${V3_SUPPORTED_CLIS.join(', ')}`,
      );
    }
    if (typeof obj.workingDir !== 'string' || obj.workingDir.length === 0) {
      throw new Error(`bots.snapshot.json[${JSON.stringify(key)}].workingDir must be a non-empty string`);
    }
    for (const field of ['cliPathOverride', 'model'] as const) {
      if (obj[field] !== undefined && typeof obj[field] !== 'string') {
        throw new Error(`bots.snapshot.json[${JSON.stringify(key)}].${field} must be a string`);
      }
    }
    for (const field of ['sandbox', 'sandboxNetwork'] as const) {
      if (obj[field] !== undefined && typeof obj[field] !== 'boolean') {
        throw new Error(`bots.snapshot.json[${JSON.stringify(key)}].${field} must be a boolean`);
      }
    }
    for (const field of ['sandboxHidePaths', 'sandboxReadonlyPaths'] as const) {
      if (
        obj[field] !== undefined &&
        (!Array.isArray(obj[field]) || !(obj[field] as unknown[]).every((item) => typeof item === 'string'))
      ) {
        throw new Error(`bots.snapshot.json[${JSON.stringify(key)}].${field} must be a string array`);
      }
    }
    snapshots.set(key, {
      larkAppId: obj.larkAppId,
      cliId: obj.cliId as BotSnapshot['cliId'],
      ...(obj.cliPathOverride !== undefined ? { cliPathOverride: obj.cliPathOverride as string } : {}),
      ...(obj.model !== undefined ? { model: obj.model as string } : {}),
      ...(obj.sandbox !== undefined ? { sandbox: obj.sandbox as boolean } : {}),
      ...(obj.sandboxHidePaths !== undefined ? { sandboxHidePaths: [...obj.sandboxHidePaths as string[]] } : {}),
      ...(obj.sandboxReadonlyPaths !== undefined ? { sandboxReadonlyPaths: [...obj.sandboxReadonlyPaths as string[]] } : {}),
      ...(obj.sandboxNetwork !== undefined ? { sandboxNetwork: obj.sandboxNetwork as boolean } : {}),
      workingDir: obj.workingDir,
    });
  }

  if (dag) {
    const required = new Set<string>();
    for (const node of dag.nodes) {
      if (isGoalNode(node)) required.add(node.bot ?? '');
      if (isLoopNode(node)) {
        for (const bodyNode of node.body.nodes) required.add(bodyNode.bot ?? node.bot ?? '');
      }
    }
    for (const key of required) {
      if (!snapshots.has(key)) {
        throw new Error(`bots.snapshot.json is missing selector ${JSON.stringify(key || '<default>')}`);
      }
    }
  }
  return snapshots;
}
