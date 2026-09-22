import type { AskOption } from './ask-types.js';

const NATURAL_LANGUAGE_FREEZE_INTENT = [
  /(?:把|将).{0,80}(?:固化成|固化为)\s*\/[\p{L}\p{N}_-]+/iu,
  /(?:安装|创建|新增|修改|更新|覆盖|废弃|停用|恢复|撤销|删除).{0,30}(?:固化命令|固定查询)/iu,
  /(?:固化命令|固定查询).{0,30}(?:安装|创建|新增|修改|更新|覆盖|废弃|停用|恢复|撤销|删除)/iu,
  /(?:安装|创建|新增|修改|更新|覆盖|废弃|停用|恢复|撤销|删除).{0,30}(?<![\p{L}\p{N}_\/-])\/[\p{L}\p{N}_-]+(?![\p{L}\p{N}_\/-])/iu,
  /(?<![\p{L}\p{N}_\/-])\/[\p{L}\p{N}_-]+(?![\p{L}\p{N}_\/-]).{0,30}(?:安装|创建|新增|修改|更新|覆盖|废弃|停用|恢复|撤销|删除)/iu,
  /(?:有哪些|列出|查看|打开).{0,20}固化命令/iu,
  /(?:freeze|frozen)\s+command/iu,
];

const LIFECYCLE_OPERATION =
  /(?:固化成|固化为|安装|创建|新增|修改|更新|覆盖|废弃|停用|恢复|撤销|删除)|\b(?:install(?:ing|ed)?|creat(?:e|ing|ed)|updat(?:e|ing|ed)|replac(?:e|ing|ed)|retir(?:e|ing|ed)|disabl(?:e|ing|ed)|restor(?:e|ing|ed)|revok(?:e|ing|ed)|delet(?:e|ing|ed)|remov(?:e|ing|ed)|purg(?:e|ing|ed))\b/iu;
const AFFIRMATIVE_OPTION =
  /\b(?:confirm|approve|yes|ok|continue)\b|(?:确认|同意|批准|继续)/iu;

/**
 * Existing long-lived CLI sessions may predate installation of the bundled
 * botmux-freeze skill. Give only matching turns a fresh, host-authored routing
 * hint so those sessions do not fall back to a generic botmux ask card.
 */
export function frozenCommandSkillHintForMessage(content: string): string | undefined {
  if (!matchesFrozenCommandIntent(content)) return undefined;
  return [
    '<botmux_capability_hint name="botmux-freeze">',
    'This request matches the host-owned frozen-command lifecycle. Before acting, run `botmux skill show botmux-freeze` and follow it exactly.',
    'Creation/update/retire/restore/revoke must use `botmux freeze ...` so the host emits the single authoritative lifecycle card. Do not use `botmux ask` for this confirmation.',
    '</botmux_capability_hint>',
  ].join('\n');
}

/**
 * Defense in depth for agents that missed or ignored the skill instructions.
 * A generic ask answer is not bound to candidate YAML, spec hash, target Bot,
 * working directory, or the exact human turn, so it must never stand in for a
 * frozen-command lifecycle confirmation.
 */
export function rejectsFrozenCommandLifecycleAsk(
  prompt: string,
  options: ReadonlyArray<Pick<AskOption, 'key' | 'label'>>,
): boolean {
  if (!matchesFrozenCommandIntent(prompt) || !LIFECYCLE_OPERATION.test(prompt)) {
    return false;
  }
  return options.some(option => AFFIRMATIVE_OPTION.test(`${option.key} ${option.label}`));
}

function matchesFrozenCommandIntent(content: string): boolean {
  return NATURAL_LANGUAGE_FREEZE_INTENT.some(pattern => pattern.test(content));
}
