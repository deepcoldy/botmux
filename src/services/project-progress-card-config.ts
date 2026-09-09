export const PROJECT_PROGRESS_CARD_TEMPLATE_IDS = ['status-dashboard', 'compact-list'] as const;
export type ProjectProgressCardTemplateId = typeof PROJECT_PROGRESS_CARD_TEMPLATE_IDS[number];

export const PROJECT_PROGRESS_CARD_SECTION_IDS = ['goal', 'blockers', 'workstreams', 'milestones'] as const;
export type ProjectProgressCardSectionId = typeof PROJECT_PROGRESS_CARD_SECTION_IDS[number];

/** Group-level presentation policy. Project content never belongs here. */
export interface ProjectProgressCardConfig {
  schemaVersion: 1;
  templateId: ProjectProgressCardTemplateId;
  sections: ProjectProgressCardSectionId[];
  milestonesExpanded: boolean;
}

export type ProjectProgressCardConfigParseResult =
  | { ok: true; value: ProjectProgressCardConfig }
  | { ok: false; error: 'invalid_progress_card_config' };

export const DEFAULT_PROJECT_PROGRESS_CARD_CONFIG: Readonly<ProjectProgressCardConfig> = Object.freeze({
  schemaVersion: 1,
  templateId: 'status-dashboard',
  sections: [...PROJECT_PROGRESS_CARD_SECTION_IDS],
  milestonesExpanded: false,
});

function defaultConfig(): ProjectProgressCardConfig {
  return {
    ...DEFAULT_PROJECT_PROGRESS_CARD_CONFIG,
    sections: [...DEFAULT_PROJECT_PROGRESS_CARD_CONFIG.sections],
  };
}

export function parseProjectProgressCardConfig(raw: unknown): ProjectProgressCardConfigParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  const record = raw as Record<string, unknown>;
  const keys = new Set(['schemaVersion', 'templateId', 'sections', 'milestonesExpanded']);
  if (Object.keys(record).some(key => !keys.has(key))) {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  if (record.schemaVersion !== 1 || !PROJECT_PROGRESS_CARD_TEMPLATE_IDS.includes(record.templateId as ProjectProgressCardTemplateId)) {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  if (!Array.isArray(record.sections) || record.sections.length > PROJECT_PROGRESS_CARD_SECTION_IDS.length) {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  const sections = record.sections.filter((value): value is ProjectProgressCardSectionId => (
    typeof value === 'string' && PROJECT_PROGRESS_CARD_SECTION_IDS.includes(value as ProjectProgressCardSectionId)
  ));
  if (sections.length !== record.sections.length || new Set(sections).size !== sections.length) {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  if (typeof record.milestonesExpanded !== 'boolean') {
    return { ok: false, error: 'invalid_progress_card_config' };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      templateId: record.templateId as ProjectProgressCardTemplateId,
      sections: [...sections],
      milestonesExpanded: record.milestonesExpanded,
    },
  };
}

/** Runtime reads fail soft for backward compatibility with pre-config groups. */
export function resolveProjectProgressCardConfig(raw: unknown): ProjectProgressCardConfig {
  if (raw === undefined) return defaultConfig();
  const parsed = parseProjectProgressCardConfig(raw);
  return parsed.ok ? parsed.value : defaultConfig();
}
