const TITLE_GENERATOR_HEADER = /^\s*You\s+are\s+a\s+helpful\s+assistant\.\s+You\s+will\s+be\s+presented\s+with\s+a\s+user\s+prompt,\s+and\s+your\s+job\s+is\s+to\s+provide\s+a\s+short\s+title\s+for\s+a\s+task\b/i;
const AMBIENT_SUGGESTIONS_WORKER_HEADER = /^\s*Generate\s+\d+\s+to\s+\d+\s+ambient\s+suggestions\b/i;
const HYPERPERSONALIZED_SUGGESTIONS_WORKER_HEADER = /^\s*#\s*Overview\s+Generate\s+\d+\s+to\s+\d+\s+hyperpersonalized\s+suggestions\b/i;
const AMBIENT_SUGGESTIONS_REVIEWER_HEADER = /^\s*You\s+are\s+an\s+expert\s+at\s+upholding\s+safety\s+and\s+compliance\s+standards\s+for\s+Codex\s+ambient\s+suggestions\b/i;
const PR_METADATA_HEADER = /^\s*You\s+are\s+a\s+helpful\s+assistant\.\s*Generate\s+a\s+pull\s+request\s+title\s+and\s+body\b/i;
const SUMMARY_GENERATOR_HEADER = /^\s*You\s+are\s+writing\s+a\s+short\s+summary\s+of\s+a\s+final\s+assistant\s+message\b/i;
const COMMIT_MESSAGE_GENERATOR_HEADER = /^\s*Using\s+the\s+current\s+thread\s+context\s+and\s+the\s+diff\s+below,\s*generate\s+a\s+single-line\s+git\s+commit\s+message\b/i;
const COMMIT_AND_PR_GENERATOR_HEADER = /^\s*Using\s+the\s+current\s+thread\s+context\s+and\s+the\s+commit\s+and\s+pull\s+request\s+contexts\s+below,\s*generate\s+one\s+git\s+commit\s+message\s+plus\s+one\s+pull\s+request\s+title\s+and\s+body\b/i;
const MEMORY_WRITER_HEADER = /^\s*##\s+Memory\s+Writing\s+Agent\s*:/i;
const GUARDIAN_REVIEWER_HEADER = /^\s*You\s+are\s+judging\s+one\s+planned\s+coding-agent\s+action\b/i;
const APPROVAL_REVIEW_HEADER = /^\s*The\s+following\s+is\s+the\s+Codex\s+agent\s+history\s+(?:added\s+since\s+your\s+last\s+approval\s+assessment|whose\s+request\s+action\s+you\s+are\s+assessing)\b/i;
const AGENT_BOX_RUNTIME_HEADER = /##\s*GDPA\s+Agent\s+Box\s+Runtime\b/i;

/** 识别 Codex Desktop 自动创建的后台任务，避免把内部 Agent 的 Stop 当成用户任务完成。 */
export function isInternalCodexPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string' || !prompt.trim()) return false;
  return TITLE_GENERATOR_HEADER.test(prompt)
    || AMBIENT_SUGGESTIONS_WORKER_HEADER.test(prompt)
    || HYPERPERSONALIZED_SUGGESTIONS_WORKER_HEADER.test(prompt)
    || AMBIENT_SUGGESTIONS_REVIEWER_HEADER.test(prompt)
    || PR_METADATA_HEADER.test(prompt)
    || SUMMARY_GENERATOR_HEADER.test(prompt)
    || COMMIT_MESSAGE_GENERATOR_HEADER.test(prompt)
    || COMMIT_AND_PR_GENERATOR_HEADER.test(prompt)
    || MEMORY_WRITER_HEADER.test(prompt)
    || GUARDIAN_REVIEWER_HEADER.test(prompt)
    || APPROVAL_REVIEW_HEADER.test(prompt)
    || AGENT_BOX_RUNTIME_HEADER.test(prompt);
}

/** session_meta.source 是协议级来源；出现 internal/subagent 时不属于用户主任务。 */
export function isInternalCodexSessionMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const payload = meta as Record<string, unknown>;
  if (typeof payload.thread_source === 'string' && payload.thread_source !== 'user') return true;
  const source = payload.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  return sourceRecord.internal !== undefined || sourceRecord.subagent !== undefined;
}
