import { readFile, mkdir, lstat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { normalizeFeedbackPresentation } from './feedback-presentation.js';
import { normalizeFeedbackHook } from './feedback-hook-config.js';
import { defaultFeedbackTemplate, validateFeedbackTemplate, type FeedbackTemplate } from './feedback-template.js';
import { feedbackExtensionId } from './feedback-extension-id.js';
import type { FeedbackHookRegistration, FeedbackPresentationConfig } from './feedback-extension-types.js';

export interface FeedbackExtensionConfig {
  version: number;
  hostId: string;
  templates: FeedbackTemplate[];
  hooks: FeedbackHookRegistration[];
  actions: Array<{ id: string; label: string; hookId: string }>;
  presentations: Record<string, FeedbackPresentationConfig>;
  updatedBy?: string;
  presentationEffectiveAt?: Record<string, string>;
  subscriptions?: Array<{ id: string; appId: string; chatId: string; buttonKey: string; hookId: string }>;
}
function normalize(input: unknown): FeedbackExtensionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('feedback_extension_config_invalid');
  const raw = input as FeedbackExtensionConfig;
  if (!Number.isSafeInteger(raw.version) || raw.version < 0 || typeof raw.hostId !== 'string' || !raw.hostId
    || !Array.isArray(raw.templates) || !Array.isArray(raw.hooks) || !Array.isArray(raw.actions)
    || !raw.presentations || typeof raw.presentations !== 'object' || Array.isArray(raw.presentations)) throw new Error('feedback_extension_config_invalid');
  const templates = raw.templates.map(validateFeedbackTemplate);
  const hooks = raw.hooks.map(normalizeFeedbackHook);
  const actions = raw.actions.map(action => {
    feedbackExtensionId(action.id, 'feedbackAction.id');
    if (typeof action.label !== 'string' || !action.label || action.label.length > 40
      || !hooks.some(hook => hook.id === action.hookId && hook.allowedActionIds.includes(action.id))) throw new Error('feedback_action_hook_invalid');
    return { id: action.id, label: action.label, hookId: action.hookId };
  });
  for (const collection of [templates, hooks, actions]) {
    if (new Set(collection.map(item => item.id)).size !== collection.length) throw new Error('feedback_extension_duplicate_id');
  }
  const presentations: Record<string, FeedbackPresentationConfig> = {};
  const subscriptions = (raw.subscriptions ?? []).map(subscription => {
    feedbackExtensionId(subscription.id, 'feedbackSubscription.id');
    const hook = hooks.find(item => item.id === subscription.hookId);
    if (!hook || !hook.allowedBotAppIds.includes(subscription.appId) || !hook.allowedChatIds.includes(subscription.chatId)
      || typeof subscription.buttonKey !== 'string' || !subscription.buttonKey) throw new Error('feedback_subscription_invalid');
    return { ...subscription };
  });
  for (const [appId, config] of Object.entries(raw.presentations)) {
    feedbackExtensionId(appId, 'feedbackPresentation.appId');
    const normalized = normalizeFeedbackPresentation(config);
    for (const layer of [normalized.default, ...normalized.rules]) {
      if (layer.templateId && !templates.some(template => template.id === layer.templateId)) throw new Error('feedback_template_not_found');
      for (const id of layer.actionIds ?? []) {
        const action = actions.find(item => item.id === id);
        const hook = hooks.find(item => item.id === action?.hookId);
        if (!hook || !hook.allowedBotAppIds.includes(appId)) throw new Error('feedback_action_not_authorized');
        if ('match' in layer && layer.match && typeof layer.match === 'object'
          && !hook.allowedChatIds.includes((layer.match as { chatId: string }).chatId)) throw new Error('feedback_action_not_authorized');
      }
    }
    presentations[appId] = normalized;
  }
  return { version: raw.version, hostId: raw.hostId, templates, hooks, actions, presentations, subscriptions,
    ...(raw.presentationEffectiveAt ? { presentationEffectiveAt: { ...raw.presentationEffectiveAt } } : {}),
    ...(typeof raw.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : {}) };
}
export async function readFeedbackExtensionConfig(dataDir: string): Promise<FeedbackExtensionConfig> {
  try {
    const path = join(dataDir, 'feedback-extensions.json');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) throw new Error('feedback_extension_config_unsafe');
    return normalize(JSON.parse(await readFile(path, 'utf8')));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 0, hostId: hostname(), templates: [defaultFeedbackTemplate()], hooks: [], actions: [], presentations: {}, subscriptions: [] };
  }
}
export async function saveFeedbackExtensionConfig(dataDir: string, expectedVersion: number, input: unknown, actor: string): Promise<FeedbackExtensionConfig> {
  const normalized = normalize(input);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'feedback-extensions.json');
  return withFileLock(path, async () => {
    const current = await readFeedbackExtensionConfig(dataDir);
    if (current.version !== expectedVersion) throw new Error('feedback_extension_config_conflict');
    if (normalized.hostId !== current.hostId) throw new Error('feedback_extension_host_conflict');
    for (const hook of normalized.hooks) {
      const previous = current.hooks.find(item => item.id === hook.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(hook) && hook.version <= previous.version) throw new Error('feedback_hook_version_conflict');
    }
    const presentationEffectiveAt = { ...current.presentationEffectiveAt };
    for (const [appId, presentation] of Object.entries(normalized.presentations)) {
      if (JSON.stringify(presentation) !== JSON.stringify(current.presentations[appId])) presentationEffectiveAt[appId] = new Date().toISOString();
    }
    const next = { ...normalized, version: current.version + 1, updatedBy: actor, presentationEffectiveAt };
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > 65536) throw new Error('feedback_extension_config_too_large');
    await appendFile(join(dataDir, 'feedback-extension-audit.jsonl'), JSON.stringify({
      version: next.version, actor, time: new Date().toISOString(),
      status: 'prepared',
      hookVersions: next.hooks.map(hook => ({ id: hook.id, version: hook.version, enabled: hook.enabled })),
    }) + '\n', { mode: 0o600 });
    await atomicWriteFile(path, serialized, { durable: true, mode: 0o600, followTargetSymlink: false });
    return next;
  });
}
