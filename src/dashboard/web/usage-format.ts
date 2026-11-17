/** Keep small positive rates visible instead of rounding them to zero. */
export function usageMetricNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > 0 && value < .01) return '<0.01';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function usageMetricShare(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${usageMetricNumber(value * 100)}%`;
}
