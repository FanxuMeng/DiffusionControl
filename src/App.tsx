import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Box, Camera, Check, ChevronDown, ChevronRight, Circle, CircleHelp, Command, Crosshair, Expand, Eye, EyeOff, Film, Focus, FolderOpen, Grid2X2, Image, Layers3, LoaderCircle, MousePointer2, Move3D, Pause, Play, Plus, RotateCcw, Scan, Settings2, SkipBack, Sparkles, Square, Upload, X } from 'lucide-react';
import { Moon, Sun } from 'lucide-react';
import { applyTheme, readTheme } from './theme';
import { validateGenerationState } from './generation/domain';
import ProjectTransfer from './ProjectTransfer';
import { archiveProject, removeProject, renameProject, withoutDemoProjects, type ClusterListing } from './projects';
import { getGlobalExecution, getJob, submitWorkflow, workflowApi, WorkflowError } from './workflow/api';
import { enqueueWorkflowRequest, makeWorkflowRequest } from './workflow/requests';
import BoundingBoxEditor from './BoundingBoxEditor';
import { boxError, objectSelectionBox } from './boxEditing';
import type { BoxEditState, SelectionBox } from './types';
import type { GenerationState } from './generation/types';
import { useRealScene } from './workflow/realScene';
import { removeCameraTrajectory, removeSceneObject } from './workflow/objects';
import type { SamPrompts, TaskKind } from './workflow/types';
import { adjustMoveSpeed, MAX_MOVE_SPEED, MIN_MOVE_SPEED, wheelSpeedAllowed } from './navigationSpeed';
import { commitRecordedTake, currentPreviewTrajectory, prepareRecordedTake } from './recording';
import { saveRecoveryBackup } from './recoveryBackup';
import SceneViewport from './SceneViewport';
import ControlPanels from './ControlPanels';
import Timeline from './Timeline';
import LensEditor from './LensEditor';
import { makeDefaultClip, validateClip, migratePrototypeWorkspace } from './model';
import { cameraCompatibility, createCameraIntrinsics } from './cameraMath';
import { createEmptyProject, DEFAULT_SETTINGS, downloadJson, exportTrajectory, frontPose, makePreset, makeTrajectoryPreview, parseTrajectory } from './model';
import type { CameraIntrinsicsTrack, ControlSettings, Face, MotionClip, Project, RecordState, Sample, SceneHandle, Telemetry, Trajectory, View } from './types';

