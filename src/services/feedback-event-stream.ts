import type { FeedbackEventEnvelope } from './feedback-outbox.js';

export interface FeedbackEventCursor { after: number; limit: number }
export interface SequencedFeedbackEvent { sequence: number; event: FeedbackEventEnvelope }

export function validateFeedbackEventCursor(input: FeedbackEventCursor): void {
  if (!Number.isSafeInteger(input.after) || input.after < 0 || !Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 1000) throw new Error('feedback_event_cursor_invalid');
}

export const SQLITE_FEEDBACK_STREAM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback_event_stream(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE REFERENCES feedback_events(event_id)
  );
  INSERT OR IGNORE INTO feedback_event_stream(event_id)
    SELECT event_id FROM feedback_events ORDER BY rowid;
  CREATE TRIGGER IF NOT EXISTS feedback_event_stream_insert AFTER INSERT ON feedback_events BEGIN
    INSERT OR IGNORE INTO feedback_event_stream(event_id) VALUES(NEW.event_id);
  END;
`;
