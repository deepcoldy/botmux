/**
 * Names of the nine feedback tables, shared by the SQLite freeze/restore path,
 * the snapshot/verification path and the PostgreSQL schema.
 *
 * This module intentionally has NO runtime dependencies — in particular it must
 * not import `pg`. The daemon and `botmux send` load the maintenance/admission
 * code on every startup while the default backend is SQLite, and a static
 * transitive import of `pg` here would make the whole CLI fail at module load
 * when the optional PostgreSQL dependency is not installed.
 */
export const FEEDBACK_TABLES = [
  'interactions', 'skill_runs', 'responses', 'deliveries', 'feedback_revisions',
  'turn_terminals', 'turn_completion_events', 'feedback_events', 'feedback_outbox',
] as const;
