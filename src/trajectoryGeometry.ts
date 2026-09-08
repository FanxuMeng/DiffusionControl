import * as THREE from 'three';
import { speedColor } from './cameraMath';
import { sampleClip, clipKinematics } from './timelineModel';
import { hasDistortion, idealCalibration, makeFrustumGeometry } from './captureProjection';
import type { CameraCalibration, MotionClip, Project, Sample, Trajectory, Vec3 } from './types';

export interface PathAnnotation { id: string; position: Vec3; text: string; color: string }
export interface TrajectoryDrawing { root: THREE.Group; maximumSpeed: number; annotations: PathAnnotation[] }
interface Track { trajectory: Trajectory; clip: MotionClip; name: string; color: string; calibration: CameraCalibration | null }

export function makeCameraGlyph(calibration: CameraCalibration, depth = .55, color = '#e5c088') {
  const root = new THREE.Group();
  const ideal = new THREE.LineSegments(makeFrustumGeometry(idealCalibration(calibration), depth), new THREE.LineBasicMaterial({ color: hasDistortion(calibration) ? '#82a6a5' : color, transparent: true, opacity: hasDistortion(calibration) ? .45 : .72, depthTest: false, toneMapped: false })); ideal.renderOrder = 15; root.add(ideal);
  if (hasDistortion(calibration)) { const distorted = new THREE.LineSegments(makeFrustumGeometry(calibration, depth), new THREE.LineBasicMaterial({ color: '#e7c275', transparent: true, opacity: .92, depthTest: false, toneMapped: false })); distorted.renderOrder = 16; root.add(distorted); }
  const forward = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), depth * 1.32, color, .085, .05); forward.userData.captureArrow = true; (forward.line.material as THREE.Material).toneMapped = false; (forward.cone.material as THREE.Material).toneMapped = false; root.add(forward);
  return root;
}

/** Preserve optical rays while preventing near-camera solid arrowheads from ballooning. */
export function limitCameraArrowHeads(root: THREE.Object3D, camera: THREE.PerspectiveCamera, viewportHeight: number) {
  root.updateMatrixWorld(true);
  root.traverse(node => {
    if (!(node instanceof THREE.ArrowHelper) || !node.userData.captureArrow) return;
    const depth = -node.cone.getWorldPosition(new THREE.Vector3()).applyMatrix4(camera.matrixWorldInverse).z;
    node.cone.visible = depth > camera.near * 2.5;
    if (!node.cone.visible) return;
    const worldPerPixel = 2 * depth / Math.max(1, camera.projectionMatrix.elements[5] * viewportHeight);
    node.cone.scale.set(Math.min(.05, worldPerPixel * 8), Math.min(.085, worldPerPixel * 12), Math.min(.05, worldPerPixel * 8));
  });
}

export function buildTrajectoryDrawing(project: Project, draft: Sample[], target: string | null, draftLens: CameraCalibration | null, includeCamera = true): TrajectoryDrawing {
  const root = new THREE.Group(), annotations: PathAnnotation[] = [], tracks: Track[] = [];
  project.objects.forEach(object => { if (object.motion === 'trajectory' && object.trajectory && object.clip) tracks.push({ trajectory: object.trajectory, clip: object.clip, name: object.name, color: object.color, calibration: null }); });
  const lens = project.cameraIntrinsics?.calibration || project.camera?.cameraIntrinsics?.calibration || project.referenceCamera;
  if (includeCamera && project.camera && project.cameraClip) tracks.push({ trajectory: project.camera, clip: project.cameraClip, name: '相机', color: '#c8d8f3', calibration: lens });
  if (draft.length >= 2 && draft[draft.length - 1].t > 0 && (target !== 'camera' || includeCamera)) {
    const duration = draft[draft.length - 1].t;
    tracks.push({ trajectory: { id: 'draft', revision: draft.length, kind: target === 'camera' ? 'camera' : 'object', name: '录制中', samples: draft, duration, preview: '', createdAt: '', source: 'recorded' }, clip: { id: 'draft', revision: 1, trajectoryId: 'draft', trajectoryRevision: draft.length, start: 0, duration, timeMap: { mode: 'linear' }, before: 'hold_first_pose', after: 'hold_last_pose' }, name: '录制中', color: '#f1a16d', calibration: target === 'camera' ? draftLens : null });
  }
  let maximumSpeed = 0;
  const prepared = tracks.map(track => {
    const samples = track.trajectory.samples, stride = Math.max(1, Math.ceil(samples.length / 400)); const times: number[] = [];
    for (let i = 0; i < samples.length; i += stride) times.push(track.clip.start + samples[i].t / track.trajectory.duration * track.clip.duration);
    const end = track.clip.start + track.clip.duration; if (times[times.length - 1] !== end) times.push(end);
    const speeds = times.slice(0, -1).map((time, i) => clipKinematics(track.trajectory, track.clip, (time + times[i + 1]) * .5).speed);
    speeds.forEach(speed => { maximumSpeed = Math.max(maximumSpeed, speed); });
    return { track, times, speeds };
  });
  prepared.forEach(({ track, times, speeds }) => {
    const positions: number[] = [], colors: number[] = [], lineColor = new THREE.Color();
    for (let i = 0; i < times.length - 1; i++) {
      const a = sampleClip(track.trajectory, track.clip, times[i]), b = sampleClip(track.trajectory, track.clip, times[i + 1]);
      positions.push(...a.position, ...b.position); lineColor.set(speedColor(speeds[i], maximumSpeed)); colors.push(lineColor.r, lineColor.g, lineColor.b, lineColor.r, lineColor.g, lineColor.b);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const path = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false, transparent: true, opacity: .95 })); path.renderOrder = 12; root.add(path);
    const count = track.calibration ? 5 : 8;
    for (let i = 0; i <= count; i++) {
      const time = track.clip.start + track.clip.duration * i / count, pose = sampleClip(track.trajectory, track.clip, time);
      const speed = clipKinematics(track.trajectory, track.clip, time).speed, color = speedColor(speed, maximumSpeed);
      // Screen-sized vertices stay legible at the observer's near plane; a world
      // sphere here can fill the entire viewport when a short path starts at (0,0,0).
      const marker = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ color, size: i === count ? 9 : i === 0 ? 7 : 4, sizeAttenuation: false, depthTest: false, toneMapped: false })); marker.position.fromArray(pose.position); marker.renderOrder = 14; root.add(marker);
      if (track.calibration) { const glyph = makeCameraGlyph(track.calibration, .3, color); glyph.position.fromArray(pose.position); glyph.quaternion.fromArray(pose.quaternion); root.add(glyph); }
      else if (i % 2 === 0) { const axes = new THREE.AxesHelper(.13); axes.position.fromArray(pose.position); axes.quaternion.fromArray(pose.quaternion); root.add(axes); }
      if (i === 0 || i === count) annotations.push({ id: `${track.trajectory.id}-${i}`, position: [...pose.position], text: `${track.name} ${time.toFixed(2)} s`, color: track.color });
    }
  });
  return { root, maximumSpeed, annotations };
}
