import { describe, expect, it } from 'vitest';
import { createCameraIntrinsics, createDefaultCalibration, deriveFov } from './cameraMath';
import { createDemoProjects, createEmptyProject, exportTrajectory, makeDefaultClip, makePreset, migratePrototypeWorkspace, parseTrajectory } from './model';
import type { Project } from './types';

function oldPayload(project: Project): Record<string, unknown> {
  const data = structuredClone(project) as unknown as Record<string, unknown>;
  delete data.referenceCamera; delete data.cameraIntrinsics; delete data.cameraClip;
  delete data.demoSceneRevision;
  data.objects = (data.objects as Record<string, unknown>[]).filter(object => object.shape !== 'humanoid');
  const stripTrajectory = (value: unknown) => {
    if (!value) return;
    const trajectory = value as Record<string, unknown>;
    delete trajectory.revision; delete trajectory.cameraIntrinsics;
  };
  for (const object of data.objects as Record<string, unknown>[]) {
    delete object.clip; stripTrajectory(object.trajectory);
    for (const historic of object.history as unknown[]) stripTrajectory(historic);
  }
  stripTrajectory(data.camera);
  for (const historic of data.cameraHistory as unknown[]) stripTrajectory(historic);
  return data;
}

function populated(): Project {
  const project = createDemoProjects()[0];
  const object = project.objects[0]; object.front = '+x'; object.motion = 'trajectory';
  object.trajectory = makePreset('object', 'arc', object, 3.25);
  object.history = [makePreset('object', 'rise', object)];
  project.camera = makePreset('camera', 'slide', undefined, 5, project.cameraIntrinsics!);
  project.cameraHistory = [makePreset('camera', 'rise', undefined, 5, project.cameraIntrinsics!)];
  return project;
}

