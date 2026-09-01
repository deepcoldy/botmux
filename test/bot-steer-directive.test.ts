import { describe, expect, it } from 'bun:test';
import {
  parseBotSteerDirective,
  withBotSteerDirective,
} from '../src/core/bot-steer-directive.js';

describe('parseBotSteerDirective', () => {
  it('consumes a standalone leading directive', () => {
    expect(parseBotSteerDirective('@steer\nadjust the current task')).toEqual({
      requested: true,
      content: 'adjust the current task',
    });
  });

  it('consumes an inline directive after a leading recipient line', () => {
    expect(parseBotSteerDirective('@TargetBot（coder）\n\n@steer use the new API')).toEqual({
      requested: true,
      content: '@TargetBot（coder）\n\nuse the new API',
    });
  });

  it('does not treat prose or a similar handle as a directive', () => {
    for (const content of [
      'please explain @steer behavior',
      '@steering\nkeep queued',
      'normal bot-to-bot message',
    ]) {
      expect(parseBotSteerDirective(content)).toEqual({ requested: false, content });
    }
  });

  it('adds the directive idempotently for sender-side convenience flags', () => {
    expect(withBotSteerDirective('adjust the current task'))
      .toBe('@steer\nadjust the current task');
    expect(withBotSteerDirective('@steer adjust the current task'))
      .toBe('@steer adjust the current task');
  });
});
