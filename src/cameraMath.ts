import type { CameraCalibration, CameraIntrinsicsTrack, Mat3, Vec2, Vec3 } from './types';

const uid = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const fields = ['k1', 'k2', 'p1', 'p2', 'k3'] as const;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数值。`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  return value;
}
function revision(value: unknown): number {
  const result = number(value, '版本');
  if (!Number.isInteger(result) || result < 1) throw new Error('版本必须是正整数。');
  return result;
}

export function deriveFov(intrinsic: Mat3, width: number, height: number): CameraCalibration['fov'] {
  const fx = intrinsic[0][0], fy = intrinsic[1][1], cx = intrinsic[0][2], cy = intrinsic[1][2];
  return {
    horizontalDegrees: (Math.atan((cx + .5) / fx) + Math.atan((width - .5 - cx) / fx)) * 180 / Math.PI,
    verticalDegrees: (Math.atan((cy + .5) / fy) + Math.atan((height - .5 - cy) / fy)) * 180 / Math.PI,
    derivedFrom: 'intrinsic_and_image_bounds',
  };
}

export function createDefaultCalibration(source = 'prototype_reference_camera'): CameraCalibration {
  const f = 350 / Math.tan(27.5 * Math.PI / 180);
  const intrinsic: Mat3 = [[f, 0, 559.5], [0, f, 349.5], [0, 0, 1]];
  return {
    id: uid('calibration'), revision: 1, model: 'pinhole', imageWidth: 1120, imageHeight: 700,
    pixelCenters: 'integer_coordinates', intrinsic, fov: deriveFov(intrinsic, 1120, 700),
    distortion: { model: 'none', coefficientOrder: [...fields], coefficients: [0, 0, 0, 0, 0], state: 'assumed' }, source,
  };
}

export function createCameraIntrinsics(calibration: CameraCalibration = createDefaultCalibration()): CameraIntrinsicsTrack {
  return { id: uid('lens'), revision: 1, mode: 'fixed', timeDomain: 'trajectory_local_seconds', calibration: structuredClone(calibration) };
}

export function validateCameraCalibration(raw: unknown): CameraCalibration {
  const data = object(raw, '相机标定');
  const imageWidth = number(data.imageWidth ?? data.image_width, '图像宽度');
  const imageHeight = number(data.imageHeight ?? data.image_height, '图像高度');
  if (![imageWidth, imageHeight].every(value => Number.isInteger(value) && value > 0 && value <= 16384)) throw new Error('标定图像宽高必须是 1 至 16384 的整数。');
  if (data.model !== 'pinhole') throw new Error('本版仅支持 pinhole 投影模型。');
  if ((data.pixelCenters ?? data.pixel_centers) !== 'integer_coordinates') throw new Error('像素中心约定必须是 integer_coordinates。');
  if (!Array.isArray(data.intrinsic) || data.intrinsic.length !== 3 || data.intrinsic.some(row => !Array.isArray(row) || row.length !== 3)) throw new Error('相机 K 必须是 3×3 矩阵。');
  const intrinsic = data.intrinsic.map(row => (row as unknown[]).map(value => number(value, 'K 矩阵元素'))) as Mat3;
  if (intrinsic[0][0] <= 0 || intrinsic[1][1] <= 0) throw new Error('相机焦距 fx / fy 必须大于 0。');
  if (Math.abs(intrinsic[0][1]) > 1e-9 || Math.abs(intrinsic[1][0]) > 1e-9 || Math.abs(intrinsic[2][0]) > 1e-9 || Math.abs(intrinsic[2][1]) > 1e-9 || Math.abs(intrinsic[2][2] - 1) > 1e-9) throw new Error('本版要求无 skew 的标准 K，最后一行为 [0,0,1]。');
  if (intrinsic[0][2] <= -.5 || intrinsic[0][2] >= imageWidth - .5 || intrinsic[1][2] <= -.5 || intrinsic[1][2] >= imageHeight - .5) throw new Error('相机主点必须位于标定图像内。');
  const fov = deriveFov(intrinsic, imageWidth, imageHeight);
  if (fov.horizontalDegrees < 1 || fov.horizontalDegrees >= 170 || fov.verticalDegrees < 1 || fov.verticalDegrees >= 170) throw new Error('针孔水平和垂直 FOV 必须在 1° 至 170° 之间。');
  const givenFov = object(data.fov, 'FOV');
  if ((givenFov.derivedFrom ?? givenFov.derived_from) !== 'intrinsic_and_image_bounds') throw new Error('FOV 必须由 K 与图像边界派生。');
  if (Math.abs(number(givenFov.horizontalDegrees ?? givenFov.horizontal_degrees, '水平 FOV') - fov.horizontalDegrees) > 1e-5 || Math.abs(number(givenFov.verticalDegrees ?? givenFov.vertical_degrees, '垂直 FOV') - fov.verticalDegrees) > 1e-5) throw new Error('保存的 FOV 与 K 或图像尺寸不一致。');
  const distortion = object(data.distortion, '畸变');
  if (distortion.model !== 'none' && distortion.model !== 'brown_conrady_5') throw new Error('本版畸变模型仅支持 none 或 brown_conrady_5。');
  const order = distortion.coefficientOrder ?? distortion.coefficient_order;
  if (!Array.isArray(order) || order.length !== 5 || fields.some((field, index) => order[index] !== field)) throw new Error('畸变系数顺序必须是 k1,k2,p1,p2,k3。');
  if (!Array.isArray(distortion.coefficients) || distortion.coefficients.length !== 5) throw new Error('畸变必须包含五个系数。');
  const coefficients = distortion.coefficients.map(value => number(value, '畸变系数')) as CameraCalibration['distortion']['coefficients'];
  if (distortion.model === 'none' && coefficients.some(value => value !== 0)) throw new Error('none 畸变模型的五个系数必须全部为 0。');
  if (!['assumed', 'estimated', 'calibrated'].includes(String(distortion.state))) throw new Error('畸变状态必须注明 assumed / estimated / calibrated。');
  const calibration: CameraCalibration = {
    id: string(data.id ?? data.calibration_id, '标定 ID'), revision: revision(data.revision), model: 'pinhole',
    imageWidth, imageHeight, pixelCenters: 'integer_coordinates', intrinsic, fov,
    distortion: { model: distortion.model, coefficientOrder: [...fields], coefficients, state: distortion.state as CameraCalibration['distortion']['state'] },
    source: string(data.source, '标定来源'),
  };
  validateProjectionDomain(calibration);
  return calibration;
}

export function validateCameraIntrinsics(raw: unknown, _sourceDuration?: number): CameraIntrinsicsTrack {
  const data = object(raw, '镜头参数');
  if (data.mode !== 'fixed' || (data.keyframes !== undefined && (!Array.isArray(data.keyframes) || data.keyframes.length > 0))) throw new Error('本版每条轨迹只支持固定镜头，不支持动态镜头关键帧。');
  if ((data.timeDomain ?? data.time_domain) !== 'trajectory_local_seconds') throw new Error('镜头时间约定必须为 trajectory_local_seconds。');
  return {
    id: string(data.id ?? data.intrinsics_id, '镜头 ID'), revision: revision(data.revision), mode: 'fixed',
    timeDomain: 'trajectory_local_seconds', calibration: validateCameraCalibration(data.calibration),
  };
}

export function sampleCameraIntrinsics(track: CameraIntrinsicsTrack, _sourceTime: number): CameraCalibration { return track.calibration; }

export function distortNormalized(point: Vec2, distortion: CameraCalibration['distortion']): Vec2;
export function distortNormalized(x: number, y: number, distortion: CameraCalibration['distortion']): Vec2;
export function distortNormalized(point: Vec2 | number, second: CameraCalibration['distortion'] | number, third?: CameraCalibration['distortion']): Vec2 {
  const [x, y] = Array.isArray(point) ? point : [point, second as number];
  const distortion = (Array.isArray(point) ? second : third) as CameraCalibration['distortion'];
  if (distortion.model === 'none') return [x, y];
  const [k1, k2, p1, p2, k3] = distortion.coefficients;
  const r2 = x * x + y * y, radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
}

/** Invert the five-coefficient model with bounded Newton iterations. */
export function undistortNormalized([xd, yd]: Vec2, distortion: CameraCalibration['distortion']): Vec2 {
  if (!Number.isFinite(xd) || !Number.isFinite(yd)) throw new Error('反投影坐标必须是有限数值。');
  if (distortion.model === 'none') return [xd, yd];
  let x = xd, y = yd;
  const [k1, k2, p1, p2, k3] = distortion.coefficients;
  for (let iteration = 0; iteration < 40; iteration++) {
    const [px, py] = distortNormalized([x, y], distortion), ex = px - xd, ey = py - yd;
    if (Math.hypot(ex, ey) < 1e-10) return [x, y];
    const r2 = x * x + y * y, radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
    const derivative = k1 + 2 * k2 * r2 + 3 * k3 * r2 * r2;
    const j11 = radial + 2 * x * x * derivative + 2 * p1 * y + 6 * p2 * x;
    const j12 = 2 * x * y * derivative + 2 * p1 * x + 2 * p2 * y;
    const j22 = radial + 2 * y * y * derivative + 6 * p1 * y + 2 * p2 * x;
    const determinant = j11 * j22 - j12 * j12;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-14) break;
    const dx = (j22 * ex - j12 * ey) / determinant, dy = (j11 * ey - j12 * ex) / determinant;
    let accepted = false;
    for (let damping = 1; damping >= 1 / 128; damping /= 2) {
      const nx = x - dx * damping, ny = y - dy * damping;
      const [qx, qy] = distortNormalized([nx, ny], distortion);
      if (Math.hypot(qx - xd, qy - yd) < Math.hypot(ex, ey)) { x = nx; y = ny; accepted = true; break; }
    }
    if (!accepted) break;
  }
  throw new Error('当前畸变参数的逆投影未收敛，请减小畸变或检查标定。');
}

/** A conservative sampled validity gate for the viewport's supported lens domain. */
function validateProjectionDomain(calibration: CameraCalibration): void {
  if (calibration.distortion.model === 'none') return;
  const [k1, k2, p1, p2, k3] = calibration.distortion.coefficients;
  const k = calibration.intrinsic;
  for (let row = 0; row <= 8; row++) for (let column = 0; column <= 8; column++) {
    const xd = (column / 8 * calibration.imageWidth - .5 - k[0][2]) / k[0][0];
    const yd = (row / 8 * calibration.imageHeight - .5 - k[1][2]) / k[1][1];
    let x: number, y: number;
    try { [x, y] = undistortNormalized([xd, yd], calibration.distortion); }
    catch { throw new Error('畸变参数超出当前预览的可逆范围；图像边界逆投影未收敛。'); }
    const [px, py] = distortNormalized([x, y], calibration.distortion);
    const r2 = x * x + y * y, radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
    const derivative = k1 + 2 * k2 * r2 + 3 * k3 * r2 * r2;
    const j11 = radial + 2 * x * x * derivative + 2 * p1 * y + 6 * p2 * x;
    const j12 = 2 * x * y * derivative + 2 * p1 * x + 2 * p2 * y;
    const j22 = radial + 2 * y * y * derivative + 6 * p1 * y + 2 * p2 * x;
    const determinant = j11 * j22 - j12 * j12;
    if (Math.hypot(x, y) > 30 || !Number.isFinite(determinant) || j11 <= 1e-6 || determinant <= 1e-8 || Math.hypot(px - xd, py - yd) > 1e-7) throw new Error('畸变参数导致投影折叠或数值不稳定，请降低畸变强度。');
  }
}

export function pixelToCameraRay(pixel: Vec2, calibration: CameraCalibration): Vec3;
export function pixelToCameraRay(calibration: CameraCalibration, u: number, v: number): Vec3;
export function pixelToCameraRay(first: Vec2 | CameraCalibration, second: CameraCalibration | number, third?: number): Vec3 {
  const [u, v] = Array.isArray(first) ? first : [second as number, third as number];
  const calibration = (Array.isArray(first) ? second : first) as CameraCalibration;
  const k = calibration.intrinsic;
  const [x, y] = undistortNormalized([(u - k[0][2]) / k[0][0], (v - k[1][2]) / k[1][1]], calibration.distortion);
  const length = Math.hypot(x, y, 1);
  return [x / length, y / length, 1 / length];
}

export function cameraCompatibility(track: CameraIntrinsicsTrack | null, reference: CameraCalibration | null): string[] {
  if (!track) return ['当前尚无相机镜头参数。'];
  const warnings: string[] = [];
  const c = track.calibration;
  if (!reference) warnings.push('参考图标定未知，尚不能验证模型输入对齐。');
  else if (c.imageWidth !== reference.imageWidth || c.imageHeight !== reference.imageHeight || c.intrinsic.some((row, i) => row.some((value, j) => Math.abs(value - reference.intrinsic[i][j]) > 1e-6))) warnings.push('当前镜头 K 或输出尺寸与首帧标定不同；模型条件需进行投影适配。');
  if (c.distortion.coefficients.some(value => value !== 0)) warnings.push('当前镜头含非零畸变；SymphoMotion 导出仍需验证畸变适配。');
  return warnings;
}

export function speedColor(speed: number, maximumSpeed: number): string {
  const fraction = maximumSpeed > 0 && Number.isFinite(speed) ? Math.max(0, Math.min(1, speed / maximumSpeed)) : 0;
  const anchors = [[76, 172, 224], [234, 194, 106], [230, 106, 100]];
  const index = fraction < .5 ? 0 : 1, t = fraction < .5 ? fraction * 2 : fraction * 2 - 1;
  return '#' + anchors[index].map((value, channel) => Math.round(value + (anchors[index + 1][channel] - value) * t).toString(16).padStart(2, '0')).join('');
}

export function exportCameraCalibration(calibration: CameraCalibration) {
  return {
    calibration_id: calibration.id, revision: calibration.revision, model: calibration.model,
    image_width: calibration.imageWidth, image_height: calibration.imageHeight, pixel_centers: calibration.pixelCenters,
    intrinsic: structuredClone(calibration.intrinsic),
    fov: { horizontal_degrees: calibration.fov.horizontalDegrees, vertical_degrees: calibration.fov.verticalDegrees, derived_from: calibration.fov.derivedFrom },
    distortion: { model: calibration.distortion.model, coefficient_order: [...calibration.distortion.coefficientOrder], coefficients: [...calibration.distortion.coefficients], state: calibration.distortion.state },
    source: calibration.source,
  };
}
export function exportCameraIntrinsics(track: CameraIntrinsicsTrack) {
  return { intrinsics_id: track.id, revision: track.revision, mode: track.mode, time_domain: track.timeDomain, calibration: exportCameraCalibration(track.calibration) };
}
