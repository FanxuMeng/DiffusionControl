import { describe, expect, it } from 'vitest';
import { createDemoProjects, makeDefaultClip, makePreset, validatePrototypeProject } from '../model';
import { applyGlobalExecution } from './ExecutionSettings';
import { imageCoordinate } from './SamPromptOverlay';
import { createRealSceneGeometry, decodePreview } from './realScene';
import { canonicalJson, exportProjectSnapshot } from './snapshot';
import { validateWorkflowState } from './state';
import type { WorkflowRequest } from './types';

function project() {
  const p = createDemoProjects()[0];
  p.demoScene = null; p.demoSceneRevision = null;
  p.workflow = { version: 1, referenceAssetId: 'a'.repeat(64), width: p.referenceCamera!.imageWidth,
    height: p.referenceCamera!.imageHeight, sceneJobId: 'scene-1', pending: [] };
  p.reference = `/api/workflow/assets/${p.workflow.referenceAssetId}/image`;
  p.objects = [p.objects.find(o => o.id === 'plant')!];
  p.objects[0].shape = 'pointcloud';
  p.objects[0].reconstruction = { jobId: 'object-job-1', sceneJobId: 'scene-1' };
  return p;
}
function preview() {
  const data = new ArrayBuffer(12 + 28 * 3), view = new DataView(data);
  new Uint8Array(data, 0, 4).set(new TextEncoder().encode('DCP1'));
  view.setUint32(4, 3, true); view.setUint32(8, 28, true);
  for (let i = 0; i < 3; i++) {
    view.setFloat32(12 + 28 * i, i, true);
    view.setFloat32(12 + 28 * i + 8, 2, true);
    view.setFloat32(12 + 28 * i + 12, .5, true);
    view.setUint32(12 + 28 * i + 24, i + 10, true);
  }
  return data;
}

describe('real point clouds and SAM image coordinates', () => {
  it('maps letterboxed image clicks to integer pixel centers and ignores padding', () => {
    expect(imageCoordinate(201, 101, 800, 600, 400, 200)).toEqual([100, 0]);
    expect(imageCoordinate(201, 90, 800, 600, 400, 200)).toBeNull();
    expect(imageCoordinate(799, 499, 800, 600, 400, 200)).toEqual([399, 199]);
  });
  it('decodes stable IDs, and rejects truncated or nonfinite binary data', () => {
    expect([...decodePreview(preview()).pointIds]).toEqual([10, 11, 12]);
    expect(() => decodePreview(preview().slice(1))).toThrow();
    const invalid = preview(); new DataView(invalid).setFloat32(12, NaN, true);
    expect(() => decodePreview(invalid)).toThrow('无效坐标');
  });
  it('removes complete object IDs from the background even when the object preview is subsampled', () => {
    const p = project(), raw = decodePreview(preview()), object = p.objects[0];
    const geometry = createRealSceneGeometry(p.objects, { scene: raw, objects: { [object.id]: {
      preview: { positions: raw.positions.slice(0, 3), colors: raw.colors.slice(0, 3), pointIds: raw.pointIds.slice(0, 1) },
      pointIds: new Uint32Array([10, 11]),
    } } });
    expect(geometry.pointCount).toBe(2); // One background point + one displayed object point.
    expect(geometry.meshes.size).toBe(0);
    geometry.dispose();
  });
  it('returns deleted object points to the background even when old object assets are cached', () => {
    const p = project(), raw = decodePreview(preview()), id = p.objects[0].id;
    const geometry = createRealSceneGeometry([], { scene: raw, objects: { [id]: { preview: raw, pointIds: new Uint32Array([10, 11]) } } });
    expect(geometry.pointCount).toBe(3);
    expect(geometry.clouds.size).toBe(0);
    expect(geometry.cloudRoot.children).toHaveLength(1);
    geometry.dispose();
  });
});

describe('workflow identity, snapshots and global execution', () => {
  it('round-trips real reconstruction references and rejects a different scene binding', () => {
    const p = project();
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(p))).workflow).toEqual(p.workflow);
    p.objects[0].reconstruction!.sceneJobId = 'wrong-scene';
    expect(() => validatePrototypeProject(p)).toThrow('版本不一致');
  });
  it('requires re-export after changes to object/camera motion, timing or prompts', () => {
    const p = project(), before = canonicalJson(exportProjectSnapshot(p));
    p.name = 'display name only'; p.updatedAt = 'later';
    expect(canonicalJson(exportProjectSnapshot(p))).toBe(before);
    p.description += ' new action';
    expect(canonicalJson(exportProjectSnapshot(p))).not.toBe(before);
    p.camera = makePreset('camera', 'arc'); p.cameraClip = makeDefaultClip(p.camera);
    const camera = canonicalJson(exportProjectSnapshot(p));
    p.camera.samples[1].position[0] += .1;
    expect(canonicalJson(exportProjectSnapshot(p))).not.toBe(camera);
    p.objects[0].motion = 'trajectory';
    p.objects[0].trajectory = makePreset('object', 'slide', p.objects[0]);
    p.objects[0].clip = makeDefaultClip(p.objects[0].trajectory);
    const motion = canonicalJson(exportProjectSnapshot(p));
    p.objects[0].initialPose.position[0] += 1;
    expect(canonicalJson(exportProjectSnapshot(p))).not.toBe(motion);
  });
  it('compares source identity independently of object key order', () => {
    expect(canonicalJson({ b: 1, a: { c: 2, d: 3 } })).toBe(canonicalJson({ a: { d: 3, c: 2 }, b: 1 }));
    expect(canonicalJson({ ids: ['a', 'b'] })).not.toBe(canonicalJson({ ids: ['b', 'a'] }));
  });
  it('keeps old local scripts and changes only explicitly opted-in global profiles', () => {
    const state = project().generation;
    state.projectProfiles[0].useGlobalExecution = undefined;
    const local = state.projectProfiles[0].execution.scriptContent;
    const global = { revision: 3, scriptName: 'shared.gpu', scriptContent: '#!/bin/bash\nexec "$@"\n' };
    expect(applyGlobalExecution(state, global).projectProfiles[0].execution.scriptContent).toBe(local);
    state.projectProfiles[0].useGlobalExecution = true;
    const effective = applyGlobalExecution(state, global);
    expect(effective.projectProfiles[0].execution.scriptContent).toBe(global.scriptContent);
    expect(state.projectProfiles[0].execution.scriptContent).toBe(local);
    expect(effective.projectProfiles[0].execution.envName).toBe(state.projectProfiles[0].execution.envName);
  });
  it('rejects re-owned or duplicate pending submissions on backup import', () => {
    const p = project(), workflow = p.workflow!;
    const pending: WorkflowRequest = { version: 1, requestId: 'request-1', createdAt: '2026-09-09T00:00:00Z',
      projectId: p.id, projectName: p.name, kind: 'sam2', inputs: { referenceAssetId: workflow.referenceAssetId },
      options: { points: [[1, 1, 1]] }, execution: p.generation.projectProfiles[0].execution };
    workflow.pending = [pending];
    expect(validateWorkflowState(workflow, p.id)?.pending[0]).toEqual(pending);
    expect(() => validateWorkflowState(workflow, 'other-project')).toThrow('项目');
    workflow.pending.push(pending);
    expect(() => validateWorkflowState(workflow, p.id)).toThrow('重复');
  });
});
