import { describe, expect, it } from 'vitest';
import { parseV3SavedWorkflowCommand } from '../src/im/lark/v3-saved-workflow-command.js';

describe('parseV3SavedWorkflowCommand', () => {
  it('keeps ordinary ad-hoc goals out of the saved-command parser', () => {
    expect(parseV3SavedWorkflowCommand('/workflow 调研竞品并出报告')).toBeNull();
    expect(parseV3SavedWorkflowCommand('/workflow new 调研')).toBeNull();
    expect(parseV3SavedWorkflowCommand('hello')).toBeNull();
  });

  it('parses save last/runId, Unicode name, and global scope', () => {
    expect(parseV3SavedWorkflowCommand('/workflow save')).toEqual({
      kind: 'save', source: 'last', global: false, acknowledgeUnsafeLiterals: false, distill: false,
    });
    expect(parseV3SavedWorkflowCommand('/workflow save report-1 每周 竞品 报告 --global --ack-unsafe')).toEqual({
      kind: 'save', source: 'report-1', displayName: '每周 竞品 报告', global: true,
      acknowledgeUnsafeLiterals: true, distill: false,
    });
    expect(parseV3SavedWorkflowCommand('/workflow save --ack-unsafe')).toEqual({
      kind: 'save', source: 'last', global: false, acknowledgeUnsafeLiterals: true, distill: false,
    });
  });

  it('parses explicit parameter distillation and keeps the multi-word display name', () => {
    expect(parseV3SavedWorkflowCommand('/workflow save report-1 每周 竞品 报告 --distill')).toEqual({
      kind: 'save', source: 'report-1', displayName: '每周 竞品 报告', global: false,
      acknowledgeUnsafeLiterals: false, distill: true,
    });
    expect(parseV3SavedWorkflowCommand('/workflow save --distill 每周 报告')).toEqual({
      kind: 'save', source: 'last', displayName: '每周 报告', global: false,
      acknowledgeUnsafeLiterals: false, distill: true,
    });
  });

  it('rejects unsafe or ambiguous distillation flags without changing exact-save semantics', () => {
    expect(parseV3SavedWorkflowCommand('/workflow save last --distill')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报 --distill --global')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报 --distill --ack-unsafe')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报 --unknown')).toEqual({
      kind: 'save', source: 'last', displayName: '周报 --unknown', global: false,
      acknowledgeUnsafeLiterals: false, distill: false,
    });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报 --distill --unknown'))
      .toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报 --distill=true'))
      .toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow save last 周报')).toEqual({
      kind: 'save', source: 'last', displayName: '周报', global: false,
      acknowledgeUnsafeLiterals: false, distill: false,
    });
  });

  it('parses run params and rejects duplicates/bad tokens', () => {
    expect(parseV3SavedWorkflowCommand('/workflow run 每周 城市 报告 city=上海 dry_run=true')).toMatchObject({
      kind: 'run', ref: '每周 城市 报告', rawParams: { city: '上海', dry_run: 'true' },
    });
    expect(parseV3SavedWorkflowCommand('/workflow run 城市 报告 city="New York" note=\'two words\'')).toMatchObject({
      kind: 'run',
      ref: '城市 报告',
      rawParams: { city: 'New York', note: 'two words' },
    });
    expect(parseV3SavedWorkflowCommand('/workflow run 城市 city="New York')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow run 周报 city=1 city=2')).toMatchObject({ kind: 'invalid' });
    const malformed = parseV3SavedWorkflowCommand('/workflow run 周报 city=1 nope');
    expect(malformed).toMatchObject({ kind: 'invalid' });
    expect(malformed && 'error' in malformed ? malformed.error : '').toContain('/workflow new run ...');
    expect(parseV3SavedWorkflowCommand('/workflow run 周报 __proto__=x')).toMatchObject({ kind: 'invalid' });
  });

  it('parses list and multi-word show names', () => {
    expect(parseV3SavedWorkflowCommand('/workflow list')).toEqual({ kind: 'list' });
    expect(parseV3SavedWorkflowCommand('/workflow show 每周 竞品 报告')).toEqual({
      kind: 'show', ref: '每周 竞品 报告',
    });
    expect(parseV3SavedWorkflowCommand('/workflow list extra')).toMatchObject({ kind: 'invalid' });
  });

  it('reserves cancel for v3 and requires exactly one safe runId', () => {
    expect(parseV3SavedWorkflowCommand('/workflow cancel report-260711-120000-123-deadbeef')).toEqual({
      kind: 'cancel', runId: 'report-260711-120000-123-deadbeef',
    });
    expect(parseV3SavedWorkflowCommand('/workflow cancel')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow cancel ../other')).toMatchObject({ kind: 'invalid' });
    expect(parseV3SavedWorkflowCommand('/workflow cancel r extra')).toMatchObject({ kind: 'invalid' });
  });

  it('reserves the retired v2 resume verb and points to v3 retry/static archive', () => {
    const result = parseV3SavedWorkflowCommand('/workflow resume old-run');
    expect(result).toMatchObject({ kind: 'invalid' });
    const error = result && 'error' in result ? result.error : '';
    expect(error).toContain('resume 已下线');
    expect(error).toContain('/workflow retry');
    expect(error).toContain('静态归档');
  });

  it('treats words before the first key=value as the saved name', () => {
    expect(parseV3SavedWorkflowCommand('/workflow run run the tests and report')).toMatchObject({
      kind: 'run', ref: 'run the tests and report', rawParams: {},
    });
    const missing = parseV3SavedWorkflowCommand('/workflow run');
    expect(missing).toMatchObject({ kind: 'invalid' });
    expect(missing && 'error' in missing ? missing.error : '').toContain('/workflow new run ...');
  });
});
