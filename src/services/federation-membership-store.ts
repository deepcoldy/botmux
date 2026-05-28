/**
 * Federation membership store (SPOKE side): which remote teams THIS deployment
 * has joined, and the syncToken/hub needed to push bots + pull the shared roster.
 *
 * Storage: `{dataDir}/federation-memberships.json`, atomic writes. Keyed by
 * `${hubUrl}::${teamId}` so a deployment can join multiple teams / hubs.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RemoteMembership {
  hubUrl: string;
  teamId: string;
  teamName: string;
  syncToken: string;
  deploymentId: string;
  joinedAt: number;
  /** Token THIS spoke issued to the hub at join; the hub presents it on
   *  delegate-group calls so we can verify the request came from a hub we joined. */
  delegationToken?: string;
}

type FileShape = Record<string, RemoteMembership>; // key = `${hubUrl}::${teamId}`

function filePath(dataDir: string): string {
  return join(dataDir, 'federation-memberships.json');
}

function keyOf(hubUrl: string, teamId: string): string {
  return `${hubUrl}::${teamId}`;
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt */ }
  return {};
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Record (or replace) a remote-team membership. */
export function addMembership(dataDir: string, m: Omit<RemoteMembership, 'joinedAt'> & { joinedAt?: number }, now: number = Date.now()): RemoteMembership {
  const data = readFile(dataDir);
  const full: RemoteMembership = { ...m, joinedAt: m.joinedAt ?? now };
  data[keyOf(m.hubUrl, m.teamId)] = full;
  writeFileAtomic(dataDir, data);
  return full;
}

/** All remote teams this deployment has joined. */
export function listMemberships(dataDir: string): RemoteMembership[] {
  return Object.values(readFile(dataDir));
}

/** Find the membership whose delegationToken matches (verifies an incoming
 *  hub→spoke delegate call came from a hub this deployment actually joined). */
export function findMembershipByDelegationToken(dataDir: string, token: string): RemoteMembership | null {
  if (!token) return null;
  return Object.values(readFile(dataDir)).find(m => m.delegationToken === token) ?? null;
}

/** Remove one membership. Returns true if removed. */
export function removeMembership(dataDir: string, hubUrl: string, teamId: string): boolean {
  const data = readFile(dataDir);
  const key = keyOf(hubUrl, teamId);
  if (!data[key]) return false;
  delete data[key];
  writeFileAtomic(dataDir, data);
  return true;
}
