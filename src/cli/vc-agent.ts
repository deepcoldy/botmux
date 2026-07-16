import {
  beginVcPollingPass,
  buildVcMeetingStatePayload,
  collectStableTranscriptItems,
  createVcMeetingSessionState,
  ingestNormalizedVcMeetingItems,
} from '../vc-agent/meeting-state.js';
import { fetchMeetingEventsAsBot, joinMeetingAsBot } from '../vc-agent/polling-source.js';
import {
  DEFAULT_REALTIME_VOICE_CHANNELS,
  DEFAULT_REALTIME_VOICE_FRAME_MS,
  DEFAULT_REALTIME_VOICE_SAMPLE_RATE,
  connectRealtimeVoiceTransport,
  createProtoRealtimeVoiceProtocol,
  fetchRealtimeVoiceEndpoint,
  RealtimeVoiceSession,
} from '../vc-agent/realtime/index.js';
import { loadBotConfigs, registerBot } from '../bot-registry.js';
import { config } from '../config.js';
import { listVcMeetingRuntimeSessions } from '../services/vc-meeting-runtime-store.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { resolveSessionContext } from '../core/session-marker.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { readManagedOriginCapability } from '../core/managed-origin-capability.js';
import type { NormalizedVcMeetingItem } from '../vc-agent/types.js';

const VC_AGENT_SPEAK_MAX_TEXT_LENGTH = 200;

function argValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function intArg(args: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(args, name);
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function usage(): void {
  console.log(`botmux vc-agent <command>

Commands:
  tat-gate   Verify bot identity can read real transcript/chat items from a meeting
  poll       Run the P0 polling bridge and print stable meeting-state JSON
  request-output
             Ask the daemon to review/send a meeting agent text or voice output
  speak      Speak one TTS utterance into an active meeting via realtime voice

Examples:
  botmux vc-agent tat-gate --meeting-id <meeting_id>
  botmux vc-agent tat-gate --meeting-number 123456789
  botmux vc-agent poll --meeting-id <meeting_id> --once
  botmux vc-agent poll --meeting-id <meeting_id> --page-token-mode incremental ...
  botmux vc-agent request-output --lark-app-id cli_xxx --meeting-id <meeting_id> --channel text --content "..."
  botmux vc-agent speak --lark-app-id cli_xxx --meeting-id <meeting_id> --text "大家好"
`);
}

let botRegistryLoaded = false;

function ensureBotRegistryLoaded(): void {
  if (botRegistryLoaded) return;
  for (const cfg of loadBotConfigs()) registerBot(cfg);
  botRegistryLoaded = true;
}

function resolveMeetingId(args: string[], opts: { allowJoin?: boolean } = {}): { meetingId: string; joined: boolean } {
  const meetingId = argValue(args, '--meeting-id');
  if (meetingId) return { meetingId, joined: false };
  const meetingNumber = argValue(args, '--meeting-number');
  if (!meetingNumber) throw new Error('missing --meeting-id or --meeting-number');
  if (opts.allowJoin === false) {
    throw new Error('--meeting-number would make the bot join the meeting; use --meeting-id for dry-run');
  }
  const joined = joinMeetingAsBot({
    meetingNumber,
    password: argValue(args, '--password'),
    profile: argValue(args, '--profile'),
  });
  return { meetingId: joined.meetingId, joined: true };
}

async function cmdTatGate(args: string[]): Promise<void> {
  const { meetingId, joined } = resolveMeetingId(args);
  const { raw, batch } = fetchMeetingEventsAsBot({
    meetingId,
    pageSize: intArg(args, '--page-size', 100, 20, 100),
    pageAll: true,
    profile: argValue(args, '--profile'),
  });
  const rawProblem = larkCliErrorSummary(raw);
  const contentItems = batch.items.filter((item) =>
    item.type === 'chat_received' || item.type === 'transcript_received',
  );
  const ok = !rawProblem && (contentItems.length > 0 || hasFlag(args, '--allow-empty-content'));
  const summary = {
    ok,
    meetingId,
    joined,
    totalItems: batch.items.length,
    transcriptItems: batch.items.filter((item) => item.type === 'transcript_received').length,
    chatItems: batch.items.filter((item) => item.type === 'chat_received').length,
    pageToken: batch.pageToken,
    ...(rawProblem ? { larkCliError: rawProblem } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) {
    if (rawProblem) {
      console.error(`TAT read gate failed: lark-cli returned an error payload: ${rawProblem}`);
    } else {
      console.error('TAT read gate failed: bot identity did not read transcript_received/chat_received items. Make sure someone speaks or sends chat during the gate.');
    }
    console.error(`raw lark-cli payload excerpt: ${rawExcerpt(raw)}`);
    process.exit(2);
  }
}

function rawExcerpt(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 2_000);
  } catch {
    return String(raw).slice(0, 2_000);
  }
}

