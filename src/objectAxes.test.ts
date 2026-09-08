import { describe, expect, it } from 'vitest';
import { ArrowHelper, Color, Group, LineBasicMaterial, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { createDemoProjects, frontPose } from './model';
import { FACE_COLORS, OBJECT_FACES, referenceAxesForBox } from './objectAxes';
import { BASIS, makeBoundingBox } from './sceneGeometry';
import type { Quat, SceneObject } from './types';

const demoObject = () => createDemoProjects()[0].objects.find(object => object.id === 'humanoid')!;
const arrows = (bbox: Group) => bbox.children.filter(node => node instanceof ArrowHelper && node.userData.referenceAxis) as ArrowHelper[];
const worldAxis = (arrow: ArrowHelper) => new Vector3(0, 1, 0).applyQuaternion(arrow.getWorldQuaternion(new Quaternion())).normalize();
function dispose(bbox: Group) {
  bbox.traverse(node => {
    if (node instanceof Mesh || 'geometry' in node) {
      const drawable = node as Mesh;
      drawable.geometry.dispose();
      for (const material of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) material.dispose();
    }
  });
}

describe('bounding-box reference axes', () => {
  it('shares all six card colors with axes and faces without adding selectable faces', () => {
    const object = demoObject(), bbox = makeBoundingBox(object), axes = referenceAxesForBox(object.halfExtents);
    try {
      expect(arrows(bbox)).toHaveLength(6);
      expect(bbox.children.filter(node => node.userData.face)).toHaveLength(6);
      for (const axis of axes) {
        const card = OBJECT_FACES.find(item => item.face === axis.face)!;
        const arrow = arrows(bbox).find(item => item.userData.referenceAxis === axis.face)!;
        const face = bbox.children.find(item => item.userData.face === axis.face) as Mesh;
        expect(new Color(card.color).equals((arrow.line.material as LineBasicMaterial).color)).toBe(true);
        expect(new Color(FACE_COLORS[axis.face]).equals((face.material as MeshBasicMaterial).color)).toBe(true);
        expect(arrow.position.toArray()).toEqual([0, 0, 0]);
        expect(arrow.userData.face).toBeUndefined();
        expect(new Vector3(...axis.labelPosition).normalize().distanceTo(new Vector3(...axis.direction))).toBeLessThan(1e-10);
        expect(new Vector3(...axis.labelPosition).length()).toBeGreaterThan(axis.length);
      }
      expect(bbox.children.filter(node => node.userData.frontArrow)).toHaveLength(1);
    } finally { dispose(bbox); }
  });

  it('keeps the original bbox axes when any of its six faces becomes object-local +X', () => {
    for (const chosen of OBJECT_FACES) {
      const object = demoObject(); object.front = chosen.face; object.initialPose = frontPose(object, chosen.face);
      const bbox = makeBoundingBox(object);
      try {
        const q0 = new Quaternion(...object.initialPose.quaternion);
        bbox.quaternion.copy(q0).multiply(q0.clone().invert()); bbox.updateMatrixWorld(true);
        for (const axis of referenceAxesForBox(object.halfExtents)) {
          const arrow = arrows(bbox).find(item => item.userData.referenceAxis === axis.face)!;
          expect(arrow.getWorldPosition(new Vector3()).distanceTo(new Vector3(...object.center))).toBeLessThan(1e-10);
          expect(worldAxis(arrow).distanceTo(new Vector3(...axis.direction))).toBeLessThan(1e-10);
        }
      } finally { dispose(bbox); }
    }
  });

  it('moves axes and labels with the same relative rotation as the object in render space', () => {
    const object: SceneObject = demoObject(); object.front = '-z'; object.initialPose = frontPose(object, '-z');
    const q0 = new Quaternion(...object.initialPose.quaternion);
    const delta = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -.4));
    const pose = { position: new Vector3(2, -1, 6), quaternion: delta.clone().multiply(q0).toArray() as Quat };
    const bbox = makeBoundingBox(object), overlay = new Group(); overlay.quaternion.copy(BASIS); overlay.add(bbox);
    try {
      bbox.position.copy(pose.position); bbox.quaternion.set(...pose.quaternion).multiply(q0.clone().invert());
      overlay.updateMatrixWorld(true);
      for (const axis of referenceAxesForBox(object.halfExtents)) {
        const arrow = arrows(bbox).find(item => item.userData.referenceAxis === axis.face)!;
        const expectedDirection = new Vector3(...axis.direction).applyQuaternion(delta).applyQuaternion(BASIS);
        expect(worldAxis(arrow).distanceTo(expectedDirection)).toBeLessThan(1e-10);
        expect(arrow.getWorldPosition(new Vector3()).distanceTo(pose.position.clone().applyQuaternion(BASIS))).toBeLessThan(1e-10);
        const label = bbox.localToWorld(new Vector3(...axis.labelPosition));
        const expectedLabel = new Vector3(...axis.labelPosition).applyQuaternion(delta).add(pose.position).applyQuaternion(BASIS);
        expect(label.distanceTo(expectedLabel)).toBeLessThan(1e-10);
      }
    } finally { dispose(bbox); }
  });
});
