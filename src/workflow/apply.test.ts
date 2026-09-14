import { describe, expect, it } from 'vitest';
import { createEmptyProject, validatePrototypeProject } from '../model';
import { applyDepthResult, applyObjectResult, definitionJob, initialDepthJob } from './apply';
import type { ObjectDefinition, WorkflowJob, WorkflowResult } from './types';
import { exportProjectSnapshot } from './snapshot';

function setup() {
  const project = createEmptyProject('真实场景', 'projects');
  project.reference = `/api/workflow/assets/${'a'.repeat(64)}/image`;
  project.workflow = { version: 1, referenceAssetId: 'a'.repeat(64), width: 64, height: 48, pending: [] };
  const job: WorkflowJob = { id: 'depth-1', requestId: 'request-depth', kind: 'depth', status: 'succeeded', message: 'done',
    inputs: { referenceAssetId: 'a'.repeat(64) }, options: {}, outputs: [] };
  const result: WorkflowResult = { kind: 'depth', source: job.inputs, width: 64, height: 48, intrinsic: [[64, 0, 31.5], [0, 64, 23.5], [0, 0, 1]] };
  return { project, job, result };
}
describe('completed workflow results become usable project state', () => {
  it('finds a completed reconstruction after refresh, binds calibration, and preserves an existing scene', () => {
    const { project, job, result } = setup();
    expect(initialDepthJob(project, [{ ...job, status: 'failed' }, job])).toBe(job);
    const ready = applyDepthResult(project, job, result);
    expect(ready.geometryReady).toBe(true);
    expect(ready.workflow?.sceneJobId).toBe(job.id);
    expect(ready.referenceCamera?.intrinsic).toEqual(result.intrinsic);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(ready))).geometryReady).toBe(true);
    expect(initialDepthJob(ready, [{ ...job, id: 'new-depth' }])).toBeUndefined();
    expect(applyDepthResult(ready, job, result)).toBe(ready);
  });
  it('never binds another image, a cancelled task, or invalid camera dimensions', () => {
    const { project, job, result } = setup();
    const wrong = { ...job, inputs: { referenceAssetId: 'b'.repeat(64) } };
    expect(initialDepthJob(project, [wrong])).toBeUndefined();
    expect(() => applyDepthResult(project, wrong, { ...result, source: wrong.inputs })).toThrow('首帧');
    expect(() => applyDepthResult(project, { ...job, cancelRequested: true }, result)).toThrow('状态');
    expect(() => applyDepthResult(project, job, { ...result, width: 128 })).toThrow('尺寸');
  });
  it('persists the chosen object definition and applies the matching association exactly once', () => {
    const source = setup(), project = applyDepthResult(source.project, source.job, source.result);
    const definition: ObjectDefinition = { id: 'object-one', name: '椅子', prompt: 'A chair moving right.', requestId: 'request-associate',
      createdAt: '2026-09-10T10:00:00Z', sceneJobId: source.job.id, segmentationJobId: 'sam-1', candidate: 1 };
    project.workflow!.objectDefinitions = [definition];
    const restored = validatePrototypeProject(JSON.parse(JSON.stringify(project)));
    expect(restored.workflow?.objectDefinitions).toEqual([definition]);
    expect(() => exportProjectSnapshot(restored)).toThrow('待处理');
    const job: WorkflowJob = { id: 'associate-1', requestId: definition.requestId, kind: 'associate', status: 'succeeded', message: 'done',
      inputs: { ...source.job.inputs, sceneJobId: source.job.id, segmentationJobId: 'sam-1', objectJobIds: [] }, options: { candidate: 1 },
      outputs: [{ name: 'overlay.png', url: 'inference/jobs/associate-1/outputs/0' }] };
    const result: WorkflowResult = { kind: 'associate', source: job.inputs, center: [0, 0, 2], halfExtents: [.2, .3, .1] };
    expect(definitionJob(definition, [job])).toBe(job);
    expect(definitionJob(definition, [{ ...job, options: { candidate: 0 } }])).toBeUndefined();
    const complete = applyObjectResult(restored, job, result, restored.workflow!.objectDefinitions![0]);
    expect(complete.objects[0]).toMatchObject({ id: definition.id, name: '椅子', prompt: definition.prompt, front: null, segmented: true });
    expect(complete.objects[0].reconstruction).toEqual({ jobId: job.id, sceneJobId: source.job.id });
    expect(applyObjectResult(complete, job, result, definition)).toBe(complete);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(complete))).objects).toHaveLength(1);
    expect(() => applyObjectResult({ ...restored, workflow: { ...restored.workflow!, sceneJobId: 'new-scene' } }, job, result, definition)).toThrow('重建');
    expect(() => applyObjectResult(complete, { ...job, id: 'another' }, result, { ...definition, id: 'another-object' })).toThrow('集合');
  });
});
