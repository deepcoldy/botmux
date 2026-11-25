/**
 * Interactive `/g` form card (`--card` or `groupCreation.card: true` on bare `/g`)
 * plus unified result/error cards shared by all `/g` creation paths.
 *
 * The card value only carries an opaque form id; who may submit, which bots get
 * invited, and every other `/g` decision stay in daemon memory, so a forwarded
 * or copied card cannot widen anything. A daemon restart drops open forms —
 * the user simply sends `/g` again.
 *
 * Lark silently drops `select_static` inside a v1 `form` and a v1 form card
 * cannot be patched in place, so the directory dropdown sits outside the form
 * and only records the choice (toast), while the form submits an optional name,
 * an optional typed directory that overrides the dropdown, and an optional git
 * branch (creates a linked worktree).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { t, type Locale } from '../i18n/index.js';
import { repoPickerScanOptions } from '../global-config.js';
import { cardHeaderTemplateFirst, larkMdDiv, urlButton, wideCard } from '../im/lark/card-primitives.js';
import type { GroupCreationArgs } from '../services/group-creation-options.js';
import { scanMultipleProjects } from '../services/project-scanner.js';
import { getProjectScanDirsForBot } from './session-manager.js';
import { effectiveDefaultWorkingDir, getBot } from '../bot-registry.js';
import { expandHome } from './working-dir.js';

export const GROUP_CREATE_DIR_ACTION = 'group_create_dir';
export const GROUP_CREATE_SUBMIT_ACTION = 'group_create_submit';

const FORM_TTL_MS = 30 * 60_000;
const MAX_DIR_OPTIONS = 50;

export interface GroupCreateForm {
  id: string;
  creatorAppId: string;
  senderOpenId: string;
  larkAppIdsForGroup: string[];
  groupArgs: GroupCreationArgs;
  appIdToName: Record<string, string>;
  /** Where `/g` was sent; the result card replies here (the form card itself is withdrawn). */
  rootId: string;
  selectedDir?: string;
  expiresAt: number;
}

export type GroupCreateCardResult =
  | {
      ok: true;
      name: string;
      link: string;
      workingDir?: string;
      branch?: string;
      started?: boolean;
      reservationFailedReason?: string;
      hints: string[];
    }
  | { ok: false; error: string };

const forms = new Map<string, GroupCreateForm>();

function sweep(now: number): void {
  for (const [id, form] of forms) if (form.expiresAt <= now) forms.delete(id);
}

export function openGroupCreateForm(
  input: Omit<GroupCreateForm, 'id' | 'expiresAt'>,
  now = Date.now(),
): GroupCreateForm {
  sweep(now);
  const form: GroupCreateForm = { ...input, id: randomBytes(16).toString('hex'), expiresAt: now + FORM_TTL_MS };
  forms.set(form.id, form);
  return form;
}

/** The open form for this id, only for the user who opened it. */
export function getGroupCreateForm(
  id: unknown,
  operatorOpenId: string | undefined,
  now = Date.now(),
): { ok: true; form: GroupCreateForm } | { ok: false; reason: 'expired' | 'not_owner' } {
  sweep(now);
  const form = typeof id === 'string' ? forms.get(id) : undefined;
  if (!form) return { ok: false, reason: 'expired' };
  if (!operatorOpenId || operatorOpenId !== form.senderOpenId) return { ok: false, reason: 'not_owner' };
  return { ok: true, form };
}

export function selectGroupCreateDir(form: GroupCreateForm, dir: string): void {
  forms.set(form.id, { ...form, selectedDir: dir });
}

/** Single use: a submitted form cannot create a second group. */
export function consumeGroupCreateForm(form: GroupCreateForm): void {
  forms.delete(form.id);
}

/** Test-only cleanup to isolate in-memory form state across cases. */
export function resetGroupCreateForms(): void {
  forms.clear();
}

/**
 * Bot default first, then the scan roots and the git repos found under them
 * (same scan as the repo picker). A failed scan only drops the dropdown — the
 * typed-path input still works.
 */
export function groupCreateDirOptions(larkAppId: string): string[] {
  const out = new Set<string>();
  try {
    const raw = effectiveDefaultWorkingDir(getBot(larkAppId).config);
    const botDefault = raw ? expandHome(raw) : undefined;
    if (botDefault && statSync(botDefault).isDirectory()) out.add(botDefault);
    const roots = getProjectScanDirsForBot(larkAppId).filter(dir => existsSync(dir));
    for (const root of roots) out.add(root);
    if (roots.length > 0) {
      for (const project of scanMultipleProjects(roots, 3, repoPickerScanOptions())) {
        if (project.type === 'repo') out.add(project.path);
      }
    }
  } catch { /* keep whatever was collected */ }
  return [...out].slice(0, MAX_DIR_OPTIONS);
}

