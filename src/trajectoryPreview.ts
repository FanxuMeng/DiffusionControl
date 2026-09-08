import { Quaternion, Vector3 } from 'three';
import { distortNormalized, pixelToCameraRay, speedColor } from './cameraMath';
import { clipKinematics, sampleSourceTrajectory } from './timelineModel';
import type { CameraIntrinsicsTrack, MotionClip, Sample, Trajectory, Vec3 } from './types';

export interface PreviewOptions { kind?: 'camera' | 'object'; cameraIntrinsics?: CameraIntrinsicsTrack; clip?: MotionClip }

/** Orthographic world-space plot. The image is derived from the same timed
 * poses, lens rays and speed scale as the interactive scene, never screen paths. */
export function makeTrajectoryPreview(samples: Sample[], color = '#327e65', options: PreviewOptions = {}): string {
  if (typeof document === 'undefined' || samples.length < 2) return '';
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
  const ctx = canvas.getContext('2d'); if (!ctx) return '';
  const duration = samples.at(-1)!.t, clip = options.clip;
  const playbackDuration = clip?.duration ?? duration;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(playbackDuration) || playbackDuration <= 0 || !Number.isFinite(clip?.start ?? 0)) throw new Error('预览需要有效的源轨迹与片段时长。');
  const rate = duration / playbackDuration, start = clip?.start ?? 0, end = start + playbackDuration;
  const trajectory: Trajectory = { id: clip?.trajectoryId ?? 'preview', revision: clip?.trajectoryRevision ?? 1, name: '', kind: options.kind || 'object', samples, duration, preview: '', createdAt: '', source: 'recorded' };
  const timing: MotionClip = clip ?? { id: 'preview', revision: 1, trajectoryId: trajectory.id, trajectoryRevision: trajectory.revision, start, duration: playbackDuration, timeMap: { mode: 'linear' }, before: 'hold_first_pose', after: 'hold_last_pose' };
  const isCamera = options.kind === 'camera';
  const cal = isCamera ? options.cameraIntrinsics?.calibration : undefined;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const include = (point: Vec3) => {
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
  };
  // Linear scans avoid spreading up to 100,000 points into a function call.
  for (const sample of samples) include(sample.position);
  const span = Math.max(.25, max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const depth = span * .19;
  const marks = Array.from({ length: 9 }, (_, i) => ({ t: duration * i / 8, ...sampleSourceTrajectory(trajectory, duration * i / 8) }));
  const transform = (p: Vec3, q: Sample, length = 1) => new Vector3(...p).multiplyScalar(length).applyQuaternion(new Quaternion(...q.quaternion)).add(new Vector3(...q.position)).toArray() as Vec3;
  const boundary = cal ? [[-.5, -.5], [cal.imageWidth - .5, -.5], [cal.imageWidth - .5, cal.imageHeight - .5], [-.5, cal.imageHeight - .5]] : [];
  // Inverse distortion is shared across poses; include curved edges in the bounds.
  const localEdges = boundary.map((a, index) => {
    const b = boundary[(index + 1) % boundary.length];
    return Array.from({ length: 9 }, (_, segment) => {
      const ray = pixelToCameraRay([a[0] + (b[0] - a[0]) * segment / 8, a[1] + (b[1] - a[1]) * segment / 8], cal!);
      return ray.map(component => component * depth / ray[2]) as Vec3;
    });
  });
  const frustumEdges = marks.map(mark => localEdges.map(edge => edge.map(point => transform(point, mark))));
  const translations = marks.map(mark => {
    const motion = clipKinematics(trajectory, timing, start + mark.t / rate);
    if (motion.speed < 1e-8) return null;
    return mark.position.map((value, axis) => value + motion.velocity[axis] / motion.speed * depth * .9) as Vec3;
  });
  for (let index = 0; index < marks.length; index++) {
    for (const edge of frustumEdges[index]) for (const point of edge) include(point);
    if (translations[index]) include(translations[index]!);
    if (isCamera && cal) include(transform([0, 0, 1], marks[index], depth * 1.35));
    else for (let axis = 0; axis < 3; axis++) { const vector: Vec3 = [0, 0, 0]; vector[axis] = depth * .6; include(transform(vector, marks[index])); }
  }
  for (let axis = 0; axis < 3; axis++) { min[axis] -= span * .1; max[axis] += span * .1; }
  // Orthonormal image-plane axes plus one shared scale produce true orthographic projection.
  const right = new Vector3(.82, 0, -.57).normalize(), down = new Vector3(.31, .78, .44);
  down.addScaledVector(right, -down.dot(right)).normalize();
  const uv = ([x, y, z]: Vec3): [number, number] => [right.x * x + right.y * y + right.z * z, down.x * x + down.y * y + down.z * z];
  const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => uv([x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]]))));
  const minU = Math.min(...corners.map(p => p[0])), maxU = Math.max(...corners.map(p => p[0]));
  const minV = Math.min(...corners.map(p => p[1])), maxV = Math.max(...corners.map(p => p[1]));
  const scale = Math.min(580 / Math.max(.1, maxU - minU), 400 / Math.max(.1, maxV - minV));
  const screen = (p: Vec3): [number, number] => { const [u, v] = uv(p); return [340 + (u - (minU + maxU) / 2) * scale, 285 + (v - (minV + maxV) / 2) * scale]; };
  const line = (a: Vec3, b: Vec3, stroke: string, width = 1) => { const p = screen(a), q = screen(b); ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke(); };
  const textAt = (text: string, p: Vec3, c = '#4d5967', dx = 4, dy = -5) => { const [x, y] = screen(p); ctx.fillStyle = c; ctx.fillText(text, x + dx, y + dy); };
  const arrow = (a: Vec3, b: Vec3, stroke: string, width = 1.5) => { line(a, b, stroke, width); const p = screen(a), q = screen(b), angle = Math.atan2(q[1] - p[1], q[0] - p[0]); ctx.fillStyle = stroke; ctx.beginPath(); ctx.moveTo(...q); ctx.lineTo(q[0] - 7 * Math.cos(angle - .4), q[1] - 7 * Math.sin(angle - .4)); ctx.lineTo(q[0] - 7 * Math.cos(angle + .4), q[1] - 7 * Math.sin(angle + .4)); ctx.closePath(); ctx.fill(); };
  ctx.fillStyle = '#fafbfc'; ctx.fillRect(0, 0, 960, 640);
  ctx.fillStyle = '#243341'; ctx.font = '600 20px system-ui,sans-serif'; ctx.fillText(isCamera ? '相机轨迹 / Camera trajectory' : '物体轨迹 / Object trajectory', 28, 32);
  ctx.font = '13px system-ui,sans-serif'; ctx.fillStyle = '#596775'; ctx.fillText(`OpenCV world · scene_unit · ${start.toFixed(3)}–${end.toFixed(3)} s · ${rate.toFixed(2)}×`, 28, 55);
  ctx.strokeStyle = '#cfd6dd'; ctx.beginPath(); ctx.moveTo(669, 18); ctx.lineTo(669, 612); ctx.stroke();
  // Grid on the three back planes, with true world coordinate ticks.
  for (let axis = 0; axis < 3; axis++) {
    const other = (axis + 1) % 3;
    for (let k = 0; k <= 4; k++) {
      const a = [...min] as Vec3, b = [...min] as Vec3;
      a[axis] = b[axis] = min[axis] + (max[axis] - min[axis]) * k / 4; b[other] = max[other];
      line(a, b, '#dce2e8', .8);
    }
    const a = [...min] as Vec3, b = [...min] as Vec3; b[axis] = max[axis];
    arrow(a, b, ['#ad4545', '#3b8458', '#3f6caa'][axis]); ctx.font = '12px monospace'; textAt(`${'XYZ'[axis]} ${max[axis].toFixed(2)}`, b);
  }
  ctx.font = '11px monospace'; textAt(`(${min.map(v => v.toFixed(2)).join(', ')})`, min, '#687786', 4, 17);
  let maxSpeed = 0, maxOmega = 0, totalLength = 0;
  const segmentSpeeds: number[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    // Mid-interval sampling avoids roundoff changing which velocity segment is selected.
    const globalTime = start + (samples[i].t + samples[i + 1].t) / (2 * rate);
    const k = clipKinematics(trajectory, timing, globalTime);
    segmentSpeeds.push(k.speed);
    maxSpeed = Math.max(maxSpeed, k.speed); maxOmega = Math.max(maxOmega, k.angularSpeed * 180 / Math.PI);
    const a = samples[i].position, b = samples[i + 1].position;
    totalLength += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  // Bound drawing cost while retaining full-rate kinematics for range labels.
  const stride = Math.max(1, Math.ceil(samples.length / 1000));
  for (let i = 0; i < samples.length - 1; i += stride) {
    const b = Math.min(samples.length - 1, i + stride);
    line(samples[i].position, samples[b].position, speedColor(segmentSpeeds[i], maxSpeed), 2.4);
  }
  marks.forEach((m, i) => {
    const p = screen(m.position); ctx.fillStyle = i === 0 ? color : '#1f3446'; ctx.beginPath(); ctx.arc(...p, i === 0 || i === 8 ? 4.5 : 2.4, 0, Math.PI * 2); ctx.fill();
    if (i === 0 || i === 8) { ctx.font = '12px monospace'; textAt(`t=${(start + m.t / rate).toFixed(2)}s`, m.position, '#263e50', 6, i === 0 ? -10 : 20); }
    if (isCamera && cal) {
      frustumEdges[i].forEach(edge => {
        line(m.position, edge[0], '#56879a', .8);
        for (let segment = 1; segment < edge.length; segment++) line(edge[segment - 1], edge[segment], '#56879a', 1);
      });
      arrow(m.position, transform([0, 0, 1], m, depth * 1.35), '#426987', 1.4);
    } else {
      for (let axis = 0; axis < 3; axis++) { const v: Vec3 = [0, 0, 0]; v[axis] = depth * .6; arrow(m.position, transform(v, m), ['#ad4545', '#3b8458', '#3f6caa'][axis], .9); }
    }
    if (translations[i]) arrow(m.position, translations[i]!, '#9950ae', 2);
  });
  ctx.font = '12px system-ui,sans-serif'; ctx.fillStyle = '#3b4c5d';
  ctx.fillText('等时间采样标记；紫色箭头：平移方向（定长）', 28, 501);
  ctx.fillText(isCamera ? '蓝色箭头：拍摄光轴；细线：由 K 与畸变计算的视锥' : '红 / 绿 / 蓝小坐标轴：物体姿态，与平移方向分别显示', 28, 520);
  for (let x = 0; x < 320; x++) { ctx.fillStyle = speedColor(x / 319 * maxSpeed, maxSpeed); ctx.fillRect(28 + x, 543, 1, 11); }
  ctx.fillStyle = '#3b4c5d'; ctx.fillText('平移速度 / su/s', 28, 534); ctx.fillText('0', 28, 572); ctx.fillText(maxSpeed.toFixed(3), 300, 572);
  ctx.fillText(`源时间 ${duration.toFixed(3)} s → 片段 ${(end - start).toFixed(3)} s`, 28, 602);
  ctx.fillText(`路径长度 ${totalLength.toFixed(3)} su`, 390, 552); ctx.fillText(`最大角速度 ${maxOmega.toFixed(2)} °/s`, 390, 574);
  let y = 38; const note = (str: string, font = '13px monospace') => { ctx.font = font; ctx.fillStyle = '#34495b'; ctx.fillText(str, 690, y); y += 22; };
  note('位姿与镜头', '600 15px system-ui,sans-serif');
  note(`start [${samples[0].position.map(v => v.toFixed(2)).join(',')}]`);
  note(`end   [${samples.at(-1)!.position.map(v => v.toFixed(2)).join(',')}]`);
  if (isCamera && cal) {
    y += 12; note(`${cal.imageWidth} × ${cal.imageHeight} px`); note(`FOV H ${cal.fov.horizontalDegrees.toFixed(2)}°`); note(`FOV V ${cal.fov.verticalDegrees.toFixed(2)}°`);
    note('K (px):'); cal.intrinsic.forEach(r => note(r.map(v => v.toFixed(2).padStart(7)).join(' '), '12px monospace'));
    y += 10; note(cal.distortion.model, '13px monospace');
    note('k1, k2, p1, p2, k3', '12px monospace');
    note(cal.distortion.coefficients.slice(0, 3).map(v => v.toFixed(4)).join(', '), '12px monospace');
    note(cal.distortion.coefficients.slice(3).map(v => v.toFixed(4)).join(', '), '12px monospace');
    const top = y + 10, w = 225, h = 125;
    for (const warp of [false, true]) {
      ctx.strokeStyle = warp ? '#326a96' : '#b9c3cc'; ctx.lineWidth = warp ? 1.1 : .7;
      for (let l = 0; l <= 6; l++) for (const vertical of [true, false]) {
        ctx.beginPath();
        for (let j = 0; j <= 25; j++) {
          const u = (vertical ? l / 6 : j / 25) * cal.imageWidth - .5, v = (vertical ? j / 25 : l / 6) * cal.imageHeight - .5;
          let nx = (u - cal.intrinsic[0][2]) / cal.intrinsic[0][0], ny = (v - cal.intrinsic[1][2]) / cal.intrinsic[1][1];
          if (warp) [nx, ny] = distortNormalized([nx, ny], cal.distortion);
          const x = 698 + (nx * cal.intrinsic[0][0] + cal.intrinsic[0][2] + .5) / cal.imageWidth * w, yy = top + (ny * cal.intrinsic[1][1] + cal.intrinsic[1][2] + .5) / cal.imageHeight * h;
          if (j) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
        }
        ctx.stroke();
      }
    }
    y = top + h + 24; note('灰：理想；蓝：畸变', '12px system-ui,sans-serif');
    if (cal.distortion.coefficients.some(v => v !== 0)) note('非零畸变：SymphoMotion 待适配', '12px system-ui,sans-serif');
  } else {
    y += 14; note('完整 SE(3) 位姿', '14px system-ui,sans-serif'); note('X：物体正面', '13px system-ui,sans-serif'); note('颜色：平移速率', '13px system-ui,sans-serif'); note('小坐标轴：旋转姿态', '13px system-ui,sans-serif');
  }
  return canvas.toDataURL('image/png');
}
