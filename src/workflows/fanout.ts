import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { EventLog } from './events/append.js';
import type { WorkflowEvent } from './events/schema.js';
import { replay, type Snapshot } from './events/replay.js';
import type { WaitCreatedEvent } from './events/types.js';
import { isPayloadRef } from './events/schema.js';
import { getRunsDir } from './runs-dir.js';
import { readRunChatBinding, type RunChatBinding } from './loader.js';
import { buildWorkflowApprovalCard } from '../im/lark/workflow-cards.js';
import { localeForBot } from '../i18n/index.js';
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';

export type WorkflowEventCallback = (event: WorkflowEvent) => void | Promise<void>;

export type WorkflowEventWatcherOptions = {
  runsDir?: string;
  onError?: (err: unknown) => void;
  pollIntervalMs?: number;
  useFsWatch?: boolean;
};

export class WorkflowEventWatcher {
  readonly runId: string;
  readonly log: EventLog;
  readonly ready: Promise<void>;

  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private lastSeq = 0;
  private draining = false;
  private pendingDrain = false;
  private closed = false;

  constructor(
    runId: string,
    private readonly onNewEvent: WorkflowEventCallback,
    private readonly opts: WorkflowEventWatcherOptions = {},
  ) {
    this.runId = runId;
    this.log = new EventLog(runId, opts.runsDir ?? getRunsDir());
    this.ready = this.start();
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    if (this.draining) {
      this.pendingDrain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pendingDrain = false;
        const events = await this.log.readAll();
        for (const event of events) {
          const seq = eventSeq(event);
          if (seq <= this.lastSeq) continue;
          try {
            await this.onNewEvent(event);
          } catch (err) {
            this.opts.onError?.(err);
            // At-least-once delivery: do not advance the cursor when a
            // downstream card/send/update fails.  A later fs.watch event or
            // polling tick will retry the same event before newer events.
            return;
          }
          this.lastSeq = seq;
        }
      } while (this.pendingDrain && !this.closed);
    } finally {
      this.draining = false;
    }
  }

  private async start(): Promise<void> {
    await mkdir(dirname(this.log.eventsFile), { recursive: true });
    if (!existsSync(this.log.eventsFile)) {
      await writeFile(this.log.eventsFile, '', { flag: 'a' });
    }
    this.lastSeq = await this.log.currentSeq();
    if (this.opts.useFsWatch !== false) {
      this.watcher = watch(this.log.eventsFile, { persistent: false }, () => {
        void this.drain();
      });
    }
    this.pollTimer = setInterval(() => {
      void this.drain();
    }, this.opts.pollIntervalMs ?? 5_000);
    this.pollTimer.unref?.();
  }
}

export type WorkflowFanoutDeps = {
  runsDir?: string;
  binding?: RunChatBinding;
  snapshot?: Snapshot;
  sendCard?: (
    larkAppId: string,
    chatId: string,
    cardJson: string,
    msgType: 'interactive',
  ) => Promise<string>;
};

export async function handleWorkflowFanoutEvent(
  event: WorkflowEvent,
  deps: WorkflowFanoutDeps = {},
): Promise<string | undefined> {
  if (event.type !== 'waitCreated') return undefined;
  const waitEvent = event as WaitCreatedEvent;
  if (isPayloadRef(waitEvent.payload) || waitEvent.payload.waitKind !== 'human-gate') {
    return undefined;
  }

  const runsDir = deps.runsDir ?? getRunsDir();
  const binding = deps.binding ?? (await readRunChatBinding(event.runId, { runsDir }));
  const snapshot =
    deps.snapshot ?? replay(await new EventLog(event.runId, runsDir).readAll());
  const cardJson = buildWorkflowApprovalCard(waitEvent, snapshot, {}, localeForBot(binding.larkAppId));
  const sendCard = deps.sendCard ?? defaultSendWorkflowCard;
  const messageId = await sendCard(binding.larkAppId, binding.chatId, cardJson, 'interactive');
  logger.info(`[workflow:${event.runId}] approval card sent to ${binding.chatId}: ${messageId}`);
  return messageId;
}

async function defaultSendWorkflowCard(
  larkAppId: string,
  chatId: string,
  cardJson: string,
  msgType: 'interactive',
): Promise<string> {
  return sendMessage(larkAppId, chatId, cardJson, msgType);
}

function eventSeq(event: WorkflowEvent): number {
  const match = event.eventId.match(/-(\d+)$/);
  return match ? Number(match[1]) : 0;
}
