/**
 * The Dashboard's view of the Saved Workflow library (design 2026-11-03
 * workflow-dashboard-orchestration §5.3, D5): the list (`#/workflows/library`)
 * and one template's detail with its version history. Read-only, from disk —
 * the Dashboard does not ask any daemon to look (§7.2: a Dashboard admin sees
 * every template; chat-scoped ones are labelled and not runnable here, I9).
 *
 * The template owner (who saves versions) and each run's initiator (who
 * clicked 「运行」) are different people: only the owner is here; runs carry
 * their own initiator.
 */

import {
  compareSavedWorkflowGates,
  savedWorkflowGatePositions,
  type LoadedSavedWorkflowRevision,
  type SavedWorkflowBotChange,
  type SavedWorkflowGateComparisonAgainst,
  type SavedWorkflowMetadata,
  type SavedWorkflowParamDef,
  type V3DagTemplate,
  type V3SpecTemplate,
} from './library-schema.js';
import {
  SavedWorkflowNotFoundError,
  listSavedWorkflowCatalog,
  listSavedWorkflowRevisions,
  readSavedWorkflowMetadata,
} from './library-store.js';

/** Where a revision came from, as the history shows it. */
export type SavedWorkflowRevisionSource = 'feishu' | 'dashboard_run' | 'dashboard_draft';

export interface SavedWorkflowCatalogEntry {
  workflowId: string;
  displayName: string;
  /** The orchestrating bot: the app the template belongs to. */
  orchestratorAppId: string;
  ownerOpenId: string;
  scope: SavedWorkflowMetadata['scope'];
  status: SavedWorkflowMetadata['status'];
  /** When the newest version was saved. */
  latestAt: string;
  latestHumanVersion: number;
  publishedHumanVersion?: number;
  /** Counted on the version 「运行」 uses (the published one, else the newest). */
  paramCount: number;
  nodeCount: number;
  gateCount: number;
  /** Global and published: the Dashboard offers 「运行」 (I9). */
  runnable: boolean;
  /** The version that would run was saved from a draft (never ran yet). */
  savedFromDraft: boolean;
}

export interface SavedWorkflowVersionView {
  revisionId: string;
  humanVersion: number;
  createdAt: string;
  createdByOpenId: string;
  published: boolean;
  latest: boolean;
  source: SavedWorkflowRevisionSource;
  sourceRunId?: string;
  draftRunId?: string;
  paramCount: number;
  nodeCount: number;
  gateCount: number;
  /** Against the previous version, and against the published version when
   *  this one is newer and the published one is not the previous (I10). */
  gateComparisons: SavedWorkflowGateComparisonAgainst[];
  botChanges?: SavedWorkflowBotChange[];
  runtimeRevisions?: number;
  confirmation?: { confirmedByOpenId: string; confirmedAt: string; flowSummarySha256: string };
}

export interface SavedWorkflowDetailView {
  entry: SavedWorkflowCatalogEntry;
  /** The version 「运行」 uses (published, else the newest for display). */
  current: {
    revisionId: string;
    humanVersion: number;
    published: boolean;
    inputs: Record<string, SavedWorkflowParamDef>;
    dagTemplate: V3DagTemplate;
    specTemplate: Pick<V3SpecTemplate, 'title' | 'requirement'>;
    specStatus: 'current' | 'stale';
  };
  versions: SavedWorkflowVersionView[];
}

function nodeCount(dag: V3DagTemplate): number {
  return dag.nodes.reduce((count, node) => count + 1 + (node.type === 'loop' && node.body ? node.body.nodes.length : 0), 0);
}

function sourceOf(revision: LoadedSavedWorkflowRevision): SavedWorkflowRevisionSource {
  return revision.payload.provenance?.kind ?? 'feishu';
}

function entryOf(metadata: SavedWorkflowMetadata, shown: LoadedSavedWorkflowRevision, latest: LoadedSavedWorkflowRevision, published?: LoadedSavedWorkflowRevision): SavedWorkflowCatalogEntry {
  return {
    workflowId: metadata.workflowId,
    displayName: metadata.displayName,
    orchestratorAppId: metadata.owner.larkAppId,
    ownerOpenId: metadata.owner.openId,
    scope: metadata.scope,
    status: metadata.status,
    latestAt: latest.payload.createdAt,
    latestHumanVersion: latest.payload.humanVersion,
    ...(published ? { publishedHumanVersion: published.payload.humanVersion } : {}),
    paramCount: Object.keys(shown.payload.inputs).length,
    nodeCount: nodeCount(shown.payload.dagTemplate),
    gateCount: savedWorkflowGatePositions(shown.payload.dagTemplate).length,
    runnable: metadata.scope.kind === 'global' && metadata.status === 'active' && !!published,
    savedFromDraft: shown.payload.provenance?.kind === 'dashboard_draft',
  };
}

