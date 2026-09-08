import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Pose, Quat, RecordState, Vec3 } from './types';

export const PITCH_LIMIT = 89 * Math.PI / 180;
const identity: Quat = [0, 0, 0, 1];
const axisX = new Vector3(1, 0, 0), axisY = new Vector3(0, 1, 0), axisZ = new Vector3(0, 0, 1);
// Object +X is forward and +Z is up; camera +Z is forward and +Y is down.
const objectCameraRotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(
  new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0),
));

export interface OrientationState { reference: Quat; yaw: number; pitch: number; roll: number }
export interface PoseController { position: Vec3; orientation: OrientationState }
export interface RecordingRig extends PoseController { target: string }

export function createOrientation(reference: Quat = identity): OrientationState {
  return { reference: new Quaternion(...reference).normalize().toArray() as Quat, yaw: 0, pitch: 0, roll: 0 };
}
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Mouse angles are scalars, never a chain of local quaternion increments.
 * Rebuilding reference · Ry · Rx · Rz prevents mouse paths from adding roll.
 */
export function lookOrientation(state: OrientationState, yawDelta: number, pitchDelta: number): OrientationState {
  return { ...state, yaw: wrapAngle(state.yaw + yawDelta), pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + pitchDelta)) };
}
export function rollOrientation(state: OrientationState, delta: number): OrientationState {
  return { ...state, roll: wrapAngle(state.roll + delta) };
}
export function orientationQuaternion(state: OrientationState): Quat {
  return new Quaternion(...state.reference)
    .multiply(new Quaternion().setFromAxisAngle(axisY, state.yaw))
    .multiply(new Quaternion().setFromAxisAngle(axisX, state.pitch))
    .multiply(new Quaternion().setFromAxisAngle(axisZ, state.roll))
    .normalize().toArray() as Quat;
}
export function createObserver(): PoseController {
  return { position: [0, 0, 0], orientation: createOrientation() };
}
export function createRecordingRig(target: string, initialPose: Pose): RecordingRig {
  const reference = new Quaternion(...initialPose.quaternion);
  if (target !== 'camera') reference.multiply(objectCameraRotation);
  return { target, position: [...initialPose.position], orientation: createOrientation(reference.toArray() as Quat) };
}
/** Camera pose of either an observer or a rig, without any viewing offset. */
export function controllerCameraPose(controller: PoseController): Pose {
  return { position: [...controller.position], quaternion: orientationQuaternion(controller.orientation) };
}
/** Recorded object frame excludes both the virtual-camera basis and follow offset. */
export function recordingRigPose(rig: RecordingRig): Pose {
  const pose = controllerCameraPose(rig);
  if (rig.target !== 'camera') pose.quaternion = new Quaternion(...pose.quaternion).multiply(objectCameraRotation.clone().invert()).normalize().toArray() as Quat;
  return pose;
}
export function usesRecordingRig(phase: RecordState): boolean {
  return phase === 'countdown' || phase === 'recording' || phase === 'paused';
}
/** Preselecting or preparing a target cannot replace the free observer. */
export function poseForTarget(observer: PoseController, rig: RecordingRig | null, target: string, phase: RecordState, fallback: Pose): Pose {
  if (usesRecordingRig(phase) && rig?.target === target) return recordingRigPose(rig);
  if (target === 'camera') return controllerCameraPose(observer);
  return { position: [...fallback.position], quaternion: [...fallback.quaternion] };
}
