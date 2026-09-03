/**
 * `botmux customize` — CLI surface for the built-in prompt/skill customization
 * feature (see services/customization-store.ts + skills/effective-builtins.ts).
 *
 * Returns a { code, stdout, stderr } result like the other admin commands so
 * cli.ts can print + set the exit code uniformly. Human-readable lines go to
 * stdout; errors to stderr with a non-zero code.
 *
 * Subcommands:
 *   status                               show master flag + counts
 *   enable | disable                     master switch
 *   prompt list [--locale zh|en]         list overridable fragments + modified state
 *   prompt show <key> [--locale]         current effective text + factory text
 *   prompt set <key> <value> [--locale]  override a fragment (stdin if value omitted)
 *   prompt reset <key> [--locale]        clear one override
 *   condition <key> on|off|reset         force a gated line
 *   skill list                           built-in skills + override/disabled state
 *   skill show <name>                    effective SKILL.md body
 *   skill set <name> [<file>]            override body (from file or stdin)
 *   skill reset <name>                   clear body override
 *   skill disable|enable <name>          toggle injection
 *   reset-all                            wipe all overrides (snapshotted, reversible)
 *   history [--limit N]                  list snapshots
 *   rollback <snapshotId>                restore a snapshot (non-destructive)
 *   export [--name <n>] [--out <file>]   write a portable bundle
 *   import <file|-> [--yes]              preview a bundle diff; apply with --yes
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Locale } from '../../i18n/types.js';
import { SUPPORTED_LOCALES } from '../../i18n/types.js';
import { t, shippedText } from '../../i18n/index.js';
import {
  readCustomizationState,
  customizationEnabled,
  setCustomizationEnabled,
  setPromptOverride,
  setConditionalLine,
  setSkillOverrideBody,
  setSkillDisabled,
  readSkillOverrideBody,
  resetAllToFactory,
  rollbackToSnapshot,
  listSnapshots,
} from '../../services/customization-store.js';
import {
  PROMPT_FRAGMENTS,
  getFragmentSpec,
  validateFragmentOverride,
} from '../../skills/prompt-fragments.js';
import { BUILTIN_SKILLS } from '../../skills/definitions.js';
import { builtinSkillContent } from '../../skills/injection-mode.js';
import {
  exportBundle,
  parseBundle,
  previewBundleImport,
  applyBundle,
  serializeBundle,
  BundleError,
} from '../../skills/customization-bundle.js';

export interface CustomizeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function ok(stdout: string): CustomizeCommandResult { return { code: 0, stdout: stdout.endsWith('\n') ? stdout : stdout + '\n', stderr: '' }; }
function err(stderr: string, code = 1): CustomizeCommandResult { return { code, stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n' }; }

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean { return args.includes(name); }

function resolveLocale(args: string[]): Locale {
  const raw = argValue(args, '--locale');
  if (raw && (SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as Locale;
  return 'zh';
}

export function runCustomizeCommand(args: string[]): CustomizeCommandResult {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case undefined:
      case 'status': return cmdStatus();
      case 'enable': return cmdEnable(true);
      case 'disable': return cmdEnable(false);
      case 'prompt': return cmdPrompt(rest);
      case 'condition': return cmdCondition(rest);
      case 'skill': return cmdSkill(rest);
      case 'reset-all': return cmdResetAll();
      case 'history': return cmdHistory(rest);
      case 'rollback': return cmdRollback(rest);
      case 'export': return cmdExport(rest);
      case 'import': return cmdImport(rest);
      default: return err(`未知子命令：${sub}\n用法：botmux customize <status|enable|disable|prompt|condition|skill|reset-all|history|rollback|export|import>`, 2);
    }
  } catch (e: any) {
    return err(`错误：${e?.message ?? String(e)}`);
  }
}

function cmdStatus(): CustomizeCommandResult {
  const state = readCustomizationState();
  const promptCount = Object.values(state.promptOverrides ?? {}).reduce((n, m) => n + Object.keys(m ?? {}).length, 0);
  const condCount = Object.keys(state.conditionalLines ?? {}).length;
  const skillOverrides = Object.values(state.builtinSkills ?? {}).filter((s) => s.body !== undefined).length;
  const skillDisabled = Object.values(state.builtinSkills ?? {}).filter((s) => s.disabled).length;
  const lines = [
    `自定义：${customizationEnabled() ? '已启用' : '已停用（所有覆盖不生效）'}`,
    `prompt 片段覆盖：${promptCount}`,
    `条件行覆盖：${condCount}`,
    `skill 正文覆盖：${skillOverrides}`,
    `skill 停用：${skillDisabled}`,
    `历史快照：${listSnapshots().length}`,
  ];
  return ok(lines.join('\n'));
}

function cmdEnable(enabled: boolean): CustomizeCommandResult {
  setCustomizationEnabled(enabled);
  return ok(enabled ? '自定义已启用' : '自定义已停用（覆盖保留，不生效）');
}

function cmdPrompt(args: string[]): CustomizeCommandResult {
  const [action, ...rest] = args;
  const locale = resolveLocale(rest);
  const state = readCustomizationState();
  switch (action) {
    case undefined:
    case 'list': {
      const lines = PROMPT_FRAGMENTS.map((f) => {
        const ov = state.promptOverrides?.[locale]?.[f.key];
        const cond = f.kind === 'conditional' ? (state.conditionalLines?.[f.key]) : undefined;
        const tags: string[] = [];
        if (ov !== undefined) tags.push('已改');
        if (f.kind === 'placeholder') tags.push(`占位符:${(f.placeholders ?? []).join(',')}`);
        if (f.kind === 'conditional') tags.push(cond === undefined ? '条件行:跟随默认' : `条件行:强制${cond ? '开' : '关'}`);
        const tag = tags.length ? `  [${tags.join(' ')}]` : '';
        return `${f.key}\t(${f.block}) ${f.label}${tag}`;
      });
      return ok(`# prompt 片段（locale=${locale}）\n` + lines.join('\n'));
    }
    case 'show': {
      const key = rest[0];
      if (!key) return err('用法：botmux customize prompt show <key> [--locale zh|en]', 2);
      const spec = getFragmentSpec(key);
      const ov = state.promptOverrides?.[locale]?.[key];
      const effective = t(key, undefined, locale);
      const shipped = shippedText(key, locale);
      const lines = [
        `key: ${key}`,
        spec ? `block: ${spec.block}  label: ${spec.label}  kind: ${spec.kind}` : 'block: (未在目录中，仍可覆盖)',
      ];
      if (ov !== undefined) {
        lines.push('--- 你的覆盖（当前生效） ---', effective, '--- 出厂默认 ---', shipped);
      } else {
        lines.push('--- 出厂默认（当前生效，未覆盖） ---', shipped);
      }
      return ok(lines.join('\n'));
    }
    case 'set': {
      const key = rest[0];
      if (!key) return err('用法：botmux customize prompt set <key> <value> [--locale zh|en]（value 省略则从 stdin 读取）', 2);
      // Value = 2nd positional, or stdin when omitted.
      let value = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      if (value === undefined) value = readStdin();
      if (value === undefined || value === '') return err('未提供覆盖内容（位置参数或 stdin）', 2);
      const vErr = validateFragmentOverride(key, value);
      if (vErr) return err(vErr, 2);
      setPromptOverride(locale, key, value);
      return ok(`已覆盖 ${key} (${locale})`);
    }
    case 'reset': {
      const key = rest[0];
      if (!key) return err('用法：botmux customize prompt reset <key> [--locale zh|en]', 2);
      setPromptOverride(locale, key, null);
      return ok(`已恢复 ${key} (${locale}) 为出厂`);
    }
    default: return err(`未知 prompt 动作：${action}`, 2);
  }
}

function cmdCondition(args: string[]): CustomizeCommandResult {
  const [key, val] = args;
  if (!key || !val) return err('用法：botmux customize condition <key> <on|off|reset>', 2);
  if (val === 'on') setConditionalLine(key, true);
  else if (val === 'off') setConditionalLine(key, false);
  else if (val === 'reset') setConditionalLine(key, null);
  else return err('值必须是 on / off / reset', 2);
  return ok(`条件行 ${key} → ${val}`);
}

function cmdSkill(args: string[]): CustomizeCommandResult {
  const [action, ...rest] = args;
  const state = readCustomizationState();
  switch (action) {
    case undefined:
    case 'list': {
      const lines = BUILTIN_SKILLS.map((s) => {
        const ov = state.builtinSkills?.[s.name];
        const tags: string[] = [];
        if (ov?.disabled) tags.push('已停用');
        if (ov?.body !== undefined) tags.push('正文已改');
        return `${s.name}\t${tags.length ? '[' + tags.join(' ') + ']' : '出厂默认'}`;
      });
      return ok('# 内置 skill\n' + lines.join('\n'));
    }
    case 'show': {
      const name = rest[0];
      if (!name) return err('用法：botmux customize skill show <name>', 2);
      const body = builtinSkillContent(name);
      if (body === undefined) return err(`${name} 已停用或不存在`, 1);
      return ok(body);
    }
    case 'set': {
      const name = rest[0];
      if (!name) return err('用法：botmux customize skill set <name> [<file>]（省略 file 则从 stdin 读取）', 2);
      if (!BUILTIN_SKILLS.some((s) => s.name === name)) return err(`${name} 不是内置 skill`, 2);
      const file = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const body = file ? readFileSync(file, 'utf-8') : readStdin();
      if (!body) return err('未提供 skill 正文（file 或 stdin）', 2);
      setSkillOverrideBody(name, body);
      return ok(`已覆盖 skill 正文：${name}`);
    }
    case 'reset': {
      const name = rest[0];
      if (!name) return err('用法：botmux customize skill reset <name>', 2);
      setSkillOverrideBody(name, null);
      return ok(`已恢复 skill 正文：${name}`);
    }
    case 'disable':
    case 'enable': {
      const name = rest[0];
      if (!name) return err(`用法：botmux customize skill ${action} <name>`, 2);
      if (!BUILTIN_SKILLS.some((s) => s.name === name)) return err(`${name} 不是内置 skill`, 2);
      setSkillDisabled(name, action === 'disable');
      return ok(`skill ${name} → ${action === 'disable' ? '已停用' : '已启用'}`);
    }
    default: return err(`未知 skill 动作：${action}`, 2);
  }
}

function cmdResetAll(): CustomizeCommandResult {
  resetAllToFactory();
  return ok('已将所有 prompt/skill 覆盖恢复出厂（已存快照，可 rollback 撤回）');
}

function cmdHistory(args: string[]): CustomizeCommandResult {
  const limit = Number(argValue(args, '--limit') ?? '20') || 20;
  const snaps = listSnapshots().slice(0, limit);
  if (!snaps.length) return ok('（暂无历史快照）');
  const lines = snaps.map((s) => `${s.id}\t${s.at}\t${s.label}\t[prompt:${s.summary.promptKeys} skill:${s.summary.skills} ${s.summary.enabled ? 'on' : 'off'}]`);
  return ok('# 历史快照（新→旧）\n' + lines.join('\n'));
}

function cmdRollback(args: string[]): CustomizeCommandResult {
  const id = args[0];
  if (!id) return err('用法：botmux customize rollback <snapshotId>', 2);
  rollbackToSnapshot(id);
  return ok(`已回滚到 ${id}（回滚本身也存了快照，可再回滚撤销）`);
}

function cmdExport(args: string[]): CustomizeCommandResult {
  const name = argValue(args, '--name');
  const out = argValue(args, '--out');
  const bundle = exportBundle({ name });
  const json = serializeBundle(bundle);
  if (out) {
    writeFileSync(out, json, 'utf-8');
    return ok(`已导出 bundle → ${out}`);
  }
  return ok(json);
}

function cmdImport(args: string[]): CustomizeCommandResult {
  const src = args[0];
  if (!src) return err('用法：botmux customize import <file|-> [--yes]', 2);
  const raw = src === '-' ? readStdin() : readFileSync(src, 'utf-8');
  if (!raw) return err('未读到 bundle 内容', 2);
  let bundle;
  try { bundle = parseBundle(raw); }
  catch (e) { return err(`bundle 校验失败：${e instanceof BundleError ? e.message : String(e)}`, 2); }

  const { diff, summary } = previewBundleImport(bundle);
  const diffLines = diff.map((d) => {
    const loc = d.locale ? ` (${d.locale})` : '';
    const arrow = d.action === 'unchanged' ? '＝' : d.action === 'add' ? '＋' : d.action === 'disable' ? '⊘' : '↻';
    return `${arrow} ${d.kind}:${d.id}${loc}${d.after ? `  →  ${d.after}` : ''}`;
  });
  const header = `# 导入预览${bundle.name ? `：${bundle.name}` : ''}\n新增 ${summary.adds} · 替换 ${summary.replaces} · 停用 ${summary.disables} · 无变化 ${summary.unchanged}`;

  if (!hasFlag(args, '--yes')) {
    return ok(`${header}\n${diffLines.join('\n')}\n\n确认无误后加 --yes 落盘应用。`);
  }
  applyBundle(bundle, `import bundle${bundle.name ? `: ${bundle.name}` : ''}`);
  return ok(`${header}\n已应用（已存快照，可 rollback 撤回）。`);
}

/** Read all of stdin synchronously (for `set` from a pipe). Returns undefined
 *  when stdin is a TTY / empty. */
function readStdin(): string | undefined {
  try {
    if (process.stdin.isTTY) return undefined;
    const data = readFileSync(0, 'utf-8');
    return data.length ? data : undefined;
  } catch {
    return undefined;
  }
}
