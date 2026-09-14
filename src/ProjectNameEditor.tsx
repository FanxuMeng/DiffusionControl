import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';

export default function ProjectNameEditor({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(name), [error, setError] = useState('');
  if (!editing) return <div className="dcp-project-caption"><span className="dcp-project-name" title={name}>{name}</span><button className="dcp-icon-button" aria-label={`重命名项目 ${name}`} title="修改场景名称" disabled={disabled} onClick={() => { setDraft(name); setError(''); setEditing(true); }}><Pencil size={12}/></button></div>;
  return <form className="dcp-project-rename" onSubmit={e => { e.preventDefault(); if (disabled) return; try { onSave(draft); setEditing(false); } catch (e) { setError(e instanceof Error ? e.message : '名称无效'); } }}>
    <input aria-label="项目场景名称" autoFocus value={draft} maxLength={200} disabled={disabled} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }}/>
    <button className="dcp-icon-button" type="submit" disabled={disabled} aria-label="保存项目名称"><Check size={13}/></button><button className="dcp-icon-button" type="button" aria-label="取消重命名" onClick={() => setEditing(false)}><X size={13}/></button>
    {error && <small role="alert">{error}</small>}
  </form>;
}