async function loadAll(dataDir: string, metadata: SavedWorkflowMetadata): Promise<{
  revisions: LoadedSavedWorkflowRevision[];
  latest: LoadedSavedWorkflowRevision;
  published?: LoadedSavedWorkflowRevision;
}> {
  const revisions = await listSavedWorkflowRevisions(dataDir, metadata.workflowId);
  const latest = revisions.find((revision) => revision.revisionId === metadata.latestRevision);
  if (!latest) throw new SavedWorkflowNotFoundError(`${metadata.workflowId}@${metadata.latestRevision}`);
  const published = metadata.publishedRevision
    ? revisions.find((revision) => revision.revisionId === metadata.publishedRevision)
    : undefined;
  return { revisions, latest, ...(published ? { published } : {}) };
}

/** Every template on this machine (all bots), name order. A template whose
 *  files cannot be read is left out (and counted). */
export async function listSavedWorkflowCatalogView(dataDir: string): Promise<{ entries: SavedWorkflowCatalogEntry[]; unreadable: number }> {
  const listed = await listSavedWorkflowCatalog(dataDir);
  const entries: SavedWorkflowCatalogEntry[] = [];
  let unreadable = listed.invalid.length;
  for (const metadata of listed.entries) {
    try {
      const { latest, published } = await loadAll(dataDir, metadata);
      entries.push(entryOf(metadata, published ?? latest, latest, published));
    } catch {
      unreadable += 1;
    }
  }
  return { entries, unreadable };
}

/** One template, its current version and every version with the change in
 *  human gates against the one before it (I10). Archived → not found. */
export async function loadSavedWorkflowDetailView(dataDir: string, workflowId: string): Promise<SavedWorkflowDetailView> {
  const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
  if (metadata.status === 'archived') throw new SavedWorkflowNotFoundError(workflowId);
  const { revisions, latest, published } = await loadAll(dataDir, metadata);
  const shown = published ?? latest;
  const versions = revisions.map((revision, index): SavedWorkflowVersionView => {
    const previous = index > 0 ? revisions[index - 1] : undefined;
    const provenance = revision.payload.provenance;
    return {
      revisionId: revision.revisionId,
      humanVersion: revision.payload.humanVersion,
      createdAt: revision.payload.createdAt,
      createdByOpenId: revision.payload.createdBy.openId,
      published: revision.revisionId === metadata.publishedRevision,
      latest: revision.revisionId === metadata.latestRevision,
      source: sourceOf(revision),
      ...(revision.payload.sourceRunId ? { sourceRunId: revision.payload.sourceRunId } : {}),
      ...(provenance?.kind === 'dashboard_draft' ? { draftRunId: provenance.draftRunId } : {}),
      paramCount: Object.keys(revision.payload.inputs).length,
      nodeCount: nodeCount(revision.payload.dagTemplate),
      gateCount: savedWorkflowGatePositions(revision.payload.dagTemplate).length,
      gateComparisons: [
        ...(previous ? [{
          base: { kind: 'previous' as const, humanVersion: previous.payload.humanVersion, revisionId: previous.revisionId },
          gates: compareSavedWorkflowGates(previous.payload.dagTemplate, revision.payload.dagTemplate),
        }] : []),
        ...(published && published !== previous && published.payload.humanVersion < revision.payload.humanVersion ? [{
          base: { kind: 'published' as const, humanVersion: published.payload.humanVersion, revisionId: published.revisionId },
          gates: compareSavedWorkflowGates(published.payload.dagTemplate, revision.payload.dagTemplate),
        }] : []),
      ],
      ...(provenance?.kind === 'dashboard_run' ? { botChanges: provenance.botChanges, runtimeRevisions: provenance.runtimeRevisions } : {}),
      ...(provenance?.kind === 'dashboard_draft' ? { confirmation: {
        confirmedByOpenId: provenance.confirmation.confirmedByOpenId,
        confirmedAt: provenance.confirmation.confirmedAt,
        flowSummarySha256: provenance.confirmation.flowSummarySha256,
      } } : {}),
    };
  });
  return {
    entry: entryOf(metadata, shown, latest, published),
    current: {
      revisionId: shown.revisionId,
      humanVersion: shown.payload.humanVersion,
      published: shown === published,
      inputs: shown.payload.inputs,
      dagTemplate: shown.payload.dagTemplate,
      specTemplate: { title: shown.payload.specTemplate.title, requirement: shown.payload.specTemplate.requirement },
      specStatus: shown.payload.specStatus,
    },
    versions: versions.reverse(),
  };
}
