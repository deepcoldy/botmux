import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallMediaTile,
  type FeatureWallMediaTileId
} from './feature-wall-tiles'

export type FeatureWallWorkflowId =
  | 'tasks'
  | 'workspaces'
  | 'agents-orchestration'
  | 'workbench'
  | 'review'

export type FeatureWallWorkflow = {
  id: FeatureWallWorkflowId
  title: string
  meta: string
  lede: string
  primaryTileId: FeatureWallMediaTileId
  relatedTileIds: readonly FeatureWallMediaTileId[]
}

export const FEATURE_WALL_WORKFLOWS: readonly FeatureWallWorkflow[] = [
  {
    id: 'workspaces',
    title: 'Workspaces',
    meta: 'Isolated work · Context kept together',
    lede: 'Botmux splits each task into an isolated workspace so agents can run in parallel.',
    primaryTileId: 'tile-01',
    relatedTileIds: ['tile-10'],
  },
  {
    id: 'tasks',
    title: 'Tasks',
    meta: 'GitHub · Linear',
    lede: 'Start work directly from GitHub or Linear.',
    primaryTileId: 'tile-03',
    relatedTileIds: [],
  },
  {
    id: 'agents-orchestration',
    title: 'Agents',
    meta: 'Agents · Usage · Botmux CLI',
    lede: 'Run several agents at once, track their progress, and let automation drive Botmux when it helps.',
    primaryTileId: 'tile-04',
    relatedTileIds: ['tile-11', 'tile-09'],
  },
  {
    id: 'workbench',
    title: 'Workbench',
    meta: 'Terminal · Editor · Browser · Files',
    lede: 'Bring your terminal setup into Botmux, then split panes to keep servers, tests, logs, and agents running side by side.',
    primaryTileId: 'tile-02',
    relatedTileIds: ['tile-07', 'tile-05', 'tile-12'],
  },
  {
    id: 'review',
    title: 'Code Review',
    meta: 'Diffs · Comments · PRs',
    lede: 'Review what changed, leave focused feedback, and send it back to the agent.',
    primaryTileId: 'tile-08',
    relatedTileIds: [],
  }
] as const

export const FEATURE_WALL_WORKFLOW_IDS = FEATURE_WALL_WORKFLOWS.map(
  (w) => w.id
) as readonly FeatureWallWorkflowId[]

const TILE_BY_ID = new Map(
  FEATURE_WALL_TILES.filter(isFeatureWallMediaTile).map((tile) => [tile.id, tile])
)

export function getFeatureWallMediaTile(id: FeatureWallMediaTileId): FeatureWallMediaTile | null {
  return TILE_BY_ID.get(id) ?? null
}

export const DEFAULT_FEATURE_WALL_WORKFLOW_ID: FeatureWallWorkflowId = 'workspaces'