function larkCliErrorSummary(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, any>;
  const code = r.code ?? r.error?.code ?? r.data?.code;
  const msg = r.msg ?? r.message ?? r.error?.msg ?? r.error?.message ?? r.data?.msg;
  if (code !== undefined && code !== 0 && code !== '0') {
    return [String(code), typeof msg === 'string' ? msg : undefined].filter(Boolean).join(' ');
  }
  if (r.error && (typeof r.error === 'string' || typeof r.error === 'object')) {
    return typeof r.error === 'string' ? r.error : rawExcerpt(r.error);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdPoll(args: string[]): Promise<void> {
  const dryRun = hasFlag(args, '--dry-run');

  const { meetingId, joined } = resolveMeetingId(args, { allowJoin: !dryRun });
  const state = createVcMeetingSessionState({
    meeting: { id: meetingId },
    attentionTargetOpenId: argValue(args, '--attention-target'),
    notificationChatId: argValue(args, '--notification-chat-id'),
  });
  const pollMs = intArg(args, '--poll-ms', 10_000, 1_000, 300_000);
  const maxPolls = intArg(args, '--max-polls', hasFlag(args, '--once') ? 1 : Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = intArg(args, '--page-size', 100, 20, 100);
  const stabilizePollWindows = intArg(args, '--stabilize-windows', 1, 0, 10);
  const lookbackMs = intArg(args, '--lookback-ms', 30_000, 0, 30 * 60_000);
  const pageTokenMode = parsePageTokenMode(args);
  const idlePollsBeforeSoftClose = intArg(args, '--idle-polls-before-soft-close', 0, 0, 10_000);

  console.error(`vc-agent polling started: meetingId=${meetingId}${joined ? ' joined=true' : ''} output=json`);

  let consecutiveFailures = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    beginVcPollingPass(state);
    const fallbackStart = pageTokenMode === 'incremental' || state.ingestion.lastSeenEventTime === undefined
      ? undefined
      : new Date(Math.max(0, state.ingestion.lastSeenEventTime - lookbackMs)).toISOString();
    let batch: ReturnType<typeof fetchMeetingEventsAsBot>['batch'];
    try {
      ({ batch } = fetchMeetingEventsAsBot({
        meetingId,
        pageToken: pageTokenMode === 'incremental' ? state.ingestion.pageToken : undefined,
        start: fallbackStart,
        pageSize,
        pageAll: true,
        profile: argValue(args, '--profile'),
      }));
      consecutiveFailures = 0;
    } catch (err) {
      if (maxPolls === 1) throw err;
      consecutiveFailures += 1;
      const backoffMs = Math.min(60_000, pollMs * Math.min(consecutiveFailures, 6));
      console.error(`vc-agent poll failed poll=${poll + 1} failures=${consecutiveFailures}: ${err instanceof Error ? err.message : String(err)}; retrying in ${backoffMs}ms`);
      if (poll + 1 < maxPolls) await sleep(backoffMs);
      continue;
    }
    state.meeting = { ...state.meeting, ...batch.meeting, id: meetingId };
    state.ingestion.pageToken = batch.pageToken;

    const ingest = ingestNormalizedVcMeetingItems(state, batch.items);
    const stableTranscripts = collectStableTranscriptItems(state, { stabilizePollWindows });
    const outgoing: NormalizedVcMeetingItem[] = [...ingest.acceptedItems, ...stableTranscripts];
    if (outgoing.length > 0) {
      const payload = buildVcMeetingStatePayload(state, outgoing, {
        pageToken: batch.pageToken,
        hasMore: batch.hasMore,
      });
      console.log(JSON.stringify(payload));
      console.error(`vc-agent emitted poll=${state.ingestion.pollOrdinal} items=${outgoing.length}`);
    }

    if (idlePollsBeforeSoftClose > 0 && state.ingestion.emptyPollCount >= idlePollsBeforeSoftClose) {
      console.error(`vc-agent soft close: ${state.ingestion.emptyPollCount} empty polls`);
      break;
    }
    if (poll + 1 < maxPolls) await sleep(pollMs);
  }
}

async function cmdSpeak(args: string[]): Promise<void> {
  const larkAppId = argValue(args, '--lark-app-id') ?? argValue(args, '--app-id') ?? argValue(args, '--profile');
  const meetingId = argValue(args, '--meeting-id');
  const text = argValue(args, '--text')?.trim();
  if (!larkAppId) throw new Error('missing --lark-app-id');
  if (!meetingId) throw new Error('missing --meeting-id');
  if (!text) throw new Error('missing --text');
  if (text.length > VC_AGENT_SPEAK_MAX_TEXT_LENGTH) {
    throw new Error(`--text is too long; keep meeting speech within ${VC_AGENT_SPEAK_MAX_TEXT_LENGTH} characters`);
  }

  ensureBotRegistryLoaded();
  if (!hasFlag(args, '--operator-override')) {
    const record = listVcMeetingRuntimeSessions(config.session.dataDir, larkAppId)
      .find(item => item.meeting.id === meetingId);
    if (record?.voiceOutputPolicy !== 'allow') {
      throw new Error('direct vc-agent speak is disabled for meeting agents; use vc-agent request-output or pass --operator-override for human dogfood');
    }
  }
  const endpoint = await fetchRealtimeVoiceEndpoint(larkAppId, meetingId);
  const transport = await connectRealtimeVoiceTransport(endpoint.websocketUrl);
  const session = new RealtimeVoiceSession({
    larkAppId,
    meetingId,
    protocol: createProtoRealtimeVoiceProtocol(),
    transport,
    audioFormat: {
      sampleRate: intArg(args, '--sample-rate', DEFAULT_REALTIME_VOICE_SAMPLE_RATE, 8_000, 48_000),
      channels: intArg(args, '--channels', DEFAULT_REALTIME_VOICE_CHANNELS, 1, 2),
      frameMs: intArg(args, '--frame-ms', DEFAULT_REALTIME_VOICE_FRAME_MS, 20, 1_000),
    },
  });
  let started = false;
  try {
    await session.start();
    started = true;
    const result = await session.speak(text);
    console.log(JSON.stringify({
      ok: true,
      meetingId,
      larkAppId,
      frames: result.frames,
      durationMs: result.durationMs,
    }, null, 2));
  } finally {
    await session.stop(started ? 'cli-speak-finished' : 'cli-speak-failed').catch(() => { /* ignore cleanup errors */ });
  }
}

async function cmdRequestOutput(args: string[]): Promise<void> {
  const larkAppId = argValue(args, '--lark-app-id') ?? argValue(args, '--app-id') ?? argValue(args, '--profile');
  const meetingId = argValue(args, '--meeting-id');
  const channel = argValue(args, '--channel');
  const content = argValue(args, '--content')?.trim();
  const reason = argValue(args, '--reason')?.trim();
  const fallbackText = argValue(args, '--fallback-text')?.trim();
  if (!larkAppId) throw new Error('missing --lark-app-id');
  if (!meetingId) throw new Error('missing --meeting-id');
  if (channel !== 'text' && channel !== 'voice') throw new Error('--channel must be text or voice');
  if (!content) throw new Error('missing --content');
  if (content.length > VC_AGENT_SPEAK_MAX_TEXT_LENGTH) {
    throw new Error(`--content is too long; keep output within ${VC_AGENT_SPEAK_MAX_TEXT_LENGTH} characters`);
  }
  if (fallbackText && fallbackText.length > VC_AGENT_SPEAK_MAX_TEXT_LENGTH) {
    throw new Error(`--fallback-text is too long; keep output within ${VC_AGENT_SPEAK_MAX_TEXT_LENGTH} characters`);
  }

  // A dedicated meeting receiver must submit to its *own* daemon first. The
  // daemon binds the rotating worker capability / live marker to the durable
  // delivery attempt, then forwards a trusted request to the listener hub.
  // Ordinary legacy sessions fall through to the old listener endpoint.
  const receiverSessionId = process.env.BOTMUX_SESSION_ID;
  const receiverAppId = process.env.BOTMUX_LARK_APP_ID;
  const receiverPortRaw = Number(process.env.BOTMUX_DAEMON_IPC_PORT);
  const liveOrigin = resolveSessionContext(config.session.dataDir, receiverSessionId);
  const relayDir = process.env.BOTMUX_SEND_RELAY;
  const originCapability = readManagedOriginCapability(
    config.session.dataDir,
    receiverSessionId,
    relayDir,
  )?.capability;
  const discoveredReceiver = receiverAppId ? findOnlineDaemon(receiverAppId) : null;
  const receiverPort = Number.isSafeInteger(receiverPortRaw) && receiverPortRaw > 0
    ? receiverPortRaw
    : discoveredReceiver?.ipcPort;
  if (receiverSessionId && receiverAppId && receiverPort) {
    const managedResponse = await fetch(`http://127.0.0.1:${receiverPort}/api/vc-meetings/action-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        receiverSessionId,
        expectedListenerAppId: larkAppId,
        expectedMeetingId: meetingId,
        channel,
        content,
        ...(reason ? { reason } : {}),
        ...(fallbackText ? { fallbackText } : {}),
        ...(liveOrigin?.turnId ? { originTurnId: liveOrigin.turnId } : {}),
        ...(liveOrigin?.dispatchAttempt !== undefined
          ? { originDispatchAttempt: liveOrigin.dispatchAttempt }
          : {}),
        ...(originCapability ? { originCapability } : {}),
      }),
    });
    const managedRaw = await managedResponse.text();
    let managedBody: unknown = managedRaw;
    try { managedBody = managedRaw ? JSON.parse(managedRaw) : {}; } catch { /* print raw */ }
    const errorCode = managedBody && typeof managedBody === 'object'
      && typeof (managedBody as { errorCode?: unknown }).errorCode === 'string'
      ? (managedBody as { errorCode: string }).errorCode
      : undefined;
    if (managedResponse.status < 400 || errorCode !== 'not_receiver_session') {
      console.log(typeof managedBody === 'string' ? managedBody : JSON.stringify(managedBody, null, 2));
      if (managedResponse.status >= 400) process.exit(2);
      return;
    }
  }

  ensureBotRegistryLoaded();
  const daemon = findOnlineDaemon(larkAppId);
  if (!daemon) throw new Error(`daemon offline for ${larkAppId}`);
  const response = await fetchDaemonIpc(daemon.ipcPort, '/api/vc-meetings/output-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      larkAppId,
      meetingId,
      channel,
      content,
      ...(reason ? { reason } : {}),
      ...(fallbackText ? { fallbackText } : {}),
    }),
  });
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // Keep the raw body for operator-visible debugging.
  }
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (response.status >= 400) process.exit(2);
}

function parsePageTokenMode(args: string[]): 'time-window' | 'incremental' {
  const raw = argValue(args, '--page-token-mode') ?? 'time-window';
  if (raw === 'time-window' || raw === 'incremental') return raw;
  throw new Error('--page-token-mode must be time-window or incremental');
}

export async function cmdVcAgent(command: string, args: string[]): Promise<void> {
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      usage();
      return;
    }
    if (command === 'tat-gate') {
      await cmdTatGate(args);
      return;
    }
    if (command === 'poll') {
      await cmdPoll(args);
      return;
    }
    if (command === 'request-output') {
      await cmdRequestOutput(args);
      return;
    }
    if (command === 'speak') {
      await cmdSpeak(args);
      return;
    }
    usage();
    throw new Error(`unknown vc-agent command: ${command}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
