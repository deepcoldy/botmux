/**
 * Slash-command discovery — enumerate the user-installed / project-local slash
 * commands, skills and plugins that the underlying CLI would surface, purely
 * by scanning the filesystem. Powers part ③ of the `/list-slash-command`
 * daemon command.
 *
 * Claude-family scope: the Claude `.claude/` layout —
 *   • custom commands:  <root>/.claude/commands/**\/*.md  → /name (subdir → ns:name)
 *   • skills:           <root>/.claude/skills/*\/SKILL.md  → /name
 *   • plugins:          <claudeHome>/plugins/cache/<mp>/<plugin>/[<ver>/]{commands,skills}
 * where <root> ∈ { workingDir (project), claudeHome (personal) } and
 * <claudeHome> = $CLAUDE_CONFIG_DIR || ~/.claude.
 *
 * Other CLIs are driven by their adapter's `skillsDir` / `pluginDir` fields
 * (e.g. Codex `~/.codex/skills`, CoCo/Trae `~/.trae/skills`, OpenCode
 * `~/.config/opencode/skills`).
 *
 * Intentionally dependency-free (no YAML / glob libs): a tiny frontmatter reader
 * and a bounded recursive walker keep this importable from the leaf-ish command
 * handler without pulling in the daemon graph.
 *
 * NOT covered: MCP-provided `/mcp__<server>__<prompt>` commands — enumerating
 * those needs a live MCP handshake. {@link listMcpServerNames} cheaply surfaces
 * the server *names* from `.mcp.json` so the caller can at least hint at them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type { CliAdapter } from '../adapters/cli/types.js';

export type DiscoveredSource =
  | 'project-command'
  | 'user-command'
  | 'project-skill'
  | 'user-skill'
  | 'plugin-command'
  | 'plugin-skill';

export interface DiscoveredCommand {
  /** Invocation form, e.g. '/deploy' or '/myplugin:foo'. */
  name: string;
  /** First-line description pulled from frontmatter, when present. */
  description?: string;
  source: DiscoveredSource;
  /** Human-friendly origin (relative-ish path or plugin id) for display. */
  origin: string;
}

export type CommandDiscoveryAdapter = Pick<CliAdapter, 'claudeDataDir' | 'skillsDir' | 'pluginDir'>;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve the Claude config/data root the CLI reads commands & skills from.
 *  Honors CLAUDE_CONFIG_DIR (set by claude-family forks); defaults to ~/.claude. */
function claudeHome(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  return env && env.length > 0 ? env : join(homedir(), '.claude');
}

/** Minimal frontmatter reader: pull `name:` / `description:` from a leading
 *  `---` … `---` block. No YAML dep — handles plain and quoted scalar values. */
function readFrontmatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*(name|description)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (m[1] === 'name') out.name = v;
    else out.description = v;
  }
  return out;
}

/** Recursively collect `*.md` files under `dir` (bounded depth, fail-soft). */
function walkMd(dir: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p, depth - 1));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Immediate subdirectories of `dir` (fail-soft). */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** `<commandsDir>/**\/*.md` → commands. Filename (minus .md) is the command;
 *  nested subdirs become `ns:sub:name` namespaces (Claude convention). */
function scanCommandsDir(
  commandsDir: string,
  source: DiscoveredSource,
  originPrefix: string,
): DiscoveredCommand[] {
  return walkMd(commandsDir).map((file) => {
    const rel = relative(commandsDir, file).replace(/\.md$/, '');
    const name = '/' + rel.split(sep).join(':');
    const fm = readFrontmatter(file);
    return { name, description: fm.description, source, origin: `${originPrefix}/${rel}.md` };
  });
}

/** `<skillsDir>/<name>/SKILL.md` → /name (optionally `ns:name` for plugins). */
function scanSkillsDir(
  skillsDir: string,
  source: DiscoveredSource,
  originPrefix: string,
  namePrefix = '',
): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  for (const d of listDirs(skillsDir)) {
    const skillMd = join(d, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const base = basename(d);
    const fm = readFrontmatter(skillMd);
    out.push({
      name: '/' + (namePrefix ? `${namePrefix}:${base}` : base),
      description: fm.description,
      source,
      origin: `${originPrefix}/${base}/SKILL.md`,
    });
  }
  return out;
}

/** Walk `<claudeRoot>/plugins/cache/<marketplace>/<plugin>/[<ver>/]{commands,skills}`.
 *  commands/skills may sit directly under the plugin or under a version subdir —
 *  we try both and let the caller's dedupe collapse any overlap. */
