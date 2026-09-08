import type { Face, Vec3 } from './types';

/** Shared reference-face palette for object cards, bounding boxes and axes. */
export const FACE_COLORS: Record<Face, string> = {
  '+x': '#ec8b7f', '-x': '#ad6367',
  '+y': '#96b59a', '-y': '#587d70',
  '+z': '#91acd8', '-z': '#686caa',
};

export const OBJECT_FACES: ReadonlyArray<{ face: Face; color: string; name: string }> = [
  { face: '+x', color: FACE_COLORS['+x'], name: 'bbox 参考 X 轴正向面' },
  { face: '-x', color: FACE_COLORS['-x'], name: 'bbox 参考 X 轴负向面' },
  { face: '+y', color: FACE_COLORS['+y'], name: 'bbox 参考 Y 轴正向面' },
  { face: '-y', color: FACE_COLORS['-y'], name: 'bbox 参考 Y 轴负向面' },
  { face: '+z', color: FACE_COLORS['+z'], name: 'bbox 参考 Z 轴正向面' },
  { face: '-z', color: FACE_COLORS['-z'], name: 'bbox 参考 Z 轴负向面' },
];

const DIRECTIONS: Record<Face, Vec3> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};

/** Coordinates are in the initial bbox frame, independent of the chosen front.
 * The bbox parent applies R(t) R(0)^-1 and the current center to these points. */
export function referenceAxesForBox(halfExtents: Vec3) {
  const length = Math.max(.22, Math.min(.85, Math.max(...halfExtents) * .72));
  return OBJECT_FACES.map(({ face, color }) => ({
    face, color, length, direction: [...DIRECTIONS[face]] as Vec3,
    labelPosition: DIRECTIONS[face].map(value => value * (length + .09)) as Vec3,
  }));
}
