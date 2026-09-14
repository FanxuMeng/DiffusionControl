import { DEFAULT_MOVE_SPEED } from './navigationSpeed';
import { createGenerationState, repairLegacyEnvironments, validateGenerationState } from './generation/domain';
import { validateMotionControls } from './workflow/motionControls';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { CameraCalibration, CameraIntrinsicsTrack, ControlSettings, Face, MigrationResult, MotionClip, Pose, Project, Quat, Sample, SceneObject, Trajectory, Vec3 } from './types';
import { createCameraIntrinsics, createDefaultCalibration, deriveFov, exportCameraIntrinsics, validateCameraCalibration, validateCameraIntrinsics } from './cameraMath';
import { exportClip, makeDefaultClip, sampleSourceTrajectory, validateClip } from './timelineModel';
import { makeTrajectoryPreview } from './trajectoryPreview';
import { validateWorkflowState } from './workflow/state';
export * from './cameraMath';
export * from './timelineModel';
export { makeTrajectoryPreview } from './trajectoryPreview';

export const DEFAULT_SETTINGS: ControlSettings = {
  moveSpeed: DEFAULT_MOVE_SPEED,
  rollSpeed: 45, sensitivity: 0.12, pointSize: 0.018,
};

export const DEMO_SCENE_REVISION = 2;

export const PRESET_OPTIONS = [
  { key: 'slide', name: '直线推进', description: '沿直线平移，平滑起步与停止' },
  { key: 'arc', name: '弧线运动', description: '沿柔和弧线移动，并逐渐转向' },
  { key: 'rise', name: '垂直升起', description: '沿世界上方向升高，保持朝向' },
  { key: 'orbit', name: '环绕运动', description: '沿水平圆弧环绕，同步改变朝向' },
] as const;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const copyPose = (pose: Pose): Pose => ({ position: [...pose.position], quaternion: [...pose.quaternion] });
const faceNormals: Record<Face, Vec3> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0],
  '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
};

/** Object local +X is its selected front; local +Z is projected world up.
 * For ±Y fronts the projection degenerates, so world +Z is the up seed.
 * These are canonical OpenCV world poses, never Three.js viewer poses.
 */
export function frontPose(object: SceneObject, face: Face): Pose {
  const x = new Vector3(...faceNormals[face]).applyQuaternion(new Quaternion(...(object.boxQuaternion || [0, 0, 0, 1])));
  const z = new Vector3(0, -1, 0).addScaledVector(x, x.y);
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  const y = new Vector3().crossVectors(z, x).normalize();
  const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
  return { position: [...object.center], quaternion: quaternion.toArray() as Quat };
}

function demoObject(id: string, name: string, shape: SceneObject['shape'], center: Vec3, halfExtents: Vec3, color: string, segmented = false, front: Face | null = null): SceneObject {
  const object: SceneObject = {
    id, name, color, prompt: '', shape, center, halfExtents, segmented, front,
    initialPose: { position: [...center], quaternion: [0, 0, 0, 1] },
    motion: 'unassigned', trajectory: null, clip: null, history: [],
  };
  object.initialPose = frontPose(object, front ?? '+x');
  return object;
}

function demoHumanoid(scene: NonNullable<Project['demoScene']>, id = 'humanoid'): SceneObject {
  const center: Vec3 = scene === 'studio' ? [-2.65, 0.45, 5.25] : [-1.8, 0.45, 5.2];
  const object = demoObject(id, '几何人物', 'humanoid', center, [0.45, 1.05, 0.27], '#78b9c8', true);
  object.motion = 'static';
  object.prompt = '球形头部与方块躯干、四肢构成的几何人物，保持整体结构与材质一致';
  return object;
}

