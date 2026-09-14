import type { Project, SceneObject } from '../types';
import { createCameraIntrinsics, deriveFov, frontPose, validateCameraCalibration } from '../model';
import { outputUrl } from './api';
import { canonicalJson } from './snapshot';
import type { ObjectDefinition, WorkflowJob, WorkflowResult } from './types';
import { Quaternion } from 'three';
import { motionControls, setMotionControl } from './motionControls';

export function validateWorkflowResult(project: Project, job: WorkflowJob, result: WorkflowResult) {
  if (job.status !== 'succeeded' || job.cancelRequested || result.kind !== job.kind || canonicalJson(result.source) !== canonicalJson(job.inputs)) throw new Error('产物来源或任务状态不匹配。');
  if (project.workflow?.referenceAssetId !== job.inputs.referenceAssetId) throw new Error('首帧已变化，此结果仅保留为历史。');
}

export function initialDepthJob(project: Project, jobs: WorkflowJob[]) {
  if (project.demoScene || project.workflow?.sceneJobId || project.objects.length || project.camera || project.cameraHistory.length) return undefined;
  return jobs.find(job => job.kind === 'depth' && job.status === 'succeeded' && !job.cancelRequested && job.inputs.referenceAssetId === project.workflow?.referenceAssetId);
}

export function applyDepthResult(project: Project, job: WorkflowJob, result: WorkflowResult): Project {
  validateWorkflowResult(project, job, result);
  if (job.kind !== 'depth' || !result.intrinsic || typeof result.width !== 'number' || typeof result.height !== 'number'
    || result.width !== project.workflow?.width || result.height !== project.workflow?.height) throw new Error('重建标定与首帧尺寸不匹配。');
  if (project.workflow.sceneJobId === job.id && project.geometryReady && project.referenceCamera) return project;
  const calibration = validateCameraCalibration({ id: `depth-${job.id}`, revision: 1, model: 'pinhole', imageWidth: result.width, imageHeight: result.height,
    pixelCenters: 'integer_coordinates', intrinsic: result.intrinsic, fov: deriveFov(result.intrinsic, result.width, result.height),
    distortion: { model: 'none', coefficientOrder: ['k1', 'k2', 'p1', 'p2', 'k3'], coefficients: [0, 0, 0, 0, 0], state: 'assumed' }, source: `depthpro:${job.id}` });
  return { ...project, geometryReady: true, workflow: { ...project.workflow, sceneJobId: job.id, exportJobId: undefined, objectDefinitions: [] },
    objects: [], fourD: 'missing', camera: null, cameraClip: null, cameraHistory: [], referenceCamera: calibration, cameraIntrinsics: createCameraIntrinsics(calibration) };
}

export function applyObjectResult(project: Project, job: WorkflowJob, result: WorkflowResult, definition: Pick<ObjectDefinition, 'id' | 'name' | 'prompt'>): Project {
  validateWorkflowResult(project, job, result);
  if (job.kind !== 'associate' || !Array.isArray(result.center) || result.center.length !== 3 || !Array.isArray(result.halfExtents) || result.halfExtents.length !== 3
    || [...result.center, ...result.halfExtents].some(value => !Number.isFinite(value)) || result.halfExtents.some(value => value <= 0)) throw new Error('包围盒数据无效。');
  if (project.workflow?.sceneJobId !== job.inputs.sceneJobId) throw new Error('场景已重建，此物体结果不能应用。');
  if (result.boxQuaternion !== undefined && (!Array.isArray(result.boxQuaternion) || result.boxQuaternion.length !== 4
    || result.boxQuaternion.some(value => !Number.isFinite(value)) || Math.abs(new Quaternion(...result.boxQuaternion).length() - 1) > 1e-5)) throw new Error('包围盒旋转无效。');
  if (project.objects.some(o => o.reconstruction?.jobId === job.id)) return project;
  if (project.objects.some(o => o.id === definition.id)) throw new Error('物体 ID 已被另一结果使用。');
  const existing = project.objects.map(o => o.reconstruction?.jobId).sort();
  if (canonicalJson(existing) !== canonicalJson([...(job.inputs.objectJobIds || [])].sort())) throw new Error('物体集合在关联期间发生变化，请重新关联以检查重叠。');
  const object: SceneObject = { id: definition.id, name: definition.name, prompt: definition.prompt, color: '#86dcb7', shape: 'pointcloud',
    center: result.center, halfExtents: result.halfExtents, ...(result.boxQuaternion ? { boxQuaternion: result.boxQuaternion } : {}), segmented: true, front: null, initialPose: { position: result.center, quaternion: [0, 0, 0, 1] },
    motion: 'unassigned', trajectory: null, clip: null, history: [], maskPreview: outputUrl(job, 'overlay.png'),
    reconstruction: { jobId: job.id, sceneJobId: job.inputs.sceneJobId! } };
  object.initialPose = frontPose(object, '+x');
  return { ...project, objects: [...project.objects, object], fourD: 'stale', workflow: { ...project.workflow!, exportJobId: undefined } };
}

export function definitionJob(definition: ObjectDefinition, jobs: WorkflowJob[]) {
  return jobs.find(job => job.requestId === definition.requestId && job.kind === 'associate' && job.inputs.sceneJobId === definition.sceneJobId
    && job.inputs.segmentationJobId === definition.segmentationJobId && job.options.candidate === definition.candidate
    && job.inputs.replaceObjectJobId === definition.replaceObjectJobId);
}

/** Recheck the current definition when a queued automatic update is committed. */
export function applyDefinedObjectResult(project: Project, job: WorkflowJob, result: WorkflowResult, definition: ObjectDefinition): Project {
  const current = project.workflow?.objectDefinitions?.find(item => item.id === definition.id && item.requestId === definition.requestId);
  if (!current || !definitionJob(current, [job])) return project;
  if (current.replaceObjectJobId) {
    const old = project.objects.find(object => object.id === current.id);
    if (!old) return project;
    if (old.reconstruction?.jobId !== current.replaceObjectJobId) throw new Error('物体点簇已被另一结果替换，请重新编辑。');
    const otherObjects = project.objects.filter(object => object.id !== current.id);
    const applied = applyObjectResult({ ...project, objects: otherObjects }, job, result, current);
    const fresh = applied.objects[applied.objects.length - 1];
    const replacement: SceneObject = { ...fresh, name: old.name, prompt: old.prompt, color: old.color, front: old.front,
      motion: old.motion === 'static' ? 'static' : 'unassigned',
      history: (old.trajectory ? [old.trajectory, ...old.history] : old.history).slice(0, 500) };
    replacement.initialPose = frontPose(replacement, replacement.front || '+x');
    const next = { ...applied, objects: project.objects.map(object => object.id === old.id ? replacement : object),
      workflow: { ...applied.workflow!, objectDefinitions: applied.workflow!.objectDefinitions?.filter(item => item.id !== old.id) } };
    return setMotionControl(next, 'object', motionControls(project).object && motionControls(next).object);
  }
  return applyObjectResult(project, job, result, current);
}
