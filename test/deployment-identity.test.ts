/**
 * Deployment identity: stable id; a corrupt file is quarantined (not overwritten by a fresh identity).
 * Run: npx vitest run --project unit test/deployment-identity.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeploymentIdentity, setDeploymentOwner } from '../src/services/deployment-identity.js';
import { logger } from '../src/utils/logger.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-deployment-identity-'));
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const corruptFiles = () => readdirSync(dataDir).filter(f => f.startsWith('deployment-identity.json.corrupt-'));

describe('deployment-identity', () => {
  it('generates once, then returns the same identity; format is 2-space JSON + trailing newline', () => {
    const a = getDeploymentIdentity(dataDir);
    expect(a.deploymentId).toMatch(/^dep_/);
    expect(getDeploymentIdentity(dataDir)).toEqual(a);
    expect(readFileSync(join(dataDir, 'deployment-identity.json'), 'utf-8')).toBe(JSON.stringify(a, null, 2) + '\n');
    expect(corruptFiles()).toEqual([]);
  });

  it('a corrupt file is quarantined (original bytes kept) before a fresh identity is written', () => {
    const corrupt = '{"deploymentId":"dep_original","ownerUnionId":"on_1","na';
    writeFileSync(join(dataDir, 'deployment-identity.json'), corrupt);

    const fresh = getDeploymentIdentity(dataDir);
    expect(fresh.deploymentId).not.toBe('dep_original');
    expect(getDeploymentIdentity(dataDir)).toEqual(fresh); // new identity is persisted and stable

    expect(corruptFiles()).toHaveLength(1);
    expect(readFileSync(join(dataDir, corruptFiles()[0]), 'utf-8')).toBe(corrupt);
  });

  it('valid JSON without a deploymentId counts as corrupt too (owner binding kept in the quarantined copy)', () => {
    const orphan = JSON.stringify({ name: 'x', ownerUnionId: 'on_9' });
    writeFileSync(join(dataDir, 'deployment-identity.json'), orphan);
    const id = setDeploymentOwner(dataDir, { unionId: 'on_2', name: 'Alice' });
    expect(id.ownerUnionId).toBe('on_2');
    expect(readFileSync(join(dataDir, corruptFiles()[0]), 'utf-8')).toBe(orphan);
  });
});
