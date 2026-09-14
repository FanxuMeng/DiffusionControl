import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getGlobalExecution, workflowApi } from './api';
import type { GlobalExecution } from './types';
import type { GenerationState, SlurmExecutionConfig } from '../generation/types';
import { normalizeSlurmScript } from '../generation/slurm';

const Context = createContext<{ value: GlobalExecution | null; error: string; reload: () => Promise<void> }>({ value: null, error: '', reload: async () => {} });
export const useExecutionSettings = () => useContext(Context);
export function ExecutionSettingsProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<GlobalExecution | null>(null), [error, setError] = useState('');
  const reload = useCallback(async () => { try { setValue(await getGlobalExecution()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : '无法读取全局设置'); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  return <Context.Provider value={{ value, error, reload }}>{children}</Context.Provider>;
}
export function applyGlobalExecution(state: GenerationState, global: GlobalExecution | null): GenerationState {
  if (!global) return state;
  return { ...state, projectProfiles: state.projectProfiles.map(profile => profile.useGlobalExecution ? {
    ...profile, execution: { ...profile.execution, scriptName: global.scriptName, scriptContent: global.scriptContent },
  } : profile) };
}
export function GlobalExecutionPanel({ locked, source, onNotify }: { locked: boolean; source?: SlurmExecutionConfig; onNotify: (message: string) => void }) {
  const { value, error, reload } = useExecutionSettings();
  const [draft, setDraft] = useState<GlobalExecution | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try { await workflowApi('/settings/execution', 'PUT', draft); await reload(); onNotify('全局 Slurm 设置已保存，后续提交使用新脚本。'); }
    catch (e) { onNotify(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section className="dcp-panel workflow-panel"><details>
    <summary>全局设置 · Slurm</summary>
    <p>分区、GPU 数量、时限与公共脚本在这里设置；各任务分别选择推理环境。</p>
    {error && <p role="alert">{error}</p>}
    <button className="dcp-button" onClick={() => void reload()} disabled={busy}>刷新设置</button>
    {draft && <><label>脚本文件名<input value={draft.scriptName} disabled={locked || busy} onChange={e => setDraft({ ...draft, scriptName: e.target.value })} /></label>
      <label>公共 Bash 脚本<textarea rows={15} value={draft.scriptContent} disabled={locked || busy} spellCheck={false} onChange={e => setDraft({ ...draft, scriptContent: normalizeSlurmScript(e.target.value) })} /></label>
      <div className="workflow-actions"><button className="dcp-button" disabled={locked || busy} onClick={() => void save()}>保存 · 当前版本 {draft.revision}</button>
        <button className="dcp-button" disabled={locked || busy || !source} onClick={() => source && setDraft({ ...draft, scriptName: source.scriptName, scriptContent: source.scriptContent })}>从当前生成配置载入</button></div></>}
  </details></section>;
}
