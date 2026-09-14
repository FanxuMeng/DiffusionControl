import type { Project } from '../types';
import { motionControls, RENDER_STRATEGY } from './motionControls';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Quaternion normalization differs by a few ulps between JS engines. */
export function sameExportSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 1e-9;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => sameExportSnapshot(value, b[i]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameExportSnapshot(left[key], right[key]));
}

/** Only export inputs participate: UI selection, previews and history do not. */
export function exportProjectSnapshot(project: Project) {
  if (!project.referenceCamera || !project.workflow?.sceneJobId) throw new Error('请先应用场景重建。');
  if (project.workflow.objectDefinitions?.some(item => item.replaceObjectJobId || !project.objects.some(object => object.id === item.id))) throw new Error('还有待处理的物体定义，请等待关联完成或放弃不再需要的更新。');
  const controls = motionControls(project);
  if (controls.object && project.objects.some(o => !o.reconstruction || o.motion === 'unassigned')) throw new Error('请先为所有物体指定静止或轨迹。');
  return {
    prompt: project.description, duration: project.duration, controls, renderStrategy: RENDER_STRATEGY,
    calibration: (controls.camera && project.camera?.cameraIntrinsics?.calibration) || project.referenceCamera,
    camera: controls.camera && project.camera ? { duration: project.camera.duration, samples: project.camera.samples } : null,
    cameraClip: controls.camera ? project.cameraClip : null,
    objects: (controls.object ? project.objects : []).map(o => ({ id: o.id, jobId: o.reconstruction!.jobId, prompt: o.prompt,
      initialPose: o.initialPose, motion: o.motion,
      trajectory: o.trajectory ? { duration: o.trajectory.duration, samples: o.trajectory.samples } : null, clip: o.clip })),
  };
}
