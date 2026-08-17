import { describe, expect, it } from 'vitest';
import {
  parseEnvFile,
  resolveMetadataQueryConfig,
  validateMetadataSql,
} from '../src/services/metadata-query.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('metadata-query', () => {
  it('parses metadata env file', () => {
    const vars = parseEnvFile([
      'AGENT_METADATA_CK_ADDR=127.0.0.1:8123',
      'AGENT_METADATA_CK_USERNAME=tester',
      'AGENT_METADATA_CK_PASSWORD=secret',
    ].join('\n'));
    expect(vars.AGENT_METADATA_CK_ADDR).toBe('127.0.0.1:8123');
    expect(vars.AGENT_METADATA_CK_USERNAME).toBe('tester');
    expect(vars.AGENT_METADATA_CK_PASSWORD).toBe('secret');
  });

  it('resolves metadata query config from env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-metadata-'));
    const envFile = join(dir, 'env');
    writeFileSync(envFile, [
      'AGENT_METADATA_CK_ADDR=10.0.0.1:9000',
      'AGENT_METADATA_CK_USERNAME=tester',
      'AGENT_METADATA_CK_PASSWORD=secret',
      'AGENT_METADATA_CK_TIMEOUT_MS=3210',
    ].join('\n'));
    try {
      const cfg = resolveMetadataQueryConfig(envFile);
      expect(cfg.host).toBe('10.0.0.1');
      expect(cfg.port).toBe(9000);
      expect(cfg.username).toBe('tester');
      expect(cfg.password).toBe('secret');
      expect(cfg.database).toBe('ksher_bi_dense');
      expect(cfg.timeoutMs).toBe(3210);
      expect(cfg.envFile).toBe(envFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects AGENT_METADATA_CK_ADDR when it is not host:port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-metadata-'));
    const envFile = join(dir, 'env');
    writeFileSync(envFile, [
      'AGENT_METADATA_CK_ADDR=http://10.0.0.2:8124/meta_db',
      'AGENT_METADATA_CK_USERNAME=tester',
      'AGENT_METADATA_CK_PASSWORD=secret',
    ].join('\n'));
    try {
      expect(() => resolveMetadataQueryConfig(envFile)).toThrow(/expected host:port/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows select from approved metadata table with limit', () => {
    const sql = validateMetadataSql('SELECT table_name FROM s_indicator_dict_detail_info LIMIT 20');
    expect(sql).toContain('FORMAT JSON');
  });

  it('rejects non-select metadata sql', () => {
    expect(() => validateMetadataSql('DELETE FROM s_indicator_dict_detail_info')).toThrow(/only allows SELECT/i);
  });

  it('rejects metadata sql without limit', () => {
    expect(() => validateMetadataSql('SELECT * FROM s_indicator_dict_detail_info')).toThrow(/must include LIMIT/i);
  });

  it('rejects metadata sql when limit exceeds hard cap', () => {
    expect(() => validateMetadataSql('SELECT * FROM s_indicator_dict_detail_info LIMIT 10001')).toThrow(/between 1 and 10000/i);
  });

  it('rejects business tables', () => {
    expect(() => validateMetadataSql('SELECT * FROM dim_kgp_merchant LIMIT 10')).toThrow(/disallowed table/i);
  });

  it('rejects comma joins that include disallowed tables', () => {
    expect(() => validateMetadataSql(
      'SELECT a.table_name FROM ksher_bi_dense.s_indicator_dict_detail_info a, ksher_bi_dense.dim_agent_ck_user_info b LIMIT 1',
    )).toThrow(/disallowed table/i);
  });

  it('rejects CTE metadata sql', () => {
    expect(() => validateMetadataSql(
      'WITH x AS (SELECT * FROM ksher_bi_dense.s_indicator_dict_detail_info LIMIT 1) SELECT * FROM x LIMIT 1',
    )).toThrow(/only allows SELECT|does not allow CTE/i);
  });

  it('rejects subquery sources', () => {
    expect(() => validateMetadataSql(
      'SELECT * FROM (SELECT * FROM ksher_bi_dense.s_indicator_dict_detail_info LIMIT 1) t LIMIT 1',
    )).toThrow(/subquery sources/i);
  });
});
