/**
 * Agent preset — a portable, **secret-free** snapshot of a bot's shareable
 * configuration.
 *
 * `botmux preset export <bot>` writes one of these so a teammate's agent can
 * self-configure a *matching* bot WITHOUT ever copying credentials. It carries
 * only the parts that are safe to share — which CLI/model to use, the team-level
 * role persona, and the one-line capability label — plus an embedded Chinese
 * guide telling the receiving agent how to apply it.
 *
 * It deliberately omits everything identity- or deployment-specific:
 * larkAppId / larkAppSecret / allowedUsers / allowedChatGroups / oncallChats /
 * workingDir. Those must be supplied by each bot's own owner. The safety
 * guarantee lives in `buildPreset`, which copies an explicit allow-list of
 * fields and NEVER spreads its input, so a caller passing a full bot config
 * (secrets and all) still produces a clean preset.
 */
import { z } from 'zod';

/**
 * On-disk preset format version. Doubles as a format discriminator: a file
 * whose `botmuxPreset` !== PRESET_VERSION is rejected by `loadPreset`. Bump
 * only on a breaking change to the shape below.
 */
export const PRESET_VERSION = 1;

/**
 * A secret-free, shareable bot preset. Field order here matches the serialized
 * JSON (see `buildPreset`): marker first, identity-free config in the middle,
 * human guide last.
 */
export interface AgentPreset {
  /** Format marker + version. Always equal to {@link PRESET_VERSION}. */
  botmuxPreset: number;
  /** CLI adapter id the source bot uses (e.g. 'claude-code', 'aiden'). */
  cliId: string;
  /** Model override, if the source bot set one. */
  model?: string;
  /** Team-level role markdown (the persona injected into the CLI). */
  teamRole?: string;
  /** One-line capability label used in the collaboration roster. */
  capability?: string;
  /** Human-facing name of the source bot — for display / default filename. */
  sourceName?: string;
  /** Chinese guide telling the *receiving* agent how to apply this preset. */
  guide: string;
}

/**
 * Input accepted by {@link buildPreset}. The named fields are the allow-list;
 * the index signature exists so callers can pass a full bot config (which also
 * carries secrets like larkAppSecret) without a type error — those extra keys
 * are simply never read.
 */
export interface BuildPresetInput {
  cliId: string;
  model?: string | null;
  teamRole?: string | null;
  capability?: string | null;
  sourceName?: string | null;
  /** Tolerate (and ignore) any extra fields, e.g. a full bot config's secrets. */
  [extra: string]: unknown;
}

/**
 * Guide embedded in every exported preset, addressed to the AI agent that will
 * apply it on the receiving side. Kept in the file so it travels with the data.
 */
export const PRESET_GUIDE = [
  '本文件是一个 botmux「Agent 预设」(agent preset)，由 `botmux preset export` 生成。',
  '它携带某个机器人「可安全分享」的配置：使用的 CLI 适配器(cliId)、模型(model)、团队角色 persona(teamRole)、能力标签(capability)。',
  '',
  '它【不包含任何凭证或部署信息】——没有 larkAppId / larkAppSecret / allowedUsers / allowedChatGroups / workingDir。',
  '因此单凭本文件无法登录、无法冒充原机器人，这是有意为之。',
  '',
  '如果你是一个 AI agent，请按下面的步骤帮用户用这份预设配置他自己的 botmux 机器人：',
  '1. 让用户用【他自己】的飞书/Lark 应用凭证跑 `botmux setup`；larkAppId/larkAppSecret/allowedUsers 必须由他本人填写，',
  '   绝不要从本文件或任何他人处复制粘贴密钥。',
  '2. setup 时把 CLI 适配器设为本预设的 `cliId`，模型设为 `model`(如有)。',
  '3. 把本预设的 `teamRole` 写为该 bot 的 team 级角色内容，把 `capability` 设为它的能力标签。',
  '4. 完成后让用户 `botmux restart` 使配置生效。',
  '',
  '再次强调：凭证(AppID/Secret/token)必须每个机器人独立、由其所有者本人提供，切勿复制他人的密钥。',
].join('\n');

/**
 * Build a preset by copying an explicit allow-list of fields. Never spreads
 * `input`, so any secret-bearing extra keys on it are dropped by construction.
 * Empty / null / undefined optional fields are omitted entirely.
 */
export function buildPreset(input: BuildPresetInput): AgentPreset {
  const preset = {
    botmuxPreset: PRESET_VERSION,
    cliId: input.cliId,
  } as AgentPreset;

  if (input.model) preset.model = input.model;
  if (input.teamRole) preset.teamRole = input.teamRole;
  if (input.capability) preset.capability = input.capability;
  if (input.sourceName) preset.sourceName = input.sourceName;

  // Guide last so it reads naturally at the bottom of the JSON file.
  preset.guide = PRESET_GUIDE;
  return preset;
}

/** Serialize a preset to pretty JSON with a trailing newline (POSIX-friendly). */
export function serializePreset(preset: AgentPreset): string {
  return JSON.stringify(preset, null, 2) + '\n';
}

/**
 * Slugify a string into a safe filename component: keep Unicode letters / digits
 * / `_` / `.` / `-`, replace every other run with a single `-`, then trim
 * leading/trailing separators. Returns '' if nothing usable remains (e.g. the
 * input was only spaces or slashes). CJK names are preserved (they're \p{L}).
 */
export function slugifyForFilename(raw: string): string {
  return raw
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
}

/**
 * Derive the default preset filename (no directory). Prefers the bot's human
 * name, falls back to its larkAppId, and ALWAYS slugifies so the path stays
 * valid/stable even when `name` carries spaces, slashes, etc. Never uses the
 * `botmux-<n>` process name. Final 'bot' fallback guards the degenerate case
 * where both name and appId slug to empty.
 */
export function presetFilename(sourceName: string | undefined, appId: string): string {
  const base = slugifyForFilename(sourceName ?? '') || slugifyForFilename(appId) || 'bot';
  return `${base}.botmux-preset.json`;
}

const presetSchema = z.object({
  botmuxPreset: z.literal(PRESET_VERSION),
  cliId: z.string().min(1),
  model: z.string().optional(),
  teamRole: z.string().optional(),
  capability: z.string().optional(),
  sourceName: z.string().optional(),
  guide: z.string(),
});

/**
 * Parse + validate a preset JSON string. Throws a friendly error on malformed
 * JSON or on a wrong/missing version (kept for tests and future "preset apply"
 * tooling). Unknown extra keys are stripped, so a future minor extension stays
 * readable by older code as long as the version still matches.
 */
export function loadPreset(raw: string): AgentPreset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`不是合法的 JSON: ${err?.message ?? String(err)}`);
  }

  const result = presetSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`不是合法的 botmux 预设 (需要 botmuxPreset=${PRESET_VERSION}): ${detail}`);
  }
  return result.data;
}
