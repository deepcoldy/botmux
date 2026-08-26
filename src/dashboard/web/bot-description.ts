import { BOT_DESCRIPTION_MAX_CHARS } from '../../services/bot-description-schema.js';

export type BotDescriptionLanguage = { lang: string; description: string };

export type BotDescriptionSnapshot = {
  primaryLang: string;
  languages: BotDescriptionLanguage[];
};

export type BotDescriptionDrafts = Record<string, string>;

const LOCALE_LABELS: Record<string, string> = {
  zh_cn: '简体中文',
  zh_tw: '繁體中文（台灣）',
  zh_hk: '繁體中文（香港）',
  en_us: 'English',
  ja_jp: '日本語',
  ko_kr: '한국어',
  fr_fr: 'Français',
  de_de: 'Deutsch',
  es_es: 'Español',
  pt_br: 'Português',
  ru_ru: 'Русский',
  th_th: 'ไทย',
  vi_vn: 'Tiếng Việt',
  id_id: 'Bahasa Indonesia',
  it_it: 'Italiano',
  hi_in: 'हिन्दी',
};

export function localeLabel(lang: string): string {
  return LOCALE_LABELS[lang] ?? lang;
}

export function orderedDescriptionDrafts(snapshot: BotDescriptionSnapshot): BotDescriptionLanguage[] {
  return [...snapshot.languages].sort((left, right) =>
    Number(right.lang === snapshot.primaryLang) - Number(left.lang === snapshot.primaryLang)
    || left.lang.localeCompare(right.lang),
  );
}

export function descriptionsFromSnapshot(snapshot: BotDescriptionSnapshot): BotDescriptionDrafts {
  return Object.fromEntries(snapshot.languages.map(row => [row.lang, row.description]));
}

export function descriptionPreview(snapshot: BotDescriptionSnapshot | null): string {
  return snapshot?.languages.find(row => row.lang === snapshot.primaryLang)?.description ?? '';
}

export function truncateDescription(value: string): string {
  return Array.from(value).slice(0, BOT_DESCRIPTION_MAX_CHARS).join('');
}

export function mergeDescriptionDrafts(
  snapshot: BotDescriptionSnapshot,
  previous: BotDescriptionDrafts,
): { ok: true; descriptions: BotDescriptionDrafts }
  | { ok: false; reason: 'languages_changed'; descriptions: BotDescriptionDrafts } {
  const fresh = descriptionsFromSnapshot(snapshot);
  const freshKeys = Object.keys(fresh).sort();
  const previousKeys = Object.keys(previous).sort();
  if (JSON.stringify(freshKeys) !== JSON.stringify(previousKeys)) {
    return { ok: false, reason: 'languages_changed', descriptions: fresh };
  }
  return { ok: true, descriptions: { ...previous } };
}
