import { describe, expect, it } from 'vitest';
import { createCameraIntrinsics, createDefaultCalibration, deriveFov, distortNormalized, exportCameraIntrinsics, pixelToCameraRay, validateCameraCalibration, validateCameraIntrinsics } from './cameraMath';

describe('saved camera projection', () => {
  it('uses integer pixel centers and image edges at half pixels', () => {
    const calibration = createDefaultCalibration();
    expect(calibration.fov.verticalDegrees).toBeCloseTo(55, 10);
    expect(pixelToCameraRay([559.5, 349.5], calibration)).toEqual([0, 0, 1]);
    const top = pixelToCameraRay(calibration, 559.5, -.5);
    expect(Math.atan2(-top[1], top[2]) * 180 / Math.PI).toBeCloseTo(27.5, 10);
    const bottom = pixelToCameraRay([559.5, 699.5], calibration);
    expect(bottom[1]).toBeCloseTo(-top[1]);
    expect(bottom[2]).toBeCloseTo(top[2]);
  });

  it('round-trips fixed camera metadata including all five nonzero coefficients', () => {
    const calibration = createDefaultCalibration();
    calibration.distortion = { ...calibration.distortion, model: 'brown_conrady_5', coefficients: [.05, .004, .001, -.001, .0001] };
    const track = createCameraIntrinsics(validateCameraCalibration(calibration));
    const restored = validateCameraIntrinsics(exportCameraIntrinsics(track));
    expect(restored).toEqual(track);
    for (const [u, v] of [[-.5, -.5], [1119.5, 699.5], [140, 470], [560, 350]]) {
      const ray = pixelToCameraRay([u, v], calibration);
      const distorted = distortNormalized(ray[0] / ray[2], ray[1] / ray[2], calibration.distortion);
      expect(distorted[0] * calibration.intrinsic[0][0] + calibration.intrinsic[0][2]).toBeCloseTo(u, 6);
      expect(distorted[1] * calibration.intrinsic[1][1] + calibration.intrinsic[1][2]).toBeCloseTo(v, 6);
      expect(Math.hypot(...ray)).toBeCloseTo(1, 12);
    }
  });

  it('rejects inconsistent FOV, truncated distortion, unsupported lenses and unusable pinhole fields', () => {
    const fov = createDefaultCalibration(); fov.fov.verticalDegrees = 60;
    expect(() => validateCameraCalibration(fov)).toThrow('FOV 与 K');
    const invalid = createDefaultCalibration();
    expect(() => validateCameraCalibration({ ...invalid, distortion: { ...invalid.distortion, coefficients: [0, 0] } })).toThrow('五个系数');
    const wide = createDefaultCalibration(); wide.intrinsic[0][0] = wide.intrinsic[1][1] = 1;
    wide.fov = deriveFov(wide.intrinsic, wide.imageWidth, wide.imageHeight);
    expect(() => validateCameraCalibration(wide)).toThrow('170');
    expect(() => validateCameraIntrinsics({ ...createCameraIntrinsics(), mode: 'keyframed' })).toThrow('固定镜头');
  });

  it('rejects finite coefficients when the image-domain projection is not safely invertible', () => {
    const calibration = createDefaultCalibration();
    calibration.distortion = { ...calibration.distortion, model: 'brown_conrady_5', coefficients: [-.5, 0, 0, 0, 0] };
    expect(() => validateCameraCalibration(calibration)).toThrow(/可逆范围|折叠|不稳定/);
    calibration.distortion.coefficients = [.03, 0, .0005, -.0005, 0];
    expect(validateCameraCalibration(calibration).distortion.coefficients).toEqual(calibration.distortion.coefficients);
  });
});
