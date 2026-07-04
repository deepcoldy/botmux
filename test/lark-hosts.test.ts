/**
 * Unit tests for lark-hosts: the single source of truth for Feishu (China) vs
 * Lark (international) host derivation.
 *
 * Run:  pnpm vitest run test/lark-hosts.test.ts
 */
import { describe, it, expect } from 'vitest';
import { larkHosts, normalizeBrand, sdkDomain, chatAppLink } from '../src/im/lark/lark-hosts.js';

describe('lark-hosts', () => {
  describe('normalizeBrand', () => {
    it('passes the exact string "lark" through', () => {
      expect(normalizeBrand('lark')).toBe('lark');
    });
    it('defaults missing / unknown / non-string values to feishu (backward compat)', () => {
      expect(normalizeBrand('feishu')).toBe('feishu');
      expect(normalizeBrand(undefined)).toBe('feishu');
      expect(normalizeBrand(null)).toBe('feishu');
      expect(normalizeBrand('')).toBe('feishu');
      expect(normalizeBrand('Lark')).toBe('feishu'); // exact-match only, no case folding
      expect(normalizeBrand(42)).toBe('feishu');
    });
  });

  describe('larkHosts', () => {
    it('returns the feishu (China) host triad', () => {
      expect(larkHosts('feishu')).toEqual({
        openApi: 'https://open.feishu.cn',
        accounts: 'https://accounts.feishu.cn',
        applink: 'applink.feishu.cn',
      });
    });
    it('returns the lark (international) host triad', () => {
      expect(larkHosts('lark')).toEqual({
        openApi: 'https://open.larksuite.com',
        accounts: 'https://accounts.larksuite.com',
        applink: 'applink.larksuite.com',
      });
    });
    it('defaults to feishu when brand is omitted', () => {
      expect(larkHosts().openApi).toBe('https://open.feishu.cn');
    });
  });

  describe('sdkDomain', () => {
    it('returns the openApi base per brand (equivalent to SDK Domain enum)', () => {
      expect(sdkDomain('feishu')).toBe('https://open.feishu.cn');
      expect(sdkDomain('lark')).toBe('https://open.larksuite.com');
    });
    it('defaults to feishu', () => {
      expect(sdkDomain()).toBe('https://open.feishu.cn');
    });
  });

  describe('chatAppLink', () => {
    it('builds a feishu client AppLink', () => {
      expect(chatAppLink('oc_abc', 'feishu')).toBe(
        'https://applink.feishu.cn/client/chat/open?openChatId=oc_abc',
      );
    });
    it('builds a lark client AppLink', () => {
      expect(chatAppLink('oc_abc', 'lark')).toBe(
        'https://applink.larksuite.com/client/chat/open?openChatId=oc_abc',
      );
    });
    it('URL-encodes the chatId', () => {
      expect(chatAppLink('oc a/b', 'lark')).toContain('openChatId=oc%20a%2Fb');
    });
    it('defaults to the feishu applink host', () => {
      expect(chatAppLink('oc_x')).toContain('applink.feishu.cn');
    });
  });
});
