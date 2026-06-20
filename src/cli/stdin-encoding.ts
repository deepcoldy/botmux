export function looksLikeWindowsStdinMojibake(
  content: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;

  const trimmed = content.trim();
  if (trimmed.length < 8) return false;
  if (/[^\x00-\x7F]/.test(trimmed)) return false;

  const questionCount = (trimmed.match(/\?/g) ?? []).length;
  return questionCount >= 4 && questionCount / trimmed.length >= 0.18;
}

export function rejectLikelyWindowsStdinMojibake(content: string): void {
  if (!looksLikeWindowsStdinMojibake(content)) return;

  console.error('botmux send refused: Windows PowerShell appears to have converted non-ASCII stdin text to "?".');
  console.error('Write the message to a UTF-8 file and use: botmux send --content-file <path>');
  process.exit(2);
}