const STORAGE_KEY = 'diffusioncontrol.prototype.v2';
const RECOVERY_KEY = `${STORAGE_KEY}.recovery.${Date.now()}`;
let initialStorageIssue = '';
let initialSaveBlocked = false;
let pendingRecoveryRaw: string | null = null;
let recoveryTask: Promise<void> | null = null;
let recoveryFailed = false;
const PRESETS = [{ key: 'slide', name: '平稳推进', en: 'DOLLY', description: '沿正前方向平移，保持初始朝向。' }, { key: 'arc', name: '弧线运动', en: 'ARC', description: '平滑弧线，带有自然的朝向变化。' }, { key: 'rise', name: '缓慢升高', en: 'RISE', description: '沿世界上方移动，体验空间纵深。' }, { key: 'orbit', name: '环绕运动', en: 'ORBIT', description: '以曲线组织平移和旋转。' }];
function loadProjects(): Project[] {
  let current: string | null = null;
  const preserveCurrent = () => {
    if (current === null) return;
    try {
      localStorage.setItem(RECOVERY_KEY, current);
      initialStorageIssue += ` 原始工作区已备份到本机 ${RECOVERY_KEY}。`;
    } catch {
      initialSaveBlocked = true;
      pendingRecoveryRaw = current;
      initialStorageIssue += ' 正在尝试浏览器恢复备份；完成前暂不覆盖旧工作区。';
    }
  };
  try {
    current = localStorage.getItem(STORAGE_KEY);
    const stored = current ?? localStorage.getItem('diffusioncontrol.prototype.v1');
    if (stored !== null) {
      const value: unknown = JSON.parse(stored);
      const result = migratePrototypeWorkspace(value, current ? 2 : 1);
      if (result.issues.length) {
        initialStorageIssue = result.issues.map(i => i.message).join('；');
        preserveCurrent();
      }
      const cleaned = withoutDemoProjects(result.projects);
      if (cleaned.length !== result.projects.length) { initialStorageIssue += ' 示例项目已移入旧工作区恢复副本。'; preserveCurrent(); }
      return cleaned;
    }
  } catch {
    initialStorageIssue = '原有本地项目读取失败。';
    if (current === null) initialSaveBlocked = true;
    preserveCurrent();
  }
  return [];
}
function readFile(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }); }

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => applyTheme(theme, true), [theme]);
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [persistenceRevision, setPersistenceRevision] = useState(0);
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const blankProject = useMemo(() => createEmptyProject('尚未创建项目', 'projects'), []);
  const project = projects.find(p => p.id === projectId) || projects[0] || blankProject;
  const hasProject = projects.length > 0;
  const [transfer, setTransfer] = useState<'import' | 'export' | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [boxEdit, setBoxEdit] = useState<BoxEditState | null>(null);
  const [boxSubmitting, setBoxSubmitting] = useState(false);
  const [associationEnvironment, setAssociationEnvironment] = useState('depthpro');
  const [view, setView] = useState<View>('2d');
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(project.objects.find(o => o.segmented)?.id || null);
  const [target, setTarget] = useState<string | null>(null);
  const [timelineTarget, setTimelineTarget] = useState<string | null>(null);
  const [recordState, setRecordState] = useState<RecordState>('preview');
  const [countdown, setCountdown] = useState(3);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followCamera, setFollowCamera] = useState(false);
  const [segmenting, setSegmenting] = useState(false);
  const [samPrompts, setSamPrompts] = useState<SamPrompts>({ points: [], box: null });
  const [samPromptMode, setSamPromptMode] = useState<'positive' | 'negative' | 'box'>('positive');
  const realScene = useRealScene(project);
  const [showMasks, setShowMasks] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showTrajectories, setShowTrajectories] = useState(true);
  const [settings, setSettings] = useState<ControlSettings>(DEFAULT_SETTINGS);
  const changeMoveSpeed = useCallback((steps: number) => setSettings(current => ({ ...current, moveSpeed: adjustMoveSpeed(current.moveSpeed, steps) })), []);
  const [telemetry, setTelemetry] = useState<Telemetry>({ position: [0, 0, 0], speed: 0, points: 0, controlled: false });
  const [modal, setModal] = useState<'new' | 'presets' | 'help' | 'settings' | 'lens' | 'preview' | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ projectId: string; targetId: string } | null>(null);
  const previewProject = projects.find(p => p.id === previewTarget?.projectId);
  const previewTrajectory = previewTarget && previewProject ? currentPreviewTrajectory(previewProject, previewTarget.targetId) : null;
  const [presetTarget, setPresetTarget] = useState<{ kind: 'object' | 'camera'; target: string }>({ kind: 'camera', target: 'camera' });
  const [selectedPreset, setSelectedPreset] = useState('arc');
  const [newName, setNewName] = useState('未命名场景');
  const [parentPath, setParentPath] = useState('projects');
  const [job, setJob] = useState<{ label: string; progress: number; type: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const [saveStatus, setSaveStatus] = useState('本机已保存');
  const [draftSamples, setDraftSamples] = useState<Sample[]>([]);
  const [importMode, setImportMode] = useState<'project' | 'trajectory'>('project');
  const scene = useRef<SceneHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const samplesRef = useRef<Sample[]>([]);
  const stateRef = useRef(recordState);
  const timeRef = useRef(time);
  const targetRef = useRef(target);
  const captureStart = useRef(0);
  const captureLens = useRef<CameraIntrinsicsTrack | null>(null);
  const durationRef = useRef(project.duration);
  const projectIdRef = useRef(project.id);
  const jobTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  stateRef.current = recordState; timeRef.current = time; targetRef.current = target; projectIdRef.current = project.id; durationRef.current = project.duration;
  const locked = recordState !== 'preview' || projectBusy || !!transfer || !!boxEdit || boxSubmitting;
  const boxPending = (id: string) => !!project.workflow?.objectDefinitions?.some(item => item.id === id && item.replaceObjectJobId);
  const selectedObject = project.objects.find(o => o.id === selectedObjectId);
  const recordedObject = project.objects.find(o => o.id === target);
  const selectedTrajectory = target === 'camera' ? project.camera : selectedObject?.trajectory;
  const canRecord = !job && !!target && !boxPending(target) && view === '3d' && project.geometryReady && (target === 'camera' ? project.fourD === 'ready' : !!recordedObject?.segmented && !!recordedObject.front);
  const wheelEnabled = wheelSpeedAllowed({ controlled: telemetry.controlled, view, recordState, followCamera, ctrlKey: false, metaKey: false, editing: !!modal });
  const notify = useCallback((text: string, kind: 'info' | 'success' | 'error' = 'info') => setToast({ text, kind }), []);
  const updateProject = useCallback((fn: (p: Project) => Project) => setProjects(prev => prev.map(p => p.id === projectIdRef.current ? { ...fn(p), updatedAt: new Date().toISOString() } : p)), []);
  const updateGeneration = useCallback((id: string, update: (state: GenerationState) => GenerationState) => setProjects(previous => previous.map(p => p.id === id ? { ...p, generation: update(p.generation), updatedAt: new Date().toISOString() } : p)), []);
  const updateWorkflowProject = useCallback((id: string, update: (project: Project) => Project) => setProjects(previous => previous.map(p => { if (p.id !== id) return p; const next = update(p); return next === p ? p : { ...next, updatedAt: new Date().toISOString() }; })), []);
  const workflowApplied = useCallback((kind: TaskKind, objectId?: string, sourceProjectId?: string) => { if (sourceProjectId && projectIdRef.current !== sourceProjectId) return; scene.current?.releaseControl(); setTarget(null); setSegmenting(false); setView('3d'); setTime(0); setPlaying(false); setSamPrompts({ points: [], box: null }); if (kind === 'depth') setSelectedObjectId(null); if (objectId) setSelectedObjectId(objectId); }, []);
  useEffect(() => { setSamPrompts({ points: [], box: null }); }, [project.id, project.workflow?.referenceAssetId]);
  useEffect(() => { if (realScene.error) notify(realScene.error, 'error'); }, [realScene.error, notify]);

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4800); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { if (initialSaveBlocked) { setSaveStatus(pendingRecoveryRaw && !recoveryFailed ? '正在备份旧工作区' : '仅当前会话 · 请导出'); return; } try { localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); setSaveStatus('本机已保存'); } catch { setSaveStatus('存储空间不足'); notify('本机存储空间不足，请导出项目备份。当前会话仍保留在内存。', 'error'); } }, [projects, notify, persistenceRevision]);
  useEffect(() => {
    if (!pendingRecoveryRaw) return;
    let cancelled = false;
    recoveryTask ??= saveRecoveryBackup(RECOVERY_KEY, pendingRecoveryRaw);
    recoveryTask.then(() => {
      if (cancelled) return;
      pendingRecoveryRaw = null; initialSaveBlocked = false;
      setPersistenceRevision(value => value + 1);
      notify('旧工作区已完成浏览器恢复备份，自动保存已恢复。', 'success');
    }).catch(() => {
      if (cancelled) return;
      recoveryFailed = true;
      setSaveStatus('仅当前会话 · 请导出');
      notify('恢复备份未成功，旧工作区未被覆盖；请导出当前项目保留修改。', 'error');
    });
    return () => { cancelled = true; };
  }, [notify]);
  useEffect(() => () => { if (jobTimer.current) clearInterval(jobTimer.current); }, []);
  useEffect(() => { if (initialStorageIssue) notify(initialStorageIssue, 'error'); }, [notify]);

  const pauseRecording = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    const lastTime = Math.min((performance.now() - captureStart.current) / 1000, durationRef.current);
    const pose = targetRef.current ? scene.current?.getPose(targetRef.current) : null;
    if (pose && lastTime > (samplesRef.current.at(-1)?.t ?? 0)) samplesRef.current.push({ ...pose, t: lastTime });
    timeRef.current = lastTime; setTime(lastTime);
    stateRef.current = 'paused';
    setRecordState('paused'); setPlaying(false); scene.current?.releaseControl();
    setDraftSamples([...samplesRef.current]);
  }, []);
  const onControlLost = useCallback(() => {
    if (stateRef.current === 'recording') pauseRecording();
    else if (stateRef.current === 'countdown') { stateRef.current = 'preview'; setRecordState('preview'); notify('倒计时已取消，起始位姿未记录。'); }
  }, [pauseRecording, notify]);

  useEffect(() => {
    if (recordState !== 'countdown') return;
    const deadline = performance.now() + 3000;
    const ticker = setInterval(() => setCountdown(Math.max(1, Math.ceil((deadline - performance.now()) / 1000))), 100);
    const start = setTimeout(() => {
      if (stateRef.current !== 'countdown') return;
      const pose = scene.current?.getPose(targetRef.current!);
      samplesRef.current = pose ? [{ ...pose, t: 0 }] : [];
      setDraftSamples([...samplesRef.current]); setTime(0); setCountdown(0);
      captureStart.current = performance.now();
      stateRef.current = 'recording'; setRecordState('recording');
    }, 3000);
    return () => { clearInterval(ticker); clearTimeout(start); };
  }, [recordState]);
  useEffect(() => {
    if (recordState !== 'recording' || !target) return;
    const started = captureStart.current; let frame = 0; let lastDraw = 0;
    const tick = (now: number) => {
      if (stateRef.current !== 'recording') return;
      const t = Math.min((now - started) / 1000, project.duration);
      const pose = scene.current?.getPose(target);
      if (pose && t > (samplesRef.current.at(-1)?.t ?? -1)) samplesRef.current.push({ ...pose, t });
      timeRef.current = t;
      if (now - lastDraw > 35 || t === project.duration) { setTime(t); setDraftSamples([...samplesRef.current]); lastDraw = now; }
      if (t >= project.duration) { pauseRecording(); notify(`已达到 ${project.duration} 秒，录制已暂停。点击「结束录制」保存。`); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [recordState, target, project.duration, pauseRecording, notify]);
  useEffect(() => {
    if (!playing || locked) return;
    let previous = performance.now(); let frame = 0;
    const tick = (now: number) => { const next = timeRef.current + (now - previous) / 1000; previous = now; if (next >= project.duration) { timeRef.current = project.duration; setTime(project.duration); setPlaying(false); return; } timeRef.current = next; setTime(next); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing, locked, project.duration]);

  const acceptImportedProject = (incoming: Project) => {
    const existing = projects.find(item => item.id === incoming.id);
    if (existing) {
      if (!window.confirm(`本机已有「${existing.name}」。替换为导入版本？当前版本会保留在回收记录。`)) throw new Error('已取消替换本机项目。');
      archiveProject(localStorage, existing);
    }
    scene.current?.releaseControl();
    setProjects(previous => [...previous.filter(item => item.id !== incoming.id), incoming]);
    setProjectId(incoming.id); setSelectedObjectId(incoming.objects.find(item => item.segmented)?.id || null);
    setTarget(null); setTimelineTarget(null); setView('2d'); setTime(0); setPlaying(false); setFollowCamera(false); setSegmenting(false); setDraftSamples([]);
    notify(`已打开「${incoming.name}」。`, 'success');
  };
  const deleteProject = async (id: string) => {
    const item = projects.find(p => p.id === id);
    if (!item || locked || job || !window.confirm(`删除项目「${item.name}」？将保留可恢复副本，集群作业与产物保留，运行任务继续执行。`)) return;
    setProjectBusy(true);
    try {
      archiveProject(localStorage, item);
      let listing: ClusterListing | null = null;
      try { listing = await workflowApi<ClusterListing>('/projects'); }
      catch { if (!window.confirm('暂时无法连接集群。是否仅从本机移除项目？集群快照保持原状。')) return; }
      const saved = listing?.projects.find(row => row.projectId === id);
      if (saved && !saved.deleted) await workflowApi(`/projects/snapshots/${saved.key}/delete`, 'POST', { revision: saved.revision });
      const next = removeProject(projects, id, project.id);
      if (id === project.id) {
        scene.current?.releaseControl(); setSelectedObjectId(null); setTarget(null); setTimelineTarget(null); setView('2d'); setTime(0); setPlaying(false); setFollowCamera(false); setSegmenting(false); setDraftSamples([]);
      }
      setProjects(previous => previous.filter(p => p.id !== id)); setProjectId(next.selectedId); notify('项目已移入回收记录，可从导入／恢复入口找回。', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : '删除失败，项目已保留。', 'error'); }
    finally { setProjectBusy(false); }
  };
  const selectProject = (id: string) => { if (locked || job || id === project.id || !projects.some(p => p.id === id)) return; setTimelineTarget(null); scene.current?.releaseControl(); setProjectId(id); setSelectedObjectId(projects.find(p => p.id === id)?.objects.find(o => o.segmented)?.id || null); setView('2d'); setTarget(null); setSegmenting(false); setTime(0); setPlaying(false); setDraftSamples([]); setFollowCamera(false); };
  const changeView = (next: View) => {
    if (locked || job) return;
    if (next === '3d' && !project.geometryReady && !project.workflow) { notify('请先上传首帧并提交 Depth Pro 重建。'); return; }
    scene.current?.releaseControl(); setView(next); setSegmenting(false); setPlaying(false); setTime(0); setFollowCamera(false);
    if (next === '2d') setTarget(null);
  };
  const pickObject = (id: string) => {
    if (locked || job) return;
    setSelectedObjectId(id);
    const object = project.objects.find(o => o.id === id);
    if (segmenting && object && !object.segmented) { updateProject(p => ({ ...p, objects: p.objects.map(o => o.id === id ? { ...o, segmented: true } : o), fourD: p.fourD === 'missing' ? 'missing' : 'stale' })); notify(`已选择「${object.name}」的演示 mask，接下来在 3D 中指定正面。`, 'success'); }
    else if (segmenting && object) notify(`已选中「${object.name}」，可在右侧编辑提示词。`);
  };
  const beginBoxEdit = () => {
    if (locked || job || !selectedObject?.reconstruction || !project.geometryReady || boxPending(selectedObject.id)) return;
    scene.current?.releaseControl(); setTarget(null); targetRef.current = null; setTime(0); timeRef.current = 0;
    setPlaying(false); setFollowCamera(false); setDraftSamples([]); setSegmenting(false); setShowBoxes(true);
    const box = objectSelectionBox(selectedObject);
    setBoxEdit({ projectId: project.id, objectId: selectedObject.id, sourceJobId: selectedObject.reconstruction.jobId, original: structuredClone(box), box, mode: 'translate' });
  };
  const changeBox = (box: SelectionBox) => setBoxEdit(previous => previous ? { ...previous, box } : previous);
  const cancelBoxEdit = () => { if (boxSubmitting) return; scene.current?.releaseControl(); setBoxEdit(null); };
  const submitBoxEdit = async () => {
    if (!boxEdit || boxSubmitting || boxError(boxEdit.box)) return;
    const edit = boxEdit, object = project.objects.find(item => item.id === edit.objectId);
    if (!object?.reconstruction || object.reconstruction.jobId !== edit.sourceJobId || !project.workflow?.sceneJobId) { notify('原物体已变化，请重新编辑。', 'error'); return; }
    setBoxSubmitting(true);
    try {
      const [execution, source] = await Promise.all([getGlobalExecution(), getJob(edit.sourceJobId)]);
      if (source.kind !== 'associate' || !source.inputs.segmentationJobId || typeof source.options.candidate !== 'number') throw new Error('原物体关联来源不完整。');
      const request = makeWorkflowRequest(project, 'associate', { referenceAssetId: project.workflow.referenceAssetId, sceneJobId: project.workflow.sceneJobId,
        segmentationJobId: source.inputs.segmentationJobId, replaceObjectJobId: edit.sourceJobId,
        objectJobIds: project.objects.filter(item => item.id !== object.id).map(item => item.reconstruction!.jobId) },
        { candidate: source.options.candidate, selectionBox: edit.box }, associationEnvironment, execution);
      updateWorkflowProject(project.id, p => enqueueWorkflowRequest(p, request, { id: object.id, name: object.name, prompt: object.prompt,
        segmentationJobId: source.inputs.segmentationJobId!, candidate: source.options.candidate as number, replaceObjectJobId: edit.sourceJobId }));
      scene.current?.releaseControl(); setBoxEdit(null);
      try {
        await submitWorkflow(request);
        updateWorkflowProject(project.id, p => !p.workflow ? p : { ...p, workflow: { ...p.workflow, pending: p.workflow.pending.filter(item => item.requestId !== request.requestId) } });
        notify('包围盒更新已提交 Slurm。成功后替换点簇并清除当前物体轨迹。', 'success');
      } catch (error) {
        if (error instanceof WorkflowError && [400, 422].includes(error.status)) updateWorkflowProject(project.id, p => !p.workflow ? p : { ...p, workflow: { ...p.workflow,
          pending: p.workflow.pending.filter(item => item.requestId !== request.requestId),
          objectDefinitions: p.workflow.objectDefinitions?.map(item => item.requestId === request.requestId ? { ...item, submissionError: error.message.slice(0, 2000) } : item) } });
        throw error;
      }
    } catch (error) { notify(error instanceof Error ? error.message : '提交失败，原物体仍保留。', 'error'); }
    finally { setBoxSubmitting(false); }
  };
  const deleteCameraTrajectory = () => {
    if (!project.camera || locked || job || !window.confirm(`删除相机轨迹「${project.camera.name}」？当前轨迹将移入历史列表，可在轨迹预设中恢复。后续生成需重新导出 Rendered Frames。`)) return;
    updateWorkflowProject(project.id, removeCameraTrajectory);
    scene.current?.releaseControl(); setPlaying(false); setTime(0); timeRef.current = 0; setFollowCamera(false);
    if (target === 'camera') { setTarget(null); targetRef.current = null; setDraftSamples([]); samplesRef.current = []; }
    if (timelineTarget === 'camera') setTimelineTarget(null);
    if (previewTarget?.projectId === project.id && previewTarget.targetId === 'camera') { setPreviewTarget(null); if (modal === 'preview') setModal(null); }
    notify('相机轨迹已移入历史列表，相机控制已关闭；生成前请重新导出 Rendered Frames。', 'success');
  };
  const deleteObject = (id: string) => {
    const item = project.objects.find(object => object.id === id)
      || project.workflow?.objectDefinitions?.find(definition => definition.id === id);
    if (!item || locked || job || !window.confirm(`删除物体「${item.name}」？将移除其定义、包围盒和全部轨迹历史，点云保留为静态背景。集群作业和产物保留，运行任务继续执行。后续生成需重新导出 Rendered Frames。`)) return;
    updateWorkflowProject(project.id, p => removeSceneObject(p, id));
    scene.current?.releaseControl(); setPlaying(false); setTime(0); timeRef.current = 0; setFollowCamera(false);
    if (selectedObjectId === id) setSelectedObjectId(project.objects.find(object => object.id !== id && object.segmented)?.id || null);
    if (timelineTarget === id) setTimelineTarget(null);
    if (target === id) { setTarget(null); targetRef.current = null; setDraftSamples([]); samplesRef.current = []; }
    if (previewTarget?.projectId === project.id && previewTarget.targetId === id) { setPreviewTarget(null); if (modal === 'preview') setModal(null); }
    if (presetTarget.kind === 'object' && presetTarget.target === id) { setPresetTarget({ kind: 'camera', target: 'camera' }); if (modal === 'presets') setModal(null); }
    notify(`已删除「${item.name}」。原始点云与集群产物保留；生成前请重新导出 Rendered Frames。`, 'success');
  };
  const chooseFront = (id: string, face: Face) => {
    if (locked || job || boxPending(id) || project.objects.find(o => o.id === id)?.front === face) return;
    updateProject(p => ({ ...p, fourD: p.fourD === 'missing' ? 'missing' : 'stale', objects: p.objects.map(o => o.id === id ? { ...o, front: face, initialPose: frontPose(o, face), trajectory: null, clip: null, history: o.trajectory ? [o.trajectory, ...o.history] : o.history, motion: o.motion === 'static' ? 'static' : 'unassigned' } : o) }));
    notify(`正面已设为 ${face.toUpperCase()}，物体局部 +X 已对齐。${face.endsWith('y') ? '此方向采用世界 +Z 作为上方参考。' : ''}`, 'success');
  };
  const armTarget = (id: string) => {
    if (locked || job || boxPending(id)) return;
    if (id === 'camera') { if (project.fourD !== 'ready') { notify('请先构建有效的 4D 场景。'); return; } setView('3d'); notify('相机录制从首帧位姿及参考镜头开始；结束后可编辑固定镜头参数。'); }
    else { const o = project.objects.find(o => o.id === id); if (!o?.front || !o.segmented || !project.geometryReady) { notify('请先完成物体分割、3D 关联并选择正面。'); return; } setSelectedObjectId(id); setView('3d'); notify(`已选择「${o.name}」为录制目标。可先自由观察，点击「开始录制」后才控制物体。`); }
    setTarget(id); setTime(0); setPlaying(false); setFollowCamera(false); setDraftSamples([]);
  };
  const startRecording = async () => {
    if (!target || locked || !scene.current || !canRecord) return;
    const requestedProject = project.id; const requestedTarget = target;
    if (target === 'camera') {
      if (!project.referenceCamera) { notify('缺少参考相机标定，无法开始相机录制。', 'error'); return; }
      captureLens.current = createCameraIntrinsics(structuredClone(project.referenceCamera));
    }
    scene.current.prepareTarget(target); setPlaying(false); setTime(0); setFollowCamera(false);
    const acquired = await scene.current.requestControl();
    if (projectIdRef.current !== requestedProject || targetRef.current !== requestedTarget) { scene.current?.releaseControl(); return; }
    if (!acquired) { notify('未能进入鼠标控制。请直接点击「开始录制」，并允许浏览器锁定鼠标。', 'error'); return; }
    setCountdown(3); setDraftSamples([]); samplesRef.current = []; stateRef.current = 'countdown'; setRecordState('countdown');
  };
  const finishRecording = () => {
    if (recordState !== 'paused' || !target) return;
    const targetId = target;
    try {
      const take = prepareRecordedTake(project, targetId, samplesRef.current, captureLens.current);
      stateRef.current = 'saving'; setRecordState('saving');
      setProjects(previous => previous.map(item => item.id === take.projectId ? commitRecordedTake(item, take) : item));
      if (targetId !== 'camera') setSelectedObjectId(targetId);
      setTimelineTarget(targetId); setTarget(null); stateRef.current = 'preview'; setRecordState('preview');
      timeRef.current = 0; setTime(0); setDraftSamples([]);
      notify('新轨迹与三维预览图已同步保存到本机。', 'success');
    } catch (error) {
      stateRef.current = 'paused'; setRecordState('paused');
      notify(error instanceof Error ? error.message : '保存失败，录制数据仍保留，请重试。', 'error');
    }
  };
  const runDemoJob = (type: string, label: string, complete: () => void) => {
    if (jobTimer.current) clearInterval(jobTimer.current); let progress = 0;
    setJob({ type, label, progress: 0 });
    jobTimer.current = setInterval(() => { progress = Math.min(100, progress + 14); setJob({ type, label, progress }); if (progress >= 100) { clearInterval(jobTimer.current!); jobTimer.current = null; complete(); setJob(null); } }, 180);
  };
  const build4D = () => {
    if (locked || job) return;
    if (!project.geometryReady || project.objects.some(o => o.segmented && o.motion === 'unassigned')) { notify('请为已分割的物体应用轨迹，或显式设为静止。'); return; }
    if (!project.demoScene) { updateProject(p => ({ ...p, fourD: 'ready' })); setView('3d'); setTime(0); setPlaying(true); setTarget(null); notify('物体运动与静态背景已组合，可以录制相机并提交条件导出。', 'success'); return; }
    runDemoJob('4d', '组合物体运动与静态背景', () => { updateProject(p => ({ ...p, fourD: 'ready' })); setView('3d'); setTime(0); setPlaying(true); setTarget(null); notify('4D 场景已就绪。现在可以在动态场景中录制相机。', 'success'); });
  };
  const openPresets = (kind: 'camera' | 'object', id: string) => { setPresetTarget({ kind, target: id }); setSelectedPreset('arc'); setModal('presets'); };
  const applyTrajectory = (trajectory: Trajectory, importedTiming?: { start: number; duration: number }) => {
    if (locked || job) return;
    try {
      const normalized = parseTrajectory(trajectory, presetTarget.kind, presetObject, project.cameraIntrinsics ?? undefined);
      trajectory = { ...normalized, id: trajectory.id, source: trajectory.source, createdAt: trajectory.createdAt };
    } catch (error) { notify(error instanceof Error ? error.message : '轨迹与当前目标不兼容。', 'error'); return; }
    let clip = makeDefaultClip(trajectory);
    try { clip = validateClip({ ...clip, ...importedTiming }, trajectory, project.duration); }
    catch (error) { notify(`请先延长项目时长，或检查导入片段。${error instanceof Error ? error.message : ''}`, 'error'); return; }
    trajectory.preview = makeTrajectoryPreview(trajectory.samples, presetObject?.color, { kind: trajectory.kind, cameraIntrinsics: trajectory.cameraIntrinsics, clip });
    if (presetTarget.kind === 'object') {
      const object = project.objects.find(o => o.id === presetTarget.target);
      if (!object?.front || !project.geometryReady) { notify('请先在 3D 中为物体选择正面。', 'error'); return; }
      updateProject(p => ({ ...p, fourD: p.fourD === 'missing' ? 'missing' : 'stale', objects: p.objects.map(o => o.id === object.id ? { ...o, motion: 'trajectory', trajectory, clip, history: o.trajectory ? [o.trajectory, ...o.history] : o.history } : o) })); setSelectedObjectId(object.id); setView('3d'); setTarget(null);
    } else {
      if (project.fourD !== 'ready') { notify('相机预设可以浏览，应用前请先构建 4D。'); return; }
      updateProject(p => ({ ...p, camera: trajectory, cameraClip: clip, cameraIntrinsics: trajectory.cameraIntrinsics!, cameraHistory: p.camera ? [p.camera, ...p.cameraHistory] : p.cameraHistory })); setView('3d'); setTarget(null);
    }
    setModal(null); setTime(0); setPlaying(true); notify('轨迹已应用，首点与当前目标对齐。', 'success');
  };
  const downloadTrajectory = (trajectory: Trajectory) => { const clip = trajectory.kind === 'camera' ? project.cameraClip : project.objects.find(o => o.trajectory?.id === trajectory.id)?.clip; downloadJson(exportTrajectory(trajectory, clip ?? undefined), `${trajectory.name}.json`); if (trajectory.preview) { const a = document.createElement('a'); a.href = trajectory.preview; a.download = `${trajectory.name}.png`; a.click(); } notify('已导出原始轨迹、片段时间映射、镜头参数与独立 PNG。', 'success'); };
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      if (importMode === 'trajectory') {
        const data = JSON.parse(await files[0].text());
        const trajectory = parseTrajectory(data, presetTarget.kind, project.objects.find(o => o.id === presetTarget.target), project.cameraIntrinsics ?? undefined);
        let timing: { start: number; duration: number } | undefined;
        if (data.clip) {
          if ((data.clip.trajectory_id ?? data.clip.trajectoryId) !== (data.trajectory_id ?? data.id)) throw new Error('导入片段与源轨迹 ID 不匹配。');
          if ((data.clip.trajectory_revision ?? data.clip.trajectoryRevision) !== (data.revision ?? 1)) throw new Error('导入片段与源轨迹版本不匹配。');
          const clip = validateClip({ ...data.clip, trajectoryId: trajectory.id, trajectoryRevision: trajectory.revision }, trajectory, project.duration);
          timing = { start: clip.start, duration: clip.duration };
        }
        applyTrajectory(trajectory, timing);
      }
      else {
        const imported: Project[] = [];
        for (const file of Array.from(files).filter(f => f.name.endsWith('.json') && !f.name.includes('trajectory'))) {
          const raw = JSON.parse(await file.text());
          let p: Project | null = null;
          if (raw.format === 'diffusioncontrol.prototype') {
            const migrated = migratePrototypeWorkspace({ version: raw.version ?? 1, projects: [raw.project] }, raw.version ?? 1);
            if (!migrated.projects.length) throw new Error(migrated.issues.map(issue => issue.message).join('；'));
            p = migrated.projects[0];
          }
          else if (raw.project_id && raw.name) { p = createEmptyProject(raw.name, raw.directory?.relative_path || 'projects'); if (raw.generation !== undefined) p.generation = validateGenerationState(raw.generation); const referenceName = raw.reference?.image?.path?.relative_path?.split('/').pop(); const imageFile = Array.from(files).find(f => f.name === referenceName); if (imageFile) p.reference = await readFile(imageFile); }
          if (p) {
            if (p.workflow && [...projects, ...imported].some(existing => existing.id === p.id)) throw new Error(`工作流项目「${p.name}」已存在，请使用现有项目；同一服务端项目不能导入为副本。`);
            imported.push({ ...p, id: p.workflow ? p.id : crypto.randomUUID(), updatedAt: new Date().toISOString() });
          }
        }
        if (!imported.length) throw new Error('未找到可识别的 project.json 或原型项目文件。');
        setProjects(prev => [...prev, ...imported]); setProjectId(imported[0].id); setSelectedObjectId(imported[0].objects.find(o => o.segmented)?.id || null); setTarget(null); setView('2d'); setTime(0); setPlaying(false); setModal(null); notify(`已导入 ${imported.length} 个项目。真实资产会从当前服务恢复，需保留原服务端作业文件。`, 'success');
      }
    } catch (error) { notify(error instanceof Error ? error.message : '文件读取失败', 'error'); }
    if (fileInput.current) fileInput.current.value = ''; if (folderInput.current) folderInput.current.value = '';
  };
  const importImage = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { notify('请选择图像文件。', 'error'); return; }
    const destinationId = projectIdRef.current;
    try {
      const reference = await readFile(file);
      setProjects(previous => previous.map(p => p.id === destinationId ? { ...p, reference, workflow: undefined, demoScene: null, demoSceneRevision: null, objects: [], geometryReady: false, fourD: 'missing', camera: null, cameraClip: null, cameraIntrinsics: null, referenceCamera: null, updatedAt: new Date().toISOString() } : p));
      if (projectIdRef.current === destinationId) { setView('2d'); setTarget(null); setSelectedObjectId(null); }
      notify('首帧已导入。请在重建与分割面板上传首帧，再提交 Depth Pro 和 SAM2 任务。', 'success');
    } catch { notify('首帧读取失败，请重新选择图像。', 'error'); }
  };
  const startSegmentation = () => { if (locked || job) return; if (!project.demoScene && !project.workflow) { notify('请先在重建与分割面板上传首帧。'); return; } setView('2d'); setTarget(null); setSegmenting(v => !v); setShowMasks(true); };

  const seekTime = (next: number) => { if (locked || job) return; scene.current?.releaseControl(); setTarget(null); setPlaying(false); timeRef.current = next; setTime(next); };
  const getCaptureTime = useCallback(() => stateRef.current === 'recording' ? Math.min((performance.now() - captureStart.current) / 1000, durationRef.current) : timeRef.current, []);
  const selectTimelineTarget = (id: string) => {
    if (locked || job) return;
    scene.current?.releaseControl(); setTarget(null); setTimelineTarget(id);
    if (id !== 'camera') setSelectedObjectId(id);
  };
  const changeTiming = (id: string, timing: { start: number; duration: number }) => {
    if (locked || job) return;
    const tr = id === 'camera' ? project.camera : project.objects.find(o => o.id === id)?.trajectory;
    if (!tr) return;
    const oldClip = id === 'camera' ? project.cameraClip : project.objects.find(o => o.id === id)?.clip;
    if (oldClip && Math.abs(oldClip.start - timing.start) < 1e-7 && Math.abs(oldClip.duration - timing.duration) < 1e-7) return;
    try {
      const clip = validateClip({ ...(oldClip || makeDefaultClip(tr)), ...timing, revision: (oldClip?.revision ?? 0) + 1 }, tr, project.duration);
      const trajectory = { ...tr, preview: makeTrajectoryPreview(tr.samples, project.objects.find(o => o.id === id)?.color, { kind: tr.kind, cameraIntrinsics: tr.cameraIntrinsics, clip }) };
      setPlaying(false); setTarget(null);
      updateProject(p => id === 'camera' ? { ...p, camera: trajectory, cameraClip: clip } : { ...p, fourD: p.fourD === 'missing' ? 'missing' : 'stale', objects: p.objects.map(o => o.id === id ? { ...o, trajectory, clip } : o) });
    } catch (error) { notify(error instanceof Error ? error.message : '时间片段无效', 'error'); }
  };
  const changeDuration = (duration: number) => {
    if (locked || job) return;
    const end = Math.max(0, ...project.objects.map(o => o.clip ? o.clip.start + o.clip.duration : 0), project.cameraClip ? project.cameraClip.start + project.cameraClip.duration : 0);
    if (!Number.isFinite(duration) || duration < Math.max(1 / project.fps, end) || duration > 600) { notify(`项目时长须在 ${Math.max(1 / project.fps, end).toFixed(3)} 至 600 秒之间，不能截断已有片段。`, 'error'); return; }
    setPlaying(false); setTime(t => Math.min(t, duration));
    updateProject(p => ({ ...p, duration, fourD: p.fourD === 'missing' ? 'missing' : 'stale' }));
  };
  const saveLens = (cameraIntrinsics: CameraIntrinsicsTrack) => {
    if (locked || job) return;
    setPlaying(false);
    updateProject(p => {
      if (!p.camera) return { ...p, cameraIntrinsics };
      const camera: Trajectory = { ...p.camera, revision: p.camera.revision + 1, cameraIntrinsics };
      const clip = p.cameraClip ? { ...p.cameraClip, trajectoryRevision: camera.revision } : makeDefaultClip(camera);
      camera.preview = makeTrajectoryPreview(camera.samples, undefined, { kind: 'camera', cameraIntrinsics, clip });
      return { ...p, cameraIntrinsics, camera, cameraClip: clip, cameraHistory: [p.camera, ...p.cameraHistory] };
    });
    setModal(null); notify('固定镜头参数与相机轨迹已一同保存；参考图标定保持原值。', 'success');
  };

  const workflowStep = !project.geometryReady ? 0 : project.objects.some(o => o.segmented && o.motion === 'unassigned') ? 1 : project.fourD !== 'ready' ? 2 : project.camera ? 4 : 3;
  const steps = ['首帧与分割', '物体运动', '4D 场景', '相机轨迹'];
  const presetObject = project.objects.find(o => o.id === presetTarget.target);
  const presetTrajectories = useMemo(() => modal === 'presets' ? PRESETS.map(p => makePreset(presetTarget.kind, p.key, presetObject, project.duration, project.cameraIntrinsics ?? undefined)) : [], [modal, presetTarget.kind, presetObject, project.duration, project.cameraIntrinsics]);
  const previewPreset = presetTrajectories[PRESETS.findIndex(p => p.key === selectedPreset)] || null;
  const onReferenceReady = useCallback((url: string) => updateProject(p => p.reference === url ? p : { ...p, reference: url }), [updateProject]);
  const onObjectPreviewsReady = useCallback((previews: Record<string, string>) => updateProject(p => ({ ...p, objects: p.objects.map(o => previews[o.id] ? { ...o, maskPreview: previews[o.id] } : o) })), [updateProject]);

  return <div className="studio-app">
    <input ref={fileInput} className="hidden" type="file" accept=".json" multiple={importMode === 'project'} onChange={e => void onFiles(e.target.files)} />
    <input ref={folderInput} className="hidden" type="file" {...{ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>} multiple onChange={e => void onFiles(e.target.files)} />
    <input ref={imageInput} className="hidden" type="file" accept="image/*" onChange={e => void importImage(e.target.files?.[0])} />
    <header className="app-header">
      <a className="brand" href="#" onClick={e => e.preventDefault()} aria-label="Diffusion Control"><span className="brand-mark"><Layers3 size={22} /></span><span>diffusion<span className="brand-light">control</span><small>场景与轨迹编辑</small></span></a>
      <div className="header-divider" /><label className="project-breadcrumb"><FolderOpen size={15} /><select aria-label="切换项目" value={hasProject ? project.id : ''} disabled={locked || !!job || !hasProject} onChange={e => selectProject(e.target.value)}>{hasProject ? projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">尚未创建项目</option>}</select><ChevronDown size={12} /></label>
      <span className="prototype-badge">生成工作区</span>
      <div className="header-actions"><span className="save-status"><span />{saveStatus}</span><button className="theme-toggle text-button" aria-label={theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'} title={theme === 'dark' ? '当前：深色模式' : '当前：浅色模式'} onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}<span>{theme === 'dark' ? '浅色模式' : '深色模式'}</span></button><button className="icon-button" onClick={() => setModal('help')} aria-label="操作指南"><CircleHelp size={18} /></button><button className="export-button" onClick={() => setTransfer('export')} disabled={locked || !hasProject}><ArrowDownToLine size={15} />导出项目</button></div>
    </header>
    {!hasProject && <main className="project-empty-home"><FolderOpen size={48}/><h1>开始你的生成项目</h1><p>新建项目并导入首帧，或从本地／集群恢复完整项目。</p><div><button className="primary-button" onClick={() => setModal('new')}><Plus size={16}/>新建项目</button><button className="secondary-button" onClick={() => setTransfer('import')}><Upload size={16}/>导入／恢复项目</button></div></main>}
    {hasProject && <div className="workspace">
      <main className="main-panel">
        <div className="workspace-heading"><h1>轨迹编辑</h1><button className="text-button" onClick={() => setModal('help')}>工作流指南 <ArrowRight size={15}/></button></div>
        <div className="workflow-strip">{steps.map((step, i) => <div key={step} className={`workflow-step ${i === workflowStep ? 'active' : ''} ${i < workflowStep ? 'complete' : ''}`}><span className="step-number">{i < workflowStep ? <Check size={11}/> : `0${i + 1}`}</span><span>{step}</span>{i < 3 && <ChevronRight className="step-arrow" size={13}/>}</div>)}<span className="workflow-end">SYMPHOMOTION WORKFLOW</span></div>
        <div className="viewport-card">
          <div className="viewport-toolbar"><div className="view-tabs" role="tablist" aria-label="场景视图">{([{ id: '2d', label: '2D View', icon: Image }, { id: '3d', label: '3D View', icon: Box }] as const).map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={view === id} disabled={locked} className={view === id ? 'active' : ''} onClick={() => changeView(id)}><Icon size={15}/>{label}</button>)}</div><div className="viewport-tools">{view === '3d' && <button className="lens-toolbar-button" aria-label="编辑物体包围盒" disabled={locked || !!job || !project.geometryReady || !selectedObject?.reconstruction || boxPending(selectedObject.id)} onClick={beginBoxEdit}>编辑包围盒</button>}<button className="lens-toolbar-button" disabled={locked || !!job || !project.referenceCamera} onClick={() => setModal('lens')}><Camera size={13}/>镜头参数</button><span className="scene-kind">{view === '2d' ? '首帧参考图' : '三维场景 / 时间预览'}</span><button className="icon-button" onClick={() => setModal('settings')} disabled={locked} aria-label="视角与速度设置"><Settings2 size={16}/></button><button className="icon-button" aria-label="重置视角" onClick={() => { scene.current?.resetView(); setTime(0); }} disabled={locked}><Focus size={17}/></button><button className="icon-button" aria-label="全屏场景" onClick={() => { const element = document.querySelector('.viewport-card'); if (document.fullscreenElement) void document.exitFullscreen(); else void element?.requestFullscreen().catch(() => notify('此浏览器未允许全屏显示。')); }}><Expand size={15}/></button></div></div>
          <div className={`scene-container view-${view}`}>
            <SceneViewport boxEdit={boxEdit} onBoxChange={changeBox} realScene={realScene.data} sceneError={realScene.error} onRetryScene={realScene.retry} samPrompts={samPrompts} samPromptMode={samPromptMode} onSamPromptsChange={setSamPrompts} key={project.id} ref={scene} project={project} view={view} selectedObjectId={selectedObjectId} target={target} recordState={recordState} time={time} getCaptureTime={getCaptureTime} playing={playing} followCamera={followCamera} showMasks={showMasks} segmenting={segmenting} showBoxes={showBoxes} showTrajectories={showTrajectories} settings={settings} onMoveSpeedChange={changeMoveSpeed} draftSamples={draftSamples} onObjectPick={pickObject} onFrontPick={chooseFront} onReferenceReady={onReferenceReady} onObjectPreviewsReady={onObjectPreviewsReady} onTelemetry={setTelemetry} onPause={pauseRecording} onControlLost={onControlLost} onError={notify}/>
            <div className="scene-top-left"><span className="scene-label"><span className="live-dot"/>{view === '2d' ? '首帧参考图' : followCamera ? '拍摄相机视角' : '三维场景 · 自由观察'}</span><span className="scene-meta">{project.demoScene ? '示例场景' : '导入图像'}<i/> {view === '2d' ? '01 / 01' : `${(telemetry.points / 1000).toFixed(1)}K 点`}</span></div>
            {boxEdit && <BoundingBoxEditor edit={boxEdit} name={project.objects.find(o => o.id === boxEdit.objectId)?.name || '物体'} busy={boxSubmitting} onChange={changeBox}
              onMode={mode => setBoxEdit(previous => previous ? { ...previous, mode } : previous)} onReset={() => changeBox(structuredClone(boxEdit.original))}
              onCancel={cancelBoxEdit} onApply={() => void submitBoxEdit()} onObserve={() => { void scene.current?.requestControl(); }}/>}
            <div className="scene-top-right">{view === '2d' ? <button className={`glass-button ${segmenting ? 'selected' : ''}`} onClick={startSegmentation}><Scan size={14}/>{segmenting ? '结束标注' : project.demoScene ? 'SAM 分割演示' : 'SAM2 标注'}</button> : <button className={`glass-button ${telemetry.controlled ? 'selected' : ''}`} disabled={locked} onClick={() => { if (telemetry.controlled) scene.current?.releaseControl(); else { setFollowCamera(false); void scene.current?.requestControl(); } }}><MousePointer2 size={14}/>{telemetry.controlled ? 'Esc 退出控制' : '进入视角控制'}</button>}</div>
            {view === '2d' && <div className="image-caption"><span>{project.demoScene ? '程序化示例 · 非模型推理' : '自定义首帧'}</span></div>}
            {segmenting && <div className="segmentation-hint"><Crosshair size={16}/><div><strong>点选画面中的物体</strong><span>{project.demoScene ? '示例 mask 与点云已对齐' : '在右侧选择正/负点击或框选，然后提交 SAM2'}</span></div><button onClick={() => setSegmenting(false)} className="icon-button" aria-label="退出分割"><X size={15}/></button></div>}
            {view !== '2d' && <><div className="scene-toggles"><button className={showBoxes ? 'selected' : ''} onClick={() => setShowBoxes(v => !v)}><Box size={13}/>包围盒与参考轴</button><button className={showTrajectories ? 'selected' : ''} onClick={() => setShowTrajectories(v => !v)}><Move3D size={13}/>轨迹</button></div><div className="movement-speed-readout" role="group" aria-label="平移速率"><output aria-label="设定平移速率" aria-live="off">设定 <b>{settings.moveSpeed.toFixed(3)}</b> su/s</output><output aria-label="实际平移速率" aria-live="off">实际 <b>{telemetry.speed.toFixed(3)}</b> su/s</output><small>{wheelEnabled ? '滚轮 ↑ 加快 · ↓ 减慢' : !telemetry.controlled && recordState === 'preview' && !followCamera ? '进入视角控制后滚轮调速' : '当前状态不接收滚轮调速'}</small></div><div className="coordinate-readout"><span>WORLD</span>{telemetry.position.map((value, i) => <span key={i}><b className={`axis-${i}`}>{'XYZ'[i]}</b>{value.toFixed(2)}</span>)}</div></>}
            {view === '2d' && <button className="mask-toggle glass-button" onClick={() => setShowMasks(v => !v)}>{showMasks ? <Eye size={14}/> : <EyeOff size={14}/>}物体 Mask <span className={`switch ${showMasks ? 'on' : ''}`}/></button>}
            {recordState === 'countdown' && <div className="countdown-overlay"><span>准备录制 {target === 'camera' ? '相机' : recordedObject?.name}</span><strong>{countdown}</strong><small>起始位姿已锁定 · Esc 取消</small></div>}
            {recordState === 'recording' && <div className="recording-overlay"><span/> REC <b>{time.toFixed(2)}s</b><small>P 暂停 / Space 急停</small></div>}
            {recordState === 'paused' && <div className="paused-overlay"><Pause size={18}/><strong>录制已暂停</strong><span>点击下方「结束录制」保存轨迹</span></div>}
            {job && <div className="job-overlay"><LoaderCircle className="spin" size={24}/><strong>{job.label}</strong><span>本机演示任务 · {job.progress}%</span><div><i style={{ width: `${job.progress}%` }}/></div></div>}
            {!project.reference && !project.demoScene && <div className="empty-scene"><div><Image size={35}/></div><h2>未导入首帧参考图</h2><p>导入首帧参考图，然后在重建与分割面板提交真实模型任务。</p><button className="primary-button" onClick={() => imageInput.current?.click()}><Upload size={15}/>导入参考图</button></div>}
          </div>
          <div className="transport"><div className="transport-target"><span className={`mode-pill ${locked ? 'drawing' : ''}`}><span/>{locked ? '绘制模式' : '预览模式'}</span><span className="transport-divider"/><span className="target-label">{target === 'camera' ? <Camera size={14}/> : target ? <Box size={14}/> : <Eye size={14}/>} {target === 'camera' ? '相机轨迹' : recordedObject?.name || (view === '2d' ? '首帧与物体' : '自由探索')}</span></div><div className="record-controls"><button className={`record-button ${recordState === 'recording' ? 'is-recording' : ''}`} disabled={!!job || (recordState !== 'paused' && !canRecord) || ['countdown', 'recording', 'saving'].includes(recordState) || view === '2d'} onClick={recordState === 'paused' ? finishRecording : () => void startRecording()}>{recordState === 'paused' ? <Square size={12} fill="currentColor"/> : <Circle size={12} fill="currentColor"/>}{recordState === 'paused' ? '结束录制' : recordState === 'recording' ? '录制中' : recordState === 'countdown' ? '准备中' : '开始录制'}</button><button className="pause-record" disabled={recordState !== 'recording'} title={recordState === 'paused' ? '本版本暂不开放继续录制' : 'P 暂停录制'} onClick={pauseRecording}>{recordState === 'paused' ? <Play size={13}/> : <Pause size={13}/>} {recordState === 'paused' ? '继续录制' : '暂停'}</button></div><span className="record-duration">{time.toFixed(2)}<span> / {project.duration.toFixed(2)} s</span></span></div>
        </div>
        <Timeline project={project} selectedTarget={timelineTarget || target || selectedObjectId} time={time} playing={playing} locked={locked || !!job || telemetry.controlled || !!project.workflow?.objectDefinitions?.some(item => item.replaceObjectJobId)} canPlay={view === '3d' && project.geometryReady} followCamera={followCamera} canFollowCamera={view === '3d' && !!project.camera} onSeek={seekTime} onTogglePlay={() => { setTarget(null); if (time >= project.duration) { timeRef.current = 0; setTime(0); } setPlaying(v => !v); }} onReset={() => seekTime(0)} onToggleFollowCamera={() => { scene.current?.releaseControl(); setTarget(null); setFollowCamera(v => !v); }} onSelectTarget={selectTimelineTarget} onTimingChange={changeTiming} onDurationChange={changeDuration}/>
        <footer className="keyboard-footer"><span><Command size={13}/>快捷操作</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动</span><span><kbd>Q</kbd><kbd>E</kbd>横滚</span><span><kbd>⇧</kbd><kbd>Ctrl</kbd>升降</span><span>相机局部坐标 · 松键停止</span><span>滚轮 ↑ 加快 / ↓ 减慢</span><span><kbd>Space</kbd>急停</span><button onClick={() => setModal('help')}>全部快捷键 <ArrowRight size={12}/></button></footer>
      </main>
      <ControlPanels workflow={{ associationEnvironment, onAssociationEnvironmentChange: setAssociationEnvironment, prompts: samPrompts, promptMode: samPromptMode, onPromptsChange: setSamPrompts, onPromptModeChange: setSamPromptMode, onChange: updateWorkflowProject, onApplied: workflowApplied }} onGenerationChange={update => updateGeneration(project.id, update)} onNotify={notify} projects={projects} project={project} selectedObjectId={selectedObjectId} locked={locked || !!job} building={job?.type === '4d'} onProjectSelect={selectProject} onCreate={() => setModal('new')} onImport={() => setTransfer('import')} onExport={() => setTransfer('export')} onDeleteProject={id => void deleteProject(id)} onRenameProject={(id, name) => { const original = projects.find(p => p.id === id); if (!original || locked) return; const renamed = renameProject(original, name); setProjects(previous => previous.map(p => p.id === id ? { ...p, name: renamed.name, updatedAt: renamed.updatedAt } : p)); }} onSelectObject={pickObject} onDeleteObject={deleteObject} onDeleteCameraTrajectory={deleteCameraTrajectory} onPromptChange={(id, prompt) => updateProject(p => ({ ...p, objects: p.objects.map(o => o.id === id ? { ...o, prompt } : o) }))} onSegment={startSegmentation} onRecordTarget={armTarget} onPresets={openPresets} onStatic={id => updateProject(p => ({ ...p, fourD: p.fourD === 'missing' ? 'missing' : 'stale', objects: p.objects.map(o => o.id === id ? { ...o, motion: 'static', history: o.trajectory ? [o.trajectory, ...o.history] : o.history, trajectory: null, clip: null } : o) }))} onBuild4D={build4D} onFrontSelect={chooseFront} onDownload={downloadTrajectory} onImageImport={() => imageInput.current?.click()} onLensEdit={() => setModal('lens')} onPreview={trajectory => { const targetId = trajectory.kind === 'camera' ? 'camera' : project.objects.find(object => object.trajectory?.id === trajectory.id)?.id; if (targetId) { setPreviewTarget({ projectId: project.id, targetId }); setModal('preview'); } }}/>
    </div>
    }
    <div className="app-status"><span><span className="amber-dot"/>浏览器自动保存 <i/> 集群保存与完整包见项目面板</span><span>OpenCV 世界坐标 <i/> SE(3) 轨迹 <i/> {project.objects.filter(o => o.segmented).length} 个物体</span><button onClick={() => setModal('help')}>操作说明 <ArrowRight size={12}/></button></div>
    {transfer && <ProjectTransfer project={hasProject ? project : null} initialMode={transfer} onImport={acceptImportedProject} onClose={() => setTransfer(null)}/> }
    {toast && <div role="status" className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={17}/> : toast.kind === 'error' ? <CircleHelp size={17}/> : <Sparkles size={17}/>}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={14}/></button></div>}
    {modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><section className={`modal modal-${modal}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close icon-button" aria-label="关闭对话框" onClick={() => setModal(null)}><X size={19}/></button>
      {modal === 'new' && <><h2 id="modal-title">创建项目</h2><p>每个项目独立保存首帧、物体与运动轨迹。</p><label className="field">项目名称<input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="为你的场景命名"/></label><label className="field">项目母路径<input value={parentPath} onChange={e => setParentPath(e.target.value)} placeholder="projects"/><small>项目分类标签；集群快照与完整包统一保存在项目管理目录。</small></label><div className="modal-actions"><button className="secondary-button" onClick={() => { setModal(null); setTransfer('import'); }}><FolderOpen size={15}/>导入项目</button><button className="primary-button" disabled={!newName.trim() || !parentPath.trim()} onClick={() => { const p = createEmptyProject(newName.trim(), parentPath.trim()); setProjects(v => [...v, p]); setProjectId(p.id); setSelectedObjectId(null); setTarget(null); setView('2d'); setTime(0); setModal(null); notify('项目已创建。现在添加首帧参考图。', 'success'); }}>创建项目<ArrowRight size={15}/></button></div></>}
      {modal === 'presets' && <><h2 id="modal-title">{presetTarget.kind === 'camera' ? '相机' : '物体'}轨迹预设</h2><p>起点与当前目标对齐，保留完整的位置与旋转。</p><div className="preset-grid">{PRESETS.map((item, index) => { const tr = presetTrajectories[index]; return <button key={item.key} className={`preset-card ${selectedPreset === item.key ? 'selected' : ''}`} onClick={() => setSelectedPreset(item.key)}><img src={tr.preview} alt={`${item.name}轨迹预览`}/><span><strong>{item.name}</strong><small>{item.en}</small></span>{selectedPreset === item.key && <Check size={15}/>}</button>; })}</div><p className="preset-description">{PRESETS.find(p => p.key === selectedPreset)?.description} <span>{project.duration.toFixed(2)} s · 首帧对齐</span></p>{(presetTarget.kind === 'camera' ? project.cameraHistory : presetObject?.history)?.length ? <details className="history-list"><summary>历史轨迹 · {(presetTarget.kind === 'camera' ? project.cameraHistory : presetObject?.history)!.length}</summary>{(presetTarget.kind === 'camera' ? project.cameraHistory : presetObject?.history)!.map(t => <button key={`${t.id}-${t.revision}-${t.createdAt}`} onClick={() => applyTrajectory(t)}>{t.name}<span>{t.duration.toFixed(2)}s · 应用</span></button>)}</details> : null}<div className="modal-actions"><button className="secondary-button" onClick={() => { setImportMode('trajectory'); fileInput.current?.click(); }}><Upload size={14}/>导入 JSON</button><button className="primary-button" disabled={presetTarget.kind === 'camera' ? project.fourD !== 'ready' : !presetObject?.front} onClick={() => previewPreset && applyTrajectory(previewPreset)}>应用轨迹<ArrowRight size={15}/></button></div>{(presetTarget.kind === 'camera' ? project.fourD !== 'ready' : !presetObject?.front) && <small className="modal-note">{presetTarget.kind === 'camera' ? '先完成 4D 构建，才能应用相机轨迹。' : '先为物体选择正面，才能对齐预设。'}</small>}</>}
      {modal === 'settings' && <><h2 id="modal-title">视角与速度设置</h2><p>所有平移按相机局部坐标计算，松键即停。进入控制后，滚轮上滚加快、下滚减慢；鼠标移动改变朝向。</p><div className="settings-grid">{([{ key: 'moveSpeed', label: '设定平移速率', unit: 'su/s', min: MIN_MOVE_SPEED, max: MAX_MOVE_SPEED, step: .01 }, { key: 'rollSpeed', label: '横滚角速度', unit: '°/s', min: 5, max: 180, step: 5 }, { key: 'sensitivity', label: '鼠标灵敏度', unit: '°/px', min: .01, max: .8, step: .01 }, { key: 'pointSize', label: '点云点尺寸', unit: 'su', min: .005, max: .05, step: .001 }] as const).map(item => <label className="field" key={item.key}>{item.label}<div className="unit-input"><input type="number" min={item.min} max={item.max} step={item.step} value={item.key === 'moveSpeed' ? Number(settings.moveSpeed.toFixed(3)) : settings[item.key]} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) setSettings(s => ({...s,[item.key]:Math.max(item.min,Math.min(item.max,n))})); }}/><span>{item.unit}</span></div></label>)}</div><p>物体控制：W 沿物体正面，Shift 沿物体上方；观察偏移不写入轨迹。su 为未标定的场景单位。</p><div className="modal-actions"><button className="text-button" onClick={() => setSettings(DEFAULT_SETTINGS)}>恢复默认</button><button className="primary-button" onClick={() => setModal(null)}>完成</button></div></>}
      {modal === 'lens' && <LensEditor track={project.cameraIntrinsics} reference={project.referenceCamera} onSave={saveLens} onCancel={() => setModal(null)}/>}
      {modal === 'preview' && previewTrajectory && <><h2 id="modal-title">{previewTrajectory.name}</h2><img className="trajectory-preview-large" src={previewTrajectory.preview} alt="三维轨迹、速度与相机参数预览"/><button className="secondary-button" onClick={() => downloadTrajectory(previewTrajectory)}>下载 JSON 与 PNG</button></>}
      {modal === 'help' && <><h2 id="modal-title">操作说明</h2><p>先决定物体如何运动，再决定相机如何看见它。</p><div className="guide-steps">{[{ icon: Scan, title: '01 / 选择物体', text: '上传首帧，完成 Depth Pro 重建与 SAM2 标注，关联物体点簇。切换 3D 后选择包围盒正面。' }, { icon: Move3D, title: '02 / 录制物体', text: '点击物体卡片的录制，在底部开始录制。3 秒倒计时后，用键鼠控制物体；P 暂停，再结束并保存。也可直接应用预设。' }, { icon: Layers3, title: '03 / 构建 4D', text: '为其余物体明确设置静止，点击构建 4D。播放时间轴，观察物体在点云中运动。' }, { icon: Camera, title: '04 / 录制相机', text: '相机会恢复首帧参考位姿，在同步播放的 4D 场景中录制。预览、下载轨迹，并在历史记录中复用。' }].map(({ icon: Icon, title, text }) => <div key={title}><Icon size={20}/><section><strong>{title}</strong><p>{text}</p></section></div>)}</div><div className="guide-keyboard"><span><kbd>WASD</kbd>移动</span><span><kbd>鼠标</kbd>朝向</span><span><kbd>滚轮 ↑ / ↓</kbd>加快／减慢平移</span><span><kbd>Q / E</kbd>横滚</span><span><kbd>Shift / Ctrl</kbd>升降</span><span>松键停止平移</span><span><kbd>Space</kbd>急停</span><span><kbd>P</kbd>暂停录制</span><span><kbd>Esc</kbd>退出控制</span></div><div className="guide-note">模型任务经 Slurm 提交到计算节点。完成物体与相机运动后，先导出条件，再提交生成。项目可保存到集群或导出完整包；删除项目会保留作业和产物。</div><button className="primary-button" onClick={() => setModal(null)}>开始探索<ArrowRight size={15}/></button></>}
    </section></div>}
  </div>;
}
