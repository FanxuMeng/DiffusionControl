import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { createCameraIntrinsics, createDemoProjects, createEmptyProject, exportTrajectory, frontPose, makeDefaultClip, makePreset, parseTrajectory, PRESET_OPTIONS, sampleTrajectory, validatePrototypeProject } from './model';
import type { Face, Sample, Trajectory, Vec3 } from './types';

const chair = () => createDemoProjects()[0].objects[0];

describe('project geometry and semantic object orientation', () => {
  it('starts without pretending objects or 4D reconstruction are complete', () => {
    const demo = createDemoProjects()[0];
    expect(demo.fourD).toBe('missing');
    expect(demo.objects.find(object => object.id === 'chair')).toMatchObject({ segmented: true, front: null, motion: 'unassigned' });
    expect(demo.objects.find(object => object.id === 'plant')).toMatchObject({ front: '+x', motion: 'static' });
    expect(demo).toMatchObject({ demoSceneRevision: 2 });
    expect(demo.objects.find(object => object.id === 'humanoid')).toMatchObject({ shape: 'humanoid', segmented: true, front: null, motion: 'static', trajectory: null, clip: null, history: [] });
    const empty = createEmptyProject('  新项目  ', ' /projects ');
    expect(empty).toMatchObject({ name: '新项目', parentPath: '/projects', geometryReady: false, reference: null, fourD: 'missing', objects: [], demoSceneRevision: null });
    expect(() => createEmptyProject('', '/projects')).toThrow('名称');
    expect(() => createEmptyProject('名称', '')).toThrow('母路径');
  });

  it('maps local +X to every selected face, with a documented ±Y up fallback', () => {
    const normals: Record<Face, Vec3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    for (const [face, normal] of Object.entries(normals)) {
      const pose = frontPose(chair(), face as Face);
      const quaternion = new Quaternion(...pose.quaternion);
      expect(new Vector3(1, 0, 0).applyQuaternion(quaternion).distanceTo(new Vector3(...normal))).toBeLessThan(1e-10);
      const expectedUp = face.endsWith('y') ? new Vector3(0, 0, 1) : new Vector3(0, -1, 0);
      expect(new Vector3(0, 0, 1).applyQuaternion(quaternion).distanceTo(expectedUp)).toBeLessThan(1e-10);
      expect(pose.position).toEqual(chair().center);
      expect(quaternion.length()).toBeCloseTo(1, 12);
    }
  });
});

