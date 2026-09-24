import type { PrincipalLaneDispatchAuthority } from '../core/principal-lane-dispatch.js';
import type { PrincipalLaneDurableRecordLocator } from './message-queue.js';

declare const principalLaneAdmissionTicketCapabilityBrand: unique symbol;

/** Opaque admission claim produced only after the durable ticket row, group
 * lease and current dispatch authority have been verified. A has no issuer;
 * the B-E admission checkpoint will own that registry. */
export interface PrincipalLaneAdmissionTicketCapability {
  readonly version: 1;
  readonly [principalLaneAdmissionTicketCapabilityBrand]: true;
}

declare const verifiedPrincipalLaneTicketRecordBrand: unique symbol;

/** Opaque resolver output. Callers cannot supply its locator directly; the
 * resolver owns both issuance and extraction. */
export interface VerifiedPrincipalLaneTicketRecord {
  readonly version: 1;
  readonly [verifiedPrincipalLaneTicketRecordBrand]: true;
}

export type PrincipalLaneTicketRecordResolution =
  | { status: 'ready'; value: VerifiedPrincipalLaneTicketRecord }
  | { status: 'invalid'; reason: 'invalid_ticket_capability' };

/** Production seam intentionally has no issuer in checkpoint A. The durable
 * admission store will replace this fail-closed implementation in B-E. */
export function resolvePrincipalLaneTicketRecord(
  _ticket: PrincipalLaneAdmissionTicketCapability,
  _authority: PrincipalLaneDispatchAuthority,
): PrincipalLaneTicketRecordResolution {
  return { status: 'invalid', reason: 'invalid_ticket_capability' };
}

/** Only a resolver-issued opaque claim may reveal a locator. Checkpoint A has
 * no production claims, so structural lookalikes always fail. */
export function principalLaneTicketRecordLocator(
  _record: VerifiedPrincipalLaneTicketRecord,
): Readonly<PrincipalLaneDurableRecordLocator> | undefined {
  return undefined;
}