describe('non-destructive browser workspace migration', () => {
  it('keeps source samples, history, identity and timestamps while creating independent clips', () => {
    const original = populated(), legacy = oldPayload(original), before = structuredClone(legacy);
    const result = migratePrototypeWorkspace([legacy], 1);
    expect(result.issues.map(issue => issue.code)).toEqual(['DEMO_SCENE_UPDATED']);
    expect(result.projects.length).toBe(1);
    const migrated = result.projects[0];
    expect(migrated.objects[0].clip).toMatchObject({ start: 0, duration: 3.25, trajectoryId: original.objects[0].trajectory!.id });
    expect(migrated.objects[0].trajectory!.samples).toEqual(original.objects[0].trajectory!.samples);
    expect(migrated.objects[0].trajectory!.createdAt).toBe(original.objects[0].trajectory!.createdAt);
    expect(migrated.objects[0].history[0].samples).toEqual(original.objects[0].history[0].samples);
    expect(migrated.camera!.samples).toEqual(original.camera!.samples);
    expect(migrated.camera!.source).toBe(original.camera!.source);
    expect(migrated.cameraClip?.duration).toBe(5);
    expect(migrated.referenceCamera?.source).toBe('legacy_prototype_default');
    expect(migrated.cameraIntrinsics).toEqual(migrated.camera!.cameraIntrinsics);
    expect(legacy).toEqual(before);
    const again = migratePrototypeWorkspace({ format: 'diffusioncontrol.prototype.workspace', version: 2, projects: result.projects }, 1);
    expect(again.projects).toEqual(result.projects);
    expect(again.issues).toEqual([]);
  });

  it('retains long source timing and reports overflow instead of silently stretching or dropping projects', () => {
    const legacy = oldPayload(populated()); legacy.duration = 2;
    const result = migratePrototypeWorkspace([legacy], 1);
    expect(result.projects.length).toBe(1);
    expect(result.projects[0].duration).toBe(2);
    expect(result.projects[0].objects[0].clip!.duration).toBe(3.25);
    expect(result.projects[0].cameraClip!.duration).toBe(5);
    expect(result.issues.map(issue => issue.code)).toContain('CLIP_OUTSIDE_TIMELINE');
  });

  it('preserves existing non-default calibration and refuses to invent external-image calibration', () => {
    const legacy = oldPayload(populated()), calibration = createDefaultCalibration();
    calibration.intrinsic[0][0] *= 1.2; calibration.intrinsic[1][1] *= 1.2;
    calibration.fov = deriveFov(calibration.intrinsic, calibration.imageWidth, calibration.imageHeight);
    calibration.distortion = { ...calibration.distortion, model: 'brown_conrady_5', coefficients: [.03, 0, .001, 0, 0] };
    const lens = createCameraIntrinsics(calibration);
    (legacy.camera as Record<string, unknown>).cameraIntrinsics = lens;
    const result = migratePrototypeWorkspace([legacy], 1);
    expect(result.projects[0].cameraIntrinsics).toEqual(lens);
    expect(result.projects[0].cameraHistory[0].cameraIntrinsics?.calibration.intrinsic).toEqual(createDefaultCalibration().intrinsic);
    const external = oldPayload(createEmptyProject('外部首帧', 'projects')); external.reference = 'data:image/png;base64,AA==';
    const unknown = migratePrototypeWorkspace([external], 1);
    expect(unknown.projects[0].referenceCamera).toBeNull();
    expect(unknown.issues.map(issue => issue.code)).toContain('REFERENCE_CALIBRATION_UNKNOWN');
  });

  it('reports repairable failures individually without mutating the original payload', () => {
    const original = [oldPayload(createDemoProjects()[0]), { id: 'bad', name: '缺字段' }];
    const before = structuredClone(original);
    const result = migratePrototypeWorkspace(original, 1);
    expect(result.projects.length).toBe(1);
    expect(result.issues).toContainEqual(expect.objectContaining({ projectId: 'bad', code: 'PROJECT_REQUIRES_REPAIR' }));
    expect(original).toEqual(before);
  });

  it('imports the saved lens instead of silently replacing it with the current lens', () => {
    const source = makePreset('camera', 'arc'), current = createCameraIntrinsics();
    source.cameraIntrinsics!.calibration.distortion = { ...source.cameraIntrinsics!.calibration.distortion, model: 'brown_conrady_5', coefficients: [.02, 0, .001, 0, 0] };
    const result = parseTrajectory(exportTrajectory(source), 'camera', undefined, current);
    expect(result.cameraIntrinsics).toEqual(source.cameraIntrinsics);
    const exported = exportTrajectory(source); delete (exported as { camera_intrinsics?: unknown }).camera_intrinsics;
    expect(() => parseTrajectory(exported, 'camera')).toThrow('缺少');
    expect(parseTrajectory(exported, 'camera', undefined, current).cameraIntrinsics).toEqual(current);
  });

  it('upgrades old v2 demos once while preserving every source track, clip, history and lens', () => {
    const legacy = populated();
    legacy.demoSceneRevision = 1;
    legacy.objects = legacy.objects.filter(object => object.shape !== 'humanoid');
    legacy.reference = 'data:image/png;base64,AA==';
    legacy.fourD = 'ready';
    legacy.cameraClip = { ...makeDefaultClip(legacy.camera!), start: 1, duration: 3, revision: 4 };
    legacy.objects[0].clip = { ...makeDefaultClip(legacy.objects[0].trajectory!), start: .5, duration: 2, revision: 3 };
    for (const object of legacy.objects) object.maskPreview = 'data:image/png;base64,AA==';
    const calibration = legacy.cameraIntrinsics!.calibration;
    calibration.intrinsic[0][0] *= 1.1;
    calibration.fov = deriveFov(calibration.intrinsic, calibration.imageWidth, calibration.imageHeight);
    calibration.distortion = { ...calibration.distortion, model: 'brown_conrady_5', coefficients: [.02, 0, .001, 0, 0] };
    legacy.camera!.cameraIntrinsics = structuredClone(legacy.cameraIntrinsics!);
    const before = structuredClone(legacy);
    const result = migratePrototypeWorkspace([legacy], 2);
    expect(result.issues.map(issue => issue.code)).toEqual(['DEMO_SCENE_UPDATED']);
    const project = result.projects[0];
    expect(project).toMatchObject({ demoSceneRevision: 2, reference: null, fourD: 'stale' });
    expect(project.objects.map(object => object.id)).toEqual(['chair', 'plant', 'table', 'humanoid']);
    expect(project.objects.at(-1)).toMatchObject({ shape: 'humanoid', segmented: true, front: null, motion: 'static', trajectory: null, clip: null });
    for (let index = 0; index < legacy.objects.length; index++) {
      const { maskPreview: ignored, ...original } = legacy.objects[index];
      void ignored;
      expect(project.objects[index]).toEqual(original);
    }
    expect(project.objects.every(object => object.maskPreview === undefined)).toBe(true);
    for (const field of ['camera', 'cameraClip', 'cameraHistory', 'referenceCamera', 'cameraIntrinsics', 'duration', 'fps', 'updatedAt'] as const) expect(project[field]).toEqual(legacy[field]);
    expect(legacy).toEqual(before);

    // Once regenerated images have been saved, another load must keep them.
    project.reference = 'data:image/png;base64,AQ==';
    for (const object of project.objects) object.maskPreview = 'data:image/png;base64,AQ==';
    const again = migratePrototypeWorkspace(result.projects, 2);
    expect(again.issues).toEqual([]);
    expect(again.projects).toEqual(result.projects);
  });

  it('recognizes missing demo revisions, avoids ID collisions and leaves external projects intact', () => {
    const legacy = structuredClone(createDemoProjects()[1]) as unknown as Record<string, unknown>;
    delete legacy.demoSceneRevision;
    const sphere = (legacy.objects as Record<string, unknown>[])[0];
    sphere.id = 'humanoid';
    legacy.objects = [sphere];
    const result = migratePrototypeWorkspace([legacy], 2);
    expect(result.projects[0].objects.map(object => [object.id, object.shape])).toEqual([['humanoid', 'sphere'], ['humanoid_2', 'humanoid']]);
    expect(migratePrototypeWorkspace(result.projects, 2).projects[0].objects).toHaveLength(2);

    const external = createEmptyProject('外部图片', 'projects');
    external.reference = 'data:image/png;base64,AA==';
    const migratedExternal = migratePrototypeWorkspace([external], 2);
    expect(migratedExternal.projects).toEqual([external]);
    expect(migratedExternal.issues).toEqual([]);
  });

  it('preserves an existing humanoid and refuses to downgrade future demo geometry', () => {
    const existing = createDemoProjects()[0]; existing.demoSceneRevision = 1;
    const object = existing.objects.at(-1)!;
    object.name = '我的人物'; object.prompt = '已编辑的提示词';
    const upgraded = migratePrototypeWorkspace([existing], 2);
    expect(upgraded.projects[0].objects.filter(item => item.shape === 'humanoid')).toEqual([object]);
    const future = createDemoProjects()[0]; future.demoSceneRevision = 3;
    const before = structuredClone(future);
    const result = migratePrototypeWorkspace([future], 2);
    expect(result.projects).toEqual([]);
    expect(result.issues[0]).toMatchObject({ code: 'PROJECT_REQUIRES_REPAIR' });
    expect(result.issues[0].message).toContain('不能降级');
    expect(future).toEqual(before);
  });
});
