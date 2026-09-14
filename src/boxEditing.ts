import { Euler, Group, Quaternion, Vector3 } from 'three';
import type { SceneObject, SelectionBox, Vec3 } from './types';

export function objectSelectionBox(object: SceneObject): SelectionBox {
  return { center: [...object.center], halfExtents: [...object.halfExtents], quaternion: [...(object.boxQuaternion || [0, 0, 0, 1])] };
}
export function boxError(box: SelectionBox): string {
  if (box.center.some(v => !Number.isFinite(v) || Math.abs(v) > 1000000)) return '中心坐标必须为有效数值。';
  if (box.halfExtents.some(v => !Number.isFinite(v) || v < .0001 || v > 1000000)) return '每条边长须在 0.0002–2000000 场景单位之间。';
  if (box.quaternion.some(v => !Number.isFinite(v)) || Math.abs(Math.hypot(...box.quaternion) - 1) > 1e-5) return '旋转四元数无效。';
  return '';
}
export function translateBoxLocal(box: SelectionBox, offset: Vec3): SelectionBox {
  const displacement = new Vector3(...offset).applyQuaternion(new Quaternion(...box.quaternion));
  return { ...box, center: new Vector3(...box.center).add(displacement).toArray() };
}
export function rotateBoxLocal(box: SelectionBox, angles: Vec3): SelectionBox {
  const delta = new Quaternion().setFromEuler(new Euler(...angles.map(v => v * Math.PI / 180) as Vec3, 'XYZ'));
  return { ...box, quaternion: new Quaternion(...box.quaternion).multiply(delta).normalize().toArray() };
}
export function setBoxTransform(target: Group, box: SelectionBox) {
  target.position.fromArray(box.center); target.quaternion.fromArray(box.quaternion);
  target.scale.fromArray(box.halfExtents.map(v => Math.max(.0001, v) * 2));
  target.updateMatrixWorld(true);
}
export function readBoxTransform(target: Group): SelectionBox {
  target.scale.max(new Vector3(.0002, .0002, .0002));
  return { center: target.position.toArray(), halfExtents: target.scale.clone().multiplyScalar(.5).toArray(), quaternion: target.quaternion.clone().normalize().toArray() };
}
