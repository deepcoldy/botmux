import { describe, expect, it } from 'vitest';
import {
  TRUSTED_IDENTITY_FIELDS,
  mergeTrustedIdentityArgs,
  redactTrustedIdentityFields,
} from '../src/utils/trusted-mcp.js';

describe('trusted-mcp', () => {
  it('keeps the Data MCP hidden identity field list in sync with known aliases', () => {
    expect(TRUSTED_IDENTITY_FIELDS).toEqual(expect.arrayContaining([
      'request_user_union_id',
      'requestUserUnionId',
      'union_id',
      'unionId',
      'request_user_open_id',
      'requestUserOpenId',
      'open_id',
      'openId',
      'request_lark_app_id',
      'requestLarkAppId',
      'lark_app_id',
      'larkAppId',
      'request_app_id',
      'requestAppId',
      'app_id',
      'appId',
    ]));
  });

  it('overrides spoofed identity fields with trusted caller values', () => {
    const result = mergeTrustedIdentityArgs({
      sql: 'select 1',
      request_user_union_id: 'fake-union',
      request_user_open_id: 'fake-open',
      request_lark_app_id: 'fake-app',
      union_id: 'fake-union-2',
      unionId: 'fake-union-3',
      requestAppId: 'fake-app-2',
      appId: 'fake-app-3',
    }, {
      requestUserUnionId: 'real-union',
      requestUserOpenId: 'real-open',
      requestLarkAppId: 'real-app',
    });

    expect(result).toEqual({
      ok: true,
      args: {
        sql: 'select 1',
        request_user_union_id: 'real-union',
        request_user_open_id: 'real-open',
        request_lark_app_id: 'real-app',
      },
    });
  });

  it('strips every model-supplied identity alias from CallTool arguments before injecting trusted identity', () => {
    const spoofedArgs = Object.fromEntries(
      TRUSTED_IDENTITY_FIELDS.map(field => [field, `spoofed-${field}`]),
    );

    const result = mergeTrustedIdentityArgs({
      sql: 'select 1',
      datasource: 'tchouse-c',
      ...spoofedArgs,
    }, {
      requestUserUnionId: 'snapshot-union',
      requestUserOpenId: 'snapshot-open',
      requestLarkAppId: 'snapshot-app',
    });

    expect(result.ok).toBe(true);
    expect(result.args).toEqual({
      sql: 'select 1',
      datasource: 'tchouse-c',
      request_user_union_id: 'snapshot-union',
      request_user_open_id: 'snapshot-open',
      request_lark_app_id: 'snapshot-app',
    });
    for (const field of TRUSTED_IDENTITY_FIELDS) {
      expect(result.args?.[field]).not.toBe(`spoofed-${field}`);
    }
  });

  it('fails closed when trusted union id is missing', () => {
    const result = mergeTrustedIdentityArgs({ sql: 'select 1' }, {
      requestUserOpenId: 'real-open',
      requestLarkAppId: 'real-app',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'missing_trusted_union_id',
      errorMessage: '当前 turn 缺少可信 union_id，拒绝执行 Data MCP 查询',
    });
  });

  it('removes trusted identity fields from visible schemas', () => {
    const schema = redactTrustedIdentityFields({
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          request_user_union_id: { type: 'string' },
          requestUserOpenId: { type: 'string' },
          requestAppId: { type: 'string' },
          nested: {
            type: 'object',
            properties: {
              request_lark_app_id: { type: 'string' },
              appId: { type: 'string' },
              datasource: { type: 'string' },
            },
            required: ['request_lark_app_id', 'appId', 'datasource'],
          },
        },
        required: ['sql', 'request_user_union_id'],
      },
    });

    expect(schema).toEqual({
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          nested: {
            type: 'object',
            properties: {
              datasource: { type: 'string' },
            },
            required: ['datasource'],
          },
        },
        required: ['sql'],
      },
    });
  });
});
