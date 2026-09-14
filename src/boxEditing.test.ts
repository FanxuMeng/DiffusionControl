import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { BASIS } from './sceneGeometry';
import { boxError, readBoxTransform, rotateBoxLocal, setBoxTransform, translateBoxLocal } from './boxEditing';
import type { SelectionBox } from './types';

const box: SelectionBox = { center: [0, 0, 3], halfExtents: [.5, .75, 1], quaternion: [0, 0, 0, 1] };
describe('interactive OBB transform contract', () => {
  it('keeps coordinates in the canonical scene frame through the viewer basis and local scaling', () => {
    const parent = new Group(), target = new Group(); parent.quaternion.copy(BASIS); parent.add(target);
    const turned = rotateBoxLocal(box, [21, -36, 43]); setBoxTransform(target, turned); parent.updateMatrixWorld(true);
    expect(target.getWorldPosition(new Vector3()).distanceTo(new Vector3(...box.center).applyQuaternion(BASIS))).toBeLessThan(1e-8);
    expect(readBoxTransform(target)).toEqual(turned);
    expect(boxError({ ...box, halfExtents: [0, .1, .1] })).not.toBe('');
    expect(boxError({ ...box, center: [NaN, 0, 0] })).not.toBe('');
  });
  it.each(['translate', 'rotate', 'scale'] as const)('responds to actual TransformControls pointer operations in %s mode', mode => {
    const scene = new Scene(), parent = new Group(), target = new Group(); parent.quaternion.copy(BASIS); scene.add(parent); parent.add(target);
    setBoxTransform(target, rotateBoxLocal(box, [21, -36, 43]));
    const camera = new PerspectiveCamera(55, 1, .01, 100); camera.position.set(2, 1, 1); camera.lookAt(0, 0, -3); camera.updateMatrixWorld();
    const controls = new TransformControls(camera); controls.attach(target); scene.add(controls.getHelper());
    controls.setMode(mode); controls.setSpace('local'); controls.axis = 'X';
    scene.updateMatrixWorld(true);
    const before = readBoxTransform(target); let changes = 0;
    controls.addEventListener('objectChange', () => changes++);
    // These methods receive normalized pointers internally; @types declares the DOM type.
    controls.pointerDown({ x: .1, y: .1, button: 0 } as PointerEvent);
    controls.pointerMove({ x: .3, y: .25, button: -1 } as PointerEvent); controls.pointerUp({ x: .3, y: .25, button: 0 } as PointerEvent);
    expect(changes).toBeGreaterThan(0);
    const after = readBoxTransform(target); expect(boxError(after)).toBe('');
    if (mode === 'translate') {
      const local = new Vector3(...after.center).sub(new Vector3(...before.center)).applyQuaternion(new Quaternion(...before.quaternion).invert());
      expect(Math.abs(local.x)).toBeGreaterThan(.01);
      expect(local.y).toBeCloseTo(0, 8); expect(local.z).toBeCloseTo(0, 8);
      expect(after.quaternion).toEqual(before.quaternion);
    }
    if (mode === 'rotate') {
      const local = new Quaternion(...before.quaternion).invert().multiply(new Quaternion(...after.quaternion));
      expect(Math.abs(local.x)).toBeGreaterThan(.001);
      expect(local.y).toBeCloseTo(0, 8); expect(local.z).toBeCloseTo(0, 8);
      expect(after.center).toEqual(before.center);
    }
    if (mode === 'scale') {
      expect(after.halfExtents[0]).not.toBe(before.halfExtents[0]);
      expect(after.halfExtents.slice(1)).toEqual(before.halfExtents.slice(1));
      expect(after.center).toEqual(before.center); expect(after.quaternion).toEqual(before.quaternion);
    }
    // dispose() expects a connected DOM element; this test exercises geometry only.
    controls.getHelper().dispose();
  });
});

describe('numeric edits in the current box frame', () => {
  it('moves local X along scene Y after a 90 degree Z turn, without scaling by box dimensions', () => {
    const turned = rotateBoxLocal(box, [0, 0, 90]);
    const moved = translateBoxLocal(turned, [2, 0, 0]);
    expect(moved.center[0]).toBeCloseTo(0, 10); expect(moved.center[1]).toBeCloseTo(2, 10); expect(moved.center[2]).toBe(3);
    expect(moved.quaternion).toEqual(turned.quaternion); expect(moved.halfExtents).toEqual(box.halfExtents);
    expect(turned.center).toEqual(box.center);
  });

  it('rotates about the current local X axis, then translates along the updated local Z axis', () => {
    const turned = rotateBoxLocal(rotateBoxLocal(box, [0, 0, 90]), [90, 0, 0]);
    const moved = translateBoxLocal(turned, [0, 0, 2]);
    // Local Z becomes scene X; a world-axis rotation would instead send it to -Y.
    expect(moved.center[0]).toBeCloseTo(2, 10); expect(moved.center[1]).toBeCloseTo(0, 10); expect(moved.center[2]).toBeCloseTo(3, 10);
    expect(turned.center).toEqual(box.center); expect(turned.halfExtents).toEqual(box.halfExtents);
    expect(boxError(moved)).toBe('');
  });

  it('reverses an arbitrary local edit without replacing the original orientation', () => {
    const start = rotateBoxLocal(box, [21, -36, 43]);
    const moved = translateBoxLocal(start, [-.3, .9, 1.2]);
    const restoredPosition = translateBoxLocal(moved, [.3, -.9, -1.2]);
    expect(new Vector3(...restoredPosition.center).distanceTo(new Vector3(...start.center))).toBeLessThan(1e-10);
    const rotated = rotateBoxLocal(start, [0, -12, 0]);
    const restored = rotateBoxLocal(rotated, [0, 12, 0]);
    expect(new Quaternion(...restored.quaternion).angleTo(new Quaternion(...start.quaternion))).toBeLessThan(1e-7);
    const worldRotation = new Quaternion(...start.quaternion).premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -12*Math.PI/180));
    expect(new Quaternion(...rotated.quaternion).angleTo(worldRotation)).toBeGreaterThan(.1);
  });
});
