import { useRef, useState, type PointerEvent } from 'react';
import type { SamPrompts } from './types';

export function imageCoordinate(x: number, y: number, containerWidth: number, containerHeight: number, width: number, height: number): [number, number] | null {
  const scale = Math.min(containerWidth / width, containerHeight / height);
  const left = (containerWidth - width * scale) / 2, top = (containerHeight - height * scale) / 2;
  if (x < left || y < top || x >= left + width * scale || y >= top + height * scale) return null;
  return [Math.max(0, Math.min(width - 1, (x - left) / scale - .5)), Math.max(0, Math.min(height - 1, (y - top) / scale - .5))];
}
export default function SamPromptOverlay({ width, height, prompts, mode, onChange }: {
  width: number; height: number; prompts: SamPrompts; mode: 'positive' | 'negative' | 'box'; onChange: (value: SamPrompts) => void;
}) {
  const start = useRef<[number, number] | null>(null), [drag, setDrag] = useState<[number, number, number, number] | null>(null);
  const point = (event: PointerEvent<SVGSVGElement>) => { const bounds = event.currentTarget.getBoundingClientRect(); return imageCoordinate(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height, width, height); };
  const box = drag || prompts.box;
  return <svg className="sam-prompt-overlay" viewBox={`-.5 -.5 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-label="SAM2 图像提示区域" onContextMenu={event => event.preventDefault()}
    onPointerDown={event => { const p = point(event); if (!p) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); if (mode === 'box') { start.current = p; setDrag([p[0], p[1], p[0], p[1]]); } else if (prompts.points.length < 100) onChange({ ...prompts, points: [...prompts.points, [p[0], p[1], event.button === 2 || mode === 'negative' ? 0 : 1]] }); }}
    onPointerMove={event => { const p = point(event); if (start.current && p) setDrag([Math.min(start.current[0], p[0]), Math.min(start.current[1], p[1]), Math.max(start.current[0], p[0]), Math.max(start.current[1], p[1])]); }}
    onPointerUp={() => { if (start.current && drag && drag[2] - drag[0] >= 1 && drag[3] - drag[1] >= 1) onChange({ ...prompts, box: drag }); start.current = null; setDrag(null); }}
    onPointerCancel={() => { start.current = null; setDrag(null); }}>
    {prompts.points.map(([x, y, label], i) => <g key={i}><circle cx={x} cy={y} r={Math.max(width / 150, 3)} fill={label ? '#54e49e' : '#ff687b'} stroke="white" strokeWidth={width / 700} /><text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={Math.max(width / 100, 9)} fill="#17221c">{label ? '+' : '−'}</text></g>)}
    {box && <rect x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]} fill="none" stroke="#ffd27a" strokeWidth={Math.max(width / 400, 1)} />}
  </svg>;
}
