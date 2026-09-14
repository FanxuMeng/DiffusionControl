import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { createDemoProjects, frontPose, makeDefaultClip, makePreset, validatePrototypeProject } from '../model';
import { createGenerationState, buildGenerationRequest, repairLegacyEnvironments, updateExecution } from '../generation/domain';
import { motionControls, setMotionControl, syncObjectControl } from './motionControls';
import { exportProjectSnapshot, sameExportSnapshot } from './snapshot';

function movingProject() {
  const project = createDemoProjects()[0];
  const object = project.objects.find(o => o.segmented)!;
  project.objects = [object]; object.motion = 'trajectory';
  object.trajectory = makePreset('object', 'slide', object); object.clip = makeDefaultClip(object.trajectory);
  object.reconstruction = { jobId: 'object-1', sceneJobId: 'scene-1' };
  project.workflow = { version: 1, referenceAssetId: 'a'.repeat(64), width: 832, height: 480, sceneJobId: 'scene-1', pending: [] };
  project.camera = makePreset('camera', 'arc'); project.cameraClip = makeDefaultClip(project.camera);
  return project;
}

describe('inference motion controls', () => {
  it('tolerates browser quaternion roundoff while rejecting changed motion, IDs and switches', () => {
    const original = exportProjectSnapshot(movingProject()), copy = structuredClone(original);
    copy.objects[0].initialPose.quaternion[0] += 1e-16;
    expect(sameExportSnapshot(original, copy)).toBe(true);
    copy.objects[0].initialPose.position[0] += 1e-5;
    expect(sameExportSnapshot(original, copy)).toBe(false);
    expect(sameExportSnapshot(original, { ...original, controls: { object: false, camera: true } })).toBe(false);
    expect(sameExportSnapshot(original, { ...original, cameraClip: { ...original.cameraClip, id: 'new' } })).toBe(false);
  });
  it('keeps disabled trajectories, exports fixed camera/no entities, and restores on enable', () => {
    const original = movingProject();
    expect(motionControls(original)).toEqual({ object: true, camera: true });
    const off = setMotionControl(setMotionControl(original, 'object', false), 'camera', false);
    expect(off.camera).toBe(original.camera); expect(off.objects).toBe(original.objects);
    const snapshot = exportProjectSnapshot(off);
    expect(snapshot.objects).toEqual([]); expect(snapshot.camera).toBeNull(); expect(snapshot.cameraClip).toBeNull();
    const restored = setMotionControl(setMotionControl(off, 'object', true), 'camera', true);
    expect(exportProjectSnapshot(restored)).toEqual(exportProjectSnapshot(original));
    expect(syncObjectControl(off.generation, false).submissions).toBe(off.generation.submissions);
  });
  it('enables newly applied trajectories and disables missing trajectories', () => {
    const off = setMotionControl(movingProject(), 'object', false);
    expect(motionControls(off).object).toBe(false);
    off.objects[0].trajectory = { ...off.objects[0].trajectory!, id: 'new-track' };
    expect(motionControls(off).object).toBe(true);
    off.objects[0].trajectory = null; off.objects[0].clip = null;
    expect(motionControls(off).object).toBe(false);
    expect(() => setMotionControl(off, 'object', true)).toThrow('轨迹');
  });
  it('repairs only legacy builtin draft environments, preserving pending request snapshots', () => {
    let state = createGenerationState(); const id = state.activeProfileIds[state.selectedModelId];
    expect(state.projectProfiles[0].execution.envName).toBe('symphomotion');
    state = updateExecution(state, id, { envName: 'base' });
    const request = buildGenerationRequest(state, id, { id: 'p', name: 'p' });
    state.submissions = [{ endpoint: 'http://localhost/api', request }];
    const repaired = repairLegacyEnvironments(state);
    expect(repaired.projectProfiles[0].execution.envName).toBe('symphomotion');
    expect(repaired.submissions).toBe(state.submissions);
    expect(repaired.submissions[0].request.execution!.envName).toBe('base');
    const customEnv = updateExecution(state, id, { envName: 'custom' });
    expect(repairLegacyEnvironments(customEnv)).toBe(customEnv);
  });
  it('round-trips an oriented box and resolves selected face in the box frame', () => {
    const project = createDemoProjects()[0], object = project.objects[0];
    object.boxQuaternion = new Quaternion().setFromAxisAngle(new Vector3(.2, .6, .5).normalize(), .7).toArray();
    object.front = '+z'; object.initialPose = frontPose(object, '+z');
    object.trajectory = null; object.clip = null; object.motion = 'static';
    const expected = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...object.boxQuaternion));
    const front = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...object.initialPose.quaternion));
    expect(front.distanceTo(expected)).toBeLessThan(1e-6);
    expect(validatePrototypeProject(JSON.parse(JSON.stringify(project))).objects[0].boxQuaternion).toEqual(object.boxQuaternion);
  });
});
