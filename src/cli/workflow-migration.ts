/** `botmux template migrate-v3`: dry-run first, explicit commit second. */

import { loadBotConfigs } from '../bot-registry.js';
import { resolve } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import {
  commitLegacyWorkflowMigration,
  LegacyWorkflowConversionError,
} from '../workflows/migration/v2-migration-service.js';
import {
  findLegacyMigration,
  legacyDefinitionIdentity,
  migratedSavedWorkflowId,
} from '../workflows/migration/v2-ledger.js';
import { scanLegacyWorkflowCandidates } from '../workflows/migration/v2-scanner.js';
import {
  convertLegacyWorkflowDefinition,
  type LegacyConversionTargetContext,
  type LegacyMigrationIssue,
} from '../workflows/migration/v2-to-v3.js';
import type { SavedWorkflowOwner, SavedWorkflowScope } from '../workflows/v3/library-schema.js';

export interface WorkflowMigrationCliOptions {
  refs: string[];
  all: boolean;
  commit: boolean;
  json: boolean;
  acknowledgeWarnings: boolean;
  supersedePending: boolean;
  dataDir: string;
  owner?: SavedWorkflowOwner;
  scope?: SavedWorkflowScope;
  chatType?: 'group' | 'p2p';
}

export interface WorkflowMigrationCliReport {
  path: string;
  workflowId: string;
  status:
    | 'invalid'
    | 'shadowed'
    | 'unsupported'
    | 'convertible'
    | 'update_required'
    | 'pending'
    | 'migrated'
    | 'committed'
    | 'failed';
  contentHash?: string;
  targetWorkflowId?: string;
  targetRevisionId?: string;
  shadowedBy?: string;
  issues: LegacyMigrationIssue[];
  error?: string;
}

export interface WorkflowMigrationCliDeps {
  loadBots?: typeof loadBotConfigs;
  scanCandidates?: typeof scanLegacyWorkflowCandidates;
}

const VALUE_FLAGS = new Set([
  '--owner-open-id',
  '--lark-app-id',
  '--scope',
  '--chat-id',
  '--chat-type',
  '--data-dir',
]);
const BOOLEAN_FLAGS = new Set([
  '--all',
  '--commit',
  '--json',
  '--ack-warnings',
  '--supersede-pending',
]);

function parseRawFlags(args: string[]): {
  refs: string[];
  values: Map<string, string>;
  booleans: Set<string>;
} {
  const refs: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      refs.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equals >= 0) throw new Error(`${flag} does not accept a value`);
      if (booleans.has(flag)) throw new Error(`duplicate flag ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate flag ${flag}`);
    const value = equals >= 0 ? token.slice(equals + 1) : args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  return { refs, values, booleans };
}

export function parseWorkflowMigrationCliOptions(
  args: string[],
  defaultDataDir: string = resolveBotmuxDataDir(),
): WorkflowMigrationCliOptions {
  const raw = parseRawFlags(args);
  const all = raw.booleans.has('--all');
  if (all && raw.refs.length > 0) throw new Error('--all cannot be combined with explicit workflow ids/paths');
  const ownerOpenId = raw.values.get('--owner-open-id');
  const larkAppId = raw.values.get('--lark-app-id');
  const scopeKind = raw.values.get('--scope');
  const chatId = raw.values.get('--chat-id');
  const chatTypeRaw = raw.values.get('--chat-type');
  const anyTargetFlag = !!ownerOpenId || !!larkAppId || !!scopeKind || !!chatId || !!chatTypeRaw;
  let owner: SavedWorkflowOwner | undefined;
  let scope: SavedWorkflowScope | undefined;
  let chatType: 'group' | 'p2p' | undefined;
  if (anyTargetFlag) {
    if (!ownerOpenId || !larkAppId || !scopeKind) {
      throw new Error('target metadata requires --owner-open-id, --lark-app-id, and --scope together');
    }
    owner = { openId: ownerOpenId, larkAppId };
    if (scopeKind === 'global') {
      if (chatId || chatTypeRaw) throw new Error('--scope global cannot include --chat-id/--chat-type');
      scope = { kind: 'global' };
    } else if (scopeKind === 'chat') {
      if (!chatId || (chatTypeRaw !== 'group' && chatTypeRaw !== 'p2p')) {
        throw new Error('--scope chat requires --chat-id and --chat-type group|p2p');
      }
      scope = { kind: 'chat', chatId };
      chatType = chatTypeRaw;
    } else {
      throw new Error('--scope must be global or chat');
    }
  }
  const commit = raw.booleans.has('--commit');
  if (commit && (!owner || !scope)) {
    throw new Error('--commit never infers ownership/scope; provide explicit owner, app, and scope flags');
  }
  const supersedePending = raw.booleans.has('--supersede-pending');
  if (supersedePending && !commit) {
    throw new Error('--supersede-pending is a commit-only recovery action');
  }
  return {
    refs: raw.refs,
    all,
    commit,
    json: raw.booleans.has('--json'),
    acknowledgeWarnings: raw.booleans.has('--ack-warnings'),
    supersedePending,
    dataDir: resolve(raw.values.get('--data-dir') ?? defaultDataDir),
    ...(owner ? { owner } : {}),
    ...(scope ? { scope } : {}),
    ...(chatType ? { chatType } : {}),
  };
}

