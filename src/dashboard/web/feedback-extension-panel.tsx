import { useEffect, useRef, useState } from 'react';
import { sendJson } from './dashboard-api.js';
import { FeedbackTemplatePreview } from './feedback-template-preview.js';

export function FeedbackExtensionPanel(props: { appId: string }) {
  const [config, setConfig] = useState<any>();
  const [presentation, setPresentation] = useState('{}');
  const [templates, setTemplates] = useState('[]');
  const [hooks, setHooks] = useState('[]');
  const [actions, setActions] = useState('[]');
  const [subscriptions, setSubscriptions] = useState('[]');
  const [chatId, setChatId] = useState('');
  const [sourceMessageId, setSourceMessageId] = useState('');
  const [round, setRound] = useState(1);
  const [width, setWidth] = useState(360);
  const [result, setResult] = useState('');
  const [statusPreview, setStatusPreview] = useState('');
  const [editingTemplateId, setEditingTemplateId] = useState('default');
  const [preview, setPreview] = useState<any>();
  const [error, setError] = useState('');
  const [executions, setExecutions] = useState<any[]>([]);
  const request = useRef(0);
  async function reload() {
    const response = await fetch('/api/feedback/extensions');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setConfig(body); setTemplates(JSON.stringify(body.templates, null, 2));
    setPresentation(JSON.stringify(body.presentations[props.appId] ?? { default: { enabled: false }, rules: [] }, null, 2));
    setHooks(JSON.stringify(body.hooks, null, 2)); setActions(JSON.stringify(body.actions, null, 2));
    setSubscriptions(JSON.stringify(body.subscriptions ?? [], null, 2));
  }
  useEffect(() => { void reload().catch(error => setError(String(error))); }, [props.appId]);
  useEffect(() => {
    const sequence = ++request.current;
    const timer = setTimeout(() => {
      if (!config) return;
      void (async () => {
        try {
          const response = await sendJson('POST', '/api/feedback/extensions/preview', {
            appId: props.appId, chatId, sourceMessageId, round, presentation: JSON.parse(presentation),
            templates: JSON.parse(templates), state: result ? { result } : {},
            status: statusPreview,
          });
          if (sequence !== request.current) return;
          if (!response.ok) throw new Error(response.body.error);
          setPreview(response.body); setError('');
        } catch (error) { if (sequence === request.current) setError(String(error)); }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [config, presentation, templates, chatId, sourceMessageId, round, result, statusPreview, props.appId]);
  function updateTemplate(field: string, value: string) {
    try {
      const parsed = JSON.parse(templates);
      setTemplates(JSON.stringify(parsed.map((template: any) => {
        if (template.id !== editingTemplateId) return template;
        if (field === 'buttonLayout') return { ...template, elements: template.elements.map((element: any) =>
          element.slot === 'feedbackButtons' ? { ...element, layout: value } : element) };
        return { ...template, [field]: value };
      }), null, 2));
    } catch (error) { setError(String(error)); }
  }
  let editableTemplates: any[] = [];
  try { const parsed = JSON.parse(templates); if (Array.isArray(parsed)) editableTemplates = parsed; } catch {}
  const selectedTemplate = editableTemplates.find(template => template.id === editingTemplateId);
  async function save(kind: 'hooks' | 'presentation' | 'subscriptions', confirmed = false) {
    try {
      const body = kind === 'hooks' ? { hooks: JSON.parse(hooks), actions: JSON.parse(actions), subscriptions: JSON.parse(subscriptions), confirmed }
        : kind === 'subscriptions' ? { subscriptions: JSON.parse(subscriptions) }
          : { appId: props.appId, templates: JSON.parse(templates), presentation: JSON.parse(presentation), actions: JSON.parse(actions) };
      const response = await sendJson('POST', `/api/feedback/extensions/${kind}`, { ...body, expectedVersion: config.version });
      if (!response.ok) throw new Error(response.body.error);
      await reload(); setError('');
    } catch (error) { setError(String(error)); }
  }
  async function loadExecutions() {
    try {
      const response = await fetch(`/api/feedback/extensions/executions?appId=${encodeURIComponent(props.appId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setExecutions(body.items);
    } catch (error) { setError(String(error)); }
  }
  async function reconcile(jobId: string, outcome: 'succeeded' | 'failed_before_effect') {
    const evidence = window.prompt('请填写已核对的业务回执或确认未执行的证据。此操作不会重新执行脚本。');
    if (!evidence?.trim()) return;
    if (!window.confirm(outcome === 'succeeded' ? '确认已有业务回执证明操作成功？' : '确认外部操作没有发生？核对后用户才能重新请求。')) return;
    const response = await sendJson('POST', '/api/feedback/extensions/reconcile', { jobId, outcome, evidence, confirmed: true });
    if (!response.ok) setError(response.body.error ?? '状态已变化，请刷新');
    await loadExecutions();
  }
  async function reconcileSurface(jobId: string) {
    const messageId = window.prompt('已发送反馈卡的消息 ID（服务端将核验应用、群、原问题及卡片内容）：');
    const evidence = messageId ? window.prompt('填写定位到该消息的回执依据：') : null;
    if (!messageId || !evidence?.trim()) return;
    const response = await sendJson('POST', '/api/feedback/extensions/reconcile-surface', { jobId, messageId, evidence, confirmed: true });
    if (!response.ok) setError(response.body.error ?? '回执未核实，保留未知状态');
    await loadExecutions();
  }
  if (!config) return <p role="status">{error || '正在加载反馈扩展配置…'}</p>;
  return <details className="bd-feedback-advanced"><summary>独立反馈卡、模板预览与 Hook</summary>
    <p>草稿预览不发消息、不保存反馈、不执行脚本。配置版本：{config.version}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      <div style={{ flex: '1 1 380px' }}>
        <label>群 ID<input value={chatId} onChange={event => setChatId(event.target.value)} /></label>
        <label>原始卡片 ID<input value={sourceMessageId} onChange={event => setSourceMessageId(event.target.value)} /></label>
        <label>回复轮次<input type="number" min={1} value={round} onChange={event => setRound(Number(event.target.value))} /></label>
        <label>展示规则 JSON<textarea rows={8} value={presentation} onChange={event => setPresentation(event.target.value)} /></label>
        <fieldset><legend>卡片样式</legend>
          <label>编辑模板<select value={editingTemplateId} onChange={event => setEditingTemplateId(event.target.value)}>
            {editableTemplates.map(template => <option key={template.id} value={template.id}>{template.id}</option>)}
          </select></label>
          <label>标题<input value={selectedTemplate?.title ?? ''} onChange={event => updateTemplate('title', event.target.value)} /></label>
          <label>主题<select value={selectedTemplate?.theme ?? 'blue'} onChange={event => updateTemplate('theme', event.target.value)}>
            {['blue', 'green', 'red', 'orange', 'purple', 'grey', 'indigo', 'turquoise'].map(theme => <option key={theme}>{theme}</option>)}
          </select></label>
          <label>间距<select value={selectedTemplate?.density ?? 'compact'} onChange={event => updateTemplate('density', event.target.value)}>
            <option value="compact">紧凑</option><option value="comfortable">宽松</option>
          </select></label>
          <label>按钮排列<select value={selectedTemplate?.elements?.find((element: any) => element.slot === 'feedbackButtons')?.layout ?? 'horizontal'} onChange={event => updateTemplate('buttonLayout', event.target.value)}>
            <option value="horizontal">横排</option><option value="vertical">竖排</option>
          </select></label>
        </fieldset>
        <label>自定义模板 JSON<textarea rows={10} value={templates} onChange={event => setTemplates(event.target.value)} /></label>
        <button type="button" onClick={() => void save('presentation')}>保存规则与模板</button>
      </div>
      <div>
        <label>宽度<select value={width} onChange={event => setWidth(Number(event.target.value))}><option value={360}>窄屏</option><option value={640}>宽屏</option></select></label>
        <label>模拟反馈<select value={result} onChange={event => setResult(event.target.value)}><option value="">未选择</option>{preview?.buttons?.map((button: { key: string; label: string }) => <option key={button.key} value={button.key}>{button.label}</option>)}</select></label>
        <label>模拟动作状态<select value={statusPreview} onChange={event => setStatusPreview(event.target.value)}>
          <option value="">未执行</option><option>处理中</option><option>操作成功</option><option>执行失败</option><option>结果未知，等待核对</option>
        </select></label>
        <p>{error ? '上次有效预览（当前草稿有错误）' : '当前草稿预览'} · {preview?.presentation.matched ? '本轮命中规则' : '本轮不发独立卡'}</p>
        {preview && <FeedbackTemplatePreview card={preview.card} width={width} />}
      </div>
    </div>
    <p role="alert">{error}</p>
    <details><summary>Hook 注册与按钮绑定</summary>
      <p>脚本运行宿主：{config.hostId}。保存不是执行。新建请设 enabled:false。</p>
      <label>评价提交订阅 JSON（appId、chatId、buttonKey、hookId）<textarea rows={6} value={subscriptions} onChange={event => setSubscriptions(event.target.value)} /></label>
      <button type="button" onClick={() => void save('subscriptions')}>保存已授权 Hook 的订阅</button>
      <label>动作与已批准 Hook 绑定<textarea rows={6} value={actions} onChange={event => setActions(event.target.value)} /></label>
      <button type="button" onClick={() => void save('presentation')}>保存动作绑定与展示规则</button>
      {config.hostAdmin ? <>
        <label>Hook 注册 JSON（命令数组、cwd、作用域、timeoutMs、concurrency、envRefs）<textarea rows={12} value={hooks} onChange={event => setHooks(event.target.value)} /></label>
        <button type="button" onClick={() => void save('hooks')}>保存 Hook 配置</button>
        <button type="button" onClick={() => { if (window.confirm(`将在 ${config.hostId} 启用所编辑的 Hook；后续授权点击可能执行其命令。请确认命令与作用范围。`)) void save('hooks', true); }}>确认启用／更新启用配置</button>
      </> : <p>只有宿主管理员可注册脚本。展示规则可引用已批准动作。</p>}
    </details>
    <details><summary>执行状态与回执</summary>
      <button type="button" onClick={() => void loadExecutions()}>刷新执行状态</button>
      <p>unknown 表示结果未知，不会自动重试；需要先核对业务回执。</p>
      <table><thead><tr><th>操作</th><th>类型</th><th>状态</th><th>结果</th></tr></thead><tbody>
        {executions.map(item => <tr key={item.id}><td>{item.id.slice(0, 12)}</td><td>{item.kind}</td><td>{item.status}</td><td>{item.result?.publicMessage ?? item.result?.reason ?? ''}
          {config.hostAdmin && item.kind === 'hook' && item.status === 'unknown' && <>
            <button type="button" onClick={() => void reconcile(item.id, 'succeeded')}>核对为已成功</button>
            <button type="button" onClick={() => void reconcile(item.id, 'failed_before_effect')}>核对为未执行</button>
          </>}
          {config.hostAdmin && item.kind === 'surface' && item.status === 'unknown' &&
            <button type="button" onClick={() => void reconcileSurface(item.id)}>核对已发送卡片</button>}
        </td></tr>)}
      </tbody></table>
    </details>
  </details>;
}