export function createDemoProjects(): Project[] {
  const chair = demoObject('chair', '休闲椅', 'chair', [-1.35, 0.65, 4.6], [0.55, 0.85, 0.55], '#a1dfbb', true);
  chair.prompt = '一把自然转动的休闲椅，保持材质与结构一致';
  const plant = demoObject('plant', '琴叶榕', 'plant', [1.5, 0.2, 6], [0.55, 1.2, 0.55], '#d9a7ff', true, '+x');
  plant.motion = 'static';
  plant.prompt = '室内绿植，叶片与花盆保持静止';
  const table = demoObject('table', '圆桌', 'table', [0.3, 0.95, 5.5], [0.7, 0.5, 0.7], '#f3c383');
  const studioCalibration = createDefaultCalibration(), galleryCalibration = createDefaultCalibration();
  return [
    {
      id: 'studio_01', name: '日光工作室', description: 'SUNLIT STUDIO', parentPath: '/projects',
      reference: null, demoScene: 'studio', demoSceneRevision: DEMO_SCENE_REVISION, objects: [chair, plant, table, demoHumanoid('studio')], geometryReady: true,
      fourD: 'missing', camera: null, cameraHistory: [], duration: 5, fps: 16, updatedAt: now(),
      referenceCamera: studioCalibration, cameraIntrinsics: createCameraIntrinsics(studioCalibration), cameraClip: null,
      generation: createGenerationState(),
    },
    {
      id: 'gallery_02', name: '形态实验室', description: 'FORM LABORATORY', parentPath: '/projects',
      reference: null, demoScene: 'gallery', demoSceneRevision: DEMO_SCENE_REVISION,
      objects: [demoObject('sculpture', '球体雕塑', 'sphere', [0, 0.2, 5], [0.8, 0.8, 0.8], '#a3c6ff'), demoHumanoid('gallery')],
      geometryReady: true, fourD: 'missing', camera: null, cameraHistory: [], duration: 5, fps: 16, updatedAt: now(),
      referenceCamera: galleryCalibration, cameraIntrinsics: createCameraIntrinsics(galleryCalibration), cameraClip: null,
      generation: createGenerationState(),
    },
  ];
}

export function createEmptyProject(name: string, parentPath: string): Project {
  if (!name.trim()) throw new Error('请输入项目名称。');
  if (!parentPath.trim()) throw new Error('请输入项目母路径。');
  return {
    id: newId('project'), name: name.trim(), description: 'NEW PROJECT', parentPath: parentPath.trim(),
    reference: null, demoScene: null, demoSceneRevision: null, objects: [], geometryReady: false, fourD: 'missing',
    camera: null, cameraHistory: [], duration: 5, fps: 16, updatedAt: now(),
    referenceCamera: null, cameraIntrinsics: null, cameraClip: null,
    generation: createGenerationState(),
  };
}

export function makePreset(kind: 'camera' | 'object', key: string, object?: SceneObject, duration = 5, lens?: CameraIntrinsicsTrack): Trajectory {
  if (kind === 'object' && !object) throw new Error('请先选择要应用轨迹的物体。');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('轨迹时长必须大于 0 且不超过 600 秒。');
  const selectedKey = key === 'dolly' ? 'slide' : key;
  const option = PRESET_OPTIONS.find(item => item.key === selectedKey);
  if (!option) throw new Error('未知轨迹预设。');
  const initial: Pose = kind === 'object' ? copyPose(object!.initialPose) : { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const samples: Sample[] = [];
  const count = Math.max(2, Math.ceil(duration * 60));
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    const u = t * t * (3 - 2 * t);
    let offset: Vec3 = [0, 0, 0];
    let yaw = 0;
    if (selectedKey === 'slide') offset = kind === 'camera' ? [0, 0, 1.8 * u]
      : new Vector3(1.5 * u, 0, 0).applyQuaternion(new Quaternion(...initial.quaternion)).toArray() as Vec3;
    if (selectedKey === 'rise') offset = [0, -1.5 * u, 0];
    if (selectedKey === 'arc' || selectedKey === 'orbit') {
      const angle = u * (selectedKey === 'arc' ? Math.PI / 3 : Math.PI * 1.5);
      const radius = kind === 'camera' ? 4 : 0.8;
      offset = kind === 'camera' ? [radius * Math.sin(angle), 0, radius * (1 - Math.cos(angle))]
        : new Vector3(radius * Math.sin(angle), radius * (1 - Math.cos(angle)), 0).applyQuaternion(new Quaternion(...initial.quaternion)).toArray() as Vec3;
      yaw = -angle;
    }
    const rotation = kind === 'camera'
      ? new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      : new Quaternion(...initial.quaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -yaw));
    rotation.normalize();
    samples.push({
      t: duration * t,
      position: initial.position.map((value, axis) => value + offset[axis]) as Vec3,
      quaternion: rotation.toArray().map(component => component === 0 ? 0 : component) as Quat,
    });
  }
  const cameraIntrinsics = kind === 'camera' ? structuredClone(lens ?? createCameraIntrinsics()) : undefined;
  return {
    id: newId('trajectory'), revision: 1, name: `${kind === 'camera' ? '相机' : object!.name} · ${option.name}`, kind,
    samples, duration, preview: makeTrajectoryPreview(samples, kind === 'camera' ? '#a7c7fa' : object!.color, { kind, cameraIntrinsics }),
    ...(cameraIntrinsics ? { cameraIntrinsics } : {}),
    createdAt: now(), source: 'preset',
  };
}

