"""Project snapshots and portable artifact packages. Never executes imported code."""
import base64
import copy
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import threading
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

from .common import Problem, atomic_write, canonical, digest, identifier, load_json, now, safe_text
from .store import TERMINAL, public_job
from .workflow import KINDS, regular_path, validate_outputs
from .adapter import collect_outputs

MAX_PACKAGE = 4 * 1024**3
MAX_EXPANDED = 8 * 1024**3
MAX_JSON = 48 * 1024**2


def checked_project(value):
    if not isinstance(value, dict) or not isinstance(value.get('objects'), list) or not isinstance(value.get('generation'), dict):
        raise Problem('项目结构无效')
    identifier(value.get('id'), 'project.id')
    safe_text(value.get('name'), 'project.name', 200)
    if value.get('demoScene') is not None:
        raise Problem('请使用真实项目；示例场景不保存到集群')
    if len(canonical(value).encode()) > MAX_JSON:
        raise Problem('项目配置超过 48 MiB', status=413)
    return copy.deepcopy(value)


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            result.update(block)
    return result.hexdigest()


def safe_member(name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or any(ord(c) < 32 for c in name):
        raise Problem('项目包文件路径无效')
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ('', '.', '..') for part in name.split('/')):
        raise Problem('项目包不允许绝对路径或路径穿越')
    return name


def relocate(value, old, new):
    return relocate_paths(value, {old: new})


def relocate_paths(value, paths):
    if isinstance(value, str):
        pattern = '|'.join(re.escape(path) for path in sorted(paths, key=len, reverse=True))
        return re.sub('(?:'+pattern+r')(?=/|$)', lambda match: paths[match.group()], value) if pattern else value
    if isinstance(value, list):
        return [relocate_paths(item, paths) for item in value]
    if isinstance(value, dict):
        result = {key: relocate_paths(item, paths) for key, item in value.items()}
        for key in ('command', 'commandText'):
            if isinstance(value.get(key), str) and result[key] != value[key]:
                result[key] = shlex.join([relocate_paths(arg, paths) for arg in shlex.split(value[key])])
        return result
    return value


def rewrite_workflow_paths(output, kind, paths, destination):
    for filename in ('result.json', 'manifest.json'):
        path = output/filename
        if path.exists(): atomic_write(path, canonical(relocate_paths(load_json(path), paths)))
    if kind == 'export':
        import csv
        import io
        csv_text = io.StringIO()
        writer = csv.writer(csv_text)
        writer.writerow(['path']); writer.writerow([str(destination/'sample')])
        atomic_write(output/'validation.csv', csv_text.getvalue())
        temporary = output/'conditions.zip.relocating'
        try:
            with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for path in sorted((output/'sample').rglob('*')):
                    if path.is_file(): archive.write(path, str(path.relative_to(output)))
                archive.write(output/'manifest.json', 'manifest.json')
                archive.writestr('validation.csv', 'path\nsample\n')
            os.replace(str(temporary), str(output/'conditions.zip'))
        finally:
            if temporary.exists(): temporary.unlink()


