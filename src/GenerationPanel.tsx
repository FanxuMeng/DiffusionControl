import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Download, LoaderCircle, Play, Plus, RefreshCw, Upload } from 'lucide-react';
import {
  buildGenerationRequest, createProjectProfile, getModelProfiles, importModelProfile,
  inspectProjectProfile, rebuildCommand, renameProjectProfile, selectModel,
  selectProjectProfile, updateCommand, updateExecution, updateField,
} from './generation/domain';
import {
  fetchGenerationCapabilities, fetchGenerationJob, GenerationRejectedError, isTerminalJob, normalizeApiBase,
  readApiEndpoint, SAME_ORIGIN_API_BASE, saveApiEndpoint, submitGenerationJob, supportsSlurmExecution,
} from './generation/api';
import { getSlurmExecution, isSlurmRequest, MAX_SLURM_SCRIPT_BYTES, normalizeSlurmScript } from './generation/slurm';
import type {
  GenerationCapabilities, GenerationJob, GenerationParameter, GenerationState, GenerationSubmission,
} from './generation/types';
import './generation.css';

export interface GenerationPanelProps {
  projectId: string;
  projectName: string;
  state: GenerationState;
  locked: boolean;
  onChange: (update: (current: GenerationState) => GenerationState) => void;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

type Connection = { endpoint: string; capabilities: GenerationCapabilities };
const JOB_LABELS: Record<GenerationJob['status'], string> = {
  queued: '排队中', running: '运行中', succeeded: '已完成', failed: '执行失败', cancelled: '已取消',
};
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function downloadText(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, '_');
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadJson(name: string, data: unknown) { downloadText(name, JSON.stringify(data, null, 2), 'application/json'); }
function supportsSlurm(connection: Connection | null): boolean {
  return supportsSlurmExecution(connection?.capabilities);
}
function hasProfile(connection: Connection | null, id: string, version: number) {
  return connection?.capabilities.profiles.some((profile) => profile.id === id && profile.version === version) ?? false;
}
function appendSubmission(state: GenerationState, submission: GenerationSubmission): GenerationState {
  const submissions = [...state.submissions, submission];
  // A pending request must remain available for polling or an idempotent retry.
  while (submissions.length > 20) {
    const index = submissions.findIndex((item) => item.rejection || (item.job && isTerminalJob(item.job)));
    if (index === -1) break;
    submissions.splice(index, 1);
  }
  if (submissions.length > 50) throw new Error('已有 50 条未结束或待确认的任务，请等待任务结束后再提交。');
  return { ...state, submissions };
}

function ParameterInput({ parameter, value, disabled, invalid, id, onChange }: {
  parameter: GenerationParameter; value: string; disabled: boolean; invalid: boolean;
  id: string; onChange: (value: string) => void;
}) {
  const common = { id, value, disabled, 'aria-invalid': invalid, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(event.target.value) };
  if (parameter.type === 'boolean') return <select {...common}>{value !== 'true' && value !== 'false' && <option value={value}>{value || '请选择'}</option>}<option value="true">开启 · true</option><option value="false">关闭 · false</option></select>;
  if (parameter.type === 'enum') return <select {...common}>{!parameter.choices?.includes(value) && <option value={value}>{value || '请选择'}</option>}{parameter.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select>;
  if (parameter.type === 'list' || (parameter.type === 'string' && /prompt|description|text/i.test(parameter.key))) return <textarea {...common} rows={parameter.type === 'list' ? 2 : 3} spellCheck={false} placeholder={parameter.type === 'list' ? '["值 1", "值 2"]' : undefined} />;
  // Text inputs preserve unfinished numeric drafts (e.g. "-" or "1e").
  return <input {...common} type="text" inputMode={parameter.type === 'integer' ? 'numeric' : parameter.type === 'number' ? 'decimal' : 'text'} spellCheck={false} autoComplete="off" />;
}

export default function GenerationPanel({ projectId, projectName, state, locked, onChange, onNotify }: GenerationPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [endpoint, setEndpoint] = useState(readApiEndpoint);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(() => new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const scriptInput = useRef<HTMLInputElement>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const connectController = useRef<AbortController | null>(null);
  const connectSequence = useRef(0);
  const inFlight = useRef(new Set<string>());
  const submittingProfiles = useRef(new Set<string>());
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const stateRef = useRef(state);
  stateRef.current = state;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const uid = useId();
  const models = getModelProfiles(state);
  const model = models.find((item) => item.id === state.selectedModelId);
  const unavailableModels = [...new Set([state.selectedModelId, ...state.projectProfiles.map((item) => item.modelProfileId)])].filter((id) => !models.some((item) => item.id === id));
  const profileId = state.activeProfileIds[state.selectedModelId] || '';
  const profiles = state.projectProfiles.filter((item) => item.modelProfileId === state.selectedModelId);
  const inspection = inspectProjectProfile(state, profileId);
  const draft = inspection.draft;
  const fields = inspection.model?.parameters ?? [];
  const execution = draft ? getSlurmExecution(draft) : null;
  const executionIssues = inspection.issues.filter((issue) => issue.field?.startsWith('execution.'));
  const modelIssues = inspection.issues.filter((issue) => !issue.field?.startsWith('execution.'));
  const compatible = !!model && hasProfile(connection, model.id, model.version) && supportsSlurm(connection);
  const unresolved = state.submissions.some((item) => item.request.projectProfileId === profileId && !item.rejection && (!item.job || !isTerminalJob(item.job)));
  const submitDisabled = locked || !inspection.canExecute || !compatible || unresolved || submittingProfiles.current.has(`${projectId}:${profileId}`);

  useEffect(() => {
    setProfileName('');
    setRequestErrors({});
    setPendingRequests(new Set());
  }, [projectId]);

  useEffect(() => () => { connectSequence.current += 1; connectController.current?.abort(); }, []);

  const pollingKey = JSON.stringify(state.submissions.filter((item) => item.job && !isTerminalJob(item.job)).map((item) => [item.endpoint, item.request.requestId, item.job!.id]));
  useEffect(() => {
    const jobs = stateRef.current.submissions.filter((item) => item.job && !isTerminalJob(item.job));
    if (!jobs.length) return;
    const abort = new AbortController();
    const updateProject = changeRef.current;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await Promise.allSettled(jobs.map(async (submission) => {
        try {
          const job = await fetchGenerationJob(submission.endpoint, submission.job!.id, submission.request.requestId, abort.signal);
          if (abort.signal.aborted) return;
          updateProject((current) => ({ ...current, submissions: current.submissions.map((item) => item.request.requestId === submission.request.requestId ? { ...item, job } : item) }));
          setRequestErrors((previous) => { const next = { ...previous }; delete next[submission.request.requestId]; return next; });
        } catch (error) {
          if (!abort.signal.aborted) setRequestErrors((previous) => ({ ...previous, [submission.request.requestId]: `状态查询暂时失败：${errorText(error)}` }));
        }
      }));
      if (!abort.signal.aborted) timeout = setTimeout(poll, 3000);
    };
    void poll();
    return () => { abort.abort(); if (timeout !== undefined) clearTimeout(timeout); };
  }, [pollingKey, projectId]);

  function mutate(update: (current: GenerationState) => GenerationState) {
    try {
      // Validate immediately so a malformed imported profile cannot escape an event handler.
      update(state);
      onChange((current) => { try { return update(current); } catch { return current; } });
    } catch (error) { onNotify(errorText(error), 'error'); }
  }
  function editEndpoint(value: string) {
    connectSequence.current += 1;
    connectController.current?.abort();
    setConnecting(false);
    setConnection(null);
    setConnectionError('');
    setEndpoint(value);
  }
  function restoreSameOrigin() {
    if (locked) return;
    editEndpoint(SAME_ORIGIN_API_BASE);
    saveApiEndpoint(SAME_ORIGIN_API_BASE);
    onNotify('已恢复同源 /api，可重新连接 CE 服务。', 'info');
  }
  async function connect() {
    const sequence = ++connectSequence.current;
    connectController.current?.abort();
    const abort = new AbortController();
    connectController.current = abort;
    setConnection(null);
    setConnectionError('');
    try {
      const raw = endpoint.trim();
      const base = normalizeApiBase(raw);
      // Keep relative deployment settings portable; jobs capture the resolved origin.
      saveApiEndpoint(raw);
      setEndpoint(raw);
      setConnecting(true);
      const capabilities = await fetchGenerationCapabilities(base, abort.signal);
      if (abort.signal.aborted || sequence !== connectSequence.current) return;
      setConnection({ endpoint: base, capabilities });
      onNotify('已连接 CE 任务 API，模型版本已读取。', 'success');
    } catch (error) {
      if (!abort.signal.aborted && sequence === connectSequence.current) setConnectionError(errorText(error));
    } finally {
      if (sequence === connectSequence.current) setConnecting(false);
    }
  }
  function nameAction(action: 'new' | 'copy' | 'rename') {
    const name = profileName.trim();
    if (!name) { onNotify('请先填写运行配置名称。', 'error'); return; }
    if (action !== 'new' && !draft) return;
    mutate((current) => action === 'rename'
      ? renameProjectProfile(current, profileId, name)
      : createProjectProfile(current, name, action === 'copy' ? profileId : undefined));
    setProfileName('');
  }
  async function importProfile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || locked) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const next = importModelProfile(stateRef.current, raw);
      onChange((current) => { try { return importModelProfile(current, raw); } catch { return current; } });
      onNotify(`已导入模型 profile：${getModelProfiles(next).find((item) => item.id === next.selectedModelId)?.name || file.name}`, 'success');
    } catch (error) { onNotify(`模型 profile 导入失败：${errorText(error)}`, 'error'); }
  }
  async function importScript(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || locked || !draft) return;
    const targetProfileId = draft.id;
    try {
      if (file.size > MAX_SLURM_SCRIPT_BYTES * 2 + 3) throw new Error('Bash 脚本不能超过 256 KiB。');
      const scriptContent = normalizeSlurmScript(await file.text());
      if (new TextEncoder().encode(scriptContent).byteLength > MAX_SLURM_SCRIPT_BYTES) throw new Error('Bash 脚本不能超过 256 KiB。');
      if (lockedRef.current) throw new Error('录制期间无法导入脚本，请结束录制后重试。');
      const patch = { scriptName: file.name, scriptContent };
      updateExecution(stateRef.current, targetProfileId, patch);
      onChange((current) => { try { return updateExecution(current, targetProfileId, patch); } catch { return current; } });
      onNotify(`已导入 Bash 脚本：${file.name}`, 'success');
    } catch (error) { onNotify(`脚本导入失败：${errorText(error)}`, 'error'); }
  }
  function exportRequest() {
    try {
      const request = buildGenerationRequest(state, profileId, { id: projectId, name: projectName });
      downloadJson(`${projectName}_${draft?.name || 'generation'}_request.json`, request);
      onNotify('已导出校验后的推理请求。', 'success');
    } catch (error) { onNotify(errorText(error), 'error'); }
  }
  async function post(submission: GenerationSubmission) {
    const { request } = submission;
    if (inFlight.current.has(request.requestId) || !isSlurmRequest(request)) return;
    const profileKey = `${projectId}:${request.projectProfileId}`;
    inFlight.current.add(request.requestId);
    submittingProfiles.current.add(profileKey);
    const capturedProjectId = projectId;
    setPendingRequests((previous) => new Set(previous).add(request.requestId));
    setRequestErrors((previous) => { const next = { ...previous }; delete next[request.requestId]; return next; });
    try {
      const job = await submitGenerationJob(submission.endpoint, request);
      // onChange is captured for the originating project, regardless of the current selection.
      onChange((current) => ({ ...current, submissions: current.submissions.map((item) => item.request.requestId === request.requestId ? { ...item, job } : item) }));
      onNotify(`CE 已接受推理任务：${job.id}`, 'success');
    } catch (error) {
      if (error instanceof GenerationRejectedError) {
        const rejection = { status: error.status, message: error.message };
        onChange((current) => ({ ...current, submissions: current.submissions.map((item) => item.request.requestId === request.requestId && !item.job ? { ...item, rejection } : item) }));
        onNotify(`请求被拒绝：${error.message}`, 'error');
      } else {
        if (projectRef.current === capturedProjectId) setRequestErrors((previous) => ({ ...previous, [request.requestId]: `提交结果待确认：${errorText(error)}。重试将复用原请求 ID 与内容。` }));
        onNotify('提交结果待确认，原请求已保留，可使用相同请求 ID 重试。', 'error');
      }
    } finally {
      inFlight.current.delete(request.requestId);
      submittingProfiles.current.delete(profileKey);
      if (projectRef.current === capturedProjectId) setPendingRequests((previous) => { const next = new Set(previous); next.delete(request.requestId); return next; });
    }
  }
  function submit() {
    if (submitDisabled || !connection || submittingProfiles.current.has(`${projectId}:${profileId}`)) return;
    try {
      const request = buildGenerationRequest(state, profileId, { id: projectId, name: projectName });
      const submission: GenerationSubmission = { endpoint: connection.endpoint, request };
      appendSubmission(state, submission);
      onChange((current) => appendSubmission(current, submission));
      void post(submission);
    } catch (error) { onNotify(errorText(error), 'error'); }
  }
  function retry(submission: GenerationSubmission) {
    if (locked || submission.job || submission.rejection || !isSlurmRequest(submission.request) || !supportsSlurm(connection) || !connection || connection.endpoint !== submission.endpoint || !hasProfile(connection, submission.request.profileId, submission.request.profileVersion)) return;
    void post(submission);
  }
  const disabledReason = locked ? '录制期间暂停编辑和提交。' : !inspection.canExecute ? '请修正参数、命令或 Slurm 配置中的错误。' : !connection ? '连接 CE 后可执行；当前可导出请求。' : !supportsSlurm(connection) ? '服务需支持 API v2 与 Slurm 提交模式。' : !compatible ? 'CE 未注册此模型 profile 的相同版本。' : unresolved ? '当前配置已有未结束或待确认的任务。' : '通过 CE 登录节点提交 Slurm 作业。';

  return <section className="dcp-panel generation-panel" aria-label="Diffusion 生成">
    <div className="dcp-panel-header">
      <button className="dcp-section-title" aria-expanded={!collapsed} aria-controls={`${uid}-body`} onClick={() => setCollapsed((value) => !value)}>
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span>Diffusion 生成</span>
      </button>
      <span className={`generation-connection-badge ${connection ? 'is-connected' : ''}`}>{connection ? 'CE 已连接' : '未连接 CE'}</span>
    </div>
    <div id={`${uid}-body`} className="generation-body" hidden={collapsed}>
      <div className="generation-block">
        <label className="generation-label" htmlFor={`${uid}-model`}>推理模型 profile</label>
        <select id={`${uid}-model`} value={state.selectedModelId} disabled={locked} onChange={(event) => { const value = event.target.value; mutate((current) => selectModel(current, value)); }}>
          {unavailableModels.map((id) => <option key={id} value={id}>模型不可用：{id}</option>)}
          {models.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
        </select>
        <div className="generation-actions">
          <button className="dcp-button" disabled={locked} onClick={() => fileInput.current?.click()}><Upload size={12} />导入模型定义</button>
          <button className="dcp-button" disabled={!model} onClick={() => model && downloadJson(`${model.id}.profile.json`, model)}><Download size={12} />导出定义</button>
        </div>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-label="导入模型 profile JSON" onChange={(event) => void importProfile(event)} />
        {model && <details className="generation-model-info"><summary>模型说明与输入要求</summary><p>{model.description}</p><ul>{model.inputRequirements.map((item, index) => <li key={index}>{item}</li>)}</ul><code>{model.commandPrefix.join(' ')}</code>{model.source && <p>模板来源：<a href={model.source.url} target="_blank" rel="noreferrer">官方源码</a><br /><span title={model.source.revision}>版本 {model.source.revision}</span></p>}</details>}
      </div>

      <div className="generation-block">
        <label className="generation-label" htmlFor={`${uid}-profile`}>项目运行配置 <span>自动保存</span></label>
        <select id={`${uid}-profile`} disabled={locked || !profiles.length} value={profileId} onChange={(event) => { const value = event.target.value; mutate((current) => selectProjectProfile(current, value)); }}>
          {!draft && <option value={profileId}>请选择运行配置</option>}{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label className="generation-label generation-name-label" htmlFor={`${uid}-name`}>新名称</label>
        <input id={`${uid}-name`} type="text" value={profileName} disabled={locked || !model} placeholder="例如：质量对比 · seed 42" onChange={(event) => setProfileName(event.target.value)} />
        <div className="generation-actions generation-profile-actions">
          <button className="dcp-button" disabled={locked || !model || !profileName.trim()} onClick={() => nameAction('new')}><Plus size={12} />新建</button>
          <button className="dcp-button" disabled={locked || !draft || !profileName.trim()} onClick={() => nameAction('copy')}><Copy size={12} />复制</button>
          <button className="dcp-button" disabled={locked || !draft || !profileName.trim()} onClick={() => nameAction('rename')}>重命名</button>
        </div>
      </div>

      {draft && <>
        <details className="generation-parameter-group" open>
          <summary>输入参数 <span>{fields.length} 项</span></summary>
          <div className="generation-fields">{fields.map((parameter) => {
            const fieldId = `${uid}-field-${parameter.key}`;
            const issues = inspection.issues.filter((issue) => issue.field === parameter.key);
            return <div className="generation-field" key={parameter.key}>
              <label className="generation-label" htmlFor={fieldId}>{parameter.label}{parameter.required && <span title="必填">必填</span>}</label>
              <ParameterInput id={fieldId} parameter={parameter} value={draft.values[parameter.key] ?? parameter.defaultValue} disabled={locked} invalid={issues.length > 0} onChange={(value) => mutate((current) => updateField(current, profileId, parameter.key, value))} />
              <small className="generation-flag">{parameter.flag} · {parameter.type}{parameter.min !== undefined ? ` · ≥ ${parameter.min}` : ''}{parameter.max !== undefined ? ` · ≤ ${parameter.max}` : ''}</small>
              {parameter.description && <p className="generation-help">{parameter.description}</p>}
              {issues.map((issue, index) => <p className="generation-field-error" key={index}>{issue.message}</p>)}
            </div>;
          })}</div>
        </details>
        <div className="generation-block generation-command-block">
          <label className="generation-label" htmlFor={`${uid}-command`}>推理命令（脚本参数）<span>可编辑</span></label>
          <textarea id={`${uid}-command`} className="generation-command" rows={7} value={draft.commandText} disabled={locked} spellCheck={false} aria-invalid={!inspection.commandParseable} onChange={(event) => { const value = event.target.value; mutate((current) => updateCommand(current, profileId, value)); }} />
          <p className="generation-help">命令解析后同步参数；无效命令会保留草稿并阻止执行。</p>
          <button className="dcp-button generation-rebuild" disabled={locked} onClick={() => mutate((current) => rebuildCommand(current, profileId))}><RefreshCw size={12} />从参数重建命令</button>
          {modelIssues.length > 0 ? <div className="generation-validation is-error" role="status"><strong>{inspection.commandParseable ? '参数校验未通过' : '命令无法解析'}</strong><ul>{modelIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div> : <div className="generation-validation is-valid" role="status"><Check size={12} />参数与推理命令校验通过</div>}
        </div>
        {execution && <div className="generation-block generation-slurm-block">
          <h3>Slurm 提交配置</h3>
          <label className="generation-label" htmlFor={`${uid}-slurm-env`}>ENVNAME <span>Conda 环境</span></label>
          <input id={`${uid}-slurm-env`} value={execution.envName} disabled={locked} spellCheck={false} autoComplete="off" placeholder="base" aria-invalid={executionIssues.some((issue) => issue.field === 'execution.envName')} onChange={(event) => { const envName = event.target.value; mutate((current) => updateExecution(current, profileId, { envName })); }} />
          <label className="generation-label generation-name-label" htmlFor={`${uid}-slurm-script-name`}>脚本文件名</label>
          <input id={`${uid}-slurm-script-name`} value={execution.scriptName} disabled={locked} spellCheck={false} autoComplete="off" placeholder="job.gpu" aria-invalid={executionIssues.some((issue) => issue.field === 'execution.scriptName')} onChange={(event) => { const scriptName = event.target.value; mutate((current) => updateExecution(current, profileId, { scriptName })); }} />
          <div className="generation-actions">
            <button className="dcp-button" disabled={locked} onClick={() => scriptInput.current?.click()}><Upload size={12} />导入脚本</button>
            <button className="dcp-button" disabled={locked} onClick={() => downloadText(execution.scriptName || 'job.gpu', execution.scriptContent, 'text/plain;charset=utf-8')}><Download size={12} />下载脚本</button>
          </div>
          <input ref={scriptInput} type="file" hidden aria-label="导入 Bash 脚本文件" onChange={(event) => void importScript(event)} />
          <details className="generation-script-editor">
            <summary>Bash 脚本 · 可编辑</summary>
            <label className="generation-label" htmlFor={`${uid}-slurm-script`}>脚本内容 <span>{(new TextEncoder().encode(execution.scriptContent).byteLength / 1024).toFixed(1)} / 256 KiB</span></label>
            <textarea id={`${uid}-slurm-script`} className="generation-script" rows={12} value={execution.scriptContent} disabled={locked} spellCheck={false} aria-invalid={executionIssues.some((issue) => issue.field === 'execution.scriptContent')} onChange={(event) => { const scriptContent = event.target.value; mutate((current) => updateExecution(current, profileId, { scriptContent })); }} />
            <p className="generation-help">脚本解析首个 ENVNAME 实参，再转发剩余推理参数；资源配置由 CE 检查。</p>
          </details>
          {executionIssues.length > 0 && <div className="generation-validation is-error" role="status"><strong>Slurm 配置校验未通过</strong><ul>{executionIssues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></div>}
          <label className="generation-label generation-name-label" htmlFor={`${uid}-submission`}>Slurm 提交命令 <span>只读预览</span></label>
          <textarea id={`${uid}-submission`} className="generation-command generation-submission-command" rows={5} value={inspection.submissionCommand} readOnly spellCheck={false} placeholder="完成 Slurm 配置与推理命令后生成提交预览。" />
          <p className="generation-help">从登录节点通过 sbatch 提交，在分配的计算节点运行。ENVNAME、脚本和推理参数随当前运行配置保存。</p>
        </div>}
      </>}
      {!draft && inspection.issues.length > 0 && <div className="generation-validation is-error" role="status">{inspection.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}

      <div className="generation-block generation-api-block">
        <div className="generation-service-summary">
          <div><span>CE 服务</span><span>{endpoint.trim() === SAME_ORIGIN_API_BASE ? '同源连接' : '自定义地址'}</span></div>
          <code>{endpoint.trim() || '尚未填写地址'}</code>
        </div>
        <button className="dcp-button generation-connect" disabled={locked || connecting || !endpoint.trim()} onClick={() => void connect()}>{connecting ? <LoaderCircle size={12} className="dcp-spinning" /> : <RefreshCw size={12} />}{connecting ? '正在连接…' : connection ? '刷新服务能力' : '连接并检查模型'}</button>
        {connectionError && <p className="generation-field-error" role="status">连接失败：{connectionError}</p>}
        {connection && <p className={`generation-help ${compatible ? 'is-success' : 'is-warning'}`}>{compatible ? '服务支持 Slurm 提交，且已注册当前模型与版本。' : !supportsSlurm(connection) ? '服务需支持 API v2 和 slurm_sbatch_v1；当前仅可编辑与导出。' : '已连接，但服务未注册当前模型与版本。'}</p>}
        <details className="generation-connection-settings">
          <summary>高级连接设置</summary>
          <label className="generation-label" htmlFor={`${uid}-endpoint`}>CE 任务 API 地址</label>
          <input id={`${uid}-endpoint`} value={endpoint} disabled={locked} type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder={SAME_ORIGIN_API_BASE} onChange={(event) => editEndpoint(event.target.value)} />
          <button className="dcp-button generation-restore-connection" disabled={locked} onClick={restoreSameOrigin}><RefreshCw size={12} />恢复同源 /api</button>
          <p className="generation-help">默认通过当前站点的 /api 连接。自定义地址在点击连接后保存；恢复同源立即保存。</p>
        </details>
        <p className="generation-help">未连接时可校验和导出请求。</p>
        <div className="generation-actions">
          <button className="dcp-button" disabled={locked || !inspection.canExecute} onClick={exportRequest}><Download size={12} />导出请求</button>
          <button className="dcp-button dcp-record-action" disabled={submitDisabled} title={disabledReason} onClick={submit}><Play size={12} />执行推理</button>
        </div>
        <p className="generation-help">{disabledReason}</p>
      </div>

      {state.submissions.length > 0 && <details className="generation-jobs" open>
        <summary>推理任务 <span>{state.submissions.length}</span></summary>
        <div className="generation-job-list">{[...state.submissions].reverse().map((submission) => {
          const { request, job, rejection } = submission;
          const pending = pendingRequests.has(request.requestId);
          const error = requestErrors[request.requestId];
          const slurmRequest = isSlurmRequest(request);
          const canRetry = !locked && !pending && !job && !rejection && slurmRequest && supportsSlurm(connection) && connection?.endpoint === submission.endpoint && hasProfile(connection, request.profileId, request.profileVersion);
          return <article className="generation-job" key={request.requestId}>
            <div className="generation-job-heading"><strong>{job ? JOB_LABELS[job.status] : rejection ? '请求被拒绝' : pending ? '正在提交…' : '提交结果待确认'}</strong><span>{request.profileId}</span></div>
            <p className="generation-help">{state.projectProfiles.find((item) => item.id === request.projectProfileId)?.name || request.projectProfileId} · {new Date(request.createdAt).toLocaleString()}</p>
            <p className="generation-help">服务：{submission.endpoint}</p>
            <code className="generation-job-id" title={job?.id || request.requestId}>{job ? `Job: ${job.id}` : `Request: ${request.requestId}`}</code>
            {job?.progress !== undefined && <div className="generation-progress"><progress value={job.progress} max={1} aria-label="推理进度" /><span>{Math.round(job.progress * 100)}%</span></div>}
            {job?.message && <p className="generation-job-message">{job.message}</p>}
            {error && <p className="generation-field-error" role="status">{error}</p>}
            {rejection && <><p className="generation-field-error">HTTP {rejection.status}：{rejection.message}</p><p className="generation-help">修改配置后可重新提交。</p></>}
            {!slurmRequest && <p className="generation-help">旧版请求仅可追溯、下载及查询；请先在原服务核实任务，再复制运行配置发起 Slurm 请求。</p>}
            {!job && !pending && !rejection && slurmRequest && <p className="generation-help">连接原 Slurm 服务后可重试；请求 ID、脚本与内容保持不变。</p>}
            <div className="generation-job-actions"><button className="dcp-button" onClick={() => downloadJson(`${request.requestId}.request.json`, request)}><Download size={11} />请求快照</button>{!job && !rejection && slurmRequest && <button className="dcp-button" disabled={!canRetry} title={`需连接 ${submission.endpoint}，支持 API v2 Slurm 并匹配原模型版本`} onClick={() => retry(submission)}><RefreshCw size={11} />{pending ? '提交中' : '重试提交'}</button>}</div>
            {job && job.outputs.length > 0 && <ul className="generation-outputs">{job.outputs.map((output, index) => <li key={index}><a href={output.url} target="_blank" rel="noreferrer">{output.name || '查看输出'}</a></li>)}</ul>}
          </article>;
        })}</div>
      </details>}
    </div>
  </section>;
}
