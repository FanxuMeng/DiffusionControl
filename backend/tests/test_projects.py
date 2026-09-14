import base64
import copy
import json
import uuid
import zipfile
import unittest

import numpy as np
from PIL import Image

from backend.diffusioncontrol.common import Problem, canonical
from backend.diffusioncontrol.projects import Projects, relocate
from backend.diffusioncontrol.workflow import Workflow
from backend.workers.geometry import reconstruct, write_preview
from .support import Fixture, SCRIPT


class ProjectTests(unittest.TestCase):
    def make_service(self):
        fixture = Fixture()
        self.addCleanup(fixture.temporary.cleanup)
        self.addCleanup(fixture.store.close)
        workflow = Workflow(fixture.settings, fixture.store)
        projects = Projects(fixture.settings, fixture.store, workflow)
        self.addCleanup(projects.close)
        return fixture, workflow, projects

    def setUp(self):
        self.fixture, self.workflow, self.projects = self.make_service()
        self.project = {'id': 'project-1', 'name': '测试项目', 'demoScene': None, 'objects': [], 'reference': None, 'generation': {'submissions': []}}

    def depth(self):
        import io
        data = io.BytesIO()
        Image.new('RGB', (24, 16), 'red').save(data, format='PNG')
        asset = self.workflow.upload({'image': 'data:image/png;base64,'+base64.b64encode(data.getvalue()).decode()})
        checkpoint = self.fixture.root/'checkpoint.pt'
        checkpoint.write_bytes(b'fixture')
        source = self.fixture.root/'third_party/ml-depth-pro/src/depth_pro/depth_pro.py'
        source.parent.mkdir(parents=True, exist_ok=True); source.write_text('# fixture')
        self.fixture.settings.workflow = {'modelRoot': str(self.fixture.root), 'tasks': {'depth': {'enabled': True, 'environment': 'base', 'checkpoint': str(checkpoint)}}}
        raw = {'version': 1, 'requestId': uuid.uuid4().hex, 'createdAt': '2026-09-10T00:00:00Z', 'projectId': self.project['id'],
               'projectName': self.project['name'], 'kind': 'depth', 'inputs': {'referenceAssetId': asset['id']}, 'options': {},
               'execution': {'kind': 'slurm_sbatch', 'version': 1, 'envName': 'base', 'scriptName': 'job.gpu', 'scriptContent': SCRIPT}}
        job = self.workflow.submit(raw, raw['requestId'])
        output = self.fixture.store.output_path(job, '')
        scene = reconstruct(np.ones((16, 24), np.float32), np.zeros((16, 24, 3), np.uint8), [[24, 0, 11.5], [0, 24, 7.5], [0, 0, 1]])
        np.savez_compressed(output/'scene.npz', **scene)
        write_preview(output/'preview.bin', scene['xyz'], scene['rgb'], scene['point_ids'])
        Image.new('L', (24, 16)).save(output/'depth.png')
        (output/'result.json').write_text(canonical({'version': 1, 'kind': 'depth', 'requestId': raw['requestId'], 'source': raw['inputs'],
            'width': 24, 'height': 16, 'intrinsic': scene['intrinsic'].tolist(), 'pointCount': len(scene['point_ids'])}))
        self.fixture.service.finish(job, {'detail': '0:0'})
        self.project.update(reference=asset['url'], workflow={'version': 1, 'referenceAssetId': asset['id'], 'width': 24, 'height': 16, 'sceneJobId': job['id'], 'pending': []})
        return self.fixture.store.get(job['id'])

    def test_snapshot_versions_delete_and_restore_preserve_jobs(self):
        job = self.depth()
        first = self.projects.save(self.project, 0)
        with self.assertRaises(Problem): self.projects.save(self.project, 0)
        removed = self.projects.delete(first['key'], 1)
        self.assertTrue(removed['deleted'])
        self.assertTrue(self.projects.snapshot(first['key'])['deleted'])
        self.assertFalse(self.projects.save(self.project, 2)['deleted'])
        self.assertEqual(self.fixture.store.get(job['id'])['status'], 'succeeded')
        self.assertEqual(self.fixture.scheduler.cancellations, [])
        self.assertEqual(len(list((self.projects.root/'snapshots'/first['key']).glob('*.json'))), 3)

    def test_complete_package_cross_root_restore_and_dependency_binding(self):
        job = self.depth()
        package = self.projects.export(self.project)
        destination, workflow, other = self.make_service()
        target = other.root/'packages'/package['name']
        target.write_bytes(self.projects.package_path(package['name']).read_bytes())
        restored = other.restore(package['name'], 0)
        self.assertEqual(restored['project']['id'], self.project['id'])
        path = workflow.dependency(job['id'], 'depth', self.project['id'], self.project['workflow']['referenceAssetId'], 'scene.npz')
        self.assertTrue(path.is_file())
        self.assertTrue(str(path).startswith(str(destination.settings.projects)))
        self.assertEqual(destination.scheduler.submissions, [])
        self.assertEqual(destination.store.active(), [])
        second = other.export(restored['project'])
        self.assertTrue(other.package_path(second['name']).is_file())
        self.assertEqual(other.restore(package['name'], 1)['revision'], 2)

    def test_same_service_restore_reuses_identical_jobs(self):
        job = self.depth()
        package = self.projects.export(self.project)
        restored = self.projects.restore(package['name'], 0)
        self.assertEqual(restored['project']['workflow']['sceneJobId'], job['id'])
        self.assertEqual(self.fixture.scheduler.submissions, [])

    def test_generation_results_are_included_and_restored_without_execution(self):
        job = self.fixture.submit()
        self.fixture.video(job)
        self.fixture.service.finish(job, {'detail': '0:0'})
        package = self.projects.export(self.project)
        destination, workflow, other = self.make_service()
        (other.root/'packages'/package['name']).write_bytes(self.projects.package_path(package['name']).read_bytes())
        other.restore(package['name'], 0)
        restored = destination.store.get(job['id'])
        self.assertEqual(restored['outputs'][0]['name'], 'video.mp4')
        self.assertEqual(restored['status'], 'succeeded')
        self.assertEqual(destination.scheduler.submissions, [])

    def test_export_refuses_unfinished_or_missing_dependencies(self):
        job = self.depth()
        self.fixture.store.update(job['id'], status='running')
        with self.assertRaisesRegex(Problem, '未结束'): self.projects.export(self.project)
        self.fixture.store.update(job['id'], status='succeeded')
        self.project['workflow']['sceneJobId'] = str(uuid.uuid4())
        with self.assertRaisesRegex(Problem, '引用'): self.projects.export(self.project)

    def test_zip_traversal_and_hash_tampering_leave_no_project(self):
        package = self.projects.export(self.project)
        original = self.projects.package_path(package['name'])
        for malicious in ('../outside', '/absolute', 'jobs/../../bad'):
            path = self.projects.root/'packages'/('bad-'+uuid.uuid4().hex+'.dcproject.zip')
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr(malicious, 'bad')
            with self.assertRaises(Problem): self.projects.restore(path.name, 0)
        self.assertEqual(self.projects.listing()['projects'], [])
        self.depth()
        populated = self.projects.package_path(self.projects.export(self.project)['name'])
        path = self.projects.root/'packages'/'tampered.dcproject.zip'
        with zipfile.ZipFile(populated) as source, zipfile.ZipFile(path, 'w') as target:
            for item in source.infolist():
                data = source.read(item.filename)
                if item.filename.endswith('preview.bin'): data = b'x'*len(data)
                target.writestr(item.filename, data)
        with self.assertRaisesRegex(Problem, '哈希'): self.projects.restore(path.name, 0)

    def test_chunk_upload_offset_and_completed_package(self):
        encoded = base64.b64encode(b'abc').decode()
        result = self.projects.upload({'offset': 0, 'data': encoded})
        with self.assertRaises(Problem): self.projects.upload({'id': result['id'], 'offset': 0, 'data': encoded})
        done = self.projects.upload({'id': result['id'], 'offset': 3, 'data': encoded, 'final': True})
        self.assertEqual(self.projects.package_path(done['name']).read_bytes(), b'abcabc')

    def test_relocation_preserves_shell_argument_boundaries(self):
        raw = {'argv': ['python', '/old/var/input.csv'], 'command': 'python /old/var/input.csv'}
        rewritten = relocate(raw, '/old/var', '/new path/var')
        import shlex
        self.assertEqual(shlex.split(rewritten['command']), rewritten['argv'])

    def test_cluster_filenames_and_invalid_package_information(self):
        package = self.projects.export(self.project)
        name = '卡车 项目 #1.dcproject.zip'
        path = self.projects.root/'packages'/name
        path.write_bytes(self.projects.package_path(package['name']).read_bytes())
        self.assertEqual(self.projects.package_info(name)['projectId'], self.project['id'])
        self.assertEqual(self.projects.restore(name, 0)['project']['id'], self.project['id'])
        for invalid in ('../'+name, '/'+name, 'bad\\'+name, 'bad\n'+name):
            with self.assertRaises(Problem): self.projects.package_path(invalid)
        path.write_bytes(b'not a zip')
        with self.assertRaisesRegex(Problem, '损坏'): self.projects.package_info(name)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('wrong.json', '{}')
        with self.assertRaisesRegex(Problem, '清单'): self.projects.package_info(name)