function issueFromError(code: string, path: string, err: unknown): LegacyMigrationIssue {
  return {
    severity: 'error',
    code,
    path,
    message: err instanceof Error ? err.message : String(err),
    hint: 'Fix the source asset and run the dry-run again.',
  };
}

function targetContext(options: WorkflowMigrationCliOptions): LegacyConversionTargetContext | undefined {
  if (!options.owner || !options.scope) return undefined;
  return {
    owner: options.owner,
    scope: options.scope,
    ...(options.chatType ? { chatType: options.chatType } : {}),
  };
}

function printHumanReport(reports: WorkflowMigrationCliReport[]): void {
  for (const report of reports) {
    const target = report.targetWorkflowId
      ? ` -> ${report.targetWorkflowId}${report.targetRevisionId ? `@${report.targetRevisionId}` : ''}`
      : '';
    console.log(`[${report.status}] ${report.workflowId}  ${report.path}${target}`);
    if (report.shadowedBy) console.log(`  shadowed by: ${report.shadowedBy}`);
    if (report.error) console.log(`  error: ${report.error}`);
    for (const item of report.issues) {
      console.log(`  - ${item.severity.toUpperCase()} ${item.code} ${item.path}: ${item.message}`);
      console.log(`    hint: ${item.hint}`);
    }
  }
  const counts = new Map<string, number>();
  reports.forEach((report) => counts.set(report.status, (counts.get(report.status) ?? 0) + 1));
  console.log(
    `summary: ${reports.length} definition(s)` +
    [...counts.entries()].map(([status, count]) => `, ${status}=${count}`).join(''),
  );
}

