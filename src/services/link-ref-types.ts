export type LinkRefMode = 'disabled' | 'observe' | 'enabled';

export interface LinkRefConfig {
  mode?: LinkRefMode;
}

export interface LinkRefTurnKey {
  appId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}

export interface LinkRefTurnRecord extends Required<LinkRefTurnKey> {
  mode: 'enabled';
  state: 'open' | 'settled' | 'expired';
  createdAtMs: number;
  lastActivityAtMs: number;
  settledAtMs?: number;
  expiresAtMs: number;
}

export type LinkRefSourceType =
  | 'user_message'
  | 'group_context'
  | 'card'
  | 'history'
  | 'quoted'
  | 'attachment'
  | 'tool'
  | 'mcp'
  | 'public_system_doc';

export type LinkRefSourceInput =
  | { sourceType: LinkRefSourceType; kind: 'text'; text: string; sourceId?: string }
  | { sourceType: 'attachment'; kind: 'attachment_text'; path: string; sourceId?: string }
  | { sourceType: LinkRefSourceType; kind: 'structured'; value: unknown; sourceId?: string };

export interface LinkRefCandidate {
  originalUrl: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
}

export interface RegisteredLinkRef {
  refId: `lr_${string}`;
  originalUrl: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
}

export interface LinkRefExtractionStats {
  scannedBytes: number;
  found: number;
  candidateCount: number;
  filteredCredential: number;
  filteredMetadata: number;
  filteredInvalid: number;
}

export interface LinkRefExtractionResult {
  candidates: LinkRefCandidate[];
  stats: LinkRefExtractionStats;
}

export interface LinkRefDiagnostic {
  mode?: LinkRefMode;
  sourceType?: LinkRefSourceType;
  scannedBytes?: number;
  found?: number;
  registered?: number;
  deduplicated?: number;
  filtered?: number;
  limited?: number;
  refId?: string;
  urlHash?: string;
  outcome?: string;
  errorCode?: string;
  refCount?: number;
  durationMs?: number;
}

export type LinkRefLedgerErrorCode =
  | 'link_ref_turn_missing'
  | 'link_ref_turn_not_open'
  | 'link_ref_unknown'
  | 'link_ref_identity_mismatch'
  | 'link_ref_expired'
  | 'link_ref_limit_exceeded'
  | 'link_ref_ledger_unavailable';

export type OutboundLinkRefErrorCode =
  | LinkRefLedgerErrorCode
  | 'expected_link_invalid_after_link_ref';

export interface LinkRefRegistrationResult {
  registered: RegisteredLinkRef[];
  deduplicated: number;
  filteredByLimit: number;
  failure?: LinkRefLedgerErrorCode;
}

export class LinkRefError extends Error {
  readonly code: OutboundLinkRefErrorCode;

  constructor(code: OutboundLinkRefErrorCode, message: string = code) {
    super(message);
    this.name = 'LinkRefError';
    this.code = code;
  }
}

export interface LinkRefTurnEnvelope {
  mode: LinkRefMode;
  sources?: LinkRefSourceInput[];
}

export const LINK_REF_MAX_URLS_PER_TURN = 128;
export const LINK_REF_MAX_URL_BYTES = 8 * 1024;
export const LINK_REF_MAX_TOTAL_URL_BYTES = 512 * 1024;
export const LINK_REF_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LINK_REF_ENV_MODE = 'BOTMUX_LINK_REFS_MODE';
