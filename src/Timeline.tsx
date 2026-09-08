import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Box, Camera, Pause, Play, SkipBack } from 'lucide-react';
import { makeDefaultClip } from './timelineModel';
import { advanceClipGesture, type ClipDragMode, type ClipGesture } from './timelineGesture';
import type { MotionClip, Project, Trajectory } from './types';
import './timeline.css';

export interface TimelineProps {
  project: Project;
  selectedTarget: string | null;
  time: number;
  playing: boolean;
  locked: boolean;
  canPlay: boolean;
  followCamera: boolean;
  canFollowCamera: boolean;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onReset: () => void;
  onToggleFollowCamera: () => void;
  onSelectTarget: (target: string) => void;
  onTimingChange: (target: string, timing: { start: number; duration: number }) => void;
  onDurationChange: (duration: number) => void;
}

interface TimelineRow {
  id: string;
  name: string;
  color: string;
  kind: 'object' | 'camera';
  status: string;
  trajectory: Trajectory | null;
  clip: MotionClip | null;
}
type DragMode = ClipDragMode;
interface DragSession extends ClipGesture {
  element: HTMLButtonElement;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const numericText = (value: number) => String(Number(value.toFixed(4)));

function NumberField({ label, value, min, max, step, disabled, onCommit, description }: {
  label: string; value: number; min: number; max: number; step: number; disabled: boolean;
  onCommit: (value: number) => void; description?: string;
}) {
  const [draft, setDraft] = useState(numericText(value));
  const [focused, setFocused] = useState(false);
  const skipCommit = useRef(false);
  useEffect(() => { if (!focused) setDraft(numericText(value)); }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (skipCommit.current) { skipCommit.current = false; setDraft(numericText(value)); return; }
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number)) { setDraft(numericText(value)); return; }
    const next = clamp(number, min, max);
    setDraft(numericText(next));
    if (Math.abs(next - value) > 1e-7) onCommit(next);
  };
  return <label className="tl-number-field" title={description}>
    <span>{label}</span>
    <span className="tl-number-input"><input type="number" aria-label={label} value={draft} min={min} max={max} step={step} disabled={disabled} onFocus={() => setFocused(true)} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { skipCommit.current = true; setDraft(numericText(value)); event.currentTarget.blur(); }
      event.stopPropagation();
    }} /><span>秒</span></span>
  </label>;
}

function pathLength(trajectory: Trajectory) {
  return trajectory.samples.reduce((length, sample, index, samples) => {
    if (index === 0) return length;
    const previous = samples[index - 1].position;
    return length + Math.hypot(sample.position[0] - previous[0], sample.position[1] - previous[1], sample.position[2] - previous[2]);
  }, 0);
}

