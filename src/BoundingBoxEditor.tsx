import { Check, Move3D, RotateCcw, Scaling, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { boxError, rotateBoxLocal, translateBoxLocal } from './boxEditing';
import type { BoxEditState, SelectionBox, Vec3 } from './types';

function NumericField({ label, value, step, min, disabled, relative, onBegin, onValue, onValidity }: {
  label: string; value: number; step: number; min?: number; disabled: boolean;
  relative?: boolean; onBegin?: () => void;
  onValue: (value: number) => void; onValidity: (valid: boolean) => void;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  return <input aria-label={label} type="number" step={step} min={min} disabled={disabled} value={text}
    onChange={event => { setText(event.target.value); const next = event.target.valueAsNumber; onValidity(Number.isFinite(next)); if (Number.isFinite(next)) onValue(next); }}
    onBlur={() => {
      focused.current = false;
      if (relative) { setText('0'); onValidity(true); }
      else if (text.trim() && Number.isFinite(Number(text))) setText(String(value));
    }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
    onFocus={event => { focused.current = true; onBegin?.(); if (relative) event.currentTarget.select(); }}/>;
}

export default function BoundingBoxEditor({ edit, name, busy, onChange, onMode, onReset, onCancel, onApply, onObserve }: {
  edit: BoxEditState; name: string; busy: boolean;
  onChange: (box: SelectionBox) => void; onMode: (mode: BoxEditState['mode']) => void;
  onReset: () => void; onCancel: () => void; onApply: () => void; onObserve: () => void;
}) {
  const [invalid, setInvalid] = useState<Set<string>>(() => new Set());
  const [resetRevision, setResetRevision] = useState(0);
  const operationStart = useRef(edit.box);
  const error = boxError(edit.box);
  return <section className="bbox-editor" aria-label="3D 包围盒编辑">
    <div className="bbox-editor-heading"><strong>编辑包围盒 · {name}</strong><button className="icon-button" aria-label="取消包围盒编辑" disabled={busy} onClick={onCancel}><X size={15}/></button></div>
    <div className="bbox-editor-modes" role="group" aria-label="包围盒编辑工具">
      {([{ mode: 'translate', name: '平移', Icon: Move3D }, { mode: 'rotate', name: '旋转', Icon: RotateCcw }, { mode: 'scale', name: '尺寸', Icon: Scaling }] as const).map(({mode, name, Icon}) =>
        <button key={mode} aria-pressed={edit.mode === mode} disabled={busy} onClick={() => onMode(mode)}><Icon size={14}/>{name}</button>)}
    </div>
    <p>XYZ 均为当前框的局部轴。相对位移／旋转实时预览，回车或离开输入框后归零；下一次操作基于更新后的框。点击「观察场景」可移动视角，Esc 返回编辑。</p>
    {(['相对位移', '边长', '相对旋转'] as const).map((label, kind) => <div className="bbox-editor-fields" key={label}><span>{label}{kind === 2 ? ' °' : ' su'}</span>
      {'XYZ'.split('').map((axis, index) => <label key={axis}>{axis}<NumericField key={resetRevision} label={`包围盒${label} ${axis}`} step={kind === 2 ? 1 : .01} min={kind === 1 ? .0002 : undefined}
        disabled={busy} relative={kind !== 1} onBegin={() => { operationStart.current = structuredClone(edit.box); }}
        value={kind === 1 ? Number((edit.box.halfExtents[index] * 2).toFixed(6)) : 0}
        onValidity={valid => setInvalid(previous => { const next = new Set(previous); if (valid) next.delete(`${kind}-${axis}`); else next.add(`${kind}-${axis}`); return next; })}
        onValue={value => {
          if (kind === 1) { const halfExtents: Vec3 = [...edit.box.halfExtents]; halfExtents[index] = value / 2; onChange({ ...edit.box, halfExtents }); }
          else {
            // Anchor to focus-time geometry: typing 1 then 12 previews 12, not 13.
            const delta: Vec3 = [0, 0, 0]; delta[index] = value;
            onChange(kind === 0 ? translateBoxLocal(operationStart.current, delta) : rotateBoxLocal(operationStart.current, delta));
          }
        }}/></label>)}
    </div>)}
    {error && <p role="alert">{error}</p>}
    <p>应用将通过 Slurm 重新筛选框内点簇，成功后清除当前物体轨迹。原物体在任务完成前保留。</p>
    <div className="bbox-editor-actions"><button disabled={busy} onClick={onObserve}>观察场景</button><button disabled={busy} onClick={() => { setInvalid(new Set()); setResetRevision(v => v + 1); onReset(); }}>重置草稿</button><button disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy || !!error || invalid.size > 0} onClick={onApply}><Check size={14}/>{busy ? '提交中…' : '应用并重新筛选'}</button></div>
  </section>;
}
