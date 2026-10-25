import type { OrcaTerminalTurn } from './orca-runner-store.js';

export interface OrcaTranscriptMessage {
  id: string;
  role: string;
  source: string;
  timestamp: number | null;
  blocks: Array<{ type: string; text?: string; name?: string }>;
}
export interface OrcaTranscript {
  messages: OrcaTranscriptMessage[];
  hasMore: boolean;
  lifecycle?: { state: 'working' | 'completed' | 'interrupted'; turnId: string; timestamp: number | null };
}

function text(message: OrcaTranscriptMessage): string {
  return message.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
}

/** Terminal transcripts have no submission IDs: require one exact input after the saved boundary. */
export function readOrcaTerminalTurn(page: OrcaTranscript, pending: OrcaTerminalTurn): {
  text: string; progress: string; done: boolean; failed?: string;
} {
  const boundary = pending.baselineMessageId
    ? page.messages.findIndex(m => m.id === pending.baselineMessageId) : -1;
  if ((pending.baselineMessageId && boundary < 0) || (!pending.baselineMessageId && page.hasMore)) {
    throw new Error('Orca terminal transcript lost the submission boundary; inspect the original conversation');
  }
  const messages = page.messages.slice(boundary + 1);
  if (messages.some(m => m.source !== 'transcript')) throw new Error('Orca terminal reply requires an authoritative transcript');
  const users = messages.filter(m => m.role === 'user');
  if (users.length > 1 || (users.length === 1 && text(users[0]).replace(/\r\n/g, '\n').trim() !== pending.content.trim())) {
    throw new Error('Concurrent Orca terminal input prevents attributing this reply safely');
  }
  if (!users.length) return { text: '', progress: '', done: false };
  const answer = messages.slice(messages.indexOf(users[0]) + 1)
    .filter(m => m.role === 'assistant').map(text).filter(Boolean).join('\n\n');
  const lifecycle = page.lifecycle;
  const newBoundary = lifecycle && lifecycle.turnId !== pending.baselineTurnId
    && lifecycle.timestamp !== null && users[0].timestamp !== null
    && lifecycle.timestamp >= users[0].timestamp;
  const done = !!newBoundary && lifecycle.state !== 'working';
  return { text: answer, progress: answer, done,
    ...(done && lifecycle?.state === 'interrupted' ? { failed: 'The Orca terminal turn was interrupted' } : {}) };
}