/** Source-local interpolation; project playback uses sampleClip instead. */
export function sampleTrajectory(trajectory: Trajectory, time: number): Pose {
  return sampleSourceTrajectory(trajectory, Number.isFinite(time) ? time : 0);
}

export function exportTrajectory(trajectory: Trajectory, clip?: MotionClip) {
  if (trajectory.kind === 'camera' && !trajectory.cameraIntrinsics) throw new Error('相机轨迹缺少镜头快照，无法准确导出。');
  return {
    schema_version: '0.2.0-draft', trajectory_id: trajectory.id, name: trajectory.name, revision: trajectory.revision,
    kind: trajectory.kind, coordinate_frame: 'reference_camera_opencv', length_unit: 'scene_unit', time_unit: 'seconds',
    duration_seconds: trajectory.duration, rotation_representation: 'quaternion', quaternion_order: 'xyzw',
    interpolation: { position: 'linear', rotation: 'slerp' },
    source: { kind: trajectory.source, application: 'diffusion-control-prototype' }, created_at: trajectory.createdAt,
    ...(trajectory.kind === 'camera' ? { target_id: 'camera', camera_intrinsics: exportCameraIntrinsics(trajectory.cameraIntrinsics!) } : {}),
    ...(clip ? { clip: exportClip(clip) } : {}),
    samples: trajectory.samples.map(sample => ({ t_seconds: sample.t, position_world: [...sample.position], quaternion_xyzw: [...sample.quaternion] })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numericVector(value: unknown, size: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== size || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error(`${label} 必须是包含 ${size} 个有限数值的数组。`);
  }
  return [...value];
}

function legacyCalibration(raw: unknown): CameraCalibration {
  const data = record(raw);
  if (!data) throw new Error('旧版相机标定格式无效。');
  if (data.fov && data.distortion && (data.id || data.calibration_id)) return validateCameraCalibration(data);
  const width = data.imageWidth ?? data.image_width, height = data.imageHeight ?? data.image_height;
  if (!Array.isArray(data.intrinsic) || data.intrinsic.length !== 3 || typeof width !== 'number' || typeof height !== 'number') throw new Error('旧镜头缺少完整 K 与图像尺寸。');
  const intrinsic = data.intrinsic.map(row => numericVector(row, 3, '旧镜头 K')) as CameraCalibration['intrinsic'];
  const oldDistortion = record(data.distortion);
  const knownPrototype = typeof data.source === 'string' && data.source.includes('prototype');
  if (!oldDistortion && !knownPrototype) throw new Error('旧镜头未声明畸变，不能自动假定为零；请补全标定。');
  const coefficients = oldDistortion?.coefficients;
  const assumedNone = knownPrototype || oldDistortion?.state === 'assumed_none';
  const distortion = oldDistortion?.model ? oldDistortion : {
    model: 'none', coefficient_order: ['k1', 'k2', 'p1', 'p2', 'k3'],
    coefficients: assumedNone && (!Array.isArray(coefficients) || coefficients.length === 0) ? [0, 0, 0, 0, 0] : coefficients,
    state: 'assumed',
  };
  return validateCameraCalibration({
    id: data.id ?? data.calibration_id ?? newId('calibration'), revision: data.revision ?? 1,
    model: data.model ?? 'pinhole', imageWidth: width, imageHeight: height, pixelCenters: 'integer_coordinates',
    intrinsic, fov: deriveFov(intrinsic, width, height), distortion, source: data.source ?? 'legacy_import_declared',
  });
}

function importedLens(raw: unknown): CameraIntrinsicsTrack {
  const data = record(raw);
  if (!data) throw new Error('相机镜头参数格式错误。');
  if (data.calibration) return validateCameraIntrinsics(data);
  if (data.mode !== undefined && data.mode !== 'fixed') throw new Error('本版仅支持固定镜头。');
  return createCameraIntrinsics(legacyCalibration(data));
}

export function parseTrajectory(raw: unknown, kind: 'object' | 'camera', object?: SceneObject, fallbackCameraIntrinsics?: CameraIntrinsicsTrack): Trajectory {
  const data = record(raw);
  if (!data) throw new Error('轨迹 JSON 必须是对象。');
  if (data.kind !== kind) throw new Error(`请选择 ${kind === 'camera' ? 'camera 相机' : 'object 物体'} 类型的轨迹。`);
  const conventions = {
    coordinate_frame: 'reference_camera_opencv', length_unit: 'scene_unit', time_unit: 'seconds',
    rotation_representation: 'quaternion', quaternion_order: 'xyzw',
  };
  for (const [field, expected] of Object.entries(conventions)) {
    if (data[field] !== undefined && data[field] !== expected) throw new Error(`不兼容的 ${field}；此原型要求 ${expected}。`);
  }
  if (!Array.isArray(data.samples) || data.samples.length < 2 || data.samples.length > 100000) {
    throw new Error('轨迹必须包含 2 至 100000 个采样点。');
  }
  let previousTime = -1;
  const samples: Sample[] = data.samples.map((value, index) => {
    const sample = record(value);
    if (!sample) throw new Error(`第 ${index + 1} 个采样点格式错误。`);
    const t = sample.t_seconds ?? sample.t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t <= previousTime || (index === 0 && t !== 0)) {
      throw new Error('采样时间必须从 0 秒开始、非负且严格递增。');
    }
    previousTime = t;
    const position = numericVector(sample.position_world ?? sample.position, 3, '位置') as Vec3;
    const quaternion = numericVector(sample.quaternion_xyzw ?? sample.quaternion, 4, '四元数') as Quat;
    const magnitude = Math.hypot(...quaternion);
    if (Math.abs(magnitude - 1) > 0.002) throw new Error('姿态必须使用归一化四元数 [x, y, z, w]。');
    return { t, position, quaternion: quaternion.map(item => item / magnitude) as Quat };
  });
  const lastTime = samples[samples.length - 1].t;
  const duration = data.duration_seconds ?? data.duration ?? lastTime;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || Math.abs(duration - lastTime) > 1e-6) {
    throw new Error('轨迹时长必须与最后一个采样点的时间一致。');
  }
  if (kind === 'object' && !object) throw new Error('请先选择用于绑定轨迹的物体。');
  const expected: Pose = kind === 'camera' ? { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } : object!.initialPose;
  const distance = Math.hypot(...samples[0].position.map((value, axis) => value - expected.position[axis]));
  const dot = Math.abs(samples[0].quaternion.reduce((sum, value, axis) => sum + value * expected.quaternion[axis], 0));
  if (distance > 1e-5 || 1 - dot > 1e-6) {
    throw new Error(kind === 'camera'
      ? '相机轨迹必须从参考图相机位姿开始（位置 [0,0,0]、姿态 [0,0,0,1]），以兼容 SymphoMotion。'
      : '物体轨迹起点或朝向与当前 bbox 中心及所选正面不一致。请先在来源项目重新绑定；预设会自动对齐当前物体。');
  }
  let cameraIntrinsics: CameraIntrinsicsTrack | undefined;
  if (kind === 'camera') {
    const supplied = data.cameraIntrinsics ?? data.camera_intrinsics;
    if (supplied !== undefined) cameraIntrinsics = importedLens(supplied);
    else if (fallbackCameraIntrinsics) cameraIntrinsics = validateCameraIntrinsics(fallbackCameraIntrinsics);
    else throw new Error('相机轨迹缺少 K／FOV／畸变镜头参数，请明确选择沿用当前标定后再导入。');
  }
  const revision = data.revision ?? 1;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw new Error('轨迹版本必须是正整数。');
  return {
    id: newId('trajectory'), revision, name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '导入的轨迹',
    kind, samples, duration, preview: makeTrajectoryPreview(samples, kind === 'camera' ? '#a7c7fa' : object!.color, { kind, cameraIntrinsics }),
    ...(cameraIntrinsics ? { cameraIntrinsics } : {}),
    createdAt: now(), source: 'imported',
  };
}

