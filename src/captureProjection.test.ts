import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDefaultCalibration, deriveFov } from './cameraMath';
import { applyCalibratedProjection, idealCalibration, makeFrustumGeometry, pixelRayInRenderWorld, projectCalibratedPoint } from './captureProjection';
import type { CameraCalibration } from './types';

function lens(distorted = false): CameraCalibration {
  const result = createDefaultCalibration(); result.intrinsic = [[680, 0, 470], [0, 590, 295], [0, 0, 1]];
  result.fov = deriveFov(result.intrinsic, result.imageWidth, result.imageHeight);
  if (distorted) result.distortion = { ...result.distortion, model: 'brown_conrady_5', coefficients: [.085, -.01, .008, -.004, .002] };
  return result;
}
function camera(calibration: CameraCalibration) { const result = new THREE.PerspectiveCamera(); applyCalibratedProjection(result, calibration); result.updateMatrixWorld(); return result; }

describe('calibrated point-cloud projection and frustum geometry', () => {
  it('matches an off-axis OpenCV K, including integer pixel centres', () => {
    const calibration = lens(), view = camera(calibration), point = new THREE.Vector3(.3, -.2, -2);
    const projected = point.clone().project(view);
    expect(projected.x).toBeCloseTo(2 * ((680 * .15 + 470) + .5) / 1120 - 1, 12);
    expect(projected.y).toBeCloseTo(1 - 2 * ((590 * .1 + 295) + .5) / 700, 12);
  });
  it('places inverse-distorted boundary rays on the exact captured image edges', () => {
    const calibration = lens(true), view = camera(calibration), geometry = makeFrustumGeometry(calibration, .7, 16), positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, i); if (point.z === 0) continue;
      const ndc = projectCalibratedPoint(new THREE.Vector3(point.x, -point.y, -point.z), view, calibration);
      expect(Math.min(Math.abs(Math.abs(ndc.x) - 1), Math.abs(Math.abs(ndc.y) - 1))).toBeLessThan(2e-6);
    }
    geometry.dispose();
  });
  it('changes both the image projection and frustum geometry for nonzero distortion', () => {
    const calibration = lens(true), ideal = idealCalibration(calibration), view = camera(calibration), point = new THREE.Vector3(1, -.6, -2);
    const warped = projectCalibratedPoint(point, view, calibration), pinhole = projectCalibratedPoint(point, view, ideal);
    expect(warped.distanceTo(pinhole)).toBeGreaterThan(.008);
    const a = makeFrustumGeometry(calibration), b = makeFrustumGeometry(ideal);
    const pa = new THREE.Vector3().fromBufferAttribute(a.getAttribute('position'), 1), pb = new THREE.Vector3().fromBufferAttribute(b.getAttribute('position'), 1);
    expect(pa.distanceTo(pb)).toBeGreaterThan(.01); a.dispose(); b.dispose();
  });
  it('ray picking and calibrated labels round-trip after camera movement and roll', () => {
    const calibration = lens(true), view = camera(calibration); view.position.set(2, -1, 3); view.rotation.set(.3, -.45, .4); view.updateMatrixWorld();
    const pixel: [number, number] = [760, 185]; const ray = pixelRayInRenderWorld(pixel, calibration, view); const point = view.position.clone().addScaledVector(ray, 4);
    const ndc = projectCalibratedPoint(point, view, calibration);
    expect(ndc.x).toBeCloseTo(2 * (pixel[0] + .5) / 1120 - 1, 8);
    expect(ndc.y).toBeCloseTo(1 - 2 * (pixel[1] + .5) / 700, 8);
  });
  it('keeps the saved K projection independent of the free navigation aspect', () => {
    const calibration = lens(), view = camera(calibration), expected = view.projectionMatrix.clone();
    view.aspect = .5; view.updateProjectionMatrix(); applyCalibratedProjection(view, calibration);
    expect(view.projectionMatrix.elements).toEqual(expected.elements);
    expect(view.aspect).toBe(1120 / 700);
  });
});
