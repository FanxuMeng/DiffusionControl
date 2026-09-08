import { useMemo, useState } from 'react';
import { cameraCompatibility, createCameraIntrinsics, createDefaultCalibration, deriveFov, distortNormalized, validateCameraCalibration } from './cameraMath';
import type { CameraCalibration, CameraIntrinsicsTrack, Mat3 } from './types';
import './lens.css';

interface Props {
  track: CameraIntrinsicsTrack | null; reference: CameraCalibration | null;
  onSave: (track: CameraIntrinsicsTrack) => void; onCancel: () => void;
}

export default function LensEditor({ track, reference, onSave, onCancel }: Props) {
  const [cal, setCal] = useState<CameraCalibration>(() => structuredClone(track?.calibration ?? reference ?? createDefaultCalibration()));
  const [error, setError] = useState('');
  const fov = useMemo(() => deriveFov(cal.intrinsic, cal.imageWidth, cal.imageHeight), [cal]);
  const patch = (change: (next: CameraCalibration) => void) => {
    const next = structuredClone(cal); change(next);
    next.fov = deriveFov(next.intrinsic, next.imageWidth, next.imageHeight);
    setCal(next); setError('');
  };
  const setFov = (degrees: number) => patch(next => {
    const cy = next.intrinsic[1][2];
    let low = .01, high = 1e7;
    for (let i = 0; i < 70; i++) {
      const fy = (low + high) / 2;
      const angle = (Math.atan((cy + .5) / fy) + Math.atan((next.imageHeight - .5 - cy) / fy)) * 180 / Math.PI;
      if (angle > degrees) low = fy; else high = fy;
    }
    const fy = (low + high) / 2;
    next.intrinsic[0][0] *= fy / next.intrinsic[1][1]; next.intrinsic[1][1] = fy;
  });
  const field = (label: string, value: number, onChange: (value: number) => void, min: number, max: number, step = .1) =>
    <label className="field" key={label}>{label}<input type="number" aria-label={label} value={Number(value.toFixed(5))} min={min} max={max} step={step} onChange={e => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(n); }}/></label>;
  const warnings = cameraCompatibility({ ...(track || createCameraIntrinsics(cal)), calibration: cal }, reference);
  const save = () => {
    try {
      const calibration = validateCameraCalibration({ ...cal, revision: (track?.calibration.revision ?? cal.revision) + 1, fov, source: 'editor_fixed_lens', distortion: { ...cal.distortion, state: 'assumed' } });
      const next = track ? { ...track, revision: track.revision + 1, calibration } : createCameraIntrinsics(calibration);
      onSave(next);
    } catch (err) { setError(err instanceof Error ? err.message : '镜头参数无效'); }
  };
  return <>
    <h2 id="modal-title">固定镜头参数</h2>
    <p>整条相机轨迹使用同一组参数。修改输出镜头会同步轨迹与预览，参考图标定独立保留。</p>
    <div className="lens-fields">
      {field('图像宽度 (px)', cal.imageWidth, width => patch(n => { const s = width / n.imageWidth; n.intrinsic[0][0] *= s; n.intrinsic[0][2] = (n.intrinsic[0][2] + .5) * s - .5; n.imageWidth = width; }), 64, 8192, 1)}
      {field('图像高度 (px)', cal.imageHeight, height => patch(n => { const s = height / n.imageHeight; n.intrinsic[1][1] *= s; n.intrinsic[1][2] = (n.intrinsic[1][2] + .5) * s - .5; n.imageHeight = height; }), 64, 8192, 1)}
      {field('垂直 FOV (°)', fov.verticalDegrees, setFov, 5, 140, 1)}
      <div className="lens-derived">水平 FOV <strong>{fov.horizontalDegrees.toFixed(2)}°</strong><small>由 K 与图像边界计算</small></div>
      {(['fx', 'fy', 'cx', 'cy'] as const).map((name, index) => {
        const row = index % 2, col = index < 2 ? row : 2;
        return field(`${name} (px)`, cal.intrinsic[row][col], v => patch(n => { n.intrinsic[row][col] = v; }), index < 2 ? 1 : 0, index < 2 ? 100000 : (row ? cal.imageHeight : cal.imageWidth) - 1);
      })}
    </div>
    <div className="lens-matrix" aria-label="相机内参矩阵 K"><span>K =</span><pre>{cal.intrinsic.map(row => row.map(n => n.toFixed(2).padStart(9)).join(' ')).join('\n')}</pre></div>
    <label className="field">畸变模型<select aria-label="畸变模型" value={cal.distortion.model} onChange={e => patch(n => { n.distortion.model = e.target.value as CameraCalibration['distortion']['model']; if (e.target.value === 'none') n.distortion.coefficients = [0, 0, 0, 0, 0]; })}><option value="none">无畸变（理想针孔）</option><option value="brown_conrady_5">Brown–Conrady 五参数</option></select></label>
    {cal.distortion.model === 'brown_conrady_5' && <div className="distortion-fields">{cal.distortion.coefficientOrder.map((name, i) => field(name, cal.distortion.coefficients[i], v => patch(n => { n.distortion.coefficients[i] = v; }), -.5, .5, .005))}</div>}
    <LensGrid calibration={cal}/>
    <small className="lens-caption">灰线：理想网格；蓝线：当前畸变模型。固定参数是编辑值，未经真实相机标定。</small>
    {warnings.length > 0 && <div className="lens-warnings">{warnings.map(w => <p key={w}>{w}</p>)}</div>}
    {error && <p role="alert" className="lens-error">{error}</p>}
    <div className="modal-actions"><button className="secondary-button" disabled={!reference} onClick={() => { if (reference) { setCal(structuredClone(reference)); setError(''); } }}>恢复参考镜头</button><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" onClick={save}>保存镜头与轨迹</button></div>
  </>;
}

export function LensGrid({ calibration: c }: { calibration: CameraCalibration }) {
  const ideal: string[] = [], distorted: string[] = [];
  const project = (u: number, v: number, warp: boolean) => {
    let x = (u - c.intrinsic[0][2]) / c.intrinsic[0][0], y = (v - c.intrinsic[1][2]) / c.intrinsic[1][1];
    if (warp) [x, y] = distortNormalized(x, y, c.distortion);
    return `${20 + (x * c.intrinsic[0][0] + c.intrinsic[0][2]) / c.imageWidth * 260},${15 + (y * c.intrinsic[1][1] + c.intrinsic[1][2]) / c.imageHeight * 150}`;
  };
  for (let line = 0; line <= 6; line++) for (const vertical of [true, false]) {
    for (const warp of [false, true]) {
      const points = Array.from({ length: 31 }, (_, i) => project((vertical ? line / 6 : i / 30) * c.imageWidth, (vertical ? i / 30 : line / 6) * c.imageHeight, warp)).join(' ');
      (warp ? distorted : ideal).push(points);
    }
  }
  return <svg className="lens-grid" viewBox="0 0 300 180" role="img" aria-label="理想与畸变镜头网格对照">{ideal.map((p, i) => <polyline key={`i${i}`} points={p} stroke="#9ca3af" fill="none" strokeWidth=".65"/>)}{distorted.map((p, i) => <polyline key={`d${i}`} points={p} stroke="#2563a8" fill="none" strokeWidth="1"/>)}</svg>;
}
