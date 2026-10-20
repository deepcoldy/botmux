/**
 * Federation membership store (SPOKE side): which remote teams THIS deployment
 * has joined, and the syncToken/hub needed to push bots + pull the shared roster.
 *
 * Storage: `{dataDir}/federation-memberships.json`, atomic writes. Keyed by
 * `${hubUrl}::${teamId}` so a deployment can join multiple teams / hubs.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

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
  // 损坏的文件被隔离为 .corrupt-*（而不是被下一次写入覆盖），见 utils/json-file.ts。
  return readJsonFileSoft<FileShape>(filePath(dataDir), {
    fallback: () => ({}),
    validate: isJsonObject,
    label: 'federation-membership-store',
  });
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n', { followTargetSymlink: false });
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