export function Timeline(props: TimelineProps) {
  const { project, time, locked } = props;
  const rows = useMemo<TimelineRow[]>(() => [
    ...project.objects.filter((object) => object.segmented).map((object) => ({
      id: object.id, name: object.name, color: object.color, kind: 'object' as const,
      status: object.motion === 'static' ? '全程静止' : object.trajectory ? '位姿轨迹' : '运动未定义',
      trajectory: object.trajectory,
      clip: object.trajectory ? object.clip || makeDefaultClip(object.trajectory) : null,
    })),
    { id: 'camera', name: '相机', color: '#8eafcf', kind: 'camera', status: project.camera ? '位姿轨迹' : '尚无轨迹', trajectory: project.camera, clip: project.camera ? project.cameraClip || makeDefaultClip(project.camera) : null },
  ], [project.objects, project.camera, project.cameraClip]);
  const selected = rows.find((row) => row.id === props.selectedTarget) || null;
  const step = 1 / project.fps;
  const duration = project.duration;
  const minimumDuration = Math.max(step, ...rows.map((row) => row.clip ? row.clip.start + row.clip.duration : 0));
  const drag = useRef<DragSession | null>(null);
  const seekPointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const selectedLength = useMemo(() => selected?.trajectory ? pathLength(selected.trajectory) : 0, [selected?.trajectory]);
  const tickCount = duration <= 10 ? 10 : 8;
  const snap = (value: number) => Math.round(value * project.fps) / project.fps;

  const clearDragSession = useCallback((pointerId?: number, element?: EventTarget | null) => {
    const session = drag.current;
    if (!session || (pointerId !== undefined && pointerId !== session.pointerId) || (element && element !== session.element)) return;
    drag.current = null;
    if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
    setDragging(false);
  }, []);

  useEffect(() => { clearDragSession(); seekPointer.current = null; }, [project.id, locked, clearDragSession]);
  useEffect(() => {
    const release = (event: globalThis.PointerEvent) => {
      clearDragSession(event.pointerId);
      if (seekPointer.current === event.pointerId) seekPointer.current = null;
    };
    const blur = () => { clearDragSession(); seekPointer.current = null; };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [clearDragSession]);

  const seekAtPointer = (event: PointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    props.onSeek(clamp(snap((event.clientX - bounds.left) / Math.max(1, bounds.width) * duration), 0, duration));
  };

  const changeTiming = (row: TimelineRow, next: { start: number; duration: number }) => {
    if (locked || !row.clip) return;
    props.onTimingChange(row.id, next);
  };
  const startDrag = (event: PointerEvent<HTMLButtonElement>, row: TimelineRow, mode: DragMode) => {
    if (locked || !row.clip || event.button !== 0) return;
    const lane = event.currentTarget.closest('.tl-lane');
    if (!lane) return;
    event.preventDefault(); event.stopPropagation();
    clearDragSession();
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    if (props.playing) props.onTogglePlay();
    props.onSelectTarget(row.id);
    const initial = { start: row.clip.start, duration: row.clip.duration };
    drag.current = { pointerId: event.pointerId, target: row.id, mode, x: event.clientX, width: lane.getBoundingClientRect().width, initial, last: initial, element: event.currentTarget };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const session = drag.current;
    if (!session || locked) return;
    const result = advanceClipGesture(session, { pointerId: event.pointerId, matchesOwner: event.currentTarget === session.element, buttons: event.buttons, captured: session.element.hasPointerCapture(event.pointerId), x: event.clientX }, duration, project.fps);
    if (result.action === 'release') { clearDragSession(event.pointerId); return; }
    if (result.action !== 'change') return;
    event.preventDefault(); event.stopPropagation();
    session.last = result.timing;
    props.onTimingChange(result.target, result.timing);
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId || session.element !== event.currentTarget) return;
    if (cancel && !locked) props.onTimingChange(session.target, session.initial);
    clearDragSession(event.pointerId, event.currentTarget);
    setAnnouncement(cancel ? '已取消时间调整' : '轨迹时间已更新');
  };
  const keyAdjust = (event: KeyboardEvent<HTMLButtonElement>, row: TimelineRow, mode: DragMode) => {
    if (event.key === 'Escape' && drag.current) {
      const session = drag.current;
      props.onTimingChange(session.target, session.initial);
      clearDragSession(session.pointerId); event.preventDefault(); return;
    }
    if (locked || !row.clip || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    props.onSelectTarget(row.id);
    if (props.playing) props.onTogglePlay();
    const clip = row.clip;
    const end = clip.start + clip.duration;
    const delta = (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
    if (mode === 'move') changeTiming(row, { start: event.key === 'Home' ? 0 : event.key === 'End' ? duration - clip.duration : clamp(clip.start + delta, 0, duration - clip.duration), duration: clip.duration });
    else if (mode === 'start') {
      const start = event.key === 'Home' ? 0 : event.key === 'End' ? end - step : clamp(clip.start + delta, 0, end - step);
      changeTiming(row, { start, duration: end - start });
    } else {
      const nextEnd = event.key === 'Home' ? clip.start + step : event.key === 'End' ? duration : clamp(end + delta, clip.start + step, duration);
      changeTiming(row, { start: clip.start, duration: nextEnd - clip.start });
    }
  };

  return <section className={`tl-panel ${dragging ? 'is-dragging' : ''}`} aria-label="并行运动时间轴">
    <div className="tl-toolbar">
      <div className="tl-heading"><strong>时间轴</strong><span>{project.fps} 帧/秒</span></div>
      <div className="tl-playback">
        <button title="回到 0 秒" aria-label="回到起点" disabled={locked} onClick={props.onReset}><SkipBack size={14} /></button>
        <button className="tl-play" title={props.playing ? '暂停回放' : '播放全部轨迹'} aria-label={props.playing ? '暂停回放' : '播放全部轨迹'} disabled={locked || !props.canPlay} onClick={props.onTogglePlay}>{props.playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <output aria-label="当前时间">{time.toFixed(2)} <span>/ {duration.toFixed(2)} 秒</span></output>
      </div>
      <div className="tl-observer" role="group" aria-label="3D 观察方式">
        <button aria-pressed={!props.followCamera} disabled={locked} className={!props.followCamera ? 'is-active' : ''} onClick={() => { if (props.followCamera) props.onToggleFollowCamera(); }}>自由观察</button>
        <button aria-pressed={props.followCamera} disabled={locked || !props.canFollowCamera} className={props.followCamera ? 'is-active' : ''} onClick={() => { if (!props.followCamera) props.onToggleFollowCamera(); }}>跟随相机</button>
      </div>
      <NumberField key={`${project.id}-duration`} label="项目时长" value={duration} min={minimumDuration} max={600} step={step} disabled={locked} onCommit={props.onDurationChange} description={`不能短于所有片段的最晚结束时间（${minimumDuration.toFixed(3)} 秒），最长 600 秒。`} />
    </div>

    <div className="tl-scroll">
      <div className="tl-grid" style={{ '--tick-width': `${100 / tickCount}%` } as CSSProperties}>
        <div className="tl-ruler-label">对象 / 全局时间（秒）</div>
        <div className="tl-ruler">
          {Array.from({ length: tickCount + 1 }, (_, index) => <span key={index} style={{ left: `${index / tickCount * 100}%` }}>{(index * duration / tickCount).toFixed(duration < 20 ? 1 : 0)}</span>)}
          <input type="range" aria-label="全局预览时间" min={0} max={duration} step={step} value={time} disabled={locked} onChange={(event) => props.onSeek(Number(event.target.value))} onPointerDown={(event) => {
            if (locked || event.button !== 0) return;
            event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); seekPointer.current = event.pointerId; seekAtPointer(event);
          }} onPointerMove={(event) => { if (!locked && seekPointer.current === event.pointerId) seekAtPointer(event); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); seekPointer.current = null; }} onPointerCancel={() => { seekPointer.current = null; }} />
          <i className="tl-ruler-playhead" style={{ left: `${clamp(time / duration, 0, 1) * 100}%` }} />
        </div>
        {rows.map((row) => <div key={row.id} className={`tl-row ${row.id === props.selectedTarget ? 'is-selected' : ''}`} style={{ '--track-color': row.color } as CSSProperties}>
          <button className="tl-label" title={row.name} disabled={locked} onClick={() => props.onSelectTarget(row.id)}>
            {row.kind === 'camera' ? <Camera size={13} /> : <Box size={13} />}
            <span><strong>{row.name}</strong><small>{row.status}</small></span>
          </button>
          <div className="tl-lane" onPointerDown={(event) => {
            if (locked || event.button !== 0 || event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            props.onSeek(clamp(snap((event.clientX - bounds.left) / bounds.width * duration), 0, duration));
          }}>
            {row.trajectory && row.clip ? <div className="tl-clip" data-target={row.id} style={{ left: `${row.clip.start / duration * 100}%`, width: `${row.clip.duration / duration * 100}%` }}>
              <button className="tl-clip-move" role="slider" aria-label={`${row.name}轨迹开始时间`} aria-valuemin={0} aria-valuemax={duration - row.clip.duration} aria-valuenow={row.clip.start} aria-valuetext={`开始 ${row.clip.start.toFixed(3)} 秒，时长 ${row.clip.duration.toFixed(3)} 秒`} aria-orientation="horizontal" disabled={locked} onPointerDown={(event) => startDrag(event, row, 'move')} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => clearDragSession(event.pointerId, event.currentTarget)} onKeyDown={(event) => keyAdjust(event, row, 'move')} title={`${row.name}：拖动整体平移；源时长 ${row.trajectory.duration.toFixed(2)} 秒；播放倍率 ${(row.trajectory.duration / row.clip.duration).toFixed(2)}×`}>
                <span>{row.clip.duration.toFixed(2)} 秒</span><small>{(row.trajectory.duration / row.clip.duration).toFixed(2)}×</small>
              </button>
              {(['start', 'end'] as const).map((mode) => <button key={mode} className={`tl-handle tl-handle-${mode}`} role="slider" aria-label={`${row.name}轨迹${mode === 'start' ? '左' : '右'}边界`} aria-valuemin={mode === 'start' ? 0 : row.clip!.start + step} aria-valuemax={mode === 'start' ? row.clip!.start + row.clip!.duration - step : duration} aria-valuenow={mode === 'start' ? row.clip!.start : row.clip!.start + row.clip!.duration} aria-valuetext={`${mode === 'start' ? '开始' : '结束'} ${(mode === 'start' ? row.clip!.start : row.clip!.start + row.clip!.duration).toFixed(3)} 秒`} aria-orientation="horizontal" title={`拖动${mode === 'start' ? '左' : '右'}边界等比例变速`} disabled={locked} onPointerDown={(event) => startDrag(event, row, mode)} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => clearDragSession(event.pointerId, event.currentTarget)} onKeyDown={(event) => keyAdjust(event, row, mode)}><i /></button>)}
            </div> : <span className={`tl-empty ${row.status === '全程静止' ? 'is-static' : ''}`}>{row.status === '全程静止' ? '首位姿保持' : row.kind === 'camera' ? '在动态场景就绪后录制或导入' : '录制、导入轨迹或设为静止'}</span>}
            <i className="tl-lane-playhead" style={{ left: `${clamp(time / duration, 0, 1) * 100}%` }} />
          </div>
        </div>)}
      </div>
    </div>

    <div className="tl-inspector">
      {selected?.trajectory && selected.clip ? <>
        <span className="tl-selected-name" title={selected.name}><i style={{ background: selected.color }} />{selected.name}</span>
        <NumberField key={`${selected.id}-start`} label="开始" value={selected.clip.start} min={0} max={duration - selected.clip.duration} step={step} disabled={locked} onCommit={(start) => changeTiming(selected, { start, duration: selected.clip!.duration })} />
        <NumberField key={`${selected.id}-duration`} label="时长" value={selected.clip.duration} min={step} max={duration - selected.clip.start} step={step} disabled={locked} onCommit={(clipDuration) => changeTiming(selected, { start: selected.clip!.start, duration: clipDuration })} />
        <span className="tl-stat"><span>结束</span><b>{(selected.clip.start + selected.clip.duration).toFixed(2)} 秒</b></span>
        <span className="tl-stat"><span>源时长</span><b>{selected.trajectory.duration.toFixed(2)} 秒</b></span>
        <span className="tl-stat"><span>播放倍率</span><b>{(selected.trajectory.duration / selected.clip.duration).toFixed(2)}×</b></span>
        <span className="tl-stat tl-speed" title="源轨迹路径总长度除以片段时长；整段等比例变速保留原始快慢分布。"><span>平均平移速度</span><b>{(selectedLength / selected.clip.duration).toFixed(3)} <small>场景单位/秒</small></b></span>
      </> : <span className="tl-inspector-empty">{selected ? `${selected.name}：${selected.status}。选择有轨迹的对象可编辑时间。` : '选择一条轨迹，查看开始时间、时长和播放倍率。'}</span>}
    </div>
    <div className="tl-help"><span>拖动片段平移 · 拖动两端等比例变速 · 方向键调整一帧，Shift 调整十帧</span><span>片段占满时轴时，先缩短片段或增加项目时长</span></div>
    <span className="tl-announcement" role="status" aria-live="polite">{announcement}</span>
  </section>;
}

export default Timeline;