describe('preset binding and interpolation', () => {
  it('anchors every camera preset to the reference camera and records valid timed poses', () => {
    for (const { key } of PRESET_OPTIONS) {
      const trajectory = makePreset('camera', key);
      expect(trajectory.samples[0]).toEqual({ t: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
      expect(trajectory.samples.at(-1)?.t).toBe(5);
      trajectory.samples.forEach((sample, index) => {
        expect(Math.hypot(...sample.quaternion)).toBeCloseTo(1, 12);
        if (index) expect(sample.t).toBeGreaterThan(trajectory.samples[index - 1].t);
      });
      expect(parseTrajectory(exportTrajectory(trajectory), 'camera').duration).toBe(5);
    }
  });

  it('anchors object curves to their bbox and initial full orientation', () => {
    const object = chair();
    object.initialPose = frontPose(object, '-z');
    for (const { key } of PRESET_OPTIONS) {
      const trajectory = makePreset('object', key, object, 3);
      expect(trajectory.samples[0].position).toEqual(object.center);
      expect(new Quaternion(...trajectory.samples[0].quaternion).angleTo(new Quaternion(...object.initialPose.quaternion))).toBeCloseTo(0, 8);
      expect(parseTrajectory(exportTrajectory(trajectory), 'object', object).samples.length).toBe(trajectory.samples.length);
      if (key === 'arc' || key === 'orbit') expect(new Quaternion(...trajectory.samples.at(-1)!.quaternion).angleTo(new Quaternion(...object.initialPose.quaternion))).toBeGreaterThan(0.5);
    }
  });

  it('moves an object along its selected front and constructs curves in its local horizontal plane', () => {
    const object = chair(); object.front = '-z'; object.initialPose = frontPose(object, '-z');
    const slide = makePreset('object', 'slide', object);
    const end = slide.samples.at(-1)!.position;
    expect(end[0]).toBeCloseTo(object.center[0]);
    expect(end[1]).toBeCloseTo(object.center[1]);
    expect(end[2]).toBeCloseTo(object.center[2] - 1.5);
    const imported = parseTrajectory(exportTrajectory(slide), 'object', object);
    expect(imported.samples.at(-1)!.position).toEqual(end);
    const arc = makePreset('object', 'arc', object);
    expect(arc.samples.at(-1)!.position[1]).toBeCloseTo(object.center[1]);
    expect(arc.samples.at(-1)!.position[2]).toBeLessThan(object.center[2]);
    const rise = makePreset('object', 'rise', object);
    expect(rise.samples.at(-1)!.position[1]).toBeCloseTo(object.center[1] - 1.5);
  });

  it('interpolates in seconds and holds endpoint poses, including antipodal quaternion signs', () => {
    const trajectory: Trajectory = { id: 'test', revision: 1, name: 'test', kind: 'camera', samples: [
      { t: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      { t: 2, position: [2, 0, 0], quaternion: [0, 0, 0, -1] },
      { t: 5, position: [5, 3, 0], quaternion: [0, 1, 0, 0] },
    ], duration: 5, preview: '', source: 'recorded', createdAt: '' };
    expect(sampleTrajectory(trajectory, 1).position).toEqual([1, 0, 0]);
    expect(Math.abs(sampleTrajectory(trajectory, 1).quaternion[3])).toBeCloseTo(1);
    expect(sampleTrajectory(trajectory, 3.5).position).toEqual([3.5, 1.5, 0]);
    expect(sampleTrajectory(trajectory, -2).position).toEqual([0, 0, 0]);
    expect(sampleTrajectory(trajectory, 9).position).toEqual([5, 3, 0]);
  });
});

describe('trajectory import validation', () => {
  const valid = () => ({ kind: 'camera', cameraIntrinsics: createCameraIntrinsics(), samples: [
    { t: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    { t: 1, position: [0, 0, 1], quaternion: [0, 0, 0, 1] },
  ] as Sample[] });

  it('accepts both frontend and documented file fields without changing the poses', () => {
    expect(parseTrajectory(valid(), 'camera').samples).toEqual(valid().samples);
    const exported = exportTrajectory(makePreset('camera', 'slide'));
    expect(exported.coordinate_frame).toBe('reference_camera_opencv');
    expect(exported.quaternion_order).toBe('xyzw');
    expect(exported.samples[0]).toEqual({ t_seconds: 0, position_world: [0, 0, 0], quaternion_xyzw: [0, 0, 0, 1] });
    expect(exported.camera_intrinsics?.calibration).toMatchObject({ image_width: 1120, image_height: 700 });
    expect(exported.camera_intrinsics!.calibration.intrinsic[0][0]).toBeCloseTo(350 / Math.tan(27.5 * Math.PI / 180));
    expect(exportTrajectory(makePreset('object', 'slide', chair())).camera_intrinsics).toBeUndefined();
  });

  it('rejects incompatible coordinate systems, target kinds, and start poses', () => {
    expect(() => parseTrajectory({ ...valid(), coordinate_frame: 'threejs' }, 'camera')).toThrow('coordinate_frame');
    expect(() => parseTrajectory(valid(), 'object', chair())).toThrow('object');
    const camera = valid(); camera.samples[0].position[0] = 1;
    expect(() => parseTrajectory(camera, 'camera')).toThrow('参考图相机位姿');
    const object = makePreset('object', 'arc', chair());
    const other = chair(); other.center[0] += 1; other.initialPose = frontPose(other, '+x');
    expect(() => parseTrajectory(exportTrajectory(object), 'object', other)).toThrow('bbox 中心');
  });

  it('rejects duplicate, decreasing, nonzero-start and invalid timestamps', () => {
    for (const times of [[0, 0], [0, -1], [0.1, 1], [0, Number.NaN], [0, Infinity]]) {
      const data = valid(); data.samples.forEach((sample, index) => { sample.t = times[index]; });
      expect(() => parseTrajectory(data, 'camera')).toThrow('采样时间');
    }
    expect(() => parseTrajectory({ ...valid(), duration: 3 }, 'camera')).toThrow('最后一个采样点');
  });

  it('rejects malformed positions and non-unit rotations', () => {
    const data = valid(); data.samples[1].position[0] = Infinity;
    expect(() => parseTrajectory(data, 'camera')).toThrow('有限数值');
    const rotation = valid(); rotation.samples[1].quaternion = [0, 0, 0, 2];
    expect(() => parseTrajectory(rotation, 'camera')).toThrow('归一化');
    expect(() => parseTrajectory({ ...valid(), samples: [valid().samples[0]] }, 'camera')).toThrow('2 至');
  });
});

describe('prototype project input validation', () => {
  it('round-trips project backups while preserving trajectory identities and archive metadata', () => {
    const project = createDemoProjects()[0];
    const object = project.objects[0]; object.front = '+x';
    const archived = makePreset('object', 'arc', object);
    object.front = '-z'; object.initialPose = frontPose(object, '-z');
    object.motion = 'trajectory'; object.trajectory = makePreset('object', 'slide', object); object.clip = makeDefaultClip(object.trajectory); object.history = [archived];
    project.fourD = 'ready'; project.camera = makePreset('camera', 'arc', undefined, 5, project.cameraIntrinsics!); project.cameraClip = makeDefaultClip(project.camera);
    project.cameraHistory = [makePreset('camera', 'rise')];
    const validated = validatePrototypeProject(JSON.parse(JSON.stringify(project)));
    expect(validated.id).toBe(project.id);
    expect(validated.fourD).toBe('ready');
    const originals = [project.camera, project.cameraHistory[0], object.trajectory, object.history[0]];
    const restored = [validated.camera!, validated.cameraHistory[0], validated.objects[0].trajectory!, validated.objects[0].history[0]];
    originals.forEach((trajectory, index) => {
      expect(restored[index].id).toBe(trajectory.id);
      expect(restored[index].source).toBe(trajectory.source);
      expect(restored[index].createdAt).toBe(trajectory.createdAt);
      expect(restored[index].samples.length).toBe(trajectory.samples.length);
      trajectory.samples.forEach((sample, sampleIndex) => {
        const result = restored[index].samples[sampleIndex];
        expect(result.position).toEqual(sample.position);
        expect(result.t).toBe(sample.t);
        result.quaternion.forEach((component, axis) => expect(component).toBeCloseTo(sample.quaternion[axis], 12));
      });
    });
    expect(validatePrototypeProject(createEmptyProject('空项目', 'projects')).objects).toEqual([]);
  });

  it('rejects incomplete and non-finite project timeline data before rendering', () => {
    expect(() => validatePrototypeProject({ id: 'bad', objects: [] })).toThrow('duration');
    for (const duration of [0, -1, Infinity, Number.NaN, 601, '5']) {
      expect(() => validatePrototypeProject({ ...createDemoProjects()[0], duration })).toThrow('duration');
    }
    for (const fps of [0, 121, 1.5, '16']) {
      expect(() => validatePrototypeProject({ ...createDemoProjects()[0], fps })).toThrow('fps');
    }
    expect(() => validatePrototypeProject({ ...createDemoProjects()[0], cameraHistory: null })).toThrow('cameraHistory');
  });

  it('rejects invalid object geometry and conflicting target IDs', () => {
    const missing = createDemoProjects()[0];
    expect(() => validatePrototypeProject({ ...missing, objects: [{ id: 'bad' }] })).toThrow();
    const dimension = createDemoProjects()[0]; dimension.objects[0].halfExtents[1] = -1;
    expect(() => validatePrototypeProject(dimension)).toThrow('半尺寸');
    const position = createDemoProjects()[0]; position.objects[0].center[0] = Infinity;
    expect(() => validatePrototypeProject(position)).toThrow('有限数值');
    const origin = createDemoProjects()[0]; origin.objects[0].initialPose.position[0] += 1;
    expect(() => validatePrototypeProject(origin)).toThrow('bbox 中心');
    const duplicate = createDemoProjects()[0]; duplicate.objects[1].id = duplicate.objects[0].id;
    expect(() => validatePrototypeProject(duplicate)).toThrow('ID 不能重复');
    const reserved = createDemoProjects()[0]; reserved.objects[0].id = 'camera';
    expect(() => validatePrototypeProject(reserved)).toThrow('保留名称');
  });

  it('rejects false readiness and stale current bindings while allowing archived bindings', () => {
    expect(() => validatePrototypeProject({ ...createDemoProjects()[0], fourD: 'ready' })).toThrow('明确运动或静止');
    expect(() => validatePrototypeProject({ ...createEmptyProject('空项目', 'projects'), fourD: 'ready' })).toThrow('没有有效 3D');
    const project = createDemoProjects()[0]; const object = project.objects[0];
    object.front = '+x'; object.motion = 'trajectory'; object.trajectory = makePreset('object', 'arc', object);
    object.front = '-z'; object.initialPose = frontPose(object, '-z');
    expect(() => validatePrototypeProject(project)).toThrow('bbox 中心');
    object.history = [object.trajectory]; object.trajectory = null; object.motion = 'unassigned'; object.clip = null;
    expect(validatePrototypeProject(project).objects[0].history[0].id).toBe(object.history[0].id);
  });
});
