export function feedbackExtensionId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${path}: invalid identifier`);
  }
  return value;
}
