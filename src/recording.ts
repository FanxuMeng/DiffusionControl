import { parseTrajectory } from './model';
import { makeDefaultClip, validateClip } from './timelineModel';
import { makeTrajectoryPreview, type PreviewOptions } from './trajectoryPreview';
import type { CameraIntrinsicsTrack, MotionClip, Project, Sample, Trajectory } from './types';

export interface RecordedTake { projectId: string; targetId: string; trajectory: Trajectory; clip: MotionClip }
type PreviewRenderer = (samples: Sample[], color: string | undefined, options: PreviewOptions) => string;

/** Prepare a complete immutable result before replacing any current asset. */
export function prepareRecordedTake(project: Project, targetId: string, samples: Sample[], lens?: CameraIntrinsicsTrack | null, renderPreview: PreviewRenderer = makeTrajectoryPreview): RecordedTake {
  const object = project.objects.find(item => item.id === targetId);
  const kind = targetId === 'camera' ? 'camera' : 'object';
  if (kind === 'object' && (!object?.segmented || !object.front)) throw new Error('录制物体已失效，请检查分割与正面。');
  const name = `${kind === 'camera' ? project.name : object!.name}_${kind === 'camera' ? 'camtrj' : 'objtrj'}`;
  const parsed = parseTrajectory({ kind, name, samples: structuredClone(samples), ...(kind === 'camera' ? { cameraIntrinsics: lens } : {}) }, kind, object);
  const trajectory: Trajectory = { ...parsed, source: 'recorded', preview: '' };
  const clip = validateClip(makeDefaultClip(trajectory), trajectory, project.duration);
  trajectory.preview = renderPreview(trajectory.samples, object?.color, { kind, cameraIntrinsics: trajectory.cameraIntrinsics, clip });
  if (!trajectory.preview) throw new Error('轨迹预览图生成失败；录制仍保留在暂停状态，请重试结束录制。');
  return { projectId: project.id, targetId, trajectory, clip };
}

/** A single project update keeps thumbnail, samples, clip and history in sync. */
export function commitRecordedTake(project: Project, take: RecordedTake): Project {
  if (project.id !== take.projectId) throw new Error('录制结果与当前项目不匹配。');
  const { targetId, trajectory, clip } = take;
  const updatedAt = new Date().toISOString();
  if (targetId === 'camera') {
    if (trajectory.kind !== 'camera' || !trajectory.cameraIntrinsics) throw new Error('相机录制缺少固定镜头参数。');
    return { ...project, updatedAt, camera: trajectory, cameraClip: clip, cameraIntrinsics: trajectory.cameraIntrinsics, cameraHistory: project.camera ? [project.camera, ...project.cameraHistory] : project.cameraHistory };
  }
  if (trajectory.kind !== 'object' || !project.objects.some(object => object.id === targetId)) throw new Error('录制目标已不存在。');
  return { ...project, updatedAt, fourD: project.fourD === 'missing' ? 'missing' : 'stale', objects: project.objects.map(object => object.id === targetId ? { ...object, motion: 'trajectory', trajectory, clip, history: object.trajectory ? [object.trajectory, ...object.history] : object.history } : object) };
}

export function currentPreviewTrajectory(project: Project, targetId: string): Trajectory | null {
  return targetId === 'camera' ? project.camera : project.objects.find(object => object.id === targetId)?.trajectory ?? null;
}
