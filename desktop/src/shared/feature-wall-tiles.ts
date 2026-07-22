export type FeatureWallTileId =
  | 'tile-01'
  | 'tile-02'
  | 'tile-03'
  | 'tile-04'
  | 'tile-05'
  | 'tile-06'
  | 'tile-07'
  | 'tile-08'
  | 'tile-09'
  | 'tile-10'
  | 'tile-11'
  | 'tile-12'

type FeatureWallTileBase = {
  id: FeatureWallTileId
  title: string
  caption: string
  owner: string
}

export type FeatureWallTile =
  | (FeatureWallTileBase & {
      kind: 'media'
      gifPath: string
      posterPath: string
      recordedAtPath: string
    })
  | (FeatureWallTileBase & {
      kind: 'agent-status-mockup'
    })

export const FEATURE_WALL_MEDIA_TILE_IDS = [
  'tile-01',
  'tile-02',
  'tile-03',
  'tile-04',
  'tile-05',
  'tile-06',
  'tile-07',
  'tile-08',
  'tile-09',
  'tile-10',
  'tile-11',
  'tile-12'
] as const satisfies readonly FeatureWallTileId[]

export type FeatureWallMediaTileId = (typeof FEATURE_WALL_MEDIA_TILE_IDS)[number]

export type FeatureWallMediaTile = Extract<FeatureWallTile, { kind: 'media' }>

export function isFeatureWallMediaTile(tile: FeatureWallTile): tile is FeatureWallMediaTile {
  return tile.kind === 'media'
}

export const FEATURE_WALL_TILES: readonly FeatureWallTile[] = [
  {
    id: 'tile-01',
    kind: 'media',
    title: 'Parallel workspace orchestration',
    caption:
      'Give each task its own workspace - no stashing, no branch juggling. Fan work across agents, compare, and continue with the best result.',
    gifPath: 'tile-01.gif',
    posterPath: 'tile-01.poster.jpg',
    recordedAtPath: 'tile-01.recorded-at.json',
    owner: 'worktree-orchestration',
  },
  {
    id: 'tile-02',
    kind: 'media',
    title: 'Ghostty-class terminal',
    caption:
      'WebGL rendering, infinite splits, scrollback restored on restart, full scrollback search.',
    gifPath: 'tile-02.gif',
    posterPath: 'tile-02.poster.jpg',
    recordedAtPath: 'tile-02.recorded-at.json',
    owner: 'terminal',
  },
  {
    id: 'tile-03',
    kind: 'media',
    title: 'GitHub & Linear, native',
    caption:
      'Find connected GitHub or Linear work in Tasks, open its context, and start workspaces without switching tools.',
    gifPath: 'tile-03.gif',
    posterPath: 'tile-03.poster.jpg',
    recordedAtPath: 'tile-03.recorded-at.json',
    owner: 'task-integrations',
  },
  {
    id: 'tile-04',
    kind: 'media',
    title: 'Supported CLI agents',
    caption: 'Claude Code, Codex, Cursor CLI, Gemini, Copilot, OpenCode, and Pi are preconfigured.',
    gifPath: 'tile-04.gif',
    posterPath: 'tile-04.poster.jpg',
    recordedAtPath: 'tile-04.recorded-at.json',
    owner: 'agent-integrations',
  },
  {
    id: 'tile-05',
    kind: 'media',
    title: 'Embedded browser + Design Mode',
    caption:
      'A real Chromium window per workspace. Click any UI element to send its HTML, CSS, and a cropped screenshot into your agent.',
    gifPath: 'tile-05.gif',
    posterPath: 'tile-05.poster.jpg',
    recordedAtPath: 'tile-05.recorded-at.json',
    owner: 'browser-experience',
  },
  {
    id: 'tile-06',
    kind: 'media',
    title: 'Remote workspaces',
    caption:
      'Run agents on a remote machine with the same Botmux editing, git, and terminal workflow.',
    gifPath: 'tile-06.gif',
    posterPath: 'tile-06.poster.jpg',
    recordedAtPath: 'tile-06.recorded-at.json',
    owner: 'ssh-workspaces',
  },
  {
    id: 'tile-07',
    kind: 'media',
    title: 'Monaco editor, drag-to-agent',
    caption:
      "VS Code's editor, autosave everywhere, quick-open with hidden files, drag-drop files or Finder images into an agent prompt.",
    gifPath: 'tile-07.gif',
    posterPath: 'tile-07.poster.jpg',
    recordedAtPath: 'tile-07.recorded-at.json',
    owner: 'editor',
  },
  {
    id: 'tile-08',
    kind: 'media',
    title: 'Inline review, back to the agent',
    caption:
      'Drop markdown comments on any diff line, batch them, ship them back to the agent. Inspect CI, resolve conflicts, open PRs - all in-app.',
    gifPath: 'tile-08.gif',
    posterPath: 'tile-08.poster.jpg',
    recordedAtPath: 'tile-08.recorded-at.json',
    owner: 'diff-review',
  },
  {
    id: 'tile-09',
    kind: 'media',
    title: 'Botmux CLI',
    caption: 'Agents can drive Botmux too: create workspaces, snapshot screens, click, and fill.',
    gifPath: 'tile-09.gif',
    posterPath: 'tile-09.poster.jpg',
    recordedAtPath: 'tile-09.recorded-at.json',
    owner: 'botmux-cli',
  },
  {
    id: 'tile-10',
    kind: 'media',
    title: 'Keyboard-native',
    caption:
      'Jump across workspaces, open files, and remap every shortcut. Move at the speed of your fingers.',
    gifPath: 'tile-10.gif',
    posterPath: 'tile-10.poster.jpg',
    recordedAtPath: 'tile-10.recorded-at.json',
    owner: 'keyboard-ux',
  },
  {
    id: 'tile-11',
    kind: 'media',
    title: 'Usage & rate-limit aware',
    caption:
      'See Claude and Codex usage, rate-limit resets, and hot-swap Codex accounts without re-logging in.',
    gifPath: 'tile-11.gif',
    posterPath: 'tile-11.poster.jpg',
    recordedAtPath: 'tile-11.recorded-at.json',
    owner: 'usage-rate-limits',
  },
  {
    id: 'tile-12',
    kind: 'media',
    title: 'PDFs, images, CSV, Markdown',
    caption:
      'Preview everything your repo carries: PDFs, image diff modes, CSV tables, wiki-linked Markdown with search.',
    gifPath: 'tile-12.gif',
    posterPath: 'tile-12.poster.jpg',
    recordedAtPath: 'tile-12.recorded-at.json',
    owner: 'file-preview',
  }
] as const
