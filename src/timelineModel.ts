import { Quaternion } from 'three';
import type { MotionClip, Pose, Quat, Trajectory, TrajectoryKinematics, Vec3 } from './types';

const uid = () => `clip_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const zero = (): TrajectoryKinematics => ({ velocity: [0, 0, 0], speed: 0, angularVelocity: [0, 0, 0], angularSpeed: 0 });

export function makeDefaultClip(trajectory: Trajectory): MotionClip {
  return { id: uid(), revision: 1, trajectoryId: trajectory.id, trajectoryRevision: trajectory.revision,
    start: 0, duration: trajectory.duration, timeMap: { mode: 'linear' }, before: 'hold_first_pose', after: 'hold_last_pose' };
}

export function validateClip(raw: unknown, trajectory: Trajectory, projectDuration: number): MotionClip {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运动轨迹必须绑定有效的时间片段。');
  const data = raw as Record<string, unknown>;
  const start = data.start ?? data.start_time_seconds, duration = data.duration ?? data.duration_seconds;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) throw new Error('片段开始时间必须是非负有限数值。');
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('片段时长必须大于 0。');
  if (!Number.isFinite(projectDuration) || projectDuration <= 0 || start + duration > projectDuration + 1e-7) throw new Error('片段超出公共时间轴，请扩展项目时长或明确缩短片段。');
  const trajectoryId = data.trajectoryId ?? data.trajectory_id, trajectoryRevision = data.trajectoryRevision ?? data.trajectory_revision;
  if (trajectoryId !== trajectory.id || trajectoryRevision !== trajectory.revision) throw new Error('时间片段绑定的轨迹 ID 或版本不匹配。');
  const mapping = data.timeMap ?? data.time_mapping;
  if (!mapping || typeof mapping !== 'object' || (mapping as Record<string, unknown>).mode !== 'linear') throw new Error('本版仅支持整段线性变速，不支持分段时间映射。');
  if ((data.before ?? data.before_start) !== 'hold_first_pose' || (data.after ?? data.after_end) !== 'hold_last_pose') throw new Error('片段前后必须分别保持首位姿和末位姿。');
  const id = data.id ?? data.clip_id;
  if (typeof id !== 'string' || !id.trim() || typeof data.revision !== 'number' || !Number.isInteger(data.revision) || data.revision < 1) throw new Error('片段必须包含有效 ID 和版本。');
  return { id, revision: data.revision, trajectoryId: trajectory.id, trajectoryRevision: trajectory.revision,
    start, duration, timeMap: { mode: 'linear' }, before: 'hold_first_pose', after: 'hold_last_pose' };
}

export function sourceTimeAt(clip: MotionClip, sourceDuration: number, globalTime: number): number {
  if (!Number.isFinite(globalTime) || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(clip.duration) || clip.duration <= 0 || !Number.isFinite(clip.start)) throw new Error('时间映射需要有效的全局时间与正时长。');
  return clamp((globalTime - clip.start) * sourceDuration / clip.duration, 0, sourceDuration);
}

function intervalAt(trajectory: Trajectory, time: number): number {
  const samples = trajectory.samples;
  if (samples.length < 2) throw new Error('轨迹至少需要两个采样点。');
  if (time <= samples[0].t) return 0;
  if (time >= samples[samples.length - 1].t) return samples.length - 2;
  let low = 0, high = samples.length - 1;
  while (high - low > 1) { const middle = (low + high) >>> 1; if (samples[middle].t <= time) low = middle; else high = middle; }
  return low;
}

export function sampleSourceTrajectory(trajectory: Trajectory, time: number): Pose {
  const index = intervalAt(trajectory, time), a = trajectory.samples[index], b = trajectory.samples[index + 1];
  const factor = clamp((time - a.t) / (b.t - a.t), 0, 1);
  return {
    position: a.position.map((value, axis) => value + (b.position[axis] - value) * factor) as Vec3,
    quaternion: new Quaternion(...a.quaternion).slerp(new Quaternion(...b.quaternion), factor).normalize().toArray() as Quat,
  };
}

export function sampleClip(trajectory: Trajectory, clip: MotionClip, globalTime: number): Pose {
  return sampleSourceTrajectory(trajectory, sourceTimeAt(clip, trajectory.duration, globalTime));
}

export function editClip(clip: MotionClip, action: 'move' | 'resize-start' | 'resize-end', time: number, projectDuration: number, fps: number): MotionClip {
  if (!Number.isFinite(time) || !Number.isFinite(projectDuration) || projectDuration <= 0 || !Number.isFinite(fps) || fps < 1) throw new Error('时间片段编辑参数无效。');
  const minimum = 1 / fps, snapped = Math.round(time * fps) / fps;
  const end = clip.start + clip.duration;
  let start = clip.start, duration = clip.duration;
  if (action === 'move') {
    if (duration > projectDuration) throw new Error('片段长于项目时间轴，请先扩展项目时长。');
    start = clamp(snapped, 0, projectDuration - duration);
  } else if (action === 'resize-start') { start = clamp(snapped, 0, Math.max(0, end - minimum)); duration = end - start; }
  else { const nextEnd = clamp(snapped, Math.min(projectDuration, start + minimum), projectDuration); duration = nextEnd - start; }
  if (duration <= 0 || start + duration > projectDuration + 1e-7) throw new Error('片段边界超出有效时间轴。');
  return { ...clip, start, duration, revision: start === clip.start && duration === clip.duration ? clip.revision : clip.revision + 1 };
}

export function trajectoryVelocity(trajectory: Trajectory, sourceTime: number): TrajectoryKinematics {
  if (sourceTime < 0 || sourceTime > trajectory.duration) return zero();
  const index = intervalAt(trajectory, sourceTime), a = trajectory.samples[index], b = trajectory.samples[index + 1];
  const elapsed = b.t - a.t;
  const velocity = a.position.map((value, axis) => (b.position[axis] - value) / elapsed) as Vec3;
  const delta = new Quaternion(...b.quaternion).multiply(new Quaternion(...a.quaternion).invert()).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const sine = Math.hypot(delta.x, delta.y, delta.z);
  const angle = 2 * Math.atan2(sine, delta.w);
  const angularVelocity: Vec3 = sine < 1e-12 ? [0, 0, 0] : [delta.x, delta.y, delta.z].map(component => component / sine * angle / elapsed) as Vec3;
  return { velocity, speed: Math.hypot(...velocity), angularVelocity, angularSpeed: Math.hypot(...angularVelocity) };
}

export function clipKinematics(trajectory: Trajectory, clip: MotionClip, globalTime: number): TrajectoryKinematics {
  if (globalTime < clip.start || globalTime > clip.start + clip.duration) return zero();
  const source = trajectoryVelocity(trajectory, sourceTimeAt(clip, trajectory.duration, globalTime));
  const multiplier = trajectory.duration / clip.duration;
  return { velocity: source.velocity.map(value => value * multiplier) as Vec3, speed: source.speed * multiplier,
    angularVelocity: source.angularVelocity.map(value => value * multiplier) as Vec3, angularSpeed: source.angularSpeed * multiplier };
}

export function exportClip(clip: MotionClip) {
  return { clip_id: clip.id, revision: clip.revision, trajectory_id: clip.trajectoryId, trajectory_revision: clip.trajectoryRevision,
    start_time_seconds: clip.start, duration_seconds: clip.duration, time_mapping: { mode: 'linear' }, before_start: clip.before, after_end: clip.after };
}