export async function runWorkflowMigrationCli(
  options: WorkflowMigrationCliOptions,
  deps: WorkflowMigrationCliDeps = {},
): Promise<{ reports: WorkflowMigrationCliReport[]; ok: boolean }> {
  let bots: ReturnType<typeof loadBotConfigs>;
  let botLoadError: string | undefined;
  try { bots = (deps.loadBots ?? loadBotConfigs)(); }
  catch (err) {
    bots = [];
    botLoadError = err instanceof Error ? err.message : String(err);
  }
  const candidates = await (deps.scanCandidates ?? scanLegacyWorkflowCandidates)({
    ...(options.refs.length > 0 ? { refs: options.refs } : {}),
  });
  const reports: WorkflowMigrationCliReport[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === 'invalid') {
      reports.push({
        path: candidate.path,
        workflowId: candidate.inferredWorkflowId,
        status: 'invalid',
        issues: [issueFromError('LEGACY_DEFINITION_INVALID', candidate.path, candidate.error)],
        error: candidate.error,
      });
      continue;
    }
    if (candidate.kind === 'shadowed') {
      reports.push({
        path: candidate.path,
        workflowId: candidate.definition.workflowId,
        status: 'shadowed',
        shadowedBy: candidate.shadowedBy,
        issues: [{
          severity: 'error',
          code: 'LEGACY_DEFINITION_SHADOWED',
          path: candidate.path,
          message: 'A higher-priority definition with the same workflowId wins v2 resolution.',
          hint: 'Migrate the winner, or pass this exact path explicitly after resolving the duplicate.',
        }],
      });
      continue;
    }

    let identity;
    try {
      identity = legacyDefinitionIdentity(candidate.path, candidate.definition);
    } catch (err) {
      reports.push({
        path: candidate.path,
        workflowId: candidate.definition.workflowId,
        status: 'invalid',
        issues: [issueFromError('LEGACY_SOURCE_INVALID', candidate.path, err)],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const conversion = convertLegacyWorkflowDefinition({
      definition: candidate.definition,
      bots,
      ...(targetContext(options) ? { target: targetContext(options) } : {}),
    });
    const botConfigIssue: LegacyMigrationIssue[] = botLoadError &&
      Object.values(candidate.definition.nodes).some((node) => node.type === 'subagent')
      ? [{
        severity: 'error',
        code: 'BOTS_CONFIG_LOAD_FAILED',
        path: 'bots.json',
        message: botLoadError,
        hint: 'Repair bots.json, then rerun the migration dry-run.',
      }]
      : [];
    const targetWorkflowId = migratedSavedWorkflowId(identity);
    if (!conversion.ok || botConfigIssue.length > 0) {
      reports.push({
        path: identity.path,
        workflowId: identity.workflowId,
        contentHash: identity.contentHash,
        targetWorkflowId,
        status: 'unsupported',
        issues: [
          ...botConfigIssue,
          ...conversion.issues.filter((item) =>
            !(botConfigIssue.length > 0 && item.code === 'BOT_NOT_FOUND')),
        ],
      });
      continue;
    }
    const lookup = findLegacyMigration(options.dataDir, identity);
    if (!options.commit) {
      reports.push({
        path: identity.path,
        workflowId: identity.workflowId,
        contentHash: identity.contentHash,
        targetWorkflowId,
        ...(lookup.kind === 'exact' ? { targetRevisionId: lookup.revision.targetRevisionId } : {}),
        status: lookup.kind === 'exact'
          ? lookup.revision.state === 'committed' ? 'migrated' : 'pending'
          : lookup.kind === 'changed_after_migration' ? 'update_required' : 'convertible',
        issues: conversion.issues,
      });
      continue;
    }
    try {
      const result = await commitLegacyWorkflowMigration({
        dataDir: options.dataDir,
        sourcePath: identity.path,
        bots,
        owner: options.owner!,
        scope: options.scope!,
        ...(options.chatType ? { chatType: options.chatType } : {}),
        acknowledgeWarnings: options.acknowledgeWarnings,
        supersedePending: options.supersedePending,
      });
      reports.push({
        path: result.identity.path,
        workflowId: result.identity.workflowId,
        contentHash: result.identity.contentHash,
        targetWorkflowId: result.metadata.workflowId,
        targetRevisionId: result.revision.revisionId,
        status: 'committed',
        issues: result.issues,
      });
    } catch (err) {
      const issues = err instanceof LegacyWorkflowConversionError
        ? err.issues
        : [issueFromError('MIGRATION_COMMIT_FAILED', identity.path, err)];
      reports.push({
        path: identity.path,
        workflowId: identity.workflowId,
        contentHash: identity.contentHash,
        targetWorkflowId,
        status: 'failed',
        issues,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const ok = reports.every((report) =>
    report.status === 'convertible' ||
    report.status === 'update_required' ||
    report.status === 'pending' ||
    report.status === 'migrated' ||
    report.status === 'committed');
  return { reports, ok };
}

export async function cmdWorkflowMigration(args: string[]): Promise<void> {
  const options = parseWorkflowMigrationCliOptions(args);
  const result = await runWorkflowMigrationCli(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result.reports);
  if (!result.ok) process.exitCode = 1;
}
