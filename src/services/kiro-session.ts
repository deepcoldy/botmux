const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RESUME_COMMAND_RE = new RegExp(`(?:kiro-cli|kiro)\\s+chat\\s+--resume-id\\s+(${UUID_RE})`, 'i');
const BARE_UUID_RE = new RegExp(`^${UUID_RE}$`);

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function extractKiroSessionIdFromOutput(output: string): string | undefined {
  const clean = stripAnsi(output);
  const resume = clean.match(RESUME_COMMAND_RE);
  if (resume?.[1]) return resume[1];

  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (BARE_UUID_RE.test(trimmed)) return trimmed;
  }
  return undefined;
}