export function buildGroupCreateCard(
  form: GroupCreateForm,
  dirOptions: readonly string[],
  locale?: Locale,
): string {
  const elements: unknown[] = [larkMdDiv(t('card.group_create.intro', undefined, locale))];
  const prefilledDir = form.selectedDir;
  const dirInDropdown = !!prefilledDir && dirOptions.includes(prefilledDir);
  if (dirOptions.length > 0) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: t('card.group_create.dir_select', undefined, locale) },
        ...(dirInDropdown ? { initial_option: prefilledDir } : {}),
        options: dirOptions.map(dir => ({ text: { tag: 'plain_text', content: dir }, value: dir })),
        value: { action: GROUP_CREATE_DIR_ACTION, form: form.id },
      }],
    });
  }
  const prefilledName = form.groupArgs.name.trim();
  const prefilledBranch = form.groupArgs.branch?.trim();
  elements.push({
    tag: 'form',
    name: 'group_create_form',
    elements: [
      {
        tag: 'input',
        name: 'group_name',
        placeholder: { tag: 'plain_text', content: t('card.group_create.name_placeholder', undefined, locale) },
        ...(prefilledName ? { default_value: prefilledName } : {}),
      },
      {
        tag: 'input',
        name: 'group_dir',
        placeholder: { tag: 'plain_text', content: t('card.group_create.dir_placeholder', undefined, locale) },
        ...(prefilledDir && !dirInDropdown ? { default_value: prefilledDir } : {}),
      },
      {
        tag: 'input',
        name: 'group_branch',
        placeholder: { tag: 'plain_text', content: t('card.group_create.branch_placeholder', undefined, locale) },
        ...(prefilledBranch ? { default_value: prefilledBranch } : {}),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.group_create.submit', undefined, locale) },
        type: 'primary',
        name: 'group_create_submit',
        action_type: 'form_submit',
        value: { action: GROUP_CREATE_SUBMIT_ACTION, form: form.id },
      },
    ],
  });
  return JSON.stringify(wideCard({
    header: cardHeaderTemplateFirst('blue', t('card.group_create.title', undefined, locale)),
    elements,
  }));
}

/** Result card shared by the `/g` command path and the submitted form card. */
export function buildGroupCreatedCard(result: GroupCreateCardResult, locale?: Locale): string {
  if (!result.ok) {
    return JSON.stringify(wideCard({
      header: cardHeaderTemplateFirst('red', t('card.group_create.failed_title', undefined, locale)),
      elements: [larkMdDiv(t('cmd.group.failed', { error: result.error }, locale))],
    }));
  }
  if (result.reservationFailedReason) {
    return JSON.stringify(wideCard({
      header: cardHeaderTemplateFirst('orange', t('card.group_create.done_title', { name: result.name }, locale)),
      elements: [
        larkMdDiv(t('cmd.group.reservation_failed', {
          name: result.name,
          reason: result.reservationFailedReason,
          link: result.link,
        }, locale)),
        {
          tag: 'action',
          actions: [urlButton(t('card.group_create.open_chat', undefined, locale), 'primary', {
            url: result.link, pc_url: result.link, android_url: result.link, ios_url: result.link,
          })],
        },
      ],
    }));
  }
  const lines = [
    ...(!result.started ? [t('card.group_create.done_intro', undefined, locale)] : []),
    ...(result.workingDir
      ? [t('card.group_create.done_dir', { dir: result.workingDir }, locale)]
      : []),
    ...(result.branch ? [t('card.group_create.done_branch', { branch: result.branch }, locale)] : []),
    ...result.hints,
  ];
  return JSON.stringify(wideCard({
    header: cardHeaderTemplateFirst(
      'green',
      t(result.started ? 'card.group_create.started_title' : 'card.group_create.done_title', { name: result.name }, locale),
    ),
    elements: [
      ...(lines.length > 0 ? [larkMdDiv(lines.join('\n'))] : []),
      {
        tag: 'action',
        actions: [urlButton(t('card.group_create.open_chat', undefined, locale), 'primary', {
          url: result.link, pc_url: result.link, android_url: result.link, ios_url: result.link,
        })],
      },
    ],
  }));
}

/** `/g` could not start (bad options, unresolved bots, invalid directory…): same card family as the result. */
export function buildGroupErrorCard(message: string, locale?: Locale): string {
  return JSON.stringify(wideCard({
    header: cardHeaderTemplateFirst('red', t('card.group_create.error_title', undefined, locale)),
    elements: [larkMdDiv(message)],
  }));
}
