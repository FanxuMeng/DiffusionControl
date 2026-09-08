import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { advanceFlight, cameraLocalDirection, createFlightState, stopFlight } from './flight';
import type { Quat, Vec3 } from './types';
const identity: Quat = [0, 0, 0, 1];
const input = (direction: Vec3 | null) => ({ direction });

describe('held-key camera-local movement', () => {
  it('uses one translation speed for diagonal movement', () => {
    const result = advanceFlight(createFlightState(), input([1, -1, 1]), 2, { moveSpeed: 1 });
    expect(Math.hypot(...result.displacement)).toBeCloseTo(2, 12);
    expect(Math.hypot(...result.state.velocity)).toBeCloseTo(1, 12);
  });
  it('stops immediately when all movement keys are released', () => {
    const moving = advanceFlight(createFlightState(), input([0, 0, 1]), 1, { moveSpeed: .5 });
    const stopped = advanceFlight(moving.state, input(null), 30, { moveSpeed: .5 });
    expect(stopped.displacement).toEqual([0, 0, 0]);
    expect(stopped.state.velocity).toEqual([0, 0, 0]);
  });
  it('cancels opposing components without preserving stale movement', () => {
    const direction = cameraLocalDirection(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'ControlLeft']), identity);
    const result = advanceFlight({ velocity: [0, 0, 2] }, input(direction), 1, { moveSpeed: 2 });
    expect(result.state.velocity).toEqual([0, 0, 0]);
  });
  it('moves local up along world right after a quarter roll', () => {
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).toArray() as Quat;
    const direction = cameraLocalDirection(new Set(['ShiftLeft']), rotation);
    expect(direction[0]).toBeCloseTo(1, 12);
    expect(direction[1]).toBeCloseTo(0, 12);
    expect(direction[2]).toBeCloseTo(0, 12);
  });
  it('rotates elevation with pitch instead of adding world Y', () => {
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2).toArray() as Quat;
    const direction = cameraLocalDirection(new Set(['ControlLeft']), rotation);
    expect(direction[1]).toBeCloseTo(0, 12);
    expect(direction[2]).toBeCloseTo(1, 12);
  });
  it('updates direction while held and stops moving after release even if orientation changes', () => {
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray() as Quat;
    const turning = advanceFlight(createFlightState(), input(cameraLocalDirection(new Set(['KeyW']), yaw)), 1, { moveSpeed: 2 });
    expect(turning.displacement[0]).toBeCloseTo(2, 12);
    const released = advanceFlight(turning.state, input(cameraLocalDirection(new Set(), yaw)), 2, { moveSpeed: 2 });
    expect(released.displacement).toEqual([0, 0, 0]);
  });
  it('preserves elapsed distance across slow or partitioned frames', () => {
    const long = advanceFlight(createFlightState(), input([0, 0, 1]), 3.75, { moveSpeed: .5 });
    const short = advanceFlight(createFlightState(), input([0, 0, 1]), 1 / 60, { moveSpeed: .5 });
    expect(short.displacement[2] * 225).toBeCloseTo(long.displacement[2], 12);
  });
  it('Space clears actual movement without changing the user-selected speed', () => {
    expect(stopFlight().velocity).toEqual([0, 0, 0]);
    const resumed = advanceFlight(stopFlight(), input([1, 0, 0]), 1, { moveSpeed: .8 });
    expect(resumed.displacement).toEqual([.8, 0, 0]);
  });
});
