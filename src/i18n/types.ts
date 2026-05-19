export type Locale = 'zh' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh', 'en'] as const;

export function isLocale(v: unknown): v is Locale {
  return v === 'zh' || v === 'en';
}
