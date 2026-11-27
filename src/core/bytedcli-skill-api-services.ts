import { boundedText, closedRecord, integer, rejectSkillApi, type SkillApiDescriptor } from './bytedcli-skill-api.js';
export const SERVICE_SKILL_OPERATIONS = Object.freeze([
  ...['selfdo.auth.me', 'selfdo.draft.get', 'argos.duties.get', 'argos.anomalies.list', 'mindai.auth.status', 'mindai.tasks.events', 'oncall.knowledge.search'].map(id => ({ id: `skill-api.${id}`, effect: 'read' as const })),
  ...['selfdo.draft.create', 'selfdo.draft.advance', 'selfdo.draft.turn', 'selfdo.draft.summary', 'selfdo.draft.submit', 'selfdo.creation.advance', 'selfdo.quest.message', 'mindai.tasks.create', 'mindai.tasks.resume', 'mindai.attachment.upload'].map(id => ({ id: `skill-api.${id}`, effect: 'write' as const })),
]);
const resource = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function requireText(value: unknown, max = 65536): void { if (!boundedText(value, max)) rejectSkillApi(); }
function summary(value: unknown): void {
  const r = closedRecord(value, ['flowKind', 'background', 'goal', 'scope', 'unknown']);
  if (!resource(r.flowKind) || JSON.stringify(r).length > 65536) rejectSkillApi();
}
export function describeServiceSkillApi(id: string, value: unknown): SkillApiDescriptor | undefined {
  const op = SERVICE_SKILL_OPERATIONS.find(entry => entry.id === id); if (!op) return undefined;
  const base = { id, effect: op.effect, realm: 'bytecloud' as const, headers: { accept: 'application/json', 'content-type': 'application/json' } };
  const api = (origin: string, path: string, method: 'GET' | 'POST', body?: unknown): SkillApiDescriptor => ({ ...base, url: origin + path, method, ...(body === undefined ? {} : { body }) });
  if (id.startsWith('skill-api.selfdo.')) {
    const origin = 'https://selfdo.bytedance.net/api';
    if (id === 'skill-api.selfdo.auth.me') { closedRecord(value, []); return api(origin, '/auth/me', 'GET'); }
    if (id === 'skill-api.selfdo.draft.get' || id === 'skill-api.selfdo.creation.advance') {
      const creation = id.endsWith('creation.advance'), key = creation ? 'jobId' : 'draftId';
      const r = closedRecord(value, [key]); if (!resource(r[key])) rejectSkillApi();
      return api(origin, `/quest/draft/${creation ? 'creation/' : ''}${r[key]}`, 'GET');
    }
    if (id === 'skill-api.selfdo.draft.create') {
      const r = closedRecord(value, ['bizLine', 'flowKind', 'rawInput', 'idempotencyKey']);
      if (!resource(r.bizLine) || !resource(r.flowKind) || !resource(r.idempotencyKey)) rejectSkillApi(); requireText(r.rawInput);
      return api(origin, '/quest/draft', 'POST', r);
    }
    if (id === 'skill-api.selfdo.quest.message') {
      const r = closedRecord(value, ['questId', 'body']); if (!resource(r.questId)) rejectSkillApi(); requireText(r.body);
      return api(origin, `/quest/${r.questId}/message`, 'POST', { body: r.body });
    }
    const action = id.slice('skill-api.selfdo.draft.'.length);
    const fields: Record<string, string[]> = { advance: ['trigger'], turn: ['clientMessageId', 'expectedRevision', 'questionId', 'optionId', 'additionalText', 'marker', 'idempotencyKey'], summary: ['expectedRevision', 'title', 'summary', 'idempotencyKey'], submit: ['expectedRevision', 'title', 'summary', 'idempotencyKey'] };
    if (!fields[action]) rejectSkillApi();
    const r = closedRecord(value, ['draftId', ...fields[action]!], action === 'submit' ? ['inviteeEmails'] : []);
    if (!resource(r.draftId)) rejectSkillApi();
    if (action === 'advance') { if (r.trigger !== 'poll') rejectSkillApi(); }
    else {
      if (!integer(r.expectedRevision, 0, Number.MAX_SAFE_INTEGER) || !resource(r.idempotencyKey)) rejectSkillApi();
      if (action === 'turn') {
        if (!resource(r.clientMessageId) || ![r.questionId, r.optionId, r.marker].every(v => v === null || boundedText(v, 256))
          || typeof r.additionalText !== 'string' || r.additionalText.length > 65536) rejectSkillApi();
      } else { requireText(r.title, 40); summary(r.summary); }
      if (r.inviteeEmails !== undefined && (!Array.isArray(r.inviteeEmails) || r.inviteeEmails.length > 30 || !r.inviteeEmails.every((v: unknown) => typeof v === 'string' && /^[^\s@]+@[^\s@]+$/.test(v)))) rejectSkillApi();
    }
    const { draftId, ...body } = r;
    return api(origin, `/quest/draft/${draftId}/${action === 'submit' ? 'create' : action}`, 'POST', body);
  }
  if (id === 'skill-api.argos.duties.get') {
    const r = closedRecord(value, ['name']); if (!boundedText(r.name, 128) || !/^[A-Za-z0-9._-]+$/.test(r.name)) rejectSkillApi();
    return api('https://cloud.bytedance.net', `/api/v1/duty_ssr/duty/api/open/duties?limit=1&page=1&name=${encodeURIComponent(r.name)}`, 'GET');
  }
  if (id === 'skill-api.argos.anomalies.list') {
    const r = closedRecord(value, ['body', 'regionGroup']);
    const body = closedRecord(r.body, ['notification_policy_id', 'page_number', 'page_size', 'recovered_at_end', 'recovered_at_start', 'region', 'severity_level', 'sort_by_list', 'space_id', 'status']);
    if (r.regionGroup !== 'cn-north' || !['China-North', 'China-North6'].includes(body.region)
      || !/^[a-f0-9]{24}$/.test(body.space_id) || !Array.isArray(body.notification_policy_id) || body.notification_policy_id.length > 50
      || !body.notification_policy_id.every((v: unknown) => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v))
      || !integer(body.page_number, 1, 100) || body.page_size !== 50 || JSON.stringify(body.sort_by_list) !== '[{"field":"created_at","order":"desc"}]'
      || !Array.isArray(body.severity_level) || !body.severity_level.every((v: unknown) => ['critical', 'warning', 'fatal', 'notice'].includes(v as string))
      || !Array.isArray(body.status) || !body.status.every((v: unknown) => ['triggered', 'recovered'].includes(v as string))) rejectSkillApi();
    const span = Date.parse(body.recovered_at_end) - Date.parse(body.recovered_at_start);
    if (!Number.isFinite(span) || span <= 0 || span > 63 * 86400000) rejectSkillApi();
    return { ...api('https://cloud.bytedance.net', '/api/v1/argos_aiops_fe/aiopsaggr/alert_manager/api/v1/duty/anomalies/list_anomaly', 'POST', body), headers: { ...base.headers,
      origin: 'https://cloud.bytedance.net', referer: `https://cloud.bytedance.net/argos/alarm/space/${body.space_id}`, 'x-argos-alarm-region-group-fe': r.regionGroup, 'x-bcgw-tenant-id': 'bytedance' } };
  }
  if (id === 'skill-api.oncall.knowledge.search') {
    const r = closedRecord(value, ['query', 'directory'], ['topK']); requireText(r.query, 4096);
    if (![69, 71].includes(r.directory) || r.topK !== undefined && !integer(r.topK, 1, 20)) rejectSkillApi();
    return api('mcp://bytedance.mcp.ecom_marketing_rd_platform', '/ecom_marketing_rd_platform_retrieval_knowledge', 'POST', {
      search_condition: { query: r.query, space_ids: [12], leaf_directory_ids: [r.directory], status: [4], top_k: r.topK ?? 5, score: r.directory === 69 ? 0.6 : 0.2 }, search_option: { enable_reranker: true, enable_expand_scope: false },
    });
  }
  const origin = 'https://eops.bytedance.net';
  if (id === 'skill-api.mindai.auth.status') { closedRecord(value, []); return api(origin, '/mindai/wiki/apiai/feishuHasAuth', 'GET'); }
  if (id === 'skill-api.mindai.tasks.events') {
    const r = closedRecord(value, ['taskId'], ['lastEventId']); if (!resource(r.taskId) || r.lastEventId !== undefined && (typeof r.lastEventId !== 'string' || !/^[A-Za-z0-9_.:-]{0,128}$/.test(r.lastEventId))) rejectSkillApi();
    return {...api(origin, '/mindai/deep_research/api/tasks/events', 'POST', {taskId:r.taskId}), headers:{...base.headers, accept:'text/event-stream', 'Last-Event-ID': r.lastEventId ?? ''}};
  }
  if (id === 'skill-api.mindai.tasks.create') {
    const r = closedRecord(value, ['query', 'scene', 'source', 'config'], ['businessPath', 'imageStyleName']); requireText(r.query);
    if (r.scene !== 'lark_whiteboard_gen' || r.source !== 'dr' || closedRecord(r.config, ['client']).client !== 'mindai-chart-generation-skill') rejectSkillApi();
    for (const key of ['businessPath', 'imageStyleName']) if (r[key] !== undefined) requireText(r[key], 1024);
    return api(origin, '/mindai/deep_research/api/tasks', 'POST', r);
  }
  if (id === 'skill-api.mindai.tasks.resume') {
    const r = closedRecord(value, ['taskId', 'response', 'attachmentUrls', 'source'], ['imageStyleName']); requireText(r.response);
    if (!resource(r.taskId) || r.source !== 'chat' || !Array.isArray(r.attachmentUrls) || r.attachmentUrls.length > 20
      || !r.attachmentUrls.every((v: unknown) => typeof v === 'string' && v.length <= 4096 && /^https:\/\//.test(v))) rejectSkillApi();
    if (r.imageStyleName !== undefined) requireText(r.imageStyleName, 1024);
    return api(origin, '/mindai/deep_research/api/tasks/resume', 'POST', r);
  }
  // Agent bytes are encoded only into the audited JSON attachment shape.
  if (id === 'skill-api.mindai.attachment.upload') {
    const r = closedRecord(value, ['name', 'mimeType', 'dataBase64']);
    if (!boundedText(r.name, 255) || /[\/\\\x00-\x1f\x7f]/.test(r.name) || typeof r.mimeType !== 'string' || !/^[A-Za-z0-9.+_-]{1,64}\/[A-Za-z0-9.+_-]{1,64}$/.test(r.mimeType)
      || typeof r.dataBase64 !== 'string' || r.dataBase64.length > 2 * 1024 * 1024 - 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(r.dataBase64)) rejectSkillApi();
    return api(origin, '/mindai/wiki/apiai/uploadAttachment', 'POST', {attachment:{type:r.mimeType.startsWith('image/')?'image':'file',key:r.name,content:`data:${r.mimeType};base64,${r.dataBase64}`,metadata:{name:r.name,size:r.dataBase64.length / 4 * 3 - (r.dataBase64.endsWith('==') ? 2 : r.dataBase64.endsWith('=') ? 1 : 0),type:r.mimeType}}});
  }
  rejectSkillApi();
}
