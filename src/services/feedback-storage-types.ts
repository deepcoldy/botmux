export interface PostgresTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
  passwordRef: string;
  tls: { mode: 'verify-full' | 'disable'; caRef?: string };
  connectTimeoutMs: number;
}

export type FeedbackStorageTarget =
  | { backend: 'sqlite' }
  | { backend: 'postgresql'; postgres: PostgresTarget };

export interface FeedbackStorageConfig {
  version: 1;
  generation: number;
  instanceId: string;
  active: FeedbackStorageTarget;
  candidate?: FeedbackStorageTarget;
}
