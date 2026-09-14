import { migratePrototypeWorkspace, validatePrototypeProject } from './model';
import type { Project } from './types';
import { workflowApi } from './workflow/api';

export interface ClusterSnapshot { key: string; projectId: string; name: string; revision: number; deleted: boolean; updatedAt: string; project: Project }
export interface ClusterListing { root: string; projects: Omit<ClusterSnapshot, 'project'>[]; packages: { name: string; size: number }[] }
export const TRASH_KEY = 'diffusioncontrol.projects.trash.v1';
export function withoutDemoProjects(projects: Project[]): Project[] { return projects.filter(project => project.demoScene === null); }
export function renameProject(project: Project, rawName: string): Project {
  const name = rawName.trim();
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('项目名称须为 1–200 字符，不能包含换行或控制字符。');
  return name === project.name ? project : { ...project, name, updatedAt: new Date().toISOString() };
}
export function removeProject(projects: Project[], id: string, selectedId: string) {
  const index = projects.findIndex(project => project.id === id);
  const remaining = projects.filter(project => project.id !== id);
  return { projects: remaining, selectedId: selectedId === id ? remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? '' : selectedId };
}
export function archiveProject(storage: Pick<Storage, 'getItem' | 'setItem'>, project: Project): void {
  const existing = readProjectTrash(storage);
  storage.setItem(TRASH_KEY, JSON.stringify([{ project, deletedAt: new Date().toISOString() }, ...existing]));
}
export function readProjectTrash(storage: Pick<Storage, 'getItem'>): { project: Project; deletedAt: string }[] {
  const data = JSON.parse(storage.getItem(TRASH_KEY) || '[]');
  if (!Array.isArray(data)) throw new Error('本机回收记录损坏，请先导出浏览器数据。');
  return data.map(row => ({ project: validatePrototypeProject(row.project), deletedAt: String(row.deletedAt) }));
}
export function importProjectJson(raw: unknown): Project[] {
  const value = raw as { format?: string; version?: number; project?: unknown };
  if (value?.format !== 'diffusioncontrol.prototype') throw new Error('请选择完整 .dcproject.zip 或原有 .prototype.json 备份。');
  const result = migratePrototypeWorkspace({ version: value.version ?? 1, projects: [value.project] }, value.version ?? 1);
  if (!result.projects.length || result.issues.some(issue => issue.code === 'INVALID_PROJECT')) throw new Error(result.issues.map(issue => issue.message).join('；') || '项目格式无效');
  if (result.projects.some(project => project.demoScene !== null)) throw new Error('此备份包含演示场景，请新建真实项目并导入首帧。');
  return result.projects;
}
export function clusterProject(project: Project): Project {
  const result = validatePrototypeProject(project);
  // Preserve job/request identity; authenticated downloads now use this service.
  result.generation.submissions = result.generation.submissions.map(submission => ({ ...submission, endpoint: `${window.location.origin}/api` }));
  return result;
}
export async function waitOperation<T>(operation: { id: string }, progress: (text: string) => void): Promise<T> {
  for (;;) {
    const result = await workflowApi<{ status: string; message: string; result?: T }>(`/projects/operations/${operation.id}`);
    progress(result.message);
    if (result.status === 'failed') throw new Error(result.message);
    if (result.status === 'succeeded') return result.result!;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
}
export async function uploadProjectPackage(file: File, progress: (message: string) => void): Promise<string> {
  if (file.size > 4 * 1024 ** 3 || !file.size) throw new Error('项目包需为非空文件，且不超过 4 GiB。');
  let id: string | undefined, offset = 0, name = '';
  while (offset < file.size) {
    const end = Math.min(file.size, offset + 2 * 1024 ** 2);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject;
      reader.readAsDataURL(file.slice(offset, end));
    });
    const result = await workflowApi<{ id: string; offset: number; name?: string }>('/projects/uploads', 'POST', { id, offset, data, final: end === file.size });
    id = result.id; offset = result.offset; name = result.name || '';
    progress(`上传项目包 ${Math.round(offset / file.size * 100)}%`);
  }
  return name;
}
