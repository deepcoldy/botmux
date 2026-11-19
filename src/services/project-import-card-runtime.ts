import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';
import * as larkClient from '../im/lark/client.js';
import * as cardHandler from '../im/lark/card-handler.js';
import type { CardActionData } from '../im/lark/card-handler.js';
import { getIdentity } from '../im/lark/identity-cache.js';
import {
  buildProjectImportCard,
  deriveImportWorkstreamTitle,
  PROJECT_IMPORT_CONFIRM_ACTION,
  type ProjectImportUnattachedReason,
} from '../im/lark/project-import-card.js';
import { readGroupCollaborationMode } from './group-collaboration-mode-store.js';
import { readProjectGroup } from './project-group-store.js';
import { isPlatformTeamBot } from './platform-team-store.js';
import { isTeamBot } from './team-bots-store.js';
import { projectWorkstreamErrorHint } from './project-workstream-authority.js';
import {
  readProjectAttachmentRecord,
  type ProjectAttachmentSource,
  type ProjectAttachmentSourceKind,
} from './project-workstream-attachments.js';
import {
  canHumanOperateBot,
  claimOwnerlessProjectSource,
  getProjectAttachmentSource,
  markHostCardCallbackActor,
  projectSessionOwnerKey,
  projectWorkstreamAttachments,
  resolveSourceBotDisplayName,
} from './project-workstream-runtime.js';
import * as sessionStore from './session-store.js';
import { logger } from '../utils/logger.js';

export interface ProjectImportCardRecord {
  schemaVersion: 1;
  chatId: string;
  rootMessageId: string;
  coordinatorAppId: string;
  messageId: string;
  sourceSessionId: string;
  sourceLarkAppId: string;
  sourceKind: ProjectAttachmentSourceKind;
  routeRevision: number;
  status: 'pending' | 'registered';
  reason?: ProjectImportUnattachedReason;
  proposedTitle?: string;
  proposedPurpose?: string;
  workstreamTitle?: string;
  confirmedByOpenId?: string;
  registrationMode?: 'human_card' | 'human_turn' | 'coordinator_notice';
  updatedAt: string;
}

export interface ProjectImportCardTransport {
  replyCard(appId: string, rootMessageId: string, cardJson: string): Promise<string>;
  updateCard(appId: string, messageId: string, cardJson: string): Promise<void>;
  isCardGone(error: unknown): boolean;
  resolveOperator(data: CardActionData, appId: string): Promise<{ openId?: string; unionId?: string }>;
  findCoordinatorSession(sessionId: string): {
    sessionId: string;
    larkAppId?: string;
    chatId: string;
    scope?: 'chat' | 'thread';
    status: string;
    ownerOpenId?: string;
    ownerUnionId?: string;
    vcMeetingReceiver?: unknown;
  } | undefined;
  onCardAttached?(chatId: string, coordinatorSessionId: string): Promise<void>;
}

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/u;
const ROOT_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/u;
const APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/u;

let installedCoordinatorLookup: ((sessionId: string) => ProjectImportCardTransport['findCoordinatorSession'] extends (id: string) => infer R ? R : never) | undefined;
let installedOnCardAttached: ((chatId: string, coordinatorSessionId: string) => Promise<void>) | undefined;

export function configureProjectImportCardHostHooks(hooks: {
  findCoordinatorSession?: typeof installedCoordinatorLookup;
  onCardAttached?: typeof installedOnCardAttached;
}): void {
  if (hooks.findCoordinatorSession !== undefined) installedCoordinatorLookup = hooks.findCoordinatorSession;
  if (hooks.onCardAttached !== undefined) installedOnCardAttached = hooks.onCardAttached;
}

function defaultTransport(): ProjectImportCardTransport {
  return {
    replyCard: (appId, rootMessageId, cardJson) => larkClient.replyMessage(appId, rootMessageId, cardJson, 'interactive', true),
    updateCard: (appId, messageId, cardJson) => larkClient.updateMessage(appId, messageId, cardJson),
    isCardGone: error => error instanceof larkClient.MessageWithdrawnError
      || error instanceof larkClient.MessageUpdateExpiredError
      || (error instanceof Error && (error.name === 'MessageWithdrawnError' || error.name === 'MessageUpdateExpiredError')),
    resolveOperator: (data, appId) => cardHandler.resolveCardOperatorUnionId(data, appId),
    findCoordinatorSession: sessionId => installedCoordinatorLookup?.(sessionId) ?? sessionStore.getOwnedSession(sessionId),
    onCardAttached: installedOnCardAttached,
  };
}