function projectString(value: unknown, field: string, allowEmpty = false, maxLength = 10000): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`项目字段 ${field} 必须是${allowEmpty ? '' : '非空'}字符串，且不超过 ${maxLength} 个字符。`);
  }
  return value;
}

function projectArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`项目字段 ${field} 必须是数组，最多 ${maximum} 项。`);
  return value;
}

function projectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`项目字段 ${field} 必须是布尔值。`);
  return value;
}

function projectDate(value: unknown, field: string): string {
  const result = projectString(value, field, false, 100);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`项目字段 ${field} 必须是有效日期。`);
  return result;
}

function projectImage(value: unknown, field: string): string {
  const result = projectString(value, field, true, 30000000);
  if (result && !/^(data:image\/(?:png|jpeg|jpg|webp|gif|avif|svg\+xml)[;,]|https?:\/\/|blob:|\/api\/(?:workflow\/assets\/[a-f0-9]{64}\/image$|inference\/jobs\/[a-zA-Z0-9-]+\/outputs\/\d+$))/i.test(result)) {
    throw new Error(`项目字段 ${field} 必须是图片数据或有效的图片 URL。`);
  }
  return result;
}

function projectPose(value: unknown, field: string): Pose {
  const pose = record(value);
  if (!pose) throw new Error(`项目字段 ${field} 必须是位姿对象。`);
  const position = numericVector(pose.position, 3, `${field}.position`) as Vec3;
  const quaternion = numericVector(pose.quaternion, 4, `${field}.quaternion`) as Quat;
  const length = Math.hypot(...quaternion);
  if (Math.abs(length - 1) > 0.002) throw new Error(`项目字段 ${field} 必须使用归一化四元数。`);
  return { position, quaternion: quaternion.map(component => component / length) as Quat };
}

