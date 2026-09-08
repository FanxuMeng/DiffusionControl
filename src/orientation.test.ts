import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { cameraLocalDirection } from './flight';
import { controllerCameraPose, createObserver, createOrientation, createRecordingRig, lookOrientation, orientationQuaternion, PITCH_LIMIT, poseForTarget, recordingRigPose, rollOrientation } from './orientation';
import type { Pose, Quat, Vec3 } from './types';

const origin: Pose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
function expectSameRotation(actual: Quat, expected: Quat) {
  // q and -q encode the same rotation; a component comparison would reject it.
  expect(Math.abs(new Quaternion(...actual).dot(new Quaternion(...expected)))).toBeCloseTo(1, 12);
}

describe('independent mouse look and optical-axis roll', () => {
  it('returns to an unrolled frame after a mixed mouse loop', () => {
    let orientation = createOrientation();
    for (const [yaw, pitch] of [[.3, 0], [0, .2], [-.3, 0], [0, -.2]]) orientation = lookOrientation(orientation, yaw, pitch);
    expect(orientation.roll).toBe(0);
    expectSameRotation(orientationQuaternion(orientation), origin.quaternion);
    // Incremental local Ry/Rx multiplication previously left a ~3.37° roll.
  });

  it('is independent of mouse event ordering and subdivision away from the pitch limit', () => {
    const whole = lookOrientation(createOrientation(), .8, -.5);
    let pieces = createOrientation();
    for (let i = 0; i < 40; i++) {
      pieces = lookOrientation(pieces, 0, -.5 / 40);
      pieces = lookOrientation(pieces, .8 / 40, 0);
    }
    expectSameRotation(orientationQuaternion(pieces), orientationQuaternion(whole));
  });

  it('keeps Q/E roll independent while yaw and pitch change', () => {
    const original = lookOrientation(createOrientation(), .6, .2);
    const rolled = rollOrientation(original, .45);
    expect(rolled.yaw).toBe(original.yaw); expect(rolled.pitch).toBe(original.pitch);
    const moved = lookOrientation(rolled, -.7, .5);
    expect(moved.roll).toBeCloseTo(.45, 12);
    const unrolled = { ...moved, roll: 0 };
    const delta = new Quaternion(...orientationQuaternion(unrolled)).invert().multiply(new Quaternion(...orientationQuaternion(moved)));
    expectSameRotation(delta.toArray() as Quat, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), .45).toArray() as Quat);
  });

  it('clamps pitch to ±89° and immediately responds when looking back from a limit', () => {
    const up = lookOrientation(createOrientation(), .2, 8);
    expect(up.pitch).toBe(PITCH_LIMIT);
    expect(lookOrientation(up, 0, -.1).pitch).toBeCloseTo(PITCH_LIMIT - .1, 12);
    const down = lookOrientation(up, 0, -8);
    expect(down.pitch).toBe(-PITCH_LIMIT);
    expect(lookOrientation(down, 0, .1).pitch).toBeCloseTo(-PITCH_LIMIT + .1, 12);
  });

  it('keeps the unrolled observer horizon level and its basis right-handed and orthonormal', () => {
    for (const yaw of [-3, -.4, 0, .8, 3]) for (const pitch of [-PITCH_LIMIT, -.4, 0, .7, PITCH_LIMIT]) {
      const state = lookOrientation(createOrientation(), yaw, pitch);
      const rotation = new Quaternion(...orientationQuaternion(state));
      expect(new Vector3(1, 0, 0).applyQuaternion(rotation).y).toBeCloseTo(0, 12);
      const rolled = new Quaternion(...orientationQuaternion(rollOrientation(state, .6)));
      const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map(axis => axis.applyQuaternion(rolled));
      axes.forEach(axis => expect(axis.length()).toBeCloseTo(1, 12));
      expect(axes[0].dot(axes[1])).toBeCloseTo(0, 12); expect(axes[0].dot(axes[2])).toBeCloseTo(0, 12); expect(axes[1].dot(axes[2])).toBeCloseTo(0, 12);
      expect(new Matrix4().makeRotationFromQuaternion(rolled).determinant()).toBeCloseTo(1, 12);
    }
  });
});

describe('separate free observer and recording rig', () => {
  it('preserves all six object fronts at t=0, including world-up and world-down fronts', () => {
    const normals: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const normal of normals) {
      const q = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), new Vector3(...normal));
      const initial: Pose = { position: [-1.2, .8, 4], quaternion: q.toArray() as Quat };
      const rig = createRecordingRig('object', initial);
      expectSameRotation(recordingRigPose(rig).quaternion, initial.quaternion);
      expect(recordingRigPose(rig).position).toEqual(initial.position);
      const cameraQ = orientationQuaternion(rig.orientation);
      // W, D and Shift are respectively object +X, -Y and +Z.
      for (const [key, localAxis] of [['KeyW', [1, 0, 0]], ['KeyD', [0, -1, 0]], ['ShiftLeft', [0, 0, 1]]] as [string, Vec3][]) {
        const actual = new Vector3(...cameraLocalDirection(new Set([key]), cameraQ));
        expect(actual.distanceTo(new Vector3(...localAxis).applyQuaternion(q))).toBeLessThan(1e-12);
      }
      rig.orientation = lookOrientation(rig.orientation, .4, 4);
      expect(rig.orientation.pitch).toBe(PITCH_LIMIT);
      expect(rig.orientation.reference).toEqual(createRecordingRig('object', initial).orientation.reference);
    }
  });

  it('returns the camera rig during capture and the retained observer in preview', () => {
    const observer = createObserver(); observer.position = [4, 2, -3]; observer.orientation = lookOrientation(observer.orientation, .9, .3);
    const before = controllerCameraPose(observer), rig = createRecordingRig('camera', origin);
    expect(poseForTarget(observer, rig, 'camera', 'preview', origin)).toEqual(before);
    expect(poseForTarget(observer, rig, 'camera', 'countdown', origin)).toEqual(origin);
    rig.position = [0, 0, 2]; rig.orientation = lookOrientation(rig.orientation, .1, -.2);
    for (const phase of ['recording', 'paused'] as const) expect(poseForTarget(observer, rig, 'camera', phase, origin)).toEqual(recordingRigPose(rig));
    expect(poseForTarget(observer, rig, 'camera', 'preview', origin)).toEqual(before);
    expect(controllerCameraPose(observer)).toEqual(before);
  });

  it('ignores a merely prepared object during preview and records only its own frame', () => {
    const observer = createObserver(), initial: Pose = { position: [-2, .8, 5], quaternion: [0, 0, 0, 1] };
    const rig = createRecordingRig('chair', initial);
    rig.position = [1, 2, 3]; rig.orientation = rollOrientation(lookOrientation(rig.orientation, .3, .4), -.2);
    expect(poseForTarget(observer, rig, 'chair', 'preview', initial)).toEqual(initial);
    expect(poseForTarget(observer, rig, 'camera', 'recording', origin)).toEqual(origin);
    const sample = poseForTarget(observer, rig, 'chair', 'recording', initial);
    expect(sample.position).toEqual([1, 2, 3]); // no viewing camera's follow offset
    expectSameRotation(sample.quaternion, recordingRigPose(rig).quaternion);
    sample.position[0] = 999;
    expect(rig.position).toEqual([1, 2, 3]);
    expect(poseForTarget(observer, rig, 'other', 'recording', initial)).toEqual(initial);
  });
});
