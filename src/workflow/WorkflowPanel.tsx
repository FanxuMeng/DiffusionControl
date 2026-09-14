import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../types';
import { selectModel, updateExecution, updateField } from '../generation/domain';
import { isTerminalJob, saveApiEndpoint } from '../generation/api';
import { useExecutionSettings } from './ExecutionSettings';
import { fetchOutput, getWorkflowCapabilities, getWorkflowJobs, outputUrl, submitWorkflow, workflowApi, WorkflowError } from './api';
import type { ObjectDefinition, SamPrompts, TaskKind, WorkflowCapabilities, WorkflowInputs, WorkflowJob, WorkflowRequest, WorkflowResult as Result } from './types';
import { applyDefinedObjectResult, applyDepthResult, applyObjectResult, definitionJob, initialDepthJob, validateWorkflowResult } from './apply';
import './workflow.css';
import { enqueueWorkflowRequest, makeWorkflowRequest } from './requests';
import { exportProjectSnapshot, sameExportSnapshot } from './snapshot';
import { RENDER_STRATEGY, motionControls } from './motionControls';

const LABELS: Record<TaskKind, string> = { depth: 'Depth Pro 重建', sam2: 'SAM2 分割', associate: '点簇关联与包围盒', export: '条件导出' };
const STATES = { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const uid = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface WorkflowPanelProps {
  associationEnvironment: string; onAssociationEnvironmentChange: (value: string) => void;
  project: Project; locked: boolean; prompts: SamPrompts; promptMode: 'positive' | 'negative' | 'box';
  onPromptsChange: (value: SamPrompts) => void; onPromptModeChange: (value: 'positive' | 'negative' | 'box') => void;
  onSegment: () => void; onChange: (id: string, update: (project: Project) => Project) => void;
  onApplied: (kind: TaskKind, objectId?: string, projectId?: string) => void; onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
  onJobsChange?: (jobs: WorkflowJob[], errors: Record<string, string>) => void;
}

export default function WorkflowPanel(props: WorkflowPanelProps) {
  const { project, locked, prompts, onChange, onNotify } = props;
  const latest = useRef(project); latest.current = project;
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const global = useExecutionSettings();
  const [capabilities, setCapabilities] = useState<WorkflowCapabilities | null>(null);
  const [jobs, setJobs] = useState<WorkflowJob[]>([]), [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [applicationErrors, setApplicationErrors] = useState<Record<string, string>>({});
  const resultCache = useRef(results); resultCache.current = results;
  const busyRef = useRef(false);
  const [environments, setEnvironments] = useState<Record<TaskKind, string>>({ depth: 'depthpro', sam2: 'sam2', associate: 'depthpro', export: 'depthpro' });
  const [focal, setFocal] = useState(''), [contract, setContract] = useState('8'), [threshold, setThreshold] = useState('0.35');
  const [objectName, setObjectName] = useState('新物体'), [objectPrompt, setObjectPrompt] = useState('');
  const [chosen, setChosen] = useState<{ jobId: string; candidate: number } | null>(null);
  const [numFrames, setNumFrames] = useState(81), [fps, setFps] = useState(16), [width, setWidth] = useState(832), [height, setHeight] = useState(480), [radius, setRadius] = useState(.005);
  const reload = useCallback(async () => {
    try { const [caps, list] = await Promise.all([getWorkflowCapabilities(), getWorkflowJobs(project.id)]); if (!mounted.current || latest.current.id !== project.id) return; setCapabilities(caps); setJobs(list.jobs); setError(''); }
    catch (e) { if (mounted.current && latest.current.id === project.id) setError(message(e)); }
  }, [project.id]);
  useEffect(() => {
    setJobs([]); setResults({}); setChosen(null);
    setObjectName('新物体'); setObjectPrompt(''); setApplicationErrors({});
    void reload(); const timer = window.setInterval(() => { void reload(); }, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => { props.onJobsChange?.(jobs, applicationErrors); }, [jobs, applicationErrors, props.onJobsChange]);
  useEffect(() => {
    let cancelled = false;
    for (const job of jobs) if (job.status === 'succeeded' && !resultCache.current[job.id]) {
      void fetchOutput<Result>(job, 'result.json').then(result => { if (!cancelled) setResults(previous => ({ ...previous, [job.id]: result })); })
        .catch(e => { if (!cancelled) setError(`读取${LABELS[job.kind]}结果失败：${message(e)}`); });
    }
    return () => { cancelled = true; };
  }, [jobs]);
  const taskReady = (kind: TaskKind) => !!capabilities?.tasks.find(task => task.kind === kind)?.available;
  const reason = (kind: TaskKind) => capabilities?.tasks.find(task => task.kind === kind)?.reason;
  const active = (kind: TaskKind) => jobs.some(job => job.kind === kind && !isTerminalJob(job)) || project.workflow?.pending.some(request => request.kind === kind);
  const disabled = (kind: TaskKind) => locked || busy || !global.value || !taskReady(kind) || !!active(kind);
  const input = (): WorkflowInputs => {
    const state = latest.current.workflow;
    if (!state) throw new Error('请先上传首帧到后端。');
    return { referenceAssetId: state.referenceAssetId };
  };
  const guard = async (action: () => Promise<void>) => {
    if (busyRef.current || locked) return;
    busyRef.current = true; setBusy(true);
    try { await action(); } catch (e) { onNotify(message(e), 'error'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const post = async (request: WorkflowRequest) => {
    try {
      await submitWorkflow(request);
      onChange(request.projectId, p => !p.workflow ? p : { ...p, workflow: { ...p.workflow, pending: p.workflow.pending.filter(item => item.requestId !== request.requestId) } });
      await reload(); onNotify(`${LABELS[request.kind]}已提交，等待 Slurm 调度。`, 'success');
    } catch (e) {
      if (e instanceof WorkflowError && [400, 422].includes(e.status)) onChange(request.projectId, p => !p.workflow ? p : { ...p, workflow: { ...p.workflow, pending: p.workflow.pending.filter(item => item.requestId !== request.requestId),
        objectDefinitions: p.workflow.objectDefinitions?.map(item => item.requestId === request.requestId ? { ...item, submissionError: message(e).slice(0, 2000) } : item) } });
      throw e;
    }
  };
  const submit = async (kind: TaskKind, inputs: WorkflowInputs, options: Record<string, unknown>, definition?: Pick<ObjectDefinition, 'id' | 'name' | 'prompt' | 'segmentationJobId' | 'candidate'>) => {
    if (!global.value) throw new Error('请先读取全局 Slurm 设置。');
    const request = makeWorkflowRequest(project, kind, inputs, options, kind === 'associate' ? props.associationEnvironment : environments[kind], global.value);
    onChange(project.id, p => enqueueWorkflowRequest(p, request, definition));
    await post(request);
  };
  const upload = async () => {
    const destination = project.id, original = project.reference;
    if (!original || project.demoScene) throw new Error('请先导入真实参考图。');
    if (!original.startsWith('data:image/')) throw new Error('请重新导入本地图像后上传。');
    const asset = await workflowApi<{ id: string; width: number; height: number; url: string }>('/workflow/assets', 'POST', { image: original });
    if (latest.current.id !== destination || latest.current.reference !== original) throw new Error('首帧已改变，上传结果未应用。');
    onChange(destination, p => p.reference !== original ? p : { ...p, reference: asset.url,
      workflow: { version: 1, referenceAssetId: asset.id, width: asset.width, height: asset.height, pending: [] } });
    onNotify('规范化首帧已上传，可以进行重建与分割。', 'success');
  };
  const resultOf = async (job: WorkflowJob) => {
    const result = results[job.id] || await fetchOutput<Result>(job, 'result.json');
    if (!mounted.current || lockedRef.current || latest.current.id !== project.id) throw new Error('当前项目或编辑状态已变化，请重新应用结果。');
    validateWorkflowResult(latest.current, job, result);
    return result;
  };
  const applyDepth = async (job: WorkflowJob) => {
    const result = await resultOf(job);
    const current = latest.current;
    applyDepthResult(current, job, result);
    if ((current.objects.length || current.camera || current.cameraHistory.length || current.workflow?.objectDefinitions?.length) && !window.confirm('替换重建将重置当前物体、待处理定义与轨迹。继续应用？')) return;
    onChange(project.id, p => p.workflow?.referenceAssetId !== job.inputs.referenceAssetId ? p : applyDepthResult(p, job, result));
    props.onApplied('depth', undefined, project.id); onNotify('真实场景点云已绑定到项目。', 'success');
  };
  const applyObject = async (job: WorkflowJob) => {
    const result = await resultOf(job);
    const pending = latest.current.workflow?.objectDefinitions?.find(item => item.requestId === job.requestId);
    if (job.inputs.replaceObjectJobId) {
      if (!pending) throw new Error('本次包围盒更新已放弃或已应用；请重新编辑物体。');
      applyDefinedObjectResult(latest.current, job, result, pending);
      onChange(project.id, p => { try { return applyDefinedObjectResult(p, job, result, pending); } catch { return p; } });
      props.onApplied('associate', pending.id, project.id); onNotify('物体点簇已更新，请重新定义运动。', 'success'); return;
    }
    const definition = pending || { id: uid('object'), name: objectName.trim() || '新物体', prompt: objectPrompt };
    applyObjectResult(latest.current, job, result, definition);
    onChange(project.id, p => { try { return applyObjectResult(p, job, result, definition); } catch { return p; } });
    props.onApplied('associate', definition.id, project.id); onNotify('物体点簇和初始包围盒已加入场景，请选择正面并设置运动。', 'success');
  };
  useEffect(() => {
    if (locked || busy) return;
    const depth = initialDepthJob(project, jobs);
    if (depth && results[depth.id] && !applicationErrors[depth.id]) {
      try {
        applyDepthResult(project, depth, results[depth.id]);
        onChange(project.id, p => initialDepthJob(p, [depth]) ? applyDepthResult(p, depth, results[depth.id]) : p);
      } catch (e) { setApplicationErrors(previous => ({ ...previous, [depth.id]: message(e) })); }
      return;
    }
    for (const definition of project.workflow?.objectDefinitions || []) {
      if (!definition.replaceObjectJobId && project.objects.some(object => object.id === definition.id)) continue;
      const completed = definitionJob(definition, jobs);
      if (!completed || completed.status !== 'succeeded' || !results[completed.id] || applicationErrors[completed.id]) continue;
      if (project.objects.some(object => object.reconstruction?.jobId === completed.id)) continue;
      try {
        applyDefinedObjectResult(project, completed, results[completed.id], definition);
        onChange(project.id, p => { try { return applyDefinedObjectResult(p, completed, results[completed.id], definition); } catch { return p; } });
      } catch (e) { setApplicationErrors(previous => ({ ...previous, [completed.id]: message(e) })); }
      break;
    }
  }, [project, jobs, results, locked, busy, onChange, applicationErrors]);

  const addObject = async () => {
    const current = latest.current;
    if (!chosen || !current.workflow?.sceneJobId) throw new Error('请等待 Depth Pro 重建就绪，并选择一个 SAM2 候选。');
    if (!objectName.trim() || objectName.trim().length > 200 || objectPrompt.length > 10000) throw new Error('请填写 1–200 字符的物体名称，描述最多 10000 字符。');
    if ((current.workflow.objectDefinitions?.length || 0) >= 100) throw new Error('物体定义已达上限。');
    const sam = jobs.find(job => job.id === chosen.jobId);
    if (!sam) throw new Error('分割任务不可用，请刷新任务。');
    const result = await resultOf(sam);
    if (!result.candidates?.some(item => item.index === chosen.candidate)) throw new Error('所选候选不存在。');
    await submit('associate', { ...input(), sceneJobId: current.workflow.sceneJobId, segmentationJobId: chosen.jobId,
      objectJobIds: current.objects.map(o => o.reconstruction!.jobId) }, { candidate: chosen.candidate },
      { id: uid('object'), name: objectName.trim(), prompt: objectPrompt, segmentationJobId: chosen.jobId, candidate: chosen.candidate });
    setChosen(null);
  };
  const exportConditions = async () => {
    const snapshot = exportProjectSnapshot(project);
    await submit('export', { ...input(), sceneJobId: project.workflow!.sceneJobId, objectJobIds: snapshot.objects.map(o => o.jobId) }, {
      numFrames, fps, width, height, radius, pointsPerObject: 500, pointsPerPixel: 8, seed: 42,
      project: snapshot });
  };
  const useForGeneration = async (job: WorkflowJob) => {
    const result = await resultOf(job);
    if (job.inputs.sceneJobId !== latest.current.workflow?.sceneJobId || !result.validationCsv) throw new Error('导出源场景已变化。');
    if (result.renderStrategy !== RENDER_STRATEGY) throw new Error('这是旧版条件包，请重新导出 Rendered Frames。');
    if (JSON.stringify(job.inputs.objectJobIds || []) !== JSON.stringify(exportProjectSnapshot(latest.current).objects.map(o => o.jobId))) throw new Error('导出后的物体集合已改变，请重新导出。');
    if (!sameExportSnapshot(job.options.project, exportProjectSnapshot(latest.current))) throw new Error('导出后的轨迹、相机、时间轴或提示词已改变，请重新导出。');
    onChange(project.id, p => {
      let state = selectModel(p.generation, 'symphomotion-multi-gpu');
      const id = state.activeProfileIds[state.selectedModelId];
      const values = { validation_csv_path: result.validationCsv!, num_frames: String(result.numFrames), fps: String(result.fps), max_area: String(result.maxArea),
        use_object_prompt: String(motionControls(p).object), normalize_object_to_first_frame: 'true', max_entities: String(Math.max(2, result.numEntities || 0)),
        pretrained_model_path: '/home/225015066/PretrainedModels/Diffusers/Wan2.1-I2V-14B-720P-Diffusers',
        controlnet_path: '/home/225015066/PretrainedModels/Symphomotion/pretrained_checkpoints/camera_control/controlnet.pth',
        obj_injector_path: '/home/225015066/PretrainedModels/Symphomotion/pretrained_checkpoints/object_control/object_injector.pth' };
      for (const [key, value] of Object.entries(values)) state = updateField(state, id, key, value);
      state = updateExecution(state, id, { envName: 'symphomotion' });
      return { ...p, generation: state, workflow: p.workflow ? { ...p.workflow, exportJobId: job.id } : undefined };
    });
    saveApiEndpoint('/api'); onNotify('已将条件包和参数填入生成面板，请连接当前服务后提交。', 'success');
  };
  const envField = (kind: TaskKind) => <><label>ENVNAME<input value={kind === 'associate' ? props.associationEnvironment : environments[kind]} list="workflow-environments" disabled={locked || busy} onChange={e => kind === 'associate' ? props.onAssociationEnvironmentChange(e.target.value) : setEnvironments({ ...environments, [kind]: e.target.value })} /></label>{reason(kind) && <p className="workflow-muted">{reason(kind)}</p>}</>;
  const currentJobs = jobs.filter(job => job.inputs.referenceAssetId === project.workflow?.referenceAssetId);
  if (project.demoScene) return null;
  return <section className="dcp-panel workflow-panel" aria-label="重建、分割与条件导出">
    <h3>重建与分割</h3>
    {error && <p role="alert">{error}</p>}
    <button className="dcp-button" disabled={busy} onClick={() => void reload()}>刷新任务与模型状态</button>
    <datalist id="workflow-environments">{capabilities?.environments.map(env => <option key={env} value={env} />)}</datalist>
    {!project.workflow ? <p><button className="dcp-button is-primary" disabled={locked || busy || !project.reference} onClick={() => void guard(upload)}>上传首帧到后端</button></p> : <p className="workflow-muted">首帧 {project.workflow.width} × {project.workflow.height} · 已上传</p>}
    <details open><summary>1 · Depth Pro 场景重建</summary>{envField('depth')}
      <p role="status">{project.geometryReady ? '点云已就绪，可直接切换 3D View 预览。' : active('depth') ? '场景重建进行中；完成后自动准备点云预览。' : initialDepthJob(project, jobs) ? '重建已完成，正在读取标定与点云。' : '首次重建完成后自动准备点云预览。'}</p>
      <div className="workflow-fields"><label>远景压缩系数<input type="number" value={contract} onChange={e => setContract(e.target.value)} /></label><label>边缘阈值<input type="number" step="0.01" value={threshold} onChange={e => setThreshold(e.target.value)} /></label></div>
      <label>像素焦距（留空由模型估计）<input type="number" value={focal} onChange={e => setFocal(e.target.value)} /></label>
      <button className="dcp-button is-primary" disabled={disabled('depth') || !project.workflow} onClick={() => void guard(() => submit('depth', input(), { contract: Number(contract), sobelThreshold: Number(threshold), ...(focal ? { focalLengthPx: Number(focal) } : {}) }))}>提交场景重建</button>
    </details>
    <details open><summary>2 · SAM2 物体分割</summary>{envField('sam2')}
      <div className="workflow-actions"><button className="dcp-button" disabled={locked || !project.workflow} onClick={props.onSegment}>在首帧上标注</button><select aria-label="SAM2 提示方式" value={props.promptMode} onChange={e => props.onPromptModeChange(e.target.value as typeof props.promptMode)}><option value="positive">正点击</option><option value="negative">负点击</option><option value="box">矩形框</option></select><button className="dcp-button" disabled={locked} onClick={() => props.onPromptsChange({ points: [], box: null })}>清空提示</button></div>
      <p>{prompts.points.length} 个提示点{prompts.box ? ' · 已框选' : ''}；右键可添加负点击。</p>
      <button className="dcp-button is-primary" disabled={disabled('sam2') || !project.workflow || (!prompts.box && !prompts.points.some(p => p[2] === 1))} onClick={() => void guard(() => submit('sam2', input(), { ...prompts }))}>提交 SAM2 分割</button>
      {currentJobs.filter(job => job.kind === 'sam2' && job.status === 'succeeded' && !job.cancelRequested).slice(0, 2).map(job => <div className="workflow-candidates" key={job.id}>{results[job.id]?.candidates?.map(candidate => <button key={candidate.index} disabled={locked || busy} aria-pressed={chosen?.jobId === job.id && chosen.candidate === candidate.index} className={chosen?.jobId === job.id && chosen.candidate === candidate.index ? 'selected' : ''} onClick={() => setChosen({ jobId: job.id, candidate: candidate.index })}><img src={outputUrl(job, candidate.mask)} alt={`分割候选 ${candidate.index + 1}`} /><span>候选 {candidate.index + 1} · {candidate.score.toFixed(3)}</span></button>)}</div>)}
      {chosen && <p role="status">已选择候选 {chosen.candidate + 1}，请在下方填写物体定义并点击「添加物体」。</p>}
    </details>
    <details open><summary>3 · 添加物体与关联 3D 点簇</summary>{envField('associate')}
      <label>物体名称<input value={objectName} maxLength={200} disabled={locked || busy} onChange={e => setObjectName(e.target.value)} /></label><label>物体描述与运动提示<textarea value={objectPrompt} maxLength={10000} disabled={locked || busy} onChange={e => setObjectPrompt(e.target.value)} rows={2} /></label>
      <button className="dcp-button is-primary" disabled={disabled('associate') || !chosen || !project.workflow?.sceneJobId || !objectName.trim()} onClick={() => void guard(addObject)}>添加物体</button>
      <p className="workflow-muted">{!project.workflow?.sceneJobId ? '请先等待场景重建就绪。' : active('associate') ? '正在关联物体点簇，完成后自动加入下方物体面板。' : !chosen ? '请先选择一个 SAM2 分割候选。' : '将在计算节点拟合点簇和包围盒，完成后自动加入物体面板。'}</p>
    </details>
    <details><summary>4 · 导出SymphoMotion Rendered Frames</summary>{envField('export')}
      <label>全局场景与运动提示词<textarea rows={3} value={project.description} disabled={locked} onChange={e => { const value = e.target.value; onChange(project.id, p => ({ ...p, description: value })); }} /></label>
      <div className="workflow-fields">{([{ label: '帧数（4n+1）', value: numFrames, set: setNumFrames }, { label: 'FPS', value: fps, set: setFps }, { label: '宽（16 的倍数）', value: width, set: setWidth }, { label: '高（16 的倍数）', value: height, set: setHeight }, { label: '点半径（NDC）', value: radius, set: setRadius }]).map(field => <label key={field.label}>{field.label}<input type="number" step="any" value={field.value} onChange={e => field.set(Number(e.target.value))} /></label>)}</div>
      <p>渲染参考场景的原处点云，仅叠加操控物体的投影框。输出 RGB、空洞 mask 和点集轨迹。物体控制：{motionControls(project).object ? '开启' : '关闭'}；相机控制：{motionControls(project).camera ? '开启' : '关闭（固定参考视角）'}。开关位于生成面板的输入参数中。</p>
      <button className="dcp-button is-primary" disabled={disabled('export') || !project.workflow?.sceneJobId} onClick={() => void guard(exportConditions)}>导出SymphoMotion Rendered Frames</button>
    </details>
    {!!project.workflow?.pending.length && <div role="status"><h4>待确认提交</h4>{project.workflow.pending.map(request => <p key={request.requestId}>{LABELS[request.kind]} <button className="dcp-button" disabled={busy || locked} onClick={() => void guard(() => post(request))}>使用原请求 ID 重试确认</button></p>)}</div>}
    <details open><summary>工作流作业 · {jobs.length}</summary>{jobs.slice(0, 20).map(job => <article className="workflow-job" key={job.id}>
      <strong>{LABELS[job.kind]} · {STATES[job.status]}</strong><p>{job.message}</p>{job.slurmId && <small>Slurm {job.slurmId}</small>}
      {job.outputDirectory && <p className="workflow-output-path">产物目录：<code>{job.outputDirectory}</code></p>}
      {applicationErrors[job.id] && <p role="alert">应用结果失败：{applicationErrors[job.id]} 可核对后手动重试。</p>}
      <div className="workflow-actions"><button className="dcp-button" onClick={() => void guard(async () => { const logs = await workflowApi<Record<string, { text: string }>>(`/inference/jobs/${job.id}/logs`); const blob = new Blob([Object.entries(logs).map(([name, value]) => `${name}\n${value.text}`).join('\n')]); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${job.id}.log`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); })}>下载日志</button>
        {!isTerminalJob(job) && <button className="dcp-button" disabled={busy || locked || job.cancelRequested} onClick={() => void guard(async () => { await workflowApi(`/inference/jobs/${job.id}/cancel`, 'POST', {}); await reload(); })}>取消任务</button>}
        {job.status === 'succeeded' && !job.cancelRequested && job.inputs.referenceAssetId === project.workflow?.referenceAssetId && <>
          {job.kind === 'depth' && <button className="dcp-button" disabled={busy || locked || project.workflow?.sceneJobId === job.id} onClick={() => void guard(() => applyDepth(job))}>应用重建</button>}
          {job.kind === 'associate' && <button className="dcp-button" disabled={busy || locked || project.objects.some(o => o.reconstruction?.jobId === job.id) || (!!job.inputs.replaceObjectJobId && !project.workflow?.objectDefinitions?.some(item => item.requestId === job.requestId))} onClick={() => void guard(() => applyObject(job))}>{job.inputs.replaceObjectJobId ? '应用包围盒更新' : '加入场景'}</button>}
          {job.kind === 'export' && <button className="dcp-button" disabled={busy || locked} onClick={() => void guard(() => useForGeneration(job))}>填入生成配置</button>}
        </>}
      </div>
      {job.kind === 'export' && job.status === 'succeeded' && <details><summary>预览与下载条件包</summary><video controls preload="none" src={outputUrl(job, 'sample/render_output/render_with_2d_bbox.mp4')} /><video controls preload="none" src={outputUrl(job, 'sample/render_output/render_mask.mp4')} /><a href={outputUrl(job, 'conditions.zip')} download>下载完整条件包</a></details>}
    </article>)}</details>
  </section>;
}
