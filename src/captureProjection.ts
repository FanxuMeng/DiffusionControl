import * as THREE from 'three';
import { distortNormalized, pixelToCameraRay } from './cameraMath';
import type { CameraCalibration, Vec2, Vec3 } from './types';

/** OpenCV pixel centres are integers; image edges are -0.5 through size-0.5. */
export function applyCalibratedProjection(camera: THREE.PerspectiveCamera, calibration: CameraCalibration) {
  const { imageWidth: w, imageHeight: h, intrinsic: k } = calibration;
  const n = camera.near, f = camera.far;
  camera.aspect = w / h;
  camera.projectionMatrix.set(
    2 * k[0][0] / w, -2 * k[0][1] / w, 1 - 2 * (k[0][2] + .5) / w, 0,
    -2 * k[1][0] / h, 2 * k[1][1] / h, 2 * (k[1][2] + .5) / h - 1, 0,
    0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),
    0, 0, -1, 0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
export function hasDistortion(calibration: CameraCalibration) { return calibration.distortion.model !== 'none' && calibration.distortion.coefficients.some(value => Math.abs(value) > 1e-12); }
export function idealCalibration(calibration: CameraCalibration): CameraCalibration { return { ...calibration, distortion: { ...calibration.distortion, model: 'none', coefficients: [0, 0, 0, 0, 0] } }; }

export function createCaptureProjection() {
  const uniforms = {
    dcLensEnabled: { value: 0 }, dcImageSize: { value: new THREE.Vector2(1120, 700) },
    dcK0: { value: new THREE.Vector3() }, dcK1: { value: new THREE.Vector3() },
    dcRadial: { value: new THREE.Vector3() }, dcTangential: { value: new THREE.Vector2() }, dcRayDomain: { value: new THREE.Vector4(-100, 100, -100, 100) },
  };
  const installed = new WeakSet<THREE.Material>(); let rayDomainKey = '';
  return {
    update(calibration: CameraCalibration | null) {
      uniforms.dcLensEnabled.value = calibration && hasDistortion(calibration) ? 1 : 0;
      if (!calibration) return;
      uniforms.dcImageSize.value.set(calibration.imageWidth, calibration.imageHeight);
      uniforms.dcK0.value.fromArray(calibration.intrinsic[0]); uniforms.dcK1.value.fromArray(calibration.intrinsic[1]);
      const [k1, k2, p1, p2, k3] = calibration.distortion.coefficients;
      uniforms.dcRadial.value.set(k1, k2, k3); uniforms.dcTangential.value.set(p1, p2);
      const nextKey = JSON.stringify([calibration.intrinsic, calibration.imageWidth, calibration.imageHeight, calibration.distortion]);
      if (hasDistortion(calibration) && nextKey !== rayDomainKey) {
        rayDomainKey = nextKey; let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        // Clip to the principal inverse-image branch. Far outside a barrel lens's
        // valid domain, the polynomial can fold unrelated offscreen points back in.
        for (let i = 0; i <= 64; i++) for (const edge of [0, 1, 2, 3]) {
          const x = edge === 0 ? -.5 : edge === 1 ? calibration.imageWidth - .5 : i / 64 * calibration.imageWidth - .5;
          const y = edge === 2 ? -.5 : edge === 3 ? calibration.imageHeight - .5 : i / 64 * calibration.imageHeight - .5;
          const ray = pixelToCameraRay([x, y], calibration), nx = ray[0] / ray[2], ny = ray[1] / ray[2];
          minX = Math.min(minX, nx); maxX = Math.max(maxX, nx); minY = Math.min(minY, ny); maxY = Math.max(maxY, ny);
        }
        const padX = (maxX - minX) * .02, padY = (maxY - minY) * .02; uniforms.dcRayDomain.value.set(minX - padX, maxX + padX, minY - padY, maxY + padY);
      }
    },
    install(root: THREE.Object3D) {
      root.traverse(node => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points)) return;
        // An ideal frustum may exclude points that a distorted lens brings into frame.
        node.frustumCulled = false;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (installed.has(material)) continue; installed.add(material);
          material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = `uniform float dcLensEnabled;\nuniform vec2 dcImageSize;\nuniform vec3 dcK0;\nuniform vec3 dcK1;\nuniform vec3 dcRadial;\nuniform vec2 dcTangential;\nuniform vec4 dcRayDomain;\n` + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
              if (dcLensEnabled > 0.5 && -mvPosition.z > 0.00001) {
                vec2 p = vec2(mvPosition.x, -mvPosition.y) / -mvPosition.z;
                if (p.x < dcRayDomain.x || p.x > dcRayDomain.y || p.y < dcRayDomain.z || p.y > dcRayDomain.w) {
                  gl_Position.xy = vec2(4.0) * gl_Position.w;
                } else {
                float r2 = dot(p, p);
                float radial = 1.0 + dcRadial.x * r2 + dcRadial.y * r2 * r2 + dcRadial.z * r2 * r2 * r2;
                vec2 distorted = p * radial + vec2(
                  2.0 * dcTangential.x * p.x * p.y + dcTangential.y * (r2 + 2.0 * p.x * p.x),
                  dcTangential.x * (r2 + 2.0 * p.y * p.y) + 2.0 * dcTangential.y * p.x * p.y
                );
                vec3 normalizedPixel = vec3(distorted, 1.0);
                vec2 pixel = vec2(dot(dcK0, normalizedPixel), dot(dcK1, normalizedPixel));
                vec2 ndc = vec2(2.0 * (pixel.x + 0.5) / dcImageSize.x - 1.0, 1.0 - 2.0 * (pixel.y + 0.5) / dcImageSize.y);
                gl_Position.xy = ndc * gl_Position.w;
                }
              }
            `);
          };
          material.customProgramCacheKey = () => 'diffusion-control-brown-conrady-5-v2';
          material.needsUpdate = true;
        }
      });
    },
  };
}

/** CPU projection for DOM labels, using the same Brown forward map as the GPU. */
export function projectCalibratedPoint(worldPoint: THREE.Vector3, camera: THREE.PerspectiveCamera, calibration: CameraCalibration | null) {
  if (!calibration) return worldPoint.clone().project(camera);
  const view = worldPoint.clone().applyMatrix4(camera.matrixWorldInverse);
  if (view.z >= -camera.near) return new THREE.Vector3(2, 2, 2);
  const distorted = distortNormalized([view.x / -view.z, -view.y / -view.z], calibration.distortion);
  const k = calibration.intrinsic;
  const u = k[0][0] * distorted[0] + k[0][1] * distorted[1] + k[0][2];
  const v = k[1][0] * distorted[0] + k[1][1] * distorted[1] + k[1][2];
  return new THREE.Vector3(2 * (u + .5) / calibration.imageWidth - 1, 1 - 2 * (v + .5) / calibration.imageHeight, worldPoint.clone().project(camera).z);
}

/** Dense edge segments retain the shape of a nonlinear inverse-projected boundary. */
export function makeFrustumGeometry(calibration: CameraCalibration, depth = .65, edgeSegments = 12) {
  const w = calibration.imageWidth, h = calibration.imageHeight;
  const corners: Vec2[] = [[-.5, -.5], [w - .5, -.5], [w - .5, h - .5], [-.5, h - .5]];
  const points: THREE.Vector3[] = [];
  const at = (pixel: Vec2) => { const ray = pixelToCameraRay(pixel, calibration); return new THREE.Vector3(...ray).multiplyScalar(depth / ray[2]); };
  corners.forEach((corner, i) => {
    points.push(new THREE.Vector3(), at(corner));
    const next = corners[(i + 1) % corners.length];
    for (let j = 0; j < edgeSegments; j++) {
      const a = j / edgeSegments, b = (j + 1) / edgeSegments;
      points.push(at([corner[0] + (next[0] - corner[0]) * a, corner[1] + (next[1] - corner[1]) * a]), at([corner[0] + (next[0] - corner[0]) * b, corner[1] + (next[1] - corner[1]) * b]));
    }
  });
  return new THREE.BufferGeometry().setFromPoints(points);
}

export function pixelRayInRenderWorld(pixel: Vec2, calibration: CameraCalibration, camera: THREE.PerspectiveCamera): THREE.Vector3 {
  const ray: Vec3 = pixelToCameraRay(pixel, calibration);
  return new THREE.Vector3(ray[0], -ray[1], -ray[2]).applyQuaternion(camera.quaternion).normalize();
}
