import { describe, expect, it } from 'vitest';
import { createDemoProjects, frontPose, makeDefaultClip, makePreset, validatePrototypeProject } from '../model';
import { removeCameraTrajectory, removeSceneObject } from './objects';
import { motionControls, setMotionControl } from './motionControls';
import { exportProjectSnapshot, sameExportSnapshot } from './snapshot';
import { applyDefinedObjectResult, applyObjectResult } from './apply';
import type { ObjectDefinition, WorkflowJob, WorkflowRequest, WorkflowResult } from './types';

function fixture() {
  const project = createDemoProjects()[0];
  project.demoScene = null; project.demoSceneRevision = null;
  project.objects = project.objects.slice(0, 2).map((object, i) => {
    object = { ...object, front: object.front || '+x' };
    object.initialPose = frontPose(object, object.front!);
    const trajectory = makePreset('object', 'slide', object);
    return { ...object, shape: 'pointcloud' as const, segmented: true, motion: 'trajectory' as const,
      trajectory, clip: makeDefaultClip(trajectory), history: [trajectory],
      reconstruction: { sceneJobId: 'scene-1', jobId: `associate-${i}` } };
  });
  project.camera = makePreset('camera', 'arc', undefined, project.duration, project.cameraIntrinsics!); project.cameraClip = makeDefaultClip(project.camera);
  project.fourD = 'ready';
  project.workflow = { version: 1, referenceAssetId: 'a'.repeat(64), width: project.referenceCamera!.imageWidth,
    height: project.referenceCamera!.imageHeight, sceneJobId: 'scene-1', exportJobId: 'export-1', pending: [],
    objectDefinitions: project.objects.map((o, i) => ({ id: o.id, name: o.name, prompt: o.prompt,
      requestId: `request-${i}`, createdAt: project.updatedAt, sceneJobId: 'scene-1', segmentationJobId: 'sam-1', candidate: i })) };
  project.reference = `/api/workflow/assets/${project.workflow.referenceAssetId}/image`;
  return project;
}

function association(definition: ObjectDefinition) {
  const job: WorkflowJob = { id: 'associate-0', requestId: definition.requestId, kind: 'associate', status: 'succeeded', message: 'done',
    outputs: [{ name: 'overlay.png', url: 'inference/jobs/associate-0/outputs/0' }],
    inputs: { referenceAssetId: 'a'.repeat(64), sceneJobId: 'scene-1', segmentationJobId: 'sam-1', objectJobIds: [] }, options: { candidate: definition.candidate } };
  const result: WorkflowResult = { kind: 'associate', source: job.inputs, center: [0, 0, 2], halfExtents: [.2, .3, .1] };
  return { job, result };
}