function projectTrajectory(value: unknown, kind: 'camera' | 'object', object?: SceneObject, historic = false): Trajectory {
  const data = record(value);
  if (!data) throw new Error('项目中的轨迹必须是对象。');
  let binding = object;
  // Historical object trajectories may belong to an older bbox/front. Preserve
  // those valid archives, but current trajectories must match the current pose.
  if (historic && kind === 'object' && object) {
    const first = Array.isArray(data.samples) ? data.samples[0] : undefined;
    binding = { ...object, initialPose: projectPose(first, '历史轨迹起点') };
  }
  const trajectory = parseTrajectory(data, kind, binding);
  if (trajectory.duration > 600) throw new Error('项目轨迹时长不能超过 600 秒。');
  if (!['recorded', 'preset', 'imported'].includes(String(data.source))) throw new Error('项目轨迹 source 字段无效。');
  const savedPreview = projectImage(data.preview, 'trajectory.preview');
  return {
    ...trajectory,
    id: projectString(data.id, 'trajectory.id', false, 200),
    name: projectString(data.name, 'trajectory.name', false, 200),
    preview: typeof document === 'undefined' ? savedPreview : trajectory.preview,
    source: data.source as Trajectory['source'],
    createdAt: projectDate(data.createdAt, 'trajectory.createdAt'),
    // Validation must not rewrite original capture samples on workspace reload.
    samples: projectArray(data.samples, 'trajectory.samples', 100000).map(value => {
      const sample = record(value);
      if (!sample || typeof sample.t !== 'number') throw new Error('原型轨迹采样必须使用 t 字段。');
      return { t: sample.t, position: numericVector(sample.position, 3, 'position') as Vec3, quaternion: numericVector(sample.quaternion, 4, 'quaternion') as Quat };
    }),
  };
}

function persistedClip(raw: unknown, trajectory: Trajectory, projectDuration: number): MotionClip {
  const clip = record(raw);
  const end = typeof clip?.start === 'number' && typeof clip?.duration === 'number' ? clip.start + clip.duration : projectDuration;
  // Legacy overflow remains visible for explicit correction rather than being discarded.
  return validateClip(raw, trajectory, Math.max(projectDuration, end));
}

function demoRevision(data: Record<string, unknown>): number | null {
  if (data.demoScene === null) {
    if (data.demoSceneRevision !== undefined && data.demoSceneRevision !== null) throw new Error('外部项目的 demoSceneRevision 必须为 null。');
    return null;
  }
  const revision = data.demoSceneRevision ?? 1;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw new Error('示例 demoSceneRevision 必须为正整数。');
  if (revision > DEMO_SCENE_REVISION) throw new Error('示例几何版本较新；请使用兼容版本打开，不能降级覆盖。');
  return revision;
}

/** Mutates only the caller's cloned payload. Generated images share the scene
 * revision, so both reference and masks must be rebuilt from the same geometry.
 * Object ordering is stable: point-cloud sampling seeds depend on that order.
 */
function upgradeDemoScene(data: Record<string, unknown>): boolean {
  if (data.demoScene !== 'studio' && data.demoScene !== 'gallery') return false;
  const revision = demoRevision(data)!;
  if (revision === DEMO_SCENE_REVISION) return false;
  const objects = projectArray(data.objects, 'objects', 100).map(value => {
    const object = record(value);
    if (!object) throw new Error('旧示例物体格式无效。');
    return object;
  });
  if (!objects.some(object => object.shape === 'humanoid')) {
    const ids = new Set(objects.map(object => object.id));
    let id = 'humanoid', suffix = 2;
    while (ids.has(id)) id = `humanoid_${suffix++}`;
    objects.push(demoHumanoid(data.demoScene, id) as unknown as Record<string, unknown>);
  }
  for (const object of objects) delete object.maskPreview;
  data.objects = objects;
  data.reference = null;
  data.demoSceneRevision = DEMO_SCENE_REVISION;
  if (data.fourD === 'ready') data.fourD = 'stale';
  return true;
}

