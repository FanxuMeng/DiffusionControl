import { useEffect, useState } from 'react';
import { Download, FolderOpen, LoaderCircle, RefreshCw, RotateCcw, Save, Trash2, Upload } from 'lucide-react';
import type { Project } from './types';
import { clusterProject, importProjectJson, readProjectTrash, uploadProjectPackage, waitOperation, type ClusterListing, type ClusterSnapshot } from './projects';
import { workflowApi } from './workflow/api';

interface Props {
  project: Project | null; initialMode: 'import' | 'export';
  onImport: (project: Project) => void; onClose: () => void;
}
export default function ProjectTransfer({ project, initialMode, onImport, onClose }: Props) {
  const [mode, setMode] = useState(initialMode), [listing, setListing] = useState<ClusterListing | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [trash] = useState(() => { try { return readProjectTrash(localStorage); } catch { return []; } });
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '文件操作失败'); } finally { setBusy(false); } };
  const refresh = async () => { const value = await workflowApi<ClusterListing>('/projects'); setListing(value); return value; };
  useEffect(() => { void refresh().catch(e => setError(String(e.message))); }, []);
  const current = listing?.projects.find(row => row.projectId === project?.id);
  const apply = (value: Project) => { onImport(clusterProject(value)); onClose(); };
  const save = async () => {
    if (!project) return;
    const value = await workflowApi<ClusterSnapshot>('/projects/save', 'POST', { project, revision: current?.revision ?? 0 });
    await refresh(); setMessage(`「${value.name}」已保存到集群，第 ${value.revision} 版。`);
  };
  const makePackage = async (download: boolean) => {
    if (!project) return;
    const op = await workflowApi<{ id: string }>('/projects/export', 'POST', { project });
    const result = await waitOperation<{ name: string; url: string; serverPath: string }>(op, setMessage);
    if (download) { const a = document.createElement('a'); a.href = result.url; a.download = `${project.name}.dcproject.zip`; a.click(); }
    await refresh(); setMessage(`完整项目包已保存：${result.serverPath}${download ? '；已开始下载。' : ''}`);
  };
  const restorePackage = async (name: string) => {
    const info = await workflowApi<{ name: string; revision: number }>(`/projects/packages/${encodeURIComponent(name)}/info`);
    if (info.revision && !window.confirm(`集群已有「${info.name}」第 ${info.revision} 版。用包内项目恢复为新版本？旧快照会保留。`)) return;
    const op = await workflowApi<{ id: string }>('/projects/import', 'POST', { name, revision: info.revision });
    const result = await waitOperation<ClusterSnapshot>(op, setMessage);
    apply(result.project);
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.name.endsWith('.zip')) {
      await restorePackage(await uploadProjectPackage(file, setMessage));
    } else {
      const projects = importProjectJson(JSON.parse(await file.text()));
      projects.forEach(onImport); onClose();
    }
  };
  return <div className="modal-backdrop"><section className="modal project-transfer" role="dialog" aria-modal="true" aria-labelledby="project-transfer-title">
    <h2 id="project-transfer-title">项目导入与导出</h2>
    <div className="project-transfer-tabs"><button className={mode === 'import' ? 'active' : ''} disabled={busy} onClick={() => setMode('import')}>导入／恢复</button><button className={mode === 'export' ? 'active' : ''} disabled={busy || !project} onClick={() => setMode('export')}>保存／导出</button></div>
    {mode === 'export' && project && <><p>当前项目：<strong>{project.name}</strong>。本机自动保存与集群保存分别管理。</p>
      <button className="export-option" disabled={busy || !listing} onClick={() => void run(save)}><Save/><div><strong>保存项目到集群</strong><small>保存首帧、轨迹和生成配置的项目快照；资产保留在集群。</small></div></button>
      <button className="export-option" disabled={busy} onClick={() => void run(() => makePackage(true))}><Download/><div><strong>导出完整包到本地</strong><small>包含首帧、点云、掩码、轨迹和已完成结果；需要连接集群。</small></div></button>
      <button className="export-option" disabled={busy} onClick={() => void run(() => makePackage(false))}><FolderOpen/><div><strong>导出完整包到集群</strong><small>保存在项目包目录，之后可下载或重新导入。</small></div></button>
      <p>运行中的任务结束后才能完整打包。包内不包含模型权重和运行环境。</p></>}
    {mode === 'import' && <>
      <label className={`primary-button project-file-select ${busy ? 'disabled' : ''}`}><Upload size={15}/>从本地导入<input type="file" accept=".zip,.json" disabled={busy} onChange={e => void run(() => importFile(e.target.files?.[0]))}/></label>
      <p>选择完整 .dcproject.zip。旧 .prototype.json 只恢复配置，真实资产仍依赖原集群服务。</p>
      <div className="project-transfer-heading"><strong>集群项目与回收记录</strong><button className="text-button" disabled={busy} onClick={() => void run(async () => { await refresh(); })}><RefreshCw size={14}/>刷新</button></div>
      {listing?.projects.map(row => <div className="project-server-row" key={row.key}><div><strong>{row.name}</strong><small>{row.deleted ? '已删除 · 可恢复' : '集群快照'} · 第 {row.revision} 版</small></div><button disabled={busy} className="secondary-button" onClick={() => void run(async () => {
        const value = await workflowApi<ClusterSnapshot>(`/projects/snapshots/${row.key}`);
        if (row.deleted) await workflowApi('/projects/save', 'POST', { project: value.project, revision: value.revision });
        apply(value.project);
      })}>{row.deleted ? <RotateCcw size={14}/> : <FolderOpen size={14}/>} {row.deleted ? '恢复' : '打开'}</button>{!row.deleted && <button aria-label={`删除集群快照 ${row.name}`} className="icon-button" disabled={busy} onClick={() => { if (window.confirm(`将集群项目「${row.name}」移入回收记录？作业与产物会保留。`)) void run(async () => { await workflowApi(`/projects/snapshots/${row.key}/delete`, 'POST', { revision: row.revision }); await refresh(); }); }}><Trash2 size={15}/></button>}</div>)}
      {listing && !listing.projects.length && <p>集群尚未保存项目。</p>}
      <strong>集群完整项目包</strong>{listing?.packages.map(row => <div className="project-server-row" key={row.name}><div><strong title={row.name}>{row.name}</strong><small>{(row.size / 1024 ** 2).toFixed(1)} MiB</small></div><button className="secondary-button" disabled={busy} onClick={() => void run(() => restorePackage(row.name))}>导入</button></div>)}
      {listing && <p className="project-server-root">项目目录：{listing.root}<br/>可将完整包放入 packages 子目录后刷新列表。</p>}
      {!!trash.length && <><strong>本机回收记录</strong>{trash.map((row, index) => <div className="project-server-row" key={index}><div><strong>{row.project.name}</strong><small>{new Date(row.deletedAt).toLocaleString()}</small></div><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { onImport(row.project); onClose(); })}>恢复</button></div>)}</>}
    </>}
    {busy && <p role="status"><LoaderCircle size={15} className="spin"/> {message || '正在处理，请稍候…'}</p>}
    {!busy && message && <p role="status">{message}</p>}{error && <p role="alert" className="project-error">{error}</p>}
    <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></div>
  </section></div>;
}
