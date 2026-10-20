import type { AskOption, AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

type RawDshQuestion = {
  id?: unknown;
  question?: unknown;
  detail?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
  multi_select?: unknown;
  intent?: unknown;
};

type ParsedDshAsk = ParsedAsk & {
  raw: {
    rawQuestions: RawDshQuestion[];
  };
};

const MAX_DSH_OPTION_LABEL_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlanReviewIntent(value: unknown): boolean {
  return isRecord(value) && value.kind === 'plan-review';
}

function validOptionLabel(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_DSH_OPTION_LABEL_LENGTH
    && !/[\r\n]/.test(value);
}

function formatPrompt(q: RawDshQuestion, options: AskOption[]): string {
  const lines: string[] = [];
  const header = cleanText(q.header);
  const question = cleanText(q.question)!;
  const detail = cleanText(q.detail);
  if (header) lines.push(`【${header}】`);
  lines.push(question);
  if (detail) lines.push('', detail);

  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const descriptions: string[] = [];
  for (let i = 0; i < rawOptions.length; i++) {
    const raw = rawOptions[i];
    if (!isRecord(raw)) continue;
    const description = cleanText(raw.description);
    if (!description) continue;
    descriptions.push(`- ${options[i]?.label ?? `Option ${i + 1}`}: ${description}`);
  }
  if (descriptions.length > 0) lines.push('', '选项说明：', ...descriptions);
  return lines.join('\n');
}

function parseOneQuestion(raw: unknown): AskQuestion | null {
  if (!isRecord(raw)) return null;
  const q = raw as RawDshQuestion;
  if (!cleanText(q.id)) return null;
  if (!cleanText(q.question)) return null;
  if (isPlanReviewIntent(q.intent)) return null;
  if (!Array.isArray(q.options) || q.options.length < 2) return null;

  const seen = new Set<string>();
  const options: AskOption[] = [];
  for (const rawOption of q.options) {
    if (!isRecord(rawOption)) return null;
    const label = rawOption.label;
    if (!validOptionLabel(label)) return null;
    if (seen.has(label)) return null;
    seen.add(label);
    options.push({ key: label, label });
  }
  return {
    prompt: formatPrompt(q, options),
    options,
    multiSelect: q.multiSelect === true || q.multi_select === true,
  };
}

function rawQuestionsFrom(payload: Record<string, unknown>): RawDshQuestion[] | null {
  const toolInput = payload.tool_input;
  if (isRecord(toolInput) && Array.isArray(toolInput.questions)) {
    return toolInput.questions as RawDshQuestion[];
  }
  const request = payload.request;
  if (isRecord(request) && Array.isArray(request.questions)) {
    return request.questions as RawDshQuestion[];
  }
  return null;
}

function rawQuestionId(raw: RawDshQuestion, index: number): string {
  const id = cleanText(raw.id);
  return id ?? `q${index}`;
}

const dshAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedDshAsk | null {
    if (!isRecord(payload)) return null;
    if (payload.hook_event_name !== 'user-questions/request') return null;
    const rawQuestions = rawQuestionsFrom(payload);
    if (!rawQuestions || rawQuestions.length === 0) return null;

    const questions: AskQuestion[] = [];
    for (const raw of rawQuestions) {
      const parsed = parseOneQuestion(raw);
      if (!parsed) return null;
      questions.push(parsed);
    }
    return { questions, raw: { rawQuestions } };
  },

  formatAnswer(
    answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
    parsed: ParsedAsk,
    comment?: string | null,
  ): string {
    const rawQuestions = Array.isArray((parsed.raw as { rawQuestions?: unknown }).rawQuestions)
      ? ((parsed.raw as { rawQuestions: RawDshQuestion[] }).rawQuestions)
      : [];
    const customText = (comment ?? '').trim();
    const answers = parsed.questions.map((_q, i) => {
      const selected = [...(answersByQuestion[i] ?? [])];
      return {
        id: rawQuestionId(rawQuestions[i] ?? {}, i),
        selected,
        ...(selected.length === 0 && customText.length > 0 ? { custom: customText } : {}),
      };
    });
    return JSON.stringify({ answers });
  },

  passthrough(): string {
    return '';
  },
};

export default dshAdapter;