/** Validate browser backups before exposing their contents to React or WebGL.
 * This accepts the prototype Project payload, not the server project schema.
 */
export function validatePrototypeProject(raw: unknown): Project {
  const data = record(raw);
  if (!data) throw new Error('原型项目必须是 JSON 对象。');
  const duration = data.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 600) {
    throw new Error('项目 duration 必须大于 0 且不超过 600 秒。');
  }
  const fps = data.fps;
  if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('项目 fps 必须是 1 至 120 的整数。');
  if (data.demoScene !== null && data.demoScene !== 'studio' && data.demoScene !== 'gallery') throw new Error('项目 demoScene 字段无效。');
  const demoSceneRevision = demoRevision(data);
  if (data.fourD !== 'missing' && data.fourD !== 'ready' && data.fourD !== 'stale') throw new Error('项目 fourD 状态无效。');
  const geometryReady = projectBoolean(data.geometryReady, 'geometryReady');
  const workflow = validateWorkflowState(data.workflow, String(data.id));
  if (geometryReady && data.demoScene === null && !workflow?.sceneJobId) throw new Error('外部点云需要有效的 CE 重建资产。');
  if (!geometryReady && data.fourD !== 'missing') throw new Error('没有有效 3D 几何时，4D 必须为 missing。');
  const referenceCamera = data.referenceCamera === null ? null : validateCameraCalibration(data.referenceCamera);
  const cameraIntrinsics = data.cameraIntrinsics === null ? null : validateCameraIntrinsics(data.cameraIntrinsics);
  const objects: SceneObject[] = projectArray(data.objects, 'objects', 100).map((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`项目第 ${index + 1} 个物体必须是对象。`);
    const id = projectString(item.id, 'object.id', false, 200);
    if (id === 'camera') throw new Error('物体 ID 不能使用保留名称 camera。');
    if (!['chair', 'plant', 'table', 'sphere', 'humanoid', 'pointcloud'].includes(String(item.shape))) throw new Error('项目物体 shape 字段无效。');
    if (item.front !== null && !Object.hasOwn(faceNormals, String(item.front))) throw new Error('项目物体 front 必须是六个轴向面之一或 null。');
    if (!['unassigned', 'static', 'trajectory'].includes(String(item.motion))) throw new Error('项目物体 motion 字段无效。');
    const color = projectString(item.color, 'object.color', false, 7);
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('项目物体 color 必须是六位十六进制颜色。');
    const center = numericVector(item.center, 3, 'object.center') as Vec3;
    const halfExtents = numericVector(item.halfExtents, 3, 'object.halfExtents') as Vec3;
    if (halfExtents.some(length => length <= 0)) throw new Error('物体包围盒半尺寸必须大于 0。');
    const initialPose = projectPose(item.initialPose, 'object.initialPose');
    if (new Vector3(...initialPose.position).distanceTo(new Vector3(...center)) > 1e-6) throw new Error('物体 initialPose 位置必须等于 bbox 中心。');
    const object: SceneObject = {
      id, name: projectString(item.name, 'object.name', false, 200),
      color, prompt: projectString(item.prompt, 'object.prompt', true), shape: item.shape as SceneObject['shape'],
      center, halfExtents, segmented: projectBoolean(item.segmented, 'object.segmented'), front: item.front as Face | null,
      initialPose, motion: item.motion as SceneObject['motion'], trajectory: null, clip: null, history: [],
      ...(item.maskPreview !== undefined ? { maskPreview: projectImage(item.maskPreview, 'object.maskPreview') } : {}),
    };
    if (item.boxQuaternion !== undefined) {
      object.boxQuaternion = projectPose({ position: center, quaternion: item.boxQuaternion }, 'object.boxQuaternion').quaternion;
    }
    if (item.reconstruction !== undefined) {
      const source = record(item.reconstruction);
      if (!source || typeof source.jobId !== 'string' || !/^[a-zA-Z0-9-]{1,200}$/.test(source.jobId) || source.sceneJobId !== workflow?.sceneJobId) throw new Error('物体点簇与场景版本不一致。');
      object.reconstruction = { jobId: source.jobId, sceneJobId: source.sceneJobId as string };
    }
    if (item.shape === 'pointcloud' && !object.reconstruction) throw new Error('点云物体缺少关联作业。');
    const expected = frontPose(object, object.front ?? '+x');
    if (new Quaternion(...initialPose.quaternion).angleTo(new Quaternion(...expected.quaternion)) > 1e-5) {
      throw new Error('物体 initialPose 朝向与所选正面不一致。');
    }
    if (!object.segmented && (object.front !== null || object.motion !== 'unassigned')) throw new Error('尚未分割的物体不能设置正面或运动。');
    if (object.motion === 'trajectory') {
      if (!geometryReady || !object.front) throw new Error('物体轨迹要求有效 3D 几何和已选正面。');
      object.trajectory = projectTrajectory(item.trajectory, 'object', object);
      object.clip = persistedClip(item.clip, object.trajectory, duration);
      const preview = makeTrajectoryPreview(object.trajectory.samples, object.color, { kind: 'object', clip: object.clip });
      if (preview) object.trajectory.preview = preview;
    } else if (item.trajectory !== null) throw new Error('静止或未定义运动的物体不能同时持有当前轨迹。');
    else if (item.clip !== null) throw new Error('没有运动轨迹时，物体 clip 必须为 null。');
    object.history = projectArray(item.history, 'object.history', 500).map(entry => projectTrajectory(entry, 'object', object, true));
    return object;
  });
  if (new Set(objects.map(object => object.id)).size !== objects.length) throw new Error('项目物体 ID 不能重复。');
  if (data.fourD === 'ready' && objects.some(object => object.segmented && object.motion === 'unassigned')) throw new Error('4D 就绪状态要求所有已分割物体明确运动或静止。');
  const camera = data.camera === null ? null : projectTrajectory(data.camera, 'camera');
  if (camera && !geometryReady) throw new Error('相机轨迹要求有效的 3D 几何。');
  const cameraClip = camera ? persistedClip(data.cameraClip, camera, duration) : null;
  if (!camera && data.cameraClip !== null) throw new Error('没有相机轨迹时，cameraClip 必须为 null。');
  if (camera && JSON.stringify(camera.cameraIntrinsics) !== JSON.stringify(cameraIntrinsics)) throw new Error('项目当前镜头与相机轨迹快照的 ID、版本或参数不一致。');
  if (camera && cameraClip) {
    const preview = makeTrajectoryPreview(camera.samples, '#a7c7fa', { kind: 'camera', clip: cameraClip, cameraIntrinsics: camera.cameraIntrinsics });
    if (preview) camera.preview = preview;
  }
  return {
    id: projectString(data.id, 'id', false, 200), name: projectString(data.name, 'name', false, 200),
    description: projectString(data.description, 'description', true), parentPath: projectString(data.parentPath, 'parentPath', false, 4096),
    reference: data.reference === null ? null : projectImage(data.reference, 'reference'),
    demoScene: data.demoScene, demoSceneRevision, objects, geometryReady, fourD: data.fourD, camera,
    referenceCamera, cameraIntrinsics, cameraClip,
    cameraHistory: projectArray(data.cameraHistory, 'cameraHistory', 500).map(entry => projectTrajectory(entry, 'camera')),
    duration, fps, updatedAt: projectDate(data.updatedAt, 'updatedAt'),
    generation: data.generation === undefined ? createGenerationState() : repairLegacyEnvironments(validateGenerationState(data.generation)),
    ...(data.motionControls !== undefined ? { motionControls: validateMotionControls(data.motionControls) } : {}),
    ...(workflow ? { workflow } : {}),
  };
}