describe('object removal and existing inference state', () => {
  it('deletes only the active camera track, keeps recoverable history and lens, and disables camera export', () => {
    const project = fixture(), next = removeCameraTrajectory(project);
    expect(next.camera).toBeNull(); expect(next.cameraClip).toBeNull();
    expect(next.cameraHistory[0]).toBe(project.camera);
    expect(next.cameraIntrinsics).toBe(project.cameraIntrinsics);
    expect(next.objects).toBe(project.objects); expect(next.fourD).toBe(project.fourD);
    expect(next.generation).toBe(project.generation); expect(next.workflow?.exportJobId).toBeUndefined();
    expect(motionControls(next)).toEqual({ object: true, camera: false });
    expect(exportProjectSnapshot(next).camera).toBeNull();
    expect(removeCameraTrajectory(next)).toBe(next);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(next))).camera).toBeNull();
  });
  it('replaces an edited point cluster in place only while its original definition and dependencies match', () => {
    const project = fixture(), old = project.objects[0];
    const definition = { ...project.workflow!.objectDefinitions![0], replaceObjectJobId: old.reconstruction!.jobId };
    project.workflow!.objectDefinitions = [definition];
    const base = association(definition), job: WorkflowJob = { ...base.job, id: 'edited-object', inputs: { ...base.job.inputs,
      replaceObjectJobId: definition.replaceObjectJobId, objectJobIds: [project.objects[1].reconstruction!.jobId] } };
    const result = { ...base.result, source: job.inputs, center: [1, 2, 3] as [number, number, number] };
    const next = applyDefinedObjectResult(project, job, result, definition);
    expect(next.objects.map(o => o.id)).toEqual(project.objects.map(o => o.id));
    expect(next.objects[0]).toMatchObject({ name: old.name, prompt: old.prompt, front: old.front, center: [1, 2, 3], trajectory: null, clip: null, motion: 'unassigned' });
    expect(next.objects[0].history[0]).toBe(old.trajectory); expect(next.objects[1]).toBe(project.objects[1]);
    expect(next.objects[0].reconstruction?.jobId).toBe(job.id);
    expect(next.workflow?.objectDefinitions).toEqual([]); expect(next.camera).toBe(project.camera);
    expect(next.workflow?.exportJobId).toBeUndefined(); expect(next.fourD).toBe('stale');
    expect(applyDefinedObjectResult(next, job, result, definition)).toBe(next);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(next))).objects[0].center).toEqual([1, 2, 3]);
    const deleted = removeSceneObject(project, old.id);
    expect(applyDefinedObjectResult(deleted, job, result, definition)).toBe(deleted);
    const stale = structuredClone(project); stale.objects[0].reconstruction!.jobId = 'newer-object';
    expect(() => applyDefinedObjectResult(stale, job, result, definition)).toThrow('另一结果');
  });
  it('removes only the selected instance and definition, invalidates export, and round-trips without losing other assets', () => {
    const project = fixture(), original = structuredClone(project), id = project.objects[0].id;
    const next = removeSceneObject(project, id);
    expect(project).toEqual(original);
    expect(next.objects).toEqual([project.objects[1]]);
    expect(next.objects[0]).toBe(project.objects[1]);
    expect(next.workflow?.objectDefinitions).toEqual([project.workflow!.objectDefinitions![1]]);
    expect(next.workflow?.sceneJobId).toBe(project.workflow!.sceneJobId);
    expect(next.workflow?.pending).toBe(project.workflow!.pending);
    expect(next.referenceCamera).toBe(project.referenceCamera);
    expect(next.reference).toBe(project.reference);
    expect(next.geometryReady).toBe(project.geometryReady);
    expect(next.camera).toBe(project.camera); expect(next.cameraClip).toBe(project.cameraClip);
    expect(next.cameraHistory).toBe(project.cameraHistory);
    expect(next.generation).toBe(project.generation);
    expect(next.fourD).toBe('stale'); expect(next.workflow?.exportJobId).toBeUndefined();
    expect(sameExportSnapshot(exportProjectSnapshot(project), exportProjectSnapshot(next))).toBe(false);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(next))).objects).toHaveLength(1);
    expect(removeSceneObject(next, id)).toBe(next);
  });

  it('preserves disabled remaining motion, but turns object control off after the last trajectory is removed', () => {
    const project = setMotionControl(setMotionControl(fixture(), 'object', false), 'camera', false);
    const next = removeSceneObject(project, project.objects[0].id);
    expect(motionControls(next)).toEqual({ object: false, camera: false });
    expect(next.motionControls?.camera).toBe(project.motionControls?.camera);
    const on = setMotionControl(next, 'object', true);
    const empty = removeSceneObject(on, next.objects[0].id);
    expect(empty.objects).toEqual([]); expect(empty.workflow?.objectDefinitions).toEqual([]);
    expect(motionControls(empty)).toEqual({ object: false, camera: false });
    expect(exportProjectSnapshot(empty).objects).toEqual([]);
    expect(empty.camera).toBe(project.camera);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(empty))).objects).toEqual([]);
  });

  it('removes a pending definition while keeping its immutable submission record', () => {
    const project = fixture();
    const definition = project.workflow!.objectDefinitions![0];
    const request: WorkflowRequest = { version: 1, requestId: definition.requestId, createdAt: definition.createdAt,
      projectId: project.id, projectName: project.name, kind: 'associate', inputs: association(definition).job.inputs,
      options: { candidate: definition.candidate }, execution: project.generation.projectProfiles[0].execution };
    project.objects = []; project.workflow!.objectDefinitions = [definition]; project.workflow!.pending = [request]; project.fourD = 'missing';
    expect(() => exportProjectSnapshot(project)).toThrow('待处理');
    const next = removeSceneObject(project, definition.id);
    expect(next.workflow?.pending[0]).toBe(request);
    expect(next.workflow?.objectDefinitions).toEqual([]); expect(next.fourD).toBe('missing');
    expect(() => exportProjectSnapshot(next)).not.toThrow();
  });

  it('rejects delayed automatic association updates after deletion, while allowing an explicit new definition', () => {
    const project = fixture(); project.objects = project.objects.slice(0, 1);
    const definition = project.workflow!.objectDefinitions![0], { job, result } = association(definition);
    project.workflow!.objectDefinitions = [definition];
    const next = removeSceneObject(project, definition.id);
    expect(applyDefinedObjectResult(next, job, result, definition)).toBe(next);
    expect(applyObjectResult(next, job, result, { ...definition, id: 'explicit-new-object' }).objects).toHaveLength(1);
    const retry = { ...definition, requestId: 'new-request' };
    next.workflow!.objectDefinitions = [retry];
    expect(applyDefinedObjectResult(next, job, result, definition)).toBe(next);
    const current = applyDefinedObjectResult(next, { ...job, requestId: retry.requestId }, result, retry);
    expect(current.objects[0].id).toBe(retry.id);
    expect(applyDefinedObjectResult(current, { ...job, requestId: retry.requestId }, result, retry)).toBe(current);
  });

  it('does nothing for unknown IDs and still rejects other results based on a deleted object', () => {
    const project = fixture();
    expect(removeSceneObject(project, 'unknown')).toBe(project);
    const next = removeSceneObject(project, project.objects[0].id);
    const definition = { ...project.workflow!.objectDefinitions![0], id: 'new' };
    const { job, result } = association(definition);
    job.inputs.objectJobIds = project.objects.map(o => o.reconstruction!.jobId);
    expect(() => applyObjectResult(next, { ...job, id: 'new-job' }, result, definition)).toThrow('物体集合');
  });
});
