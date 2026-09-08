import { Quaternion, Vector3 } from 'three';
import type { ControlSettings, Quat, Vec3 } from './types';

export interface FlightState { velocity: Vec3 }
export interface FlightInput { direction: Vec3 | null }
export function createFlightState(): FlightState { return { velocity: [0, 0, 0] }; }
export function stopFlight(): FlightState { return createFlightState(); }

/** Every movement component, including elevation, is in the controlled camera frame. */
export function cameraLocalDirection(keys: ReadonlySet<string>, quaternion: Quat): Vec3 {
  const local = new Vector3(
    Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
    Number(keys.has('ControlLeft') || keys.has('ControlRight')) - Number(keys.has('ShiftLeft') || keys.has('ShiftRight')),
    Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
  );
  return local.applyQuaternion(new Quaternion(...quaternion)).toArray() as Vec3;
}

/** Held-key translation. Releasing or cancelling all components stops immediately.
 * The configured speed is independent of actual velocity; there is no coasting,
 * mouse-button acceleration, or hidden restart speed. Wheel input changes only
 * the configured speed. Integration uses elapsed seconds.
 */
export function advanceFlight(_state: FlightState, input: FlightInput, seconds: number, settings: Pick<ControlSettings, 'moveSpeed'>): { state: FlightState; displacement: Vec3 } {
  const dt = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const norm = input.direction ? Math.hypot(...input.direction) : 0;
  const speed = Number.isFinite(settings.moveSpeed) ? Math.max(0, settings.moveSpeed) : 0;
  const velocity: Vec3 = norm > 1e-10 ? input.direction!.map(v => v / norm * speed) as Vec3 : [0, 0, 0];
  return { state: { velocity }, displacement: velocity.map(v => v * dt) as Vec3 };
}
