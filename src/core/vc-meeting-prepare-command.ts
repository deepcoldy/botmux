import { normalizeVcMeetingNumber, type VcMeetingPreparationQaMode } from '../services/vc-meeting-preparations-store.js';

export type VcMeetingPrepareCommand =
  | { kind: 'usage' }
  | { kind: 'prepare'; meetingNo: string; meetingLink?: string; qaMode: VcMeetingPreparationQaMode }
  | { kind: 'status'; meetingNo?: string }
  | { kind: 'off'; meetingNo?: string; all: boolean }
  | { kind: 'invalid'; reason: string };

export function extractVcMeetingNumber(value: string): string | undefined {
  const linkMatch = value.match(/(?:https?:\/\/[^\s]+)?\/j\/([\d\s-]{8,20})/i);
  if (linkMatch) return normalizeVcMeetingNumber(linkMatch[1]);
  return normalizeVcMeetingNumber(value);
}

export function parseVcMeetingPrepareCommand(content: string): VcMeetingPrepareCommand {
  const args = content.replace(/^\/meeting(?:\s+|$)/i, '').trim();
  if (!args || /^(help|帮助)$/i.test(args)) return { kind: 'usage' };

  const statusMatch = args.match(/^(status|状态)(?:\s+(.+))?$/i);
  if (statusMatch) {
    const raw = statusMatch[2]?.trim();
    if (!raw) return { kind: 'status' };
    const meetingNo = extractVcMeetingNumber(raw);
    return meetingNo ? { kind: 'status', meetingNo } : { kind: 'invalid', reason: 'invalid_meeting' };
  }

  const offMatch = args.match(/^(off|关闭|取消)(?:\s+(.+))?$/i);
  if (offMatch) {
    const raw = offMatch[2]?.trim();
    if (!raw) return { kind: 'off', all: false };
    if (/^(all|全部)$/i.test(raw)) return { kind: 'off', all: true };
    const meetingNo = extractVcMeetingNumber(raw);
    return meetingNo
      ? { kind: 'off', meetingNo, all: false }
      : { kind: 'invalid', reason: 'invalid_meeting' };
  }

  const prepareMatch = args.match(/^(prepare|准备)\s+([\s\S]+)$/i);
  if (!prepareMatch) return { kind: 'invalid', reason: 'unknown_command' };
  const body = prepareMatch[2].trim();
  const qaMatch = body.match(/(?:^|\s)--qa(?:=|\s+)(auto|off)(?=\s|$)/i);
  const qaMode: VcMeetingPreparationQaMode = qaMatch?.[1]?.toLowerCase() === 'off' ? 'off' : 'auto';
  const meetingRef = body.replace(/(?:^|\s)--qa(?:=|\s+)(?:auto|off)(?=\s|$)/ig, ' ').trim();
  const meetingNo = extractVcMeetingNumber(meetingRef);
  if (!meetingNo) return { kind: 'invalid', reason: 'invalid_meeting' };
  const link = meetingRef.match(/https?:\/\/\S+/i)?.[0];
  return {
    kind: 'prepare',
    meetingNo,
    qaMode,
    ...(link ? { meetingLink: link } : {}),
  };
}
