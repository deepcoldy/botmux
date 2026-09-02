export interface InteractiveCardCallbackPolicy {
  /** True only when this callback action belongs to the selected plugin. */
  allowsAction(action: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Interactive inputs fire card.action.trigger even when no value payload is
// present. Buttons are handled separately because open_url buttons are safe.
const CALLBACK_CONTROL_TAGS = new Set([
  'select_static', 'multi_select_static',
  'select_person', 'multi_select_person',
  'select_img', 'multi_select_img',
  'overflow', 'input',
  'date_picker', 'picker_time', 'picker_datetime',
]);

function isOpenUrlButton(element: Record<string, unknown>): boolean {
  if (typeof element.url === 'string' && element.url.trim() !== '') return true;
  if (element.multi_url !== undefined && element.multi_url !== null) return true;
  return Array.isArray(element.behaviors)
    && element.behaviors.some(behavior => isRecord(behavior) && behavior.type === 'open_url');
}

function pluginActionFor(value: Record<string, unknown>): string | undefined {
  if (!isRecord(value.value)) return undefined;
  const action = value.value.action;
  return typeof action === 'string' && action.trim() ? action.trim() : undefined;
}

function hasAllowedFormSubmit(value: unknown, policy: InteractiveCardCallbackPolicy): boolean {
  if (Array.isArray(value)) return value.some(child => hasAllowedFormSubmit(child, policy));
  if (!isRecord(value)) return false;
  const isSubmit = value.form_action_type === 'submit' || value.action_type === 'form_submit';
  const action = pluginActionFor(value);
  if (isSubmit && action && policy.allowsAction(action)) return true;
  return Object.values(value).some(child => hasAllowedFormSubmit(child, policy));
}

/**
 * Locate the first callback-capable element that is not admitted by policy.
 * `key` and `root_id` remain Botmux-only on every path, including cards
 * returned by a plugin service after an earlier callback.
 */
export function findDisallowedCardCallback(
  value: unknown,
  path = 'card',
  policy?: InteractiveCardCallbackPolicy,
  inAllowedPluginForm = false,
): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDisallowedCardCallback(value[i], `${path}[${i}]`, policy, inAllowedPluginForm);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const allowedPluginForm = inAllowedPluginForm
    || (value.tag === 'form' && !!policy && hasAllowedFormSubmit(value, policy));
  const action = pluginActionFor(value);
  const allowedPluginAction = !!action && !!policy && policy.allowsAction(action);

  if (isRecord(value.value)) {
    for (const field of ['key', 'root_id'] as const) {
      if (typeof value.value[field] === 'string') return `${path}.value.${field}`;
    }
  }

  if (value.type === 'callback' && !allowedPluginAction) return `${path}.type`;
  if (typeof value.form_action_type === 'string' && !allowedPluginAction) {
    return `${path}.form_action_type`;
  }
  if ((value.action_type === 'form_submit' || value.action_type === 'form_reset') && !allowedPluginAction) {
    return `${path}.action_type`;
  }
  if (typeof value.tag === 'string') {
    if (CALLBACK_CONTROL_TAGS.has(value.tag) && !allowedPluginAction && !allowedPluginForm) {
      return `${path}.tag(${value.tag})`;
    }
    if (value.tag === 'button') {
      if ('value' in value && value.value !== undefined && !allowedPluginAction) return `${path}.value`;
      if (!allowedPluginAction && !isOpenUrlButton(value)) return `${path}.tag(button)`;
    }
  }
  if (action && !allowedPluginAction) return `${path}.value.action`;

  for (const [key, child] of Object.entries(value)) {
    const found = findDisallowedCardCallback(child, `${path}.${key}`, policy, allowedPluginForm);
    if (found) return found;
  }
  return null;
}