function scanPlugins(claudeRoot: string): DiscoveredCommand[] {
  const cacheRoot = join(claudeRoot, 'plugins', 'cache');
  const out: DiscoveredCommand[] = [];
  for (const mp of listDirs(cacheRoot)) {
    for (const plugin of listDirs(mp)) {
      const pluginId = basename(plugin);
      const originPrefix = `plugins/${basename(mp)}/${pluginId}`;
      const roots = [plugin, ...listDirs(plugin)];
      for (const root of roots) {
        for (const c of scanCommandsDir(join(root, 'commands'), 'plugin-command', originPrefix)) {
          // Re-namespace `/foo` → `/pluginId:foo`.
          out.push({ ...c, name: c.name.replace(/^\//, `/${pluginId}:`) });
        }
        out.push(...scanSkillsDir(join(root, 'skills'), 'plugin-skill', originPrefix, pluginId));
      }
    }
  }
  return out;
}

function pluginName(pluginDir: string): string {
  const manifest = join(pluginDir, '.claude-plugin', 'plugin.json');
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf-8'));
    if (typeof parsed?.name === 'string' && parsed.name.trim()) return parsed.name.trim();
  } catch {
    /* no plugin manifest — fall back to dirname */
  }
  return basename(pluginDir);
}

function dedupeAndSort(found: DiscoveredCommand[]): DiscoveredCommand[] {
  const seen = new Set<string>();
  const deduped: DiscoveredCommand[] = [];
  for (const c of found) {
    const key = c.name; // dedupe by name across sources (fixes duplicate cmds)
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  deduped.sort((a, b) => a.name.localeCompare(b.name));
  return deduped;
}

/**
 * Discover all filesystem-visible slash commands for a session's working dir.
 * Personal (`~/.claude`) + project (`<workingDir>/.claude`) + plugins, deduped
 * by (name, source) and sorted by name. Safe to call on any CLI: non-Claude
 * layouts simply yield nothing.
 */
export function discoverSlashCommands(workingDir: string): DiscoveredCommand[] {
  const home = claudeHome();
  const found: DiscoveredCommand[] = [];

  // Personal (global) layer.
  found.push(...scanCommandsDir(join(home, 'commands'), 'user-command', '~/.claude/commands'));
  found.push(...scanSkillsDir(join(home, 'skills'), 'user-skill', '~/.claude/skills'));
  found.push(...scanPlugins(home));

  // Project layer.
  if (workingDir) {
    const proj = join(workingDir, '.claude');
    found.push(...scanCommandsDir(join(proj, 'commands'), 'project-command', '.claude/commands'));
    found.push(...scanSkillsDir(join(proj, 'skills'), 'project-skill', '.claude/skills'));
  }

  return dedupeAndSort(found);
}

export function supportsFilesystemCommandDiscovery(adapter: CommandDiscoveryAdapter | undefined): boolean {
  return !!(adapter?.claudeDataDir || adapter?.skillsDir || adapter?.pluginDir);
}

/**
 * Discover filesystem-visible commands for the concrete CLI adapter.
 * Claude-family adapters scan their data root plus project `.claude`; all
 * other adapters scan only the roots they explicitly advertise.
 */
export function discoverSlashCommandsForAdapter(
  workingDir: string,
  adapter: CommandDiscoveryAdapter,
): DiscoveredCommand[] {
  const found: DiscoveredCommand[] = [];

  if (adapter.claudeDataDir) {
    const rawHome = adapter.claudeDataDir;
    const home = expandHome(rawHome);
    found.push(...scanCommandsDir(join(home, 'commands'), 'user-command', `${rawHome}/commands`));
    found.push(...scanSkillsDir(join(home, 'skills'), 'user-skill', `${rawHome}/skills`));
    found.push(...scanPlugins(home));

    if (workingDir) {
      const proj = join(workingDir, '.claude');
      found.push(...scanCommandsDir(join(proj, 'commands'), 'project-command', '.claude/commands'));
      found.push(...scanSkillsDir(join(proj, 'skills'), 'project-skill', '.claude/skills'));
    }
  }

  if (adapter.skillsDir) {
    found.push(...scanSkillsDir(expandHome(adapter.skillsDir), 'user-skill', adapter.skillsDir));
  }

  if (adapter.pluginDir) {
    const root = expandHome(adapter.pluginDir);
    found.push(...scanSkillsDir(join(root, 'skills'), 'plugin-skill', `${adapter.pluginDir}/skills`, pluginName(root)));
    for (const c of scanCommandsDir(join(root, 'commands'), 'plugin-command', `${adapter.pluginDir}/commands`)) {
      found.push({ ...c, name: c.name.replace(/^\//, `/${pluginName(root)}:`) });
    }
  }

  return dedupeAndSort(found);
}

/**
 * Cheaply surface MCP *server* names from `<workingDir>/.mcp.json` (the standard
 * project-level MCP config). The actual `/mcp__<server>__<prompt>` commands need
 * a live handshake to enumerate and are out of scope here — this is just a hint.
 */
export function listMcpServerNames(workingDir: string): string[] {
  if (!workingDir) return [];
  const file = join(workingDir, '.mcp.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      return Object.keys(servers);
    }
  } catch {
    /* malformed .mcp.json — ignore */
  }
  return [];
}
