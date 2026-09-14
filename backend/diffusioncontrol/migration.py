"""Offline, reversible relocation of terminal jobs into per-project directories."""
import copy
import json
import os
import sqlite3
from pathlib import Path

from .adapter import collect_outputs
from .common import Problem, atomic_write, canonical, digest, now, regular_path
from .projects import file_hash, relocate_paths, rewrite_workflow_paths


def migrate_completed(settings, store, projects, report_root):
    if store.active():
        raise Problem('存在未结束作业；请等待结束后迁移')
    for path in (projects.root/'operations').glob('*.json'):
        if json.loads(path.read_text())['status'] in ('queued', 'running'):
            raise Problem('存在未完成项目文件操作；请等待结束后迁移')
    rows = store.db.execute('SELECT body FROM jobs ORDER BY rowid').fetchall()
    jobs = [json.loads(row[0]) for row in rows]
    moves, paths = [], {}
    for job in jobs:
        source = Path(job['directory'])
        destination = store.job_directory(job['request']['projectId'], job['id'])
        if source == destination: continue
        source = regular_path(source, settings.state)
        if source != settings.state/'jobs'/job['id'] or not source.is_dir():
            raise Problem('历史作业目录无效：'+job['id'])
        if destination.exists(): raise Problem('迁移目标已存在：'+str(destination))
        for entry in job['outputs']:
            path = store.output_path(job, entry['relativePath'])
            if not path.is_file() or file_hash(path) != entry['sha256']:
                raise Problem('历史产物缺失或改变：'+str(path))
        paths[str(source/'outputs')] = str(destination/'outputs')
        moves.append((job, source, destination))
    report_root = regular_path(report_root, settings.root)
    report_root.mkdir(parents=True, exist_ok=False, mode=0o700)
    database_backup = report_root/'jobs.sqlite3'
    backup = sqlite3.connect(str(database_backup))
    store.db.backup(backup)
    backup.close()
    atomic_write(report_root/'jobs-before.json', canonical(jobs))
    report = {'startedAt': now(), 'succeeded': False, 'jobs': [], 'gpuJobsSubmitted': 0, 'backup': str(report_root)}
    moved, originals, created = [], [], []
    try:
        for original, source, destination in moves:
            store.note_project(original['request']['projectId'], original['request']['projectName'])
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.replace(str(source), str(destination))
            moved.append((source, destination))
            job = copy.deepcopy(original)
            job['directory'] = str(destination)
            job['plan']['outputDirectory'] = str(destination/'outputs')
            job['plan']['previousOutputDirectories'] = list(dict.fromkeys(original['plan'].get('previousOutputDirectories', []) + [str(source/'outputs')]))
            # Link original inodes before atomic replacements, so rollback restores
            # the exact published inode/mtime as well as the original bytes.
            changed = ['execution-plan.json']
            if job['status'] == 'succeeded':
                changed.append('outputs.json')
                if job['plan'].get('adapter') == 'workflow':
                    changed += ['outputs/result.json', 'outputs/manifest.json']
                    if job['request']['kind'] == 'export': changed += ['outputs/validation.csv', 'outputs/conditions.zip']
            for relative in changed:
                target = destination/relative
                if target.exists():
                    saved = report_root/'files'/job['id']/relative
                    saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    os.link(str(target), str(saved), follow_symlinks=False)
                    originals.append((saved, target))
                else: created.append(target)
            if job['status'] == 'succeeded':
                if job['plan'].get('adapter') == 'workflow':
                    rewrite_workflow_paths(destination/'outputs', job['request']['kind'], paths, destination/'outputs')
                job['outputs'] = collect_outputs(destination/'outputs', job['plan'])
                if [item['relativePath'] for item in original['outputs']] != [item['relativePath'] for item in job['outputs']]:
                    raise Problem('迁移改变了产物下载索引，已中止')
                atomic_write(destination/'outputs.json', canonical(job['outputs']))
            atomic_write(destination/'execution-plan.json', canonical(job['plan']))
            (destination/'execution-plan.json').chmod(0o400)
            job.setdefault('importProvenance', {'requestHash': digest(original['request']),
                'outputs': {entry['relativePath']: entry['sha256'] for entry in original['outputs']}})
            job['storageMigratedAt'] = now()
            with store.db:
                store.db.execute('UPDATE jobs SET body=? WHERE id=?', (canonical(job), job['id']))
            report['jobs'].append({'id': job['id'], 'projectId': job['request']['projectId'], 'kind': job['request'].get('kind', 'generation'),
                'from': str(source), 'to': str(destination), 'publishedFiles': len(job['outputs']), 'status': job['status']})
        for row in store.db.execute('SELECT body FROM projects').fetchall():
            snapshot = json.loads(row[0])
            updated = relocate_paths(snapshot['project'], paths)
            if updated != snapshot['project']:
                projects.save(updated, snapshot['revision'], deleted=snapshot['deleted'])
        report.update(succeeded=True, finishedAt=now())
    except Exception as error:
        # No service is running and the Store flock excludes concurrent writers.
        for saved, target in reversed(originals): os.replace(str(saved), str(target))
        for target in created:
            if target.exists(): target.unlink()
        for source, destination in reversed(moved): os.replace(str(destination), str(source))
        store.db.rollback()
        backup = sqlite3.connect(str(database_backup))
        backup.backup(store.db); backup.close()
        report.update(error=str(error), rolledBack=True, finishedAt=now())
        atomic_write(report_root/'result.json', canonical(report))
        raise
    atomic_write(report_root/'result.json', canonical(report))
    return report
