import { afterEach, describe, expect, it } from 'vitest';
import { parseSetupEntry, withoutLangArgs } from '../src/setup/platform-entry.js';
import { getDefaultLocale, setDefaultLocale, shippedText, type Locale } from '../src/i18n/index.js';

const initialLocale = getDefaultLocale();
afterEach(() => setDefaultLocale(initialLocale));

describe('统一 setup 平台入口', () => {
  it('不带 --platform 时不选平台（走飞书流程），飞书脚本操作保持原参数', () => {
    expect(parseSetupEntry([])).toMatchObject({ platform: undefined, scripted: false });
    for (const action of ['list', 'add', 'configure', 'edit', 'remove', 'help']) {
      expect(parseSetupEntry([action, '--lang', 'en'])).toMatchObject({ platform: undefined, args: [action, '--lang', 'en'], scripted: true });
    }
    expect(parseSetupEntry(['--platform=feishu', '--lang=en'])).toMatchObject({ platform: 'lark', scripted: false });
    expect(parseSetupEntry(['--platform', 'lark', 'list'])).toMatchObject({ platform: 'lark', args: ['list'], scripted: true });
  });
  it('企微默认扫码，手工入口和已有凭据flags保留', () => {
    expect(parseSetupEntry(['--platform', 'wecom', '--cli', 'codex'])).toMatchObject({ platform: 'wecom', manual: false, args: ['--cli', 'codex'] });
    expect(parseSetupEntry(['--platform=wecom', '--manual'])).toMatchObject({ manual: true, args: [] });
    expect(parseSetupEntry(['--platform=wecom', '--secret-file', '/private/input', '--allow-user', 'real'])).toMatchObject({ manual: true });
    expect(parseSetupEntry(['--lang', 'en', '--platform=wecom'])).toMatchObject({ scripted: false, args: ['--lang', 'en'] });
  });
  it('交互 --lang 只用于分类与企微流程，两种写法都被去掉', () => {
    expect(withoutLangArgs(['--lang', 'en', '--cli', 'codex', '--lang=zh'])).toEqual(['--cli', 'codex']);
  });
  it.each([
    { args: ['--platform'], key: 'setup.platform.error_invalid' },
    { args: ['--platform=no'], key: 'setup.platform.error_invalid' },
    { args: ['--platform=lark', '--platform=wecom'], key: 'setup.platform.error_duplicate' },
    { args: ['--manual'], key: 'setup.platform.error_manual_requires_wecom' },
    { args: ['--platform', 'feishu', '--manual'], key: 'setup.platform.error_manual_requires_wecom' },
  ])('非法平台参数不进入任何向导，报错随界面语言：$args', ({ args, key }) => {
    for (const locale of ['zh', 'en'] as Locale[]) {
      setDefaultLocale(locale);
      expect(() => parseSetupEntry(args)).toThrow(shippedText(key, locale));
    }
  });
});
