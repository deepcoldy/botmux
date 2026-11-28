import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomcodeConfigPath,
  atomcodeDataDir,
  detectAtomcodeModels,
  parseAtomcodeConfigModels,
} from '../src/services/atomcode-models.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-atomcode-models-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('atomcodeDataDir', () => {
  it('honors non-empty ATOMCODE_HOME and ignores blank values', () => {
    expect(atomcodeDataDir({ HOME: '/tmp/u', ATOMCODE_HOME: '/opt/atomcode-home' }))
      .toBe('/opt/atomcode-home');
    expect(atomcodeDataDir({ HOME: '/tmp/u', ATOMCODE_HOME: '~/custom-atomcode' }))
      .toBe('/tmp/u/custom-atomcode');
    expect(atomcodeDataDir({ HOME: '/tmp/u', ATOMCODE_HOME: '   ' }))
      .toBe('/tmp/u/.atomcode');
    expect(atomcodeDataDir({ HOME: '/tmp/u' }))
      .toBe('/tmp/u/.atomcode');
  });

  it('resolves config.toml inside the data directory', () => {
    expect(atomcodeConfigPath({ HOME: '/tmp/u', ATOMCODE_HOME: '/opt/ac' }))
      .toBe('/opt/ac/config.toml');
  });
});

describe('parseAtomcodeConfigModels', () => {
  it('merges [models.*] and legacy [providers.*] in sorted order without duplicates', () => {
    const raw = `
default_model = "codingplan/glm-5"

[accounts.codingplan]
type = "openai"

[models."codingplan/glm-5"]
account = "codingplan"
model = "glm-5"

[models.alpha]
account = "codingplan"
model = "alpha-1"

[providers.legacy-claude]
type = "anthropic"
model = "claude-sonnet"

[providers.alpha]
type = "openai"
model = "alpha-legacy"
`;
    expect(parseAtomcodeConfigModels(raw)).toEqual([
      'alpha',
      'codingplan/glm-5',
      'legacy-claude',
    ]);
  });

  it('returns empty list for invalid or empty TOML', () => {
    expect(parseAtomcodeConfigModels('')).toEqual([]);
    expect(parseAtomcodeConfigModels('[broken =')).toEqual([]);
  });
});

describe('detectAtomcodeModels', () => {
  it('reads models from ATOMCODE_HOME/config.toml and returns null when absent or empty', async () => {
    const dir = makeTempDir();
    expect(await detectAtomcodeModels({ env: { ATOMCODE_HOME: dir } })).toBeNull();

    writeFileSync(join(dir, 'config.toml'), 'default_model = "none"\n');
    expect(await detectAtomcodeModels({ env: { ATOMCODE_HOME: dir } })).toBeNull();

    writeFileSync(join(dir, 'config.toml'), `
[models.zeta]
account = "a"
model = "z"

[providers.beta]
type = "openai"
model = "b"
`);
    expect(await detectAtomcodeModels({ env: { ATOMCODE_HOME: dir } })).toEqual(['beta', 'zeta']);
  });
});