/** Pure migration: callers preserve the original storage payload before saving
 * upgrades, including geometry-only upgrades within workspace version 2.
 */
export function migratePrototypeWorkspace(raw: unknown, sourceVersion: number): MigrationResult {
  const envelope = record(raw);
  const detectedVersion = typeof envelope?.version === 'number' ? envelope.version : sourceVersion;
  const result: MigrationResult = { projects: [], issues: [], sourceVersion: detectedVersion, targetVersion: 2 };
  if (detectedVersion !== 1 && detectedVersion !== 2) {
    result.issues.push({ projectId: null, code: 'UNSUPPORTED_VERSION', message: '工作区版本不受支持；原始数据必须保留。' });
    return result;
  }
  const entries = Array.isArray(raw) ? raw : Array.isArray(envelope?.projects) ? envelope.projects : envelope?.project ? [envelope.project] : null;
  if (!entries) {
    result.issues.push({ projectId: null, code: 'INVALID_WORKSPACE', message: '工作区必须包含项目数组。' });
    return result;
  }
  for (const entry of entries) {
    const original = record(entry);
    const projectId = typeof original?.id === 'string' ? original.id : null;
    const projectName = typeof original?.name === 'string' ? original.name : projectId ?? '未知项目';
    try {
      if (!original) throw new Error('项目必须是对象。');
      const data = structuredClone(original);
      if (detectedVersion === 1) {
        const knownDemo = data.demoScene === 'studio' || data.demoScene === 'gallery';
        const previousReference = data.referenceCamera ?? data.reference_camera;
        const referenceCamera = previousReference ? legacyCalibration(previousReference) : knownDemo ? createDefaultCalibration('legacy_prototype_default') : null;
        data.referenceCamera = referenceCamera;
        let currentLens = data.cameraIntrinsics ? importedLens(data.cameraIntrinsics) : referenceCamera ? createCameraIntrinsics(referenceCamera) : null;
        const historicalFallback = knownDemo ? createCameraIntrinsics(createDefaultCalibration('legacy_prototype_default')) : currentLens;
        const upgradeTrajectory = (value: unknown, kind: 'object' | 'camera', fallbackLens = currentLens): Record<string, unknown> => {
          const trajectory = record(value);
          if (!trajectory) throw new Error('旧轨迹格式无效。');
          const upgraded: Record<string, unknown> = { ...trajectory, revision: trajectory.revision ?? 1 };
          if (kind === 'camera') {
            const previousLens = trajectory.cameraIntrinsics ?? trajectory.camera_intrinsics;
            if (previousLens) upgraded.cameraIntrinsics = importedLens(previousLens);
            else if (fallbackLens) upgraded.cameraIntrinsics = structuredClone(fallbackLens);
            else throw new Error('旧相机轨迹没有镜头标定，且来源不是已知示例；请先补全标定。');
          }
          return upgraded;
        };
        data.objects = projectArray(data.objects, 'objects', 100).map(value => {
          const object = record(value);
          if (!object) throw new Error('旧物体格式无效。');
          const trajectory = object.trajectory ? upgradeTrajectory(object.trajectory, 'object') : null;
          return {
            ...object, trajectory,
            clip: trajectory ? object.clip ?? makeDefaultClip(trajectory as unknown as Trajectory) : null,
            history: projectArray(object.history, 'history', 500).map(item => upgradeTrajectory(item, 'object')),
          };
        });
        const camera = data.camera ? upgradeTrajectory(data.camera, 'camera') : null;
        if (camera?.cameraIntrinsics) currentLens = camera.cameraIntrinsics as CameraIntrinsicsTrack;
        data.camera = camera;
        data.cameraIntrinsics = currentLens;
        data.cameraClip = camera ? data.cameraClip ?? makeDefaultClip(camera as unknown as Trajectory) : null;
        data.cameraHistory = projectArray(data.cameraHistory, 'cameraHistory', 500).map(value => upgradeTrajectory(value, 'camera', historicalFallback));
        if (!referenceCamera && data.reference) result.issues.push({ projectId, code: 'REFERENCE_CALIBRATION_UNKNOWN', message: `「${projectName}」的外部首帧标定未知；未套用演示相机参数。` });
      }
      const demoUpdated = upgradeDemoScene(data);
      const project = validatePrototypeProject(data);
      const clips = [...project.objects.flatMap(object => object.clip ? [object.clip] : []), ...(project.cameraClip ? [project.cameraClip] : [])];
      if (clips.some(clip => clip.start + clip.duration > project.duration + 1e-7)) result.issues.push({ projectId, code: 'CLIP_OUTSIDE_TIMELINE', message: `「${projectName}」有片段超出公共时间轴；已保留原始时长，请扩展时间轴或主动调整片段。` });
      if (result.projects.some(existing => existing.id === project.id)) throw new Error('工作区包含重复项目 ID。');
      result.projects.push(project);
      if (demoUpdated) result.issues.push({ projectId, code: 'DEMO_SCENE_UPDATED', message: `「${projectName}」已升级人物示例几何；原对象、轨迹与镜头已保留，首帧和 mask 将按新几何重建。` });
    } catch (error) {
      result.issues.push({ projectId, code: 'PROJECT_REQUIRES_REPAIR', message: `「${projectName}」未载入：${error instanceof Error ? error.message : '结构无效'} 请保留原始内容以便修复。` });
    }
  }
  return result;
}

export function downloadJson(data: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