export function projectImportCardRecordPath(dataDir: string, chatId: string, rootMessageId: string): string {
  if (!CHAT_ID_RE.test(chatId) || !ROOT_ID_RE.test(rootMessageId)) {
    throw new Error('invalid_workstream_root');
  }
  const digest = createHash('sha256').update(`${chatId}\u0000${rootMessageId}`).digest('hex');
  return join(dataDir, '.dashboard-secret.project-imports', 'cards', `${digest}.json`);
}

export function readProjectImportCardRecord(
  dataDir: string,
  chatId: string,
  rootMessageId: string,
): ProjectImportCardRecord | undefined {
  try {
    const raw = readSecureHostFileSync(projectImportCardRecordPath(dataDir, chatId, rootMessageId), 16 * 1024);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ProjectImportCardRecord;
    if (parsed?.schemaVersion !== 1
      || parsed.chatId !== chatId
      || parsed.rootMessageId !== rootMessageId
      || !APP_ID_RE.test(parsed.coordinatorAppId)
      || !APP_ID_RE.test(parsed.sourceLarkAppId)
      || typeof parsed.messageId !== 'string' || !parsed.messageId
      || typeof parsed.sourceSessionId !== 'string' || !parsed.sourceSessionId
      || !Number.isSafeInteger(parsed.routeRevision) || parsed.routeRevision < 1
      || (parsed.status !== 'pending' && parsed.status !== 'registered')) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeProjectImportCardRecord(dataDir: string, record: ProjectImportCardRecord): void {
  writeSecureHostFileSync(
    projectImportCardRecordPath(dataDir, record.chatId, record.rootMessageId),
    JSON.stringify(record),
  );
}

const cardChains = new Map<string, Promise<unknown>>();
function serializedCardOp<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = cardChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  cardChains.set(key, tail);
  void tail.then(() => { if (cardChains.get(key) === tail) cardChains.delete(key); });
  return run;
}

function evaluateCardStatus(input: {
  chatId: string;
  rootMessageId: string;
  sourceSessionId: string;
  sourceLarkAppId: string;
  projectInitialized: boolean;
  workstreamTitleFromProject?: string;
  coordinatorOwnerKey?: string;
  source?: ProjectAttachmentSource;
  dataDir: string;
}): {
  status: 'registered';
  workstreamTitle: string;
} | {
  status: 'pending';
  reason: ProjectImportUnattachedReason;
  canConfirm: boolean;
} {
  const attachment = readProjectAttachmentRecord(input.dataDir, input.chatId, input.rootMessageId);
  const routeRev = input.source?.routeRevision;
  if (input.projectInitialized
    && attachment?.phase === 'active'
    && attachment.state === 'active'
    && attachment.source.sessionId === input.sourceSessionId
    && attachment.source.larkAppId === input.sourceLarkAppId
    && (routeRev === undefined || attachment.source.routeRevision === routeRev)) {
    return { status: 'registered', workstreamTitle: input.workstreamTitleFromProject || attachment.title };
  }
  const source = input.source;
  if (!source
    || source.status !== 'active'
    || source.chatId !== input.chatId
    || source.rootMessageId !== input.rootMessageId
    || source.scope !== 'thread'
    || !source.ordinary) {
    return { status: 'pending', reason: 'source_unavailable', canConfirm: false };
  }
  if (!input.projectInitialized) {
    return { status: 'pending', reason: 'project_uninitialized', canConfirm: false };
  }
  if (!input.coordinatorOwnerKey) {
    return { status: 'pending', reason: 'coordinator_owner_required', canConfirm: false };
  }
  if (!source.ownerKey) {
    return { status: 'pending', reason: 'source_owner_unknown', canConfirm: true };
  }
  if (source.ownerKey !== input.coordinatorOwnerKey) {
    return { status: 'pending', reason: 'source_owner_authorization_required', canConfirm: false };
  }
  return { status: 'pending', reason: 'pending_confirmation', canConfirm: true };
}

export interface PublishProjectImportCardResult {
  cardPosted: boolean;
  messageId: string;
  status: 'pending' | 'registered';
  reason?: ProjectImportUnattachedReason;
  canConfirm: boolean;
}

/**
 * Post or refresh the host-owned migration card in `rootMessageId`.
 * Idempotent per `(chatId, rootMessageId)` and `(sourceSessionId, routeRevision)`.
 */
export async function publishOrRefreshProjectImportCard(
  input: {
    dataDir?: string;
    coordinatorAppId: string;
    chatId: string;
    rootMessageId: string;
    sourceSessionId: string;
    sourceLarkAppId: string;
    sourceKindFallback?: ProjectAttachmentSourceKind;
    routeRevisionFallback?: number;
    proposedTitle?: string;
    proposedPurpose?: string;
    forceRefresh?: boolean;
  },
  transportOverride?: Partial<ProjectImportCardTransport>,
): Promise<PublishProjectImportCardResult> {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const transport = { ...defaultTransport(), ...transportOverride };
  return serializedCardOp(`${input.chatId}:${input.rootMessageId}`, async () => {
    const mode = readGroupCollaborationMode(dataDir, input.chatId);
    const project = readProjectGroup(dataDir, input.chatId);
    if (mode?.mode !== 'project' || mode.coordinatorAppId !== input.coordinatorAppId
      || (project && project.larkAppId !== input.coordinatorAppId)
      || !(mode.workerAppIds ?? []).includes(input.sourceLarkAppId)) {
      throw new Error('project_coordinator_required');
    }
    const projectInitialized = !!project && project.larkAppId === input.coordinatorAppId;
    const coordSession = projectInitialized ? transport.findCoordinatorSession(project.coordinatorSessionId) : undefined;
    const coordinatorOwnerKey = coordSession
      ? await projectSessionOwnerKey({
        larkAppId: input.coordinatorAppId,
        ownerOpenId: coordSession.ownerOpenId,
        ownerUnionId: coordSession.ownerUnionId,
      })
      : undefined;
    const source = await getProjectAttachmentSource(input.sourceLarkAppId, input.sourceSessionId);
    const existing = readProjectImportCardRecord(dataDir, input.chatId, input.rootMessageId);
    const workstreamTitleFromProject = project?.workstreams.find(item => item.dispatchRoot === input.rootMessageId)?.title;
    const evaluated = evaluateCardStatus({
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sourceSessionId: input.sourceSessionId,
      sourceLarkAppId: input.sourceLarkAppId,
      projectInitialized,
      workstreamTitleFromProject,
      coordinatorOwnerKey,
      source,
      dataDir,
    });

    const routeRevision = source?.routeRevision ?? input.routeRevisionFallback ?? existing?.routeRevision ?? 1;
    const sourceKind = source?.source ?? input.sourceKindFallback ?? existing?.sourceKind ?? 'relay';
    const proposedTitle = input.proposedTitle?.trim() || existing?.proposedTitle;
    const proposedPurpose = input.proposedPurpose?.trim() || existing?.proposedPurpose;
    const botName = resolveSourceBotDisplayName(input.sourceLarkAppId, dataDir);

    const sameEpisode = existing
      && existing.coordinatorAppId === input.coordinatorAppId
      && existing.sourceSessionId === input.sourceSessionId
      && existing.sourceLarkAppId === input.sourceLarkAppId
      && existing.routeRevision === routeRevision;

    if (sameEpisode && !input.forceRefresh
      && existing.status === evaluated.status
      && (evaluated.status === 'registered'
        ? existing.workstreamTitle === evaluated.workstreamTitle
        : existing.reason === evaluated.reason && existing.proposedTitle === proposedTitle)) {
      return {
        cardPosted: false,
        messageId: existing.messageId,
        status: evaluated.status,
        ...(evaluated.status === 'pending' ? { reason: evaluated.reason } : {}),
        canConfirm: evaluated.status === 'pending' ? evaluated.canConfirm : false,
      };
    }

    const card = evaluated.status === 'registered'
      ? buildProjectImportCard({
        state: 'registered',
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        sourceSessionId: input.sourceSessionId,
        sourceLarkAppId: input.sourceLarkAppId,
        sourceBotName: botName,
        sourceKind,
        routeRevision,
        sessionTitle: source?.title,
        workstreamTitle: evaluated.workstreamTitle,
        confirmedByOpenId: existing?.confirmedByOpenId,
        registrationMode: existing?.registrationMode,
      })
      : buildProjectImportCard({
        state: 'pending',
        chatId: input.chatId,
        rootMessageId: input.rootMessageId,
        sourceSessionId: input.sourceSessionId,
        sourceLarkAppId: input.sourceLarkAppId,
        sourceBotName: botName,
        sourceKind,
        routeRevision,
        sessionTitle: source?.title,
        reason: evaluated.reason,
        canConfirm: evaluated.canConfirm,
        proposedTitle,
      });
    const cardJson = JSON.stringify(card);

    let messageId = sameEpisode ? existing.messageId : undefined;
    let cardPosted = false;
    if (messageId) {
      try {
        await transport.updateCard(input.coordinatorAppId, messageId, cardJson);
      } catch (error) {
        if (!transport.isCardGone(error)) throw error;
        messageId = undefined;
      }
    }
    if (!messageId) {
      messageId = await transport.replyCard(input.coordinatorAppId, input.rootMessageId, cardJson);
      cardPosted = true;
    }

    const updatedAt = new Date().toISOString();
    writeProjectImportCardRecord(dataDir, {
      schemaVersion: 1,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      coordinatorAppId: input.coordinatorAppId,
      messageId,
      sourceSessionId: input.sourceSessionId,
      sourceLarkAppId: input.sourceLarkAppId,
      sourceKind,
      routeRevision,
      status: evaluated.status,
      ...(evaluated.status === 'pending' ? { reason: evaluated.reason } : {}),
      ...(proposedTitle ? { proposedTitle } : {}),
      ...(proposedPurpose ? { proposedPurpose } : {}),
      ...(evaluated.status === 'registered' ? { workstreamTitle: evaluated.workstreamTitle } : {}),
      ...(existing?.confirmedByOpenId ? { confirmedByOpenId: existing.confirmedByOpenId } : {}),
      ...(existing?.registrationMode ? { registrationMode: existing.registrationMode } : {}),
      updatedAt,
    });
    logger.info(
      `[project-import-card] ${cardPosted ? 'posted' : 'refreshed'} chat=${input.chatId} `
      + `root=${input.rootMessageId} message=${messageId} source_app=${input.sourceLarkAppId} `
      + `source_session=${input.sourceSessionId} routeRevision=${routeRevision} status=${evaluated.status}`
      + `${evaluated.status === 'pending' ? ` reason=${evaluated.reason}` : ''}`,
    );
    return {
      cardPosted,
      messageId,
      status: evaluated.status,
      ...(evaluated.status === 'pending' ? { reason: evaluated.reason } : {}),
      canConfirm: evaluated.status === 'pending' ? evaluated.canConfirm : false,
    };
  });
}

/**
 * Settle an existing pending topic card in place when `attach` completes via CLI
 * (either in a human turn or in the coordinator's notification turn).
 */
export async function settleProjectImportCardOnAttach(
  input: {
    dataDir?: string;
    coordinatorAppId: string;
    chatId: string;
    rootMessageId: string;
    sourceSessionId: string;
    sourceLarkAppId: string;
    routeRevision: number;
    workstreamTitle: string;
    confirmedByOpenId?: string;
    registrationMode: 'human_card' | 'human_turn' | 'coordinator_notice';
  },
  transportOverride?: Partial<ProjectImportCardTransport>,
): Promise<void> {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const transport = { ...defaultTransport(), ...transportOverride };
  return serializedCardOp(`${input.chatId}:${input.rootMessageId}`, async () => {
    const existing = readProjectImportCardRecord(dataDir, input.chatId, input.rootMessageId);
    if (existing && existing.coordinatorAppId !== input.coordinatorAppId) return;
    if (existing && existing.status === 'registered' && existing.workstreamTitle === input.workstreamTitle) return;
    const source = await getProjectAttachmentSource(input.sourceLarkAppId, input.sourceSessionId).catch(() => undefined);
    const botName = resolveSourceBotDisplayName(input.sourceLarkAppId, dataDir);
    const sourceKind = source?.source ?? existing?.sourceKind ?? 'relay';
    const card = buildProjectImportCard({
      state: 'registered',
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sourceSessionId: input.sourceSessionId,
      sourceLarkAppId: input.sourceLarkAppId,
      sourceBotName: botName,
      sourceKind,
      routeRevision: input.routeRevision,
      sessionTitle: source?.title,
      workstreamTitle: input.workstreamTitle,
      confirmedByOpenId: input.confirmedByOpenId,
      registrationMode: input.registrationMode,
    });
    const cardJson = JSON.stringify(card);
    let messageId = existing?.messageId;
    if (messageId) {
      try {
        await transport.updateCard(input.coordinatorAppId, messageId, cardJson);
      } catch (error) {
        if (!transport.isCardGone(error)) {
          logger.warn(
            `[project-import-card] settle update failed chat=${input.chatId} root=${input.rootMessageId} `
            + `message=${messageId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        messageId = undefined;
      }
    }
    if (!messageId) {
      try {
        messageId = await transport.replyCard(input.coordinatorAppId, input.rootMessageId, cardJson);
      } catch (error) {
        logger.warn(
          `[project-import-card] settle reply failed chat=${input.chatId} root=${input.rootMessageId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    writeProjectImportCardRecord(dataDir, {
      schemaVersion: 1,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      coordinatorAppId: input.coordinatorAppId,
      messageId,
      sourceSessionId: input.sourceSessionId,
      sourceLarkAppId: input.sourceLarkAppId,
      sourceKind,
      routeRevision: input.routeRevision,
      status: 'registered',
      reason: undefined,
      ...(existing?.proposedTitle ? { proposedTitle: existing.proposedTitle } : {}),
      ...(existing?.proposedPurpose ? { proposedPurpose: existing.proposedPurpose } : {}),
      workstreamTitle: input.workstreamTitle,
      confirmedByOpenId: input.confirmedByOpenId,
      registrationMode: input.registrationMode,
      updatedAt: new Date().toISOString(),
    });
    logger.info(
      `[project-import-card] settled chat=${input.chatId} root=${input.rootMessageId} `
      + `message=${messageId} mode=${input.registrationMode}`,
    );
  });
}

/**
 * Refresh the visible topic migration card when a workstream is renamed via
 * `botmux project workstream rename` so the topic card and pinned board stay in sync.
 */
export async function refreshProjectImportCardOnRename(
  input: {
    dataDir?: string;
    coordinatorAppId: string;
    chatId: string;
    rootMessageId: string;
    workstreamTitle: string;
  },
  transportOverride?: Partial<ProjectImportCardTransport>,
): Promise<void> {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const transport = { ...defaultTransport(), ...transportOverride };
  return serializedCardOp(`${input.chatId}:${input.rootMessageId}`, async () => {
    const existing = readProjectImportCardRecord(dataDir, input.chatId, input.rootMessageId);
    const attachment = readProjectAttachmentRecord(dataDir, input.chatId, input.rootMessageId);
    const sourceSessionId = attachment?.source.sessionId ?? existing?.sourceSessionId;
    const sourceLarkAppId = attachment?.source.larkAppId ?? existing?.sourceLarkAppId;
    const routeRevision = attachment?.source.routeRevision ?? existing?.routeRevision;
    if (!existing && !attachment) return;
    if (existing && existing.coordinatorAppId !== input.coordinatorAppId) return;
    if (!sourceSessionId || !sourceLarkAppId || !routeRevision) return;
    if (existing && existing.status === 'registered' && existing.workstreamTitle === input.workstreamTitle) return;
    const source = await getProjectAttachmentSource(sourceLarkAppId, sourceSessionId).catch(() => undefined);
    const botName = resolveSourceBotDisplayName(sourceLarkAppId, dataDir);
    const sourceKind = source?.source ?? attachment?.source.source ?? existing?.sourceKind ?? 'relay';
    const card = buildProjectImportCard({
      state: 'registered',
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      sourceSessionId,
      sourceLarkAppId,
      sourceBotName: botName,
      sourceKind,
      routeRevision,
      sessionTitle: source?.title,
      workstreamTitle: input.workstreamTitle,
      confirmedByOpenId: existing?.confirmedByOpenId,
      registrationMode: existing?.registrationMode,
    });
    const cardJson = JSON.stringify(card);
    let messageId = existing?.messageId;
    if (messageId) {
      try {
        await transport.updateCard(input.coordinatorAppId, messageId, cardJson);
      } catch (error) {
        if (!transport.isCardGone(error)) {
          logger.warn(
            `[project-import-card] rename update failed chat=${input.chatId} root=${input.rootMessageId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        messageId = undefined;
      }
    }
    if (!messageId) {
      try {
        messageId = await transport.replyCard(input.coordinatorAppId, input.rootMessageId, cardJson);
      } catch {
        return;
      }
    }
    writeProjectImportCardRecord(dataDir, {
      schemaVersion: 1,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      coordinatorAppId: input.coordinatorAppId,
      messageId,
      sourceSessionId,
      sourceLarkAppId,
      sourceKind,
      routeRevision,
      status: 'registered',
      ...(existing?.proposedTitle ? { proposedTitle: existing.proposedTitle } : {}),
      ...(existing?.proposedPurpose ? { proposedPurpose: existing.proposedPurpose } : {}),
      workstreamTitle: input.workstreamTitle,
      ...(existing?.confirmedByOpenId ? { confirmedByOpenId: existing.confirmedByOpenId } : {}),
      ...(existing?.registrationMode ? { registrationMode: existing.registrationMode } : {}),
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * Refresh any pending topic import cards in `chatId` (for example right after
 * `botmux project init` initializes a previously uninitialized project group).
 */
export async function refreshProjectImportCardsForChat(
  input: {
    dataDir?: string;
    coordinatorAppId: string;
    chatId: string;
  },
  transportOverride?: Partial<ProjectImportCardTransport>,
): Promise<number> {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const dir = join(dataDir, '.dashboard-secret.project-imports', 'cards');
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
  } catch {
    return 0;
  }
  let refreshed = 0;
  for (const name of names) {
    let parsed: ProjectImportCardRecord | undefined;
    try {
      const raw = readSecureHostFileSync(join(dir, name), 16 * 1024);
      parsed = raw ? JSON.parse(raw) as ProjectImportCardRecord : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.chatId !== input.chatId || parsed.coordinatorAppId !== input.coordinatorAppId) continue;
    try {
      await publishOrRefreshProjectImportCard({
        dataDir,
        coordinatorAppId: input.coordinatorAppId,
        chatId: input.chatId,
        rootMessageId: parsed.rootMessageId,
        sourceSessionId: parsed.sourceSessionId,
        sourceLarkAppId: parsed.sourceLarkAppId,
        sourceKindFallback: parsed.sourceKind,
        routeRevisionFallback: parsed.routeRevision,
        proposedTitle: parsed.proposedTitle,
        proposedPurpose: parsed.proposedPurpose,
        forceRefresh: true,
      }, transportOverride);
      refreshed++;
    } catch (error) {
      logger.warn(
        `[project-import-card] chat refresh failed chat=${input.chatId} root=${parsed.rootMessageId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return refreshed;
}

function isKnownBotClicker(dataDir: string, appId: string, openId: string, unionId: string): boolean {
  if (isTeamBot(dataDir, unionId) || isPlatformTeamBot(dataDir, unionId)) return true;
  const cached = getIdentity(appId, openId);
  return cached?.type === 'bot' || cached?.type === 'app';
}

/**
 * Handle Feishu callback clicks on `project_import_*` buttons.
 * Identity is strictly derived from `resolveCardOperatorUnionId(data, larkAppId)`, never `action.value`.
 */
export async function handleProjectImportCardAction(
  data: CardActionData,
  larkAppId: string,
  transportOverride?: Partial<ProjectImportCardTransport>,
): Promise<Record<string, unknown>> {
  const dataDir = config.session.dataDir;
  const transport = { ...defaultTransport(), ...transportOverride };
  const value = (data.action?.value ?? {}) as Record<string, unknown>;
  const action = typeof value.action === 'string' ? value.action : '';
  const chatId = typeof value.chat_id === 'string' ? value.chat_id : '';
  const rootMessageId = typeof value.root_id === 'string' ? value.root_id : '';
  const sourceLarkAppId = typeof value.source_app === 'string' ? value.source_app : '';
  const sourceSessionId = typeof value.source_session === 'string' ? value.source_session : '';
  const expectedRouteRev = typeof value.route_rev === 'string' && /^[1-9]\d{0,9}$/u.test(value.route_rev)
    ? Number(value.route_rev)
    : undefined;

  if (action !== PROJECT_IMPORT_CONFIRM_ACTION
    || !CHAT_ID_RE.test(chatId)
    || !ROOT_ID_RE.test(rootMessageId)
    || !APP_ID_RE.test(sourceLarkAppId)
    || !sourceSessionId || sourceSessionId.length > 256
    || expectedRouteRev === undefined
    || (typeof data.context?.open_chat_id === 'string' && data.context.open_chat_id !== chatId)) {
    return { toast: { type: 'error', content: '无效的迁入确认卡片请求' } };
  }

  const operator = await transport.resolveOperator(data, larkAppId);
  const audit = (outcome: string, extra = '') => {
    logger.info(
      `[project-import-card] action=${action} outcome=${outcome} chat=${chatId} root=${rootMessageId} `
      + `source_app=${sourceLarkAppId} source_session=${sourceSessionId} routeRevision=${expectedRouteRev} `
      + `operator_union=${operator.unionId ?? 'unverified'} operator_open=${operator.openId ?? 'none'}${extra} `
      + `at=${new Date().toISOString()}`,
    );
  };

  if (!operator.openId || !operator.unionId) {
    audit('denied_identity_unverified');
    return { toast: { type: 'error', content: '无法核验点击人的飞书身份（缺少 union_id），请稍后重试' } };
  }
  const { openId, unionId } = operator;
  if (isKnownBotClicker(dataDir, larkAppId, openId, unionId)) {
    audit('denied_actor_nonhuman');
    return { toast: { type: 'error', content: '仅真人本人可点击确认登记' } };
  }
  if (!canHumanOperateBot(larkAppId, openId)) {
    audit('denied_coordinator_operator');
    return { toast: { type: 'error', content: '无权操作当前项目主控 Bot' } };
  }

  return serializedCardOp(`${chatId}:${rootMessageId}`, async () => {
    const mode = readGroupCollaborationMode(dataDir, chatId);
    const project = readProjectGroup(dataDir, chatId);
    if (mode?.mode !== 'project' || mode.coordinatorAppId !== larkAppId
      || !project || project.larkAppId !== larkAppId
      || !(mode.workerAppIds ?? []).includes(sourceLarkAppId)) {
      audit('denied_project_policy_changed');
      return {
        toast: { type: 'warning', content: '当前群已不在项目模式或执行者不在白名单中' },
        card: { type: 'raw', data: buildProjectImportCard({ state: 'gone' }) },
      };
    }

    const coordSession = transport.findCoordinatorSession(project.coordinatorSessionId);
    if (!coordSession || coordSession.status !== 'active'
      || coordSession.scope !== 'chat' || coordSession.chatId !== chatId
      || coordSession.vcMeetingReceiver) {
      audit('denied_coordinator_unavailable');
      return { toast: { type: 'error', content: '当前项目主控会话不在线，请先在群里 @主控 唤醒后再试' } };
    }

    const coordinatorOwnerKey = await projectSessionOwnerKey({
      larkAppId,
      ownerOpenId: coordSession.ownerOpenId,
      ownerUnionId: coordSession.ownerUnionId,
    });
    const operatorOwnerKey = `union:${unionId}`;
    if (!coordinatorOwnerKey || coordinatorOwnerKey !== operatorOwnerKey) {
      audit('denied_not_coordinator_owner');
      return { toast: { type: 'error', content: '仅当前项目主控会话的本人可确认登记' } };
    }

    const clickedMessageId = data.context?.open_message_id ?? data.open_message_id;
    const storedRecord = readProjectImportCardRecord(dataDir, chatId, rootMessageId);
    const botName = resolveSourceBotDisplayName(sourceLarkAppId, dataDir);

    const existingAttachment = readProjectAttachmentRecord(dataDir, chatId, rootMessageId);
    if (existingAttachment?.phase === 'active'
      && existingAttachment.state === 'active'
      && existingAttachment.source.sessionId === sourceSessionId
      && existingAttachment.source.larkAppId === sourceLarkAppId
      && existingAttachment.source.routeRevision === expectedRouteRev) {
      audit('already_attached');
      const sourceNow = await getProjectAttachmentSource(sourceLarkAppId, sourceSessionId).catch(() => undefined);
      const settled = buildProjectImportCard({
        state: 'registered',
        chatId,
        rootMessageId,
        sourceSessionId,
        sourceLarkAppId,
        sourceBotName: botName,
        sourceKind: sourceNow?.source ?? existingAttachment.source.source,
        routeRevision: expectedRouteRev,
        sessionTitle: sourceNow?.title,
        workstreamTitle: existingAttachment.title,
        confirmedByOpenId: storedRecord?.confirmedByOpenId ?? openId,
        registrationMode: storedRecord?.registrationMode ?? 'human_card',
      });
      return {
        toast: { type: 'info', content: '该迁入会话已登记在项目看板中' },
        card: { type: 'raw', data: settled },
      };
    }

    let source = await getProjectAttachmentSource(sourceLarkAppId, sourceSessionId);
    if (!source || source.status !== 'active' || source.chatId !== chatId
      || source.rootMessageId !== rootMessageId || source.scope !== 'thread'
      || !source.ordinary || source.routeRevision !== expectedRouteRev) {
      audit('stale_source_route');
      const staleCard = buildProjectImportCard({
        state: 'pending',
        chatId,
        rootMessageId,
        sourceSessionId,
        sourceLarkAppId,
        sourceBotName: botName,
        sourceKind: source?.source ?? storedRecord?.sourceKind ?? 'relay',
        routeRevision: source?.routeRevision ?? expectedRouteRev,
        sessionTitle: source?.title,
        reason: 'source_unavailable',
        canConfirm: false,
      });
      return {
        toast: { type: 'warning', content: '源会话已关闭或路由代次已变更，无法按旧卡片登记' },
        card: { type: 'raw', data: staleCard },
      };
    }

    if (!source.ownerKey) {
      const claimResult = await claimOwnerlessProjectSource({
        sourceLarkAppId,
        sourceSessionId,
        chatId,
        rootMessageId,
        expectedRouteRevision: expectedRouteRev,
        claimantUnionId: unionId,
        claimantLarkAppId: larkAppId,
        claimantOpenId: openId,
        via: 'topic_card_confirm',
      });
      if (!claimResult.ok) {
        audit(`claim_failed_${claimResult.error}`);
        const hint = projectWorkstreamErrorHint(claimResult.error);
        return {
          toast: { type: 'error', content: hint ?? `无主会话认领失败：${claimResult.error}` },
        };
      }
      source = claimResult.source;
    }

    if (source.ownerKey !== coordinatorOwnerKey) {
      audit('denied_source_owner_mismatch');
      const mismatchCard = buildProjectImportCard({
        state: 'pending',
        chatId,
        rootMessageId,
        sourceSessionId,
        sourceLarkAppId,
        sourceBotName: botName,
        sourceKind: source.source,
        routeRevision: source.routeRevision,
        sessionTitle: source.title,
        reason: 'source_owner_authorization_required',
        canConfirm: false,
      });
      return {
        toast: {
          type: 'error',
          content: projectWorkstreamErrorHint('source_owner_authorization_required') ?? '源会话归属其他成员，无法直接登记',
        },
        card: { type: 'raw', data: mismatchCard },
      };
    }

    const existingWorkstream = project.workstreams.find(w => w.dispatchRoot === rootMessageId);
    const cardTitleHint = typeof value.title === 'string' ? value.title : undefined;
    const title = deriveImportWorkstreamTitle({
      proposedTitle: storedRecord?.proposedTitle ?? cardTitleHint,
      existingTitle: existingWorkstream?.title,
      sourceTitle: source.title,
      botName,
      sessionId: sourceSessionId,
    });
    const coordinatorSnapshot = () => {
      const latest = transport.findCoordinatorSession(project.coordinatorSessionId);
      return latest ? JSON.stringify([latest.sessionId, latest.status, latest.ownerOpenId, latest.ownerUnionId]) : '';
    };
    const admittedCoordinatorSnapshot = coordinatorSnapshot();
    const actor = markHostCardCallbackActor({
      sessionId: coordSession.sessionId,
      larkAppId,
      chatId,
      scope: 'chat',
      ownerKey: coordinatorOwnerKey,
      authorizationStillValid: () => coordinatorSnapshot() === admittedCoordinatorSnapshot
        && canHumanOperateBot(larkAppId, openId),
    });
    const needsRevisionCas = !!existingAttachment && (
      existingAttachment.source.sessionId !== sourceSessionId
      || existingAttachment.source.larkAppId !== sourceLarkAppId
      || existingAttachment.source.routeRevision !== source.routeRevision
      || existingAttachment.source.ownerKey !== source.ownerKey
    );

    try {
      const attachResult = await projectWorkstreamAttachments.attach(actor, {
        sourceSessionId,
        sourceLarkAppId,
        rootMessageId,
        title,
        purpose: storedRecord?.proposedPurpose,
        ...(needsRevisionCas ? { expectedRevision: existingAttachment.revision } : {}),
      });
      if (!attachResult.registered) {
        audit(`attach_unregistered_${attachResult.error ?? 'unknown'}`);
        return {
          toast: { type: 'error', content: `登记项目看板失败：${attachResult.error ?? 'unknown'}` },
        };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      audit(`attach_error_${detail}`);
      return {
        toast: { type: 'error', content: projectWorkstreamErrorHint(detail) ?? `登记项目看板失败：${detail}` },
      };
    }

    await transport.onCardAttached?.(chatId, coordSession.sessionId).catch(() => undefined);

    const settledCard = buildProjectImportCard({
      state: 'registered',
      chatId,
      rootMessageId,
      sourceSessionId,
      sourceLarkAppId,
      sourceBotName: botName,
      sourceKind: source.source,
      routeRevision: source.routeRevision,
      sessionTitle: source.title,
      workstreamTitle: title,
      confirmedByOpenId: openId,
      registrationMode: 'human_card',
    });
    const recordMessageId = storedRecord?.messageId ?? clickedMessageId;
    if (recordMessageId) {
      writeProjectImportCardRecord(dataDir, {
        schemaVersion: 1,
        chatId,
        rootMessageId,
        coordinatorAppId: larkAppId,
        messageId: recordMessageId,
        sourceSessionId,
        sourceLarkAppId,
        sourceKind: source.source,
        routeRevision: source.routeRevision,
        status: 'registered',
        workstreamTitle: title,
        confirmedByOpenId: openId,
        registrationMode: 'human_card',
        ...(storedRecord?.proposedTitle ? { proposedTitle: storedRecord.proposedTitle } : {}),
        ...(storedRecord?.proposedPurpose ? { proposedPurpose: storedRecord.proposedPurpose } : {}),
        updatedAt: new Date().toISOString(),
      });
    }
    audit('attached', ` title=${JSON.stringify(title)}`);

    const otherMessageId = storedRecord?.messageId && clickedMessageId && storedRecord.messageId !== clickedMessageId
      ? storedRecord.messageId
      : undefined;
    return {
      toast: { type: 'success', content: '已确认并登记到项目看板' },
      card: { type: 'raw', data: settledCard },
      ...(otherMessageId ? {
        afterAck: () => transport.updateCard(larkAppId, otherMessageId, JSON.stringify(settledCard)).catch(err =>
          logger.warn(`[project-import-card] secondary card refresh failed (${otherMessageId}): ${err instanceof Error ? err.message : String(err)}`)),
      } : {}),
    };
  }).catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`[project-import-card] callback failed chat=${chatId} root=${rootMessageId}: ${detail}`);
    return { toast: { type: 'error', content: `处理确认登记失败：${detail}` } };
  });
}
