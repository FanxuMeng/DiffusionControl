import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import App from './App';
afterEach(() => vi.unstubAllGlobals());
import { createDemoProjects, createEmptyProject } from './model';
import { archiveProject, importProjectJson, readProjectTrash, removeProject, renameProject, withoutDemoProjects } from './projects';

describe('formal project management', () => {
  it('renames a project without changing its identity, artifact references or generation history', () => {
    const project = createEmptyProject('旧名称', 'projects');
    const renamed = renameProject(project, '  正式生成测试  ');
    expect(renamed.name).toBe('正式生成测试');
    expect(renamed.id).toBe(project.id);
    expect(renamed.generation).toBe(project.generation);
    expect(() => renameProject(project, '  ')).toThrow();
    expect(() => renameProject(project, 'x'.repeat(201))).toThrow();
    expect(() => renameProject(project, 'a\nb')).toThrow();
  });
  it('renders a real project selector and accessible name-edit controls', () => {
    const projects = [createEmptyProject('场景甲', 'projects'), createEmptyProject('场景乙', 'projects')];
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), location: { origin: 'http://localhost' } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'diffusioncontrol.prototype.v2' ? JSON.stringify(projects) : null });
    const html = renderToString(createElement(App));
    expect(html).toContain('aria-label="切换项目"');
    expect(html).toContain(`<option value="${projects[1].id}">场景乙</option>`);
    expect(html).toContain('aria-label="重命名项目 场景甲"');
  });
  it('renders the first-visit empty state without mounting inference panels or demo scenes', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('localStorage', { getItem: () => null });
    const html = renderToString(createElement(App));
    expect(html).toContain('开始你的生成项目');
    expect(html).toContain('导入／恢复项目');
    expect(html).not.toContain('日光工作室');
    expect(html).not.toContain('dcp-panels');
  });
  it('keeps an empty workspace empty and removes only demo projects', () => {
    const real = createEmptyProject('测试生成', 'projects');
    expect(withoutDemoProjects([])).toEqual([]);
    expect(withoutDemoProjects([...createDemoProjects(), real])).toEqual([real]);
  });
  it('selects the next project on deletion and supports deleting the last project', () => {
    const a = createEmptyProject('A', 'projects'), b = createEmptyProject('B', 'projects');
    expect(removeProject([a, b], a.id, a.id)).toEqual({ projects: [b], selectedId: b.id });
    expect(removeProject([a, b], b.id, a.id)).toEqual({ projects: [a], selectedId: a.id });
    expect(removeProject([a], a.id, a.id)).toEqual({ projects: [], selectedId: '' });
  });
  it('preserves the full project before deletion and surfaces quota failures', () => {
    let value: string | null = null;
    const storage = { getItem: () => value, setItem: (_: string, next: string) => { value = next; } };
    const project = createEmptyProject('保留轨迹配置', 'projects');
    archiveProject(storage, project);
    expect(readProjectTrash(storage)[0].project).toEqual(project);
    expect(() => archiveProject({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, project)).toThrow('quota');
  });
  it('imports legacy backups with stable identity and rejects demo or unknown formats', () => {
    const project = createEmptyProject('导入', 'projects');
    expect(importProjectJson({ format: 'diffusioncontrol.prototype', version: 2, project })).toEqual([project]);
    expect(() => importProjectJson({ format: 'unknown', project })).toThrow();
    expect(() => importProjectJson({ format: 'diffusioncontrol.prototype', version: 2, project: createDemoProjects()[0] })).toThrow('演示');
  });
});
