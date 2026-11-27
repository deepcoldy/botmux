import { describe, expect, it } from 'vitest';
import { parseBytedcliOperation, BYTEDCLI_OPERATION_CATALOG } from '../src/core/bytedcli-operation-policy.js';

export const esQuery = { size: 0, query: { bool: { filter: [{ term: { entity_status: 6 } }, { range: { entity_end_time: { gt: 1800000000 } } }] } }, aggs: { '字段值分布': { terms: { field: 'is_gift', size: 20 } } } };
export const skillArgs = (id: string, request: unknown) => ['--json', 'skill-api', id, '--request', JSON.stringify(request)];
export const esArgs = (query: unknown = esQuery) => ['es', 'search', '--psm', 'byte.es.market_pick', '--idc', 'lf', '--index', 'udc_picko_record', '--method', 'GET', '--query', JSON.stringify(query), '--size', '0', '-j'];
describe('closed final Skill API grammar', () => {
  it('does not treat argument values as managed command names', async () => {
    const { matchSkillApi } = await import('../src/core/bytedcli-skill-api.js');
    expect(matchSkillApi(['codebase', 'mr', 'create', '--title', 'skill-api'])).toBeUndefined();
    expect(matchSkillApi(['codebase', 'mr', 'create', '--source-branch', 'es', '--title', 'search'])).toBeUndefined();
    expect(matchSkillApi(['es', 'search', '--psm', 'other', '--index', 'other', '--unreviewed', 'x'])).toBeUndefined();
  });
  it('recognizes equals syntax for the exact ES destination', () => {
    expect(parseBytedcliOperation(esArgs().flatMap((arg, index, args) => arg === '--psm' ? [`--psm=${args[index+1]}`] : args[index-1] === '--psm' ? [] : [arg])).id).toBe('es.search.picko-tag-distribution');
  });
  it('accepts staged request bytes above argv size without reading host paths', () => {
    const request = { name: 'chart.png', mimeType: 'image/png', dataBase64: Buffer.alloc(90000, 1).toString('base64') };
    const args = ['skill-api', 'mindai.attachment.upload', '--body-file', 'input0'];
    const inputs = { files: [{ id: 'input0', dataBase64: Buffer.from(JSON.stringify(request)).toString('base64') }] };
    const op = parseBytedcliOperation(args, inputs);
    expect(op).toMatchObject({id:'skill-api.mindai.attachment.upload', effect:'write'});
    expect(op.stagedInputs[0]?.dataBase64).toBe(inputs.files[0]!.dataBase64);
    expect(parseBytedcliOperation(op.argv, inputs)).toEqual(op);
    expect(() => parseBytedcliOperation(['skill-api','mindai.attachment.upload','--body-file','/etc/passwd'])).toThrow();
  });
  it('preserves MindAI original attachment names and generic MIME files', () => {
    expect(parseBytedcliOperation(skillArgs('mindai.attachment.upload', {name:'设计参考.txt',mimeType:'text/plain',dataBase64:'YQ=='})).effect).toBe('write');
  });
  it.each([
    ['bits.release.get', { ticketId: '123' }, 'read'],
    ['bits.release.tasks.list', { ticketId: '123', workspaceId: '456', page: 1 }, 'read'],
    ['bits.release.owner.update', { ticketId: '123', version: '7', releaseApprovers: ['alice'] }, 'write'],
  ])('classifies %s by final effect and canonicalizes reparse', (id, request, effect) => {
    const op = parseBytedcliOperation(skillArgs(id as string, request));
    expect(op).toMatchObject({ id: `skill-api.${id}`, effect, execution: 'host-api' });
    expect(parseBytedcliOperation(op.argv)).toEqual(op);
    expect(BYTEDCLI_OPERATION_CATALOG.find(entry => entry.id === op.id)?.effect).toBe(effect);
  });
  it('recognizes selected ES as exact host read with native syntax', () => {
    const op = parseBytedcliOperation(esArgs());
    expect(op).toMatchObject({ id: 'es.search.picko-tag-distribution', effect: 'read', execution: 'host-api' });
    expect(parseBytedcliOperation(op.argv)).toEqual(op);
  });
  it.each([
    { ticketId: '123', url: 'https://evil.test' }, { ticketId: '../1' }, { ticketId: '123', headers: {} },
    { ticketId: '123', method: 'DELETE' }, { ticketId: '123', jwt: 'secret' },
  ])('rejects target/credential selectors %#', request => expect(() => parseBytedcliOperation(skillArgs('bits.release.get', request))).toThrow());
  it.each([{ ...esQuery, script: 'mutate' }, { ...esQuery, size: 1 }, { ...esQuery, query: { match_all: {} } }])('rejects ES query widening %#', query => expect(() => parseBytedcliOperation(esArgs(query))).toThrow());
});

it.each([
 ['selfdo.auth.me', {}, 'read'],
 ['selfdo.draft.get', {draftId:'draft-1'}, 'read'],
 ['selfdo.creation.advance', {jobId:'job-1'}, 'write'],
 ['selfdo.draft.create', {bizLine:'mix',flowKind:'dev',rawInput:'fix',idempotencyKey:'key-1'}, 'write'],
 ['argos.duties.get', {name:'mix.platform.rd'}, 'read'],
 ['mindai.tasks.create', {query:'chart',scene:'lark_whiteboard_gen',source:'dr',config:{client:'mindai-chart-generation-skill'}}, 'write'],
 ['mindai.tasks.events', {taskId:'task-1'}, 'read'],
 ['oncall.knowledge.search', {query:'question',directory:69}, 'read'],
])('classifies %s by effect', (id, body, effect) => {
 const op=parseBytedcliOperation(skillArgs(id as string,body));
 expect(op).toMatchObject({id:`skill-api.${id}`,execution:'host-api',effect});
});

it.each([
 ['get','slardar.web.data.get.mix-profile',['--ev-type','view','--dh-key','event_1']],
 ['session-list','slardar.web.data.session-list.mix-profile',['--session-id','session_1','--start-time','1800000000','--end-time','1800000300']],
])('preserves selected C4 data %s via closed native scope', (command,id,flags) => {
 const op=parseBytedcliOperation(['--json','slardar','web','data',command as string,'--origin','https://slardar.bytedance.net','--bid','mix_h5','--env','production','--site-type','web',...(flags as string[])]);
 expect(op).toMatchObject({id,effect:'read',execution:'isolated-native'});
});

it('refuses coerced owner array types in the release write body',()=>expect(()=>parseBytedcliOperation(skillArgs('bits.release.owner.update',{ticketId:'123',version:'1',releaseApprovers:[['alice']]}))).toThrow());