class Projects:
    def __init__(self, settings, store, workflow):
        self.settings, self.store, self.workflow = settings, store, workflow
        self.root = settings.state/'projects'
        for name in ('snapshots', 'packages', 'uploads', 'operations', 'staging'):
            (self.root/name).mkdir(parents=True, exist_ok=True, mode=0o700)
            regular_path(self.root/name, settings.state)
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='project-packages')
        self.operation_lock = threading.RLock()
        self.inflight = 0
        with store.lock, store.db:
            store.db.execute('CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, body TEXT NOT NULL)')
        for path in (self.root/'operations').glob('*.json'):
            op = load_json(regular_path(path, self.root))
            if op['status'] in ('queued', 'running'):
                op.update(status='failed', message='服务重启中断了文件操作；请核对后重新操作', updatedAt=now())
                atomic_write(path, canonical(op))

    def close(self):
        self.pool.shutdown(wait=True)

    def key(self, project_id):
        identifier(project_id, 'project.id')
        return hashlib.sha256(project_id.encode()).hexdigest()

    def snapshot(self, key):
        if not re.fullmatch('[a-f0-9]{64}', key):
            raise Problem('集群项目 ID 无效')
        with self.store.lock:
            row = self.store.db.execute('SELECT body FROM projects WHERE key=?', (key,)).fetchone()
        if not row:
            raise Problem('集群项目不存在', 'project_not_found', 404)
        return json.loads(row[0])

    def listing(self):
        with self.store.lock:
            rows = self.store.db.execute('SELECT body FROM projects').fetchall()
        snapshots = [json.loads(row[0]) for row in rows]
        return {'root': str(self.root), 'projectsRoot': str(self.store.projects_root), 'projects': sorted([
            {key: item[key] for key in ('key', 'revision', 'deleted', 'updatedAt', 'name', 'projectId')}
            for item in snapshots], key=lambda item: item['updatedAt'], reverse=True),
            'packages': [{'name': path.name, 'size': path.stat().st_size} for path in sorted((self.root/'packages').glob('*.dcproject.zip')) if path.is_file() and not path.is_symlink()]}

    def save(self, project, revision, deleted=False):
        project = checked_project(project)
        key = self.key(project['id'])
        if type(revision) is not int or revision < 0:
            raise Problem('项目 revision 无效')
        with self.store.lock, self.store.db:
            row = self.store.db.execute('SELECT body FROM projects WHERE key=?', (key,)).fetchone()
            previous = json.loads(row[0]) if row else None
            if revision != (previous['revision'] if previous else 0):
                raise Problem('集群项目已更新，请先打开最新版本再保存', 'project_conflict', 409)
            item = {'key': key, 'projectId': project['id'], 'name': project['name'], 'revision': revision+1,
                    'updatedAt': now(), 'deleted': deleted, 'project': project}
            self.store.note_project(project['id'], project['name'])
            path = self.root/'snapshots'/key/('%08d.json' % item['revision'])
            regular_path(path, self.root)
            atomic_write(path, canonical(item))
            self.store.db.execute('INSERT OR REPLACE INTO projects VALUES (?,?)', (key, canonical(item)))
        return item

    def delete(self, key, revision):
        item = self.snapshot(key)
        return self.save(item['project'], revision, deleted=True)

    def operation(self, operation_id):
        if not re.fullmatch('[a-f0-9]{32}', operation_id):
            raise Problem('文件操作 ID 无效')
        path = regular_path(self.root/'operations'/(operation_id+'.json'), self.root)
        if not path.is_file():
            raise Problem('文件操作不存在', status=404)
        return load_json(path)

    def start(self, kind, action):
        with self.operation_lock:
            if self.inflight >= 4:
                raise Problem('文件操作队列已满，请稍后再试', status=429)
            self.inflight += 1
        operation_id = uuid.uuid4().hex
        path = self.root/'operations'/(operation_id+'.json')
        initial = {'id': operation_id, 'kind': kind, 'status': 'queued', 'message': '等待文件操作', 'updatedAt': now()}
        atomic_write(path, canonical(initial))

        def work():
            op = dict(initial, status='running', message='正在校验和处理项目文件')
            try:
                atomic_write(path, canonical(op))
                op.update(result=action(), status='succeeded', message='已完成')
            except Exception as error:
                op.update(status='failed', message=str(error)[:1000])
            finally:
                op['updatedAt'] = now()
                atomic_write(path, canonical(op))
                with self.operation_lock:
                    self.inflight -= 1
        self.pool.submit(work)
        return initial

    def package_path(self, name):
        if (not isinstance(name, str) or not name.endswith('.dcproject.zip')
                or len(name.encode('utf-8', errors='replace')) > 240
                or any(c in '/\\:' or ord(c) < 32 or ord(c) == 127 for c in name)):
            raise Problem('项目包名称无效')
        path = regular_path(self.root/'packages'/name, self.root)
        if not path.is_file() or path.stat().st_size > MAX_PACKAGE:
            raise Problem('项目包不存在或超过 4 GiB', status=404)
        return path

    def upload(self, raw):
        upload_id = raw.get('id') or uuid.uuid4().hex
        if not re.fullmatch('[a-f0-9]{32}', upload_id) or type(raw.get('offset')) is not int:
            raise Problem('上传 ID 或偏移无效')
        try:
            block = base64.b64decode(raw['data'], validate=True)
        except (KeyError, ValueError, TypeError):
            raise Problem('上传分块编码无效')
        if not 0 < len(block) <= 2*1024**2:
            raise Problem('每个上传分块须为 1 字节至 2 MiB')
        with self.operation_lock:
            path = regular_path(self.root/'uploads'/(upload_id+'.part'), self.root)
            size = path.stat().st_size if path.exists() else 0
            if raw['offset'] != size or size+len(block) > MAX_PACKAGE:
                raise Problem('上传偏移不匹配或超过 4 GiB', status=409)
            with path.open('ab') as stream:
                stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
            if raw.get('final') is True:
                name = upload_id+'.dcproject.zip'
                os.replace(str(path), str(self.root/'packages'/name))
                return {'id': upload_id, 'offset': size+len(block), 'name': name}
        return {'id': upload_id, 'offset': size+len(block)}

    def package_info(self, name):
        try:
            with zipfile.ZipFile(self.package_path(name)) as archive:
                if archive.getinfo('project.json').file_size > MAX_JSON: raise Problem('项目清单过大')
                manifest = json.loads(archive.read('project.json'))
        except (zipfile.BadZipFile, KeyError, ValueError, UnicodeError, RuntimeError, NotImplementedError):
            raise Problem('项目包损坏，或无法读取 project.json 清单')
        if not isinstance(manifest, dict) or manifest.get('format') != 'diffusioncontrol.project-package' or manifest.get('version') != 1:
            raise Problem('项目包格式不受支持')
        project = checked_project(manifest.get('project'))
        try: revision = self.snapshot(self.key(project['id']))['revision']
        except Problem as error:
            if error.status != 404: raise
            revision = 0
        return {'name': project['name'], 'projectId': project['id'], 'revision': revision}

    def project_jobs(self, project):
        with self.store.lock:
            rows = self.store.db.execute('SELECT body FROM jobs').fetchall()
        jobs = [json.loads(row[0]) for row in rows if json.loads(row[0])['request'].get('projectId') == project['id']]
        if any(job['status'] not in TERMINAL for job in jobs):
            raise Problem('该项目仍有未结束任务，请等待结束后导出完整包')
        if project.get('workflow', {}).get('pending'):
            raise Problem('请先处理重建面板中的待确认提交，再导出完整包')
        by_id = {job['id']: job for job in jobs}
        required = set()
        workflow = project.get('workflow') or {}
        for key in ('sceneJobId', 'exportJobId'):
            if workflow.get(key): required.add(workflow[key])
        for item in project['objects']:
            if item.get('reconstruction'): required.add(item['reconstruction']['jobId'])
        for submission in project['generation'].get('submissions', []):
            job = submission.get('job')
            if not job and not submission.get('rejection'):
                raise Problem('生成面板存在未确认提交，请先确认状态')
            if job: required.add(job['id'])
        if not required <= set(by_id):
            raise Problem('项目引用的作业不在当前服务或来自其他项目，无法制作完整包')
        return jobs

    def export(self, raw_project):
        project = checked_project(raw_project)
        jobs = self.project_jobs(project)
        files, records = {}, []
        assets = set()
        if project.get('workflow'): assets.add(project['workflow']['referenceAssetId'])
        for job in jobs:
            job_id = str(uuid.UUID(job['id']))
            if job['plan'].get('adapter') == 'workflow': assets.add(job['request']['inputs']['referenceAssetId'])
            record = {key: job[key] for key in ('id', 'request', 'status', 'createdAt', 'updatedAt')}
            record['kind'] = job['request'].get('kind') if job['plan'].get('adapter') == 'workflow' else None
            record['originalOutputDirectory'] = str(job['plan']['outputDirectory'])
            record['previousOutputDirectories'] = job['plan'].get('previousOutputDirectories', [])
            record['outputs'] = []
            if job['status'] == 'succeeded':
                for entry in job['outputs']:
                    relative = safe_member(entry['relativePath'])
                    path = self.store.output_path(job, relative)
                    if not path.is_file() or file_hash(path) != entry['sha256']:
                        raise Problem('作业产物缺失或已变化：'+relative)
                    name = 'jobs/'+job_id+'/'+relative
                    files[name] = path
                    record['outputs'].append({'name': relative, 'sha256': entry['sha256']})
            records.append(record)
        for asset_id in assets:
            metadata, path = self.workflow.asset(asset_id)
            files['assets/'+asset_id+'/image.png'] = path
            files['assets/'+asset_id+'/asset.json'] = path.parent/'asset.json'
        # Local data URLs remain embedded. Reject unregistered external image URLs.
        references = [project.get('reference')] + [item.get('maskPreview') for item in project['objects']]
        known_urls = {'/api/workflow/assets/'+asset_id+'/image' for asset_id in assets}
        for job in jobs:
            known_urls.update('/api/'+entry['url'] for entry in public_job(job)['outputs'])
        if any(value and not value.startswith('data:image/') and value not in known_urls for value in references):
            raise Problem('项目含未注册的外部图片，请先导入本地图片或恢复原服务资产')
        if sum(path.stat().st_size for path in files.values()) > MAX_EXPANDED or len(files) > 20000:
            raise Problem('项目包超过展开大小或文件数限制')
        manifest = {'format': 'diffusioncontrol.project-package', 'version': 1, 'createdAt': now(),
                    'stateRoot': str(self.settings.state), 'project': project, 'jobs': records,
                    'files': {name: {'sha256': file_hash(path), 'size': path.stat().st_size} for name, path in files.items()}}
        if len(canonical(manifest).encode()) > MAX_JSON:
            raise Problem('项目清单超过 48 MiB')
        name = uuid.uuid4().hex+'.dcproject.zip'
        temporary = self.root/'staging'/(name+'.tmp')
        try:
            with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                archive.writestr('project.json', canonical(manifest))
                for member, path in files.items(): archive.write(path, member)
            if temporary.stat().st_size > MAX_PACKAGE: raise Problem('项目包超过 4 GiB')
            os.replace(str(temporary), str(self.root/'packages'/name))
        finally:
            temporary.unlink(missing_ok=True)
        return {'name': name, 'projectName': project['name'], 'size': (self.root/'packages'/name).stat().st_size,
                'url': '/api/projects/packages/'+name, 'serverPath': str(self.root/'packages'/name)}

    def inspect_package(self, path, staging):
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 20001 or sum(item.file_size for item in entries) > MAX_EXPANDED:
                raise Problem('项目包文件数或展开大小超限')
            names = set()
            for item in entries:
                safe_member(item.filename)
                mode = (item.external_attr >> 16) & 0xffff
                if item.filename in names or item.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or item.flag_bits & 1:
                    raise Problem('项目包含重复、加密或非普通文件')
                if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise Problem('项目包压缩格式不受支持')
                names.add(item.filename)
            if 'project.json' not in names or archive.getinfo('project.json').file_size > MAX_JSON:
                raise Problem('项目包缺少有效清单')
            manifest = json.loads(archive.read('project.json'))
            if manifest.get('format') != 'diffusioncontrol.project-package' or manifest.get('version') != 1:
                raise Problem('不支持此项目包版本')
            checked_project(manifest['project'])
            if set(manifest['files']) != names-{'project.json'}:
                raise Problem('项目包清单与实际文件不一致')
            for name, evidence in manifest['files'].items():
                if not re.fullmatch(r'(assets/[a-f0-9]{64}/(image\.png|asset\.json)|jobs/[a-f0-9-]{36}/.+)', name):
                    raise Problem('项目包文件位置不受支持')
                item = archive.getinfo(name)
                if item.file_size != evidence['size']: raise Problem('文件大小与清单不符')
                target = staging/name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024**2)
                if file_hash(target) != evidence['sha256']: raise Problem('项目包文件哈希不匹配：'+name)
        return manifest

    def restore(self, name, revision):
        stage = self.root/'staging'/uuid.uuid4().hex
        stage.mkdir(mode=0o700)
        installed = []
        try:
            manifest = self.inspect_package(self.package_path(name), stage)
            old = manifest['stateRoot']
            if not isinstance(old, str) or not old.startswith('/') or old == '/': raise Problem('原项目管理根无效')
            records = manifest['jobs']
            if not isinstance(records, list): raise Problem('项目包作业清单无效')
            ids = {record['id'] for record in records}
            if len(ids) != len(records) or len(ids) > 1000: raise Problem('项目包作业 ID 重复或数量超限')
            paths = {old: str(self.settings.state)}
            for record in records:
                destination = self.store.job_directory(manifest['project']['id'], record['id'])/'outputs'
                try: destination = Path(self.store.get(record['id'])['plan']['outputDirectory'])
                except Problem as error:
                    if error.status != 404: raise
                aliases = record.get('previousOutputDirectories', [])
                if not isinstance(aliases, list) or len(aliases) > 50: raise Problem('历史输出目录清单无效')
                for source in [record['originalOutputDirectory']] + aliases:
                    if not isinstance(source, str) or not source.startswith('/') or source == '/': raise Problem('原输出目录无效')
                    if source in paths and paths[source] != str(destination): raise Problem('原输出目录映射冲突')
                    paths[source] = str(destination)
            project = relocate_paths(manifest['project'], paths)
            project['updatedAt'] = now()
            expected = {name for name in manifest['files'] if name.startswith('assets/')}
            for record in records:
                job_id = str(uuid.UUID(record['id']))
                if job_id != record['id']: raise Problem('作业 ID 必须采用规范 UUID')
                names = set()
                for entry in record['outputs']:
                    member = 'jobs/'+job_id+'/'+safe_member(entry['name'])
                    if member in names or manifest['files'].get(member, {}).get('sha256') != entry['sha256']:
                        raise Problem('作业产物清单不完整或重复')
                    names.add(member)
                if record['status'] != 'succeeded' and names: raise Problem('未成功作业不能带有已发布产物')
                expected.update(names)
            if expected != set(manifest['files']): raise Problem('项目包包含未登记的作业产物')
            restored = []
            for record in records:
                job_id = str(uuid.UUID(record['id']))
                request = relocate_paths(record['request'], paths)
                if request.get('projectId') != project['id'] or record['status'] not in TERMINAL:
                    raise Problem('项目包作业归属或状态无效')
                inputs = request.get('inputs', {})
                dependencies = [inputs.get('sceneJobId'), inputs.get('segmentationJobId'), inputs.get('replaceObjectJobId')] + inputs.get('objectJobIds', [])
                if any(value and value not in ids for value in dependencies): raise Problem('项目包缺少依赖作业')
                existing = None
                try: existing = self.store.get(job_id)
                except Problem as error:
                    if error.status != 404: raise
                if existing:
                    provenance = existing.get('importProvenance', {})
                    if (digest(existing['request']) not in (digest(request), digest(record['request'])) and provenance.get('requestHash') != digest(record['request'])) or existing['status'] != record['status']:
                        raise Problem('同 ID 作业已存在且与项目包不同，拒绝覆盖', status=409)
                    for entry in record['outputs']:
                        published = next((p for p in existing['outputs'] if p['relativePath'] == entry['name']), None)
                        accepted = published and (published['sha256'] == entry['sha256'] or provenance.get('outputs', {}).get(entry['name']) == entry['sha256'])
                        if not accepted: raise Problem('同 ID 作业产物不同，拒绝覆盖', status=409)
                        actual = self.store.output_path(existing, entry['name'])
                        if not actual.is_file() or file_hash(actual) != published['sha256']: raise Problem('已有作业文件缺失或改变')
                    continue
                directory = self.store.job_directory(project['id'], job_id)
                if directory.exists(): raise Problem('目标作业目录已存在但未登记，请先检查', status=409)
                output = stage/'jobs'/job_id
                output.mkdir(parents=True, exist_ok=True)
                kind = record.get('kind')
                if kind is not None and kind not in KINDS: raise Problem('项目包任务类型无效')
                if kind is not None and request.get('kind') != kind: raise Problem('任务请求与类型不一致')
                plan = {'adapter': 'workflow' if kind else 'generic', 'outputDirectory': str(directory/'outputs'),
                        'workdir': str(self.settings.root), 'argv': [], 'inputEvidence': []}
                plan['previousOutputDirectories'] = list(dict.fromkeys([record['originalOutputDirectory']] + record.get('previousOutputDirectories', [])))
                plan['outputGlobs'] = [glob.escape(safe_member(entry['name'])) for entry in record['outputs']]
                if kind: plan.update(kind=kind, requestId=request['requestId'], source=request['inputs'])
                if kind and record['status'] == 'succeeded':
                    rewrite_workflow_paths(output, kind, paths, directory/'outputs')
                restored.append({'id': job_id, 'requestId': request['requestId'], 'request': request, 'status': record['status'],
                    'message': '从完整项目包恢复；未执行推理', 'phase': 'terminal', 'createdAt': record['createdAt'], 'updatedAt': now(),
                    'cancelRequested': False, 'slurmId': None, 'cluster': None, 'schedulerState': None, 'plan': plan, 'outputs': [],
                    'directory': str(directory), 'importProvenance': {'requestHash': digest(record['request']),
                    'outputs': {entry['name']: entry['sha256'] for entry in record['outputs']}}})
            # Ensure the project points only to jobs present in this complete package.
            refs = project.get('workflow') or {}
            required = [refs.get('sceneJobId'), refs.get('exportJobId')] + [obj.get('reconstruction', {}).get('jobId') for obj in project['objects']]
            required += [sub['job']['id'] for sub in project.get('generation', {}).get('submissions', []) if sub.get('job')]
            if any(value and value not in ids for value in required): raise Problem('项目引用未包含的作业')
            asset_ids = {name.split('/')[1] for name in manifest['files'] if name.startswith('assets/')}
            required_assets = {record['request']['inputs']['referenceAssetId'] for record in records if record.get('kind')}
            if refs: required_assets.add(refs['referenceAssetId'])
            if required_assets != asset_ids: raise Problem('项目包缺少首帧资产或带有未登记资产')
            for asset in (stage/'assets').glob('*') if (stage/'assets').exists() else []:
                metadata = load_json(asset/'asset.json')
                if metadata.get('id') != asset.name or file_hash(asset/'image.png') != asset.name: raise Problem('首帧资产 ID 与内容不一致')
                from PIL import Image
                with Image.open(asset/'image.png') as image:
                    if image.format != 'PNG' or image.size != (metadata['width'], metadata['height']) or image.width*image.height > 16000000:
                        raise Problem('首帧尺寸与登记信息不符')
                    image.verify()
                metadata['url'] = '/api/workflow/assets/'+asset.name+'/image'
                atomic_write(asset/'asset.json', canonical(metadata))
                destination = self.workflow.assets/asset.name
                regular_path(destination, self.settings.state)
                if destination.exists():
                    _, existing = self.workflow.asset(asset.name)
                    if file_hash(existing) != asset.name: raise Problem('现有首帧资产损坏')
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    os.replace(str(asset), str(destination))
                    for path in destination.iterdir(): path.chmod(0o400)
            with self.store.lock:
                key = self.key(project['id'])
                try: current = self.snapshot(key)['revision']
                except Problem as error:
                    if error.status != 404: raise
                    current = 0
                if current != revision: raise Problem('集群项目版本冲突，请先打开最新版本', status=409)
                for job in restored:
                    directory = Path(job['directory'])
                    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    directory.mkdir(mode=0o700)
                    installed.append(directory)
                    os.replace(str(stage/'jobs'/job['id']), str(directory/'outputs'))
                    if job['status'] == 'succeeded':
                        if job['plan']['adapter'] == 'workflow': validate_outputs(directory/'outputs', job['plan'])
                        job['outputs'] = collect_outputs(directory/'outputs', job['plan'])
                    atomic_write(directory/'request.json', canonical(job['request']))
                    atomic_write(directory/'import-provenance.json', canonical(job['importProvenance']))
                with self.store.db:
                    for job in restored:
                        self.store.db.execute('INSERT INTO jobs VALUES (?,?,?,?,?)', (job['id'], job['requestId'], digest(job['request']), job['status'], canonical(job)))
                result = self.save(project, revision)
            installed.clear()
            return result
        finally:
            # Only newly created staging/unpublished directories are removed.
            for directory in installed:
                try: self.store.get(directory.name)
                except Problem as error:
                    if error.status == 404: shutil.rmtree(directory)
            shutil.rmtree(stage)
