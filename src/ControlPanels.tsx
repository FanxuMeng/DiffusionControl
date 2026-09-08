import { useState, type CSSProperties } from 'react';
import {
  Armchair, ArrowUpRight, Check, ChevronDown, ChevronRight, Circle,
  Crosshair, Download, Flower2, FolderOpen, ImagePlus, Layers3,
  LoaderCircle, LockKeyhole, Plus, Route, Settings2, Sparkles, Table2, Upload, Video,
} from 'lucide-react';
import type { Face, MotionClip, Project, SceneObject, Trajectory } from './types';
import { OBJECT_FACES } from './objectAxes';
import GenerationPanel from './GenerationPanel';
import type { GenerationState } from './generation/types';
import './panels.css';

export interface ControlPanelsProps {
  projects: Project[];
  project: Project;
  selectedObjectId: string | null;
  locked: boolean;
  building: boolean;
  onProjectSelect: (id: string) => void;
  onCreate: () => void;
  onImport: () => void;
  onSelectObject: (id: string) => void;
  onPromptChange: (id: string, prompt: string) => void;
  onSegment: () => void;
  onRecordTarget: (target: string) => void;
  onPresets: (kind: 'camera' | 'object', target: string) => void;
  onStatic: (id: string) => void;
  onBuild4D: () => void;
  onFrontSelect: (id: string, face: Face) => void;
  onDownload: (trajectory: Trajectory) => void;
  onImageImport: () => void;
  onImageGenerate: () => void;
  onLensEdit?: () => void;
  onPreview?: (trajectory: Trajectory) => void;
  onGenerationChange: (update: (state: GenerationState) => GenerationState) => void;
  onNotify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

function ObjectThumbnail({ object }: { object: SceneObject }) {
  const Icon = object.shape === 'chair' ? Armchair : object.shape === 'plant' ? Flower2 : object.shape === 'table' ? Table2 : Circle;
  return (
    <div className="dcp-object-thumb" style={{ '--object-color': object.color } as CSSProperties}>
      {object.maskPreview ? <img src={object.maskPreview} alt={`${object.name} 分割蒙版`} /> : <Icon size={27} strokeWidth={1.1} />}
    </div>
  );
}

function TrajectoryCard({ trajectory, clip, disabled, onDownload, onReplace, onPreview }: {
  trajectory: Trajectory; clip?: MotionClip | null; disabled: boolean;
  onDownload: () => void; onReplace: () => void; onPreview?: () => void;
}) {
  return (
    <div className="dcp-trajectory-card">
      <button className="dcp-trajectory-preview" onClick={onPreview} disabled={!onPreview} title="放大轨迹预览" aria-label={`放大 ${trajectory.name} 的轨迹预览`}>
        {trajectory.preview ? <img src={trajectory.preview} alt={`${trajectory.name} 轨迹预览`} /> : <Route size={28} strokeWidth={1} />}
        <span>源轨迹 {trajectory.duration.toFixed(2)} 秒</span>
      </button>
      <div className="dcp-trajectory-caption">
        <div><span title={trajectory.name}>{trajectory.name}</span><small>{trajectory.samples.length} 采样点 · {trajectory.source === 'recorded' ? '录制' : trajectory.source === 'preset' ? '预设' : '导入'}</small></div>
        <button className="dcp-icon-button" title="下载轨迹数据与预览" aria-label={`下载 ${trajectory.name}`} onClick={onDownload}><Download size={14} /></button>
        <button className="dcp-icon-button" title="替换轨迹" aria-label={`替换 ${trajectory.name}`} disabled={disabled} onClick={onReplace}><ArrowUpRight size={14} /></button>
      </div>
      <div className="dcp-clip-summary"><span>片段 {(clip?.start || 0).toFixed(2)}–{((clip?.start || 0) + (clip?.duration || trajectory.duration)).toFixed(2)} 秒</span><span>{(trajectory.duration / (clip?.duration || trajectory.duration)).toFixed(2)}×</span></div>
    </div>
  );
}

export function ControlPanels(props: ControlPanelsProps) {
  const { projects, project, selectedObjectId, locked, building } = props;
  const [collapsed, setCollapsed] = useState({ projects: false, objects: false, camera: false });
  const [expandedObjects, setExpandedObjects] = useState<Map<string, Set<string>>>(() => new Map());
  const objects = project.objects.filter((object) => object.segmented);
  const assignedCount = objects.filter((object) => object.motion === 'static' || (object.motion === 'trajectory' && object.trajectory)).length;
  const canBuild = project.geometryReady && assignedCount === objects.length;
  const cameraReady = project.fourD === 'ready';
  const calibration = project.cameraIntrinsics?.calibration || project.referenceCamera;
  const nonzeroDistortion = calibration?.distortion.coefficients.some((coefficient) => Math.abs(coefficient) > 1e-10);
  const toggle = (panel: keyof typeof collapsed) => setCollapsed((previous) => ({ ...previous, [panel]: !previous[panel] }));
  const toggleObject = (id: string) => {
    const expanded = expandedObjects.get(project.id)?.has(id) ?? false;
    setExpandedObjects((previous) => {
      const next = new Map(previous);
      const objectsInProject = new Set(previous.get(project.id));
      if (expanded) objectsInProject.delete(id);
      else objectsInProject.add(id);
      next.set(project.id, objectsInProject);
      return next;
    });
    if (!expanded && !locked) props.onSelectObject(id);
  };

  return (
    <aside className="dcp-panels" aria-label="项目、运动与生成控制">
      <section className="dcp-panel dcp-projects-panel">
        <div className="dcp-panel-header">
          <button className="dcp-section-title" onClick={() => toggle('projects')} aria-expanded={!collapsed.projects}>
            {collapsed.projects ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span>项目</span><span className="dcp-count">{projects.length}</span>
          </button>
          <div className="dcp-header-actions">
            <button className="dcp-icon-button" title="导入项目 JSON 或母文件夹" aria-label="导入项目" disabled={locked} onClick={props.onImport}><FolderOpen size={15} /></button>
            <button className="dcp-icon-button" title="创建项目" aria-label="创建项目" disabled={locked} onClick={props.onCreate}><Plus size={17} /></button>
          </div>
        </div>
        {!collapsed.projects && <div className="dcp-projects-body">
          <div className="dcp-project-list">
            {projects.map((item) => (
              <button key={item.id} className={`dcp-project-card ${item.id === project.id ? 'is-selected' : ''}`} onClick={() => props.onProjectSelect(item.id)} disabled={locked} aria-pressed={item.id === project.id}>
                <div className={`dcp-project-picture ${item.demoScene === 'gallery' ? 'is-gallery' : ''}`}>
                  {item.reference ? <img src={item.reference} alt={`${item.name} 首帧参考图`} /> : <div className="dcp-project-placeholder"><ImagePlus size={24} strokeWidth={1} /><span>暂无首帧</span></div>}
                  {item.id === project.id && <span className="dcp-project-selected"><Check size={10} strokeWidth={3} /></span>}
                </div>
                <span className="dcp-project-name">{item.name}</span>
                <span className="dcp-project-meta">{item.geometryReady ? '点云已加载' : '未加载点云'} <span>· {item.objects.filter((object) => object.segmented).length} 个物体</span></span>
              </button>
            ))}
          </div>
          <div className="dcp-project-location" title={project.parentPath}><FolderOpen size={11} /><span>{project.parentPath || '浏览器本地项目'}</span><span>本地</span></div>
          {!project.reference && !project.demoScene && <div className="dcp-image-actions"><button disabled={locked} onClick={props.onImageImport}><ImagePlus size={13} />导入首帧</button><button disabled={locked} onClick={props.onImageGenerate}><Sparkles size={13} />生成首帧</button></div>}
        </div>}
      </section>

      <section className="dcp-panel dcp-objects-panel">
        <div className="dcp-panel-header">
          <button className="dcp-section-title" onClick={() => toggle('objects')} aria-expanded={!collapsed.objects}>
            {collapsed.objects ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span>物体控制</span><span className="dcp-count">{objects.length}</span>
          </button>
          <button className="dcp-icon-button" title="在 2D 视图中分割物体" aria-label="添加物体分割" disabled={locked || (!project.reference && !project.demoScene)} onClick={props.onSegment}><Plus size={17} /></button>
        </div>
        {!collapsed.objects && <div className="dcp-objects-body">
          <div className="dcp-panel-intro"><span>物体轨迹与静止状态</span><span>已定义 {assignedCount} / {objects.length}</span></div>
          {objects.length === 0 ? <div className="dcp-empty-objects"><Crosshair size={25} strokeWidth={1.3} /><strong>暂无分割物体</strong><p>在 2D 参考图中选择需要控制的物体。</p><button className="dcp-button" disabled={locked || (!project.reference && !project.demoScene)} onClick={props.onSegment}><Plus size={13} />添加分割</button></div> :
          <div className="dcp-object-list">{objects.map((object, index) => {
            const selected = object.id === selectedObjectId;
            const expanded = expandedObjects.get(project.id)?.has(object.id) ?? false;
            const detailsId = `object-details-${encodeURIComponent(project.id)}-${encodeURIComponent(object.id)}`;
            const recordable = project.geometryReady && object.front !== null;
            const reason = !project.geometryReady ? '请先生成 3D 点云' : !object.front ? '请先选择物体正面' : '从物体包围盒中心开始录制';
            return <article key={object.id} className={`dcp-object-card ${selected ? 'is-selected' : ''}`} style={{ '--object-color': object.color } as CSSProperties}>
              <button className="dcp-object-heading" onClick={() => toggleObject(object.id)} aria-expanded={expanded} aria-controls={detailsId} title={`${expanded ? '收起' : '展开'} ${object.name} 的设置`}>
                <ObjectThumbnail object={object} />
                <span className="dcp-object-identity"><span className="dcp-object-name"><i />{object.name}</span><span className="dcp-object-status">{object.motion === 'static' ? <><span className="dcp-status-dot is-static" />静止物体</> : object.motion === 'trajectory' && object.trajectory ? <><span className="dcp-status-dot is-ready" />运动轨迹已就绪</> : <><span className="dcp-status-dot" />运动未定义</>}</span></span>
                <span className="dcp-object-number">{String(index + 1).padStart(2, '0')}</span>
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <div id={detailsId} className="dcp-object-details" hidden={!expanded}>
                <label className="dcp-prompt-label" htmlFor={`prompt-${object.id}`}>运动提示词 <span>自动保存</span></label>
                <textarea id={`prompt-${object.id}`} rows={2} value={object.prompt} disabled={locked} placeholder="描述这个物体的运动…" onChange={(event) => props.onPromptChange(object.id, event.target.value)} />
                {project.geometryReady && <div className="dcp-front-selection">
                  <div className="dcp-front-label"><span>物体正面 <small>物体局部 +X</small></span>{object.front ? <span className="dcp-front-confirmed"><Check size={11} />已定义</span> : <span className="dcp-front-required">请先选择</span>}</div>
                  <div className="dcp-face-options" role="group" aria-label={`${object.name} 的正面`}>
                    {OBJECT_FACES.map(({ face, color, name }) => <button key={face} title={`${name}作为物体正面`} aria-label={`${name}作为物体正面`} aria-pressed={object.front === face} className={object.front === face ? 'is-selected' : ''} style={{ '--face-color': color } as CSSProperties} disabled={locked} onClick={() => props.onFrontSelect(object.id, face)}><i />{face.toUpperCase()}</button>)}
                  </div>
                  <p className="dcp-helper">±X／Y／Z 对应 bbox 参考轴；所选面定义物体局部 +X。</p>
                </div>}
                {object.motion === 'trajectory' && object.trajectory && <TrajectoryCard trajectory={object.trajectory} clip={object.clip} disabled={locked} onDownload={() => props.onDownload(object.trajectory!)} onReplace={() => props.onPresets('object', object.id)} onPreview={props.onPreview ? () => props.onPreview!(object.trajectory!) : undefined} />}
                <div className="dcp-motion-actions">
                  <button className={`dcp-button ${object.motion === 'static' ? 'is-active' : ''}`} title={project.geometryReady ? '将该物体设为静止' : '请先生成 3D 点云'} disabled={locked || !project.geometryReady} onClick={() => props.onStatic(object.id)}>{object.motion === 'static' ? <Check size={12} /> : <Circle size={11} />}静止</button>
                  <button className="dcp-button" disabled={locked || !project.geometryReady || !object.front} title={reason} onClick={() => props.onPresets('object', object.id)}><Route size={13} />预设</button>
                  <button className="dcp-button dcp-record-action" disabled={locked || !recordable} title={reason} onClick={() => props.onRecordTarget(object.id)}><Circle size={10} fill="currentColor" />录制</button>
                </div>
                {!recordable && <p className="dcp-helper"><LockKeyhole size={10} />{reason}</p>}
              </div>
            </article>;
          })}</div>}
          <div className="dcp-build-area">
            <button className={`dcp-build-button ${cameraReady ? 'is-ready' : ''}`} disabled={locked || building || !canBuild} title={!project.geometryReady ? '请先生成 3D 点云' : assignedCount < objects.length ? '为每个物体设置轨迹或标记静止后可构建' : '根据物体运动更新时间变化的点云场景'} onClick={props.onBuild4D}>
              {building ? <LoaderCircle className="dcp-spinning" size={15} /> : cameraReady ? <Check size={15} /> : <Layers3 size={16} />}
              <span>{building ? '正在更新动态场景…' : cameraReady ? '动态场景已就绪 · 重新构建' : project.fourD === 'stale' ? '更新动态场景' : '构建动态场景'}</span>
              {!building && !cameraReady && <ArrowUpRight size={14} />}
            </button>
            <p>{project.fourD === 'stale' ? '物体运动或时序已变更，请更新派生场景。' : cameraReady ? '物体运动已同步，可在 3D 中录制相机。' : canBuild && objects.length === 0 ? '场景将全程保持静止。' : '每个物体需有轨迹或被明确设为静止。'}</p>
          </div>
        </div>}
      </section>

      <section className="dcp-panel dcp-camera-panel">
        <div className="dcp-panel-header">
          <button className="dcp-section-title" onClick={() => toggle('camera')} aria-expanded={!collapsed.camera}>
            {collapsed.camera ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <span>相机控制</span>
          </button>
          {cameraReady ? <span className="dcp-camera-state is-ready"><span />可录制</span> : <LockKeyhole size={13} className="dcp-muted" />}
        </div>
        {!collapsed.camera && <div className="dcp-camera-body">
          {project.camera ? <>
            <div className="dcp-camera-ready"><span className={`dcp-status-dot ${cameraReady ? 'is-ready' : ''}`} />{cameraReady ? '相机轨迹已就绪' : '轨迹已保存 · 动态场景待更新'}</div>
            <TrajectoryCard trajectory={project.camera} clip={project.cameraClip} disabled={locked} onDownload={() => props.onDownload(project.camera!)} onReplace={() => props.onPresets('camera', 'camera')} onPreview={props.onPreview ? () => props.onPreview!(project.camera!) : undefined} />
          </> : <div className={`dcp-camera-empty ${cameraReady ? 'is-ready' : ''}`}>
            <div className="dcp-camera-symbol"><Video size={25} strokeWidth={1} />{!cameraReady && <span><LockKeyhole size={9} /></span>}</div>
            <div><strong>{cameraReady ? '可录制相机轨迹' : '等待动态场景'}</strong><p>{cameraReady ? '在 3D 中记录相机位姿。' : project.fourD === 'stale' ? '更新场景以同步物体运动。' : '先定义物体运动并构建场景。'}</p></div>
          </div>}
          <div className="dcp-camera-actions"><button className="dcp-button" disabled={locked} onClick={() => props.onPresets('camera', 'camera')}><Upload size={12} />轨迹预设</button><button className="dcp-button dcp-record-action" disabled={locked || !cameraReady} title={cameraReady ? '返回参考图相机位姿开始录制' : '构建动态场景后可录制'} onClick={() => props.onRecordTarget('camera')}><Circle size={10} fill="currentColor" />录制相机</button></div>
          <div className="dcp-lens-summary">
            <div><span>固定镜头参数</span><button className="dcp-button" disabled={locked || !project.referenceCamera || !props.onLensEdit} onClick={props.onLensEdit}><Settings2 size={12} />镜头参数</button></div>
            {calibration ? <><dl><div><dt>图像尺寸</dt><dd>{calibration.imageWidth} × {calibration.imageHeight}</dd></div><div><dt>垂直视场角</dt><dd>{calibration.fov.verticalDegrees.toFixed(2)}°</dd></div><div><dt>畸变模型</dt><dd>{calibration.distortion.model === 'none' ? '无畸变' : 'Brown–Conrady 5'}</dd></div></dl>{nonzeroDistortion && <p>非零畸变用于预览；上游导出待适配。</p>}</> : <p>参考图标定参数尚未初始化。</p>}
          </div>
          <div className="dcp-camera-note"><Crosshair size={12} /><span>首帧位姿对齐 <span>· SymphoMotion</span></span></div>
        </div>}
      </section>
      <GenerationPanel key={project.id} projectId={project.id} projectName={project.name} state={project.generation} locked={locked} onChange={props.onGenerationChange} onNotify={props.onNotify} />
    </aside>
  );
}

export default ControlPanels;
