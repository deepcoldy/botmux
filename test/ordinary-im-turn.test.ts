/**
 * ordinary-turn 投递协议的 turnId 前缀族：worker 去重、daemon 投递追踪、冷启动
 * preload 三处都靠它识别普通回合。以后再开新前缀时三处必须同时认得——这个纯函数
 * 是唯一判定点，这里钉住三个成员与边界形状。
 */
import { describe, expect, it } from 'vitest';
import { isOrdinaryImTurnId } from '../src/core/ordinary-im-turn.js';

describe('isOrdinaryImTurnId', () => {
  it('认 om_ / bmx-recovery- / board: 三种前缀', () => {
    expect(isOrdinaryImTurnId('om_abc123')).toBe(true);
    expect(isOrdinaryImTurnId('bmx-recovery-550e8400')).toBe(true);
    expect(isOrdinaryImTurnId('board:cli_steward:42')).toBe(true);
  });

  it('其它前缀（定时任务、schedule-run、queued 等）和空值都不认', () => {
    expect(isOrdinaryImTurnId('schedule:abc:1')).toBe(false);
    expect(isOrdinaryImTurnId('schedule-run:x:y')).toBe(false);
    expect(isOrdinaryImTurnId('queued-activation-followup-1')).toBe(false);
    expect(isOrdinaryImTurnId('admitted-turn-uuid')).toBe(false);
    expect(isOrdinaryImTurnId('')).toBe(false);
    expect(isOrdinaryImTurnId(undefined)).toBe(false);
    expect(isOrdinaryImTurnId(null)).toBe(false);
  });

  it('只认前缀，不替调用方校验后续形状（board 的批次形状由 parseBoardTurnId 负责）', () => {
    expect(isOrdinaryImTurnId('board:')).toBe(true);
    expect(isOrdinaryImTurnId('omx')).toBe(false);
  });
});
