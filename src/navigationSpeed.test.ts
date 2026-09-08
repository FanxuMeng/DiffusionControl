import { describe, expect, it } from 'vitest';
import { adjustMoveSpeed, DEFAULT_MOVE_SPEED, MAX_MOVE_SPEED, MIN_MOVE_SPEED, wheelSpeedAllowed, wheelSpeedSteps } from './navigationSpeed';
import { advanceFlight, cameraLocalDirection, createFlightState } from './flight';

describe('wheel-controlled translation speed', () => {
  it('accepts only controlled 3D exploration or recording and leaves browser zoom and editing alone', () => {
    const active = { controlled: true, view: '3d' as const, recordState: 'preview' as const, followCamera: false, ctrlKey: false, metaKey: false, editing: false };
    expect(wheelSpeedAllowed(active)).toBe(true);
    expect(wheelSpeedAllowed({ ...active, recordState: 'recording' })).toBe(true);
    for (const recordState of ['countdown', 'paused', 'saving'] as const) expect(wheelSpeedAllowed({ ...active, recordState })).toBe(false);
    for (const flag of ['followCamera', 'ctrlKey', 'metaKey', 'editing'] as const) expect(wheelSpeedAllowed({ ...active, [flag]: true })).toBe(false);
    expect(wheelSpeedAllowed({ ...active, controlled: false })).toBe(false);
    expect(wheelSpeedAllowed({ ...active, view: '2d' })).toBe(false);
  });
  it('increases on upward scrolling and returns to the original speed on equal downward scrolling', () => {
    const faster = adjustMoveSpeed(DEFAULT_MOVE_SPEED, wheelSpeedSteps(-100, 0));
    expect(faster).toBeCloseTo(0.42, 12);
    expect(adjustMoveSpeed(faster, wheelSpeedSteps(100, 0))).toBeCloseTo(DEFAULT_MOVE_SPEED, 12);
  });

  it('normalizes pixel, line and page devices and preserves fractional event totals', () => {
    expect(wheelSpeedSteps(-100, 0)).toBe(wheelSpeedSteps(-3, 1));
    expect(wheelSpeedSteps(-100, 0)).toBe(wheelSpeedSteps(-1, 2));
    let split = DEFAULT_MOVE_SPEED;
    for (let index = 0; index < 40; index++) split = adjustMoveSpeed(split, wheelSpeedSteps(-2.5, 0));
    expect(split).toBeCloseTo(adjustMoveSpeed(DEFAULT_MOVE_SPEED, wheelSpeedSteps(-100, 0)), 12);
  });

  it('bounds sustained scrolling and ignores invalid input', () => {
    expect(adjustMoveSpeed(DEFAULT_MOVE_SPEED, 10000)).toBe(MAX_MOVE_SPEED);
    expect(adjustMoveSpeed(DEFAULT_MOVE_SPEED, -10000)).toBe(MIN_MOVE_SPEED);
    expect(adjustMoveSpeed(MIN_MOVE_SPEED, 1)).toBeGreaterThan(MIN_MOVE_SPEED);
    expect(adjustMoveSpeed(MAX_MOVE_SPEED, -1)).toBeLessThan(MAX_MOVE_SPEED);
    expect(wheelSpeedSteps(NaN, 0)).toBe(0);
    expect(wheelSpeedSteps(100, 9)).toBe(0);
    expect(adjustMoveSpeed(DEFAULT_MOVE_SPEED, NaN)).toBe(DEFAULT_MOVE_SPEED);
  });

  it('changes held-key speed without moving a stopped controller or changing diagonal normalization', () => {
    const moveSpeed = adjustMoveSpeed(DEFAULT_MOVE_SPEED, wheelSpeedSteps(-100, 0));
    const rest = advanceFlight(createFlightState(), { direction: null }, 1, { moveSpeed });
    expect(rest.displacement).toEqual([0, 0, 0]);
    const direction = cameraLocalDirection(new Set(['KeyW', 'KeyD', 'ShiftLeft']), [0, 0, 0, 1]);
    const moved = advanceFlight(rest.state, { direction }, 2, { moveSpeed });
    expect(Math.hypot(...moved.displacement)).toBeCloseTo(2 * moveSpeed, 12);
    expect(advanceFlight(moved.state, { direction: null }, 1, { moveSpeed }).state.velocity).toEqual([0, 0, 0]);
  });
});
