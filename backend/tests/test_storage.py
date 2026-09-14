import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.diffusioncontrol.common import Problem, canonical
from backend.diffusioncontrol.migration import migrate_completed
from backend.diffusioncontrol.projects import Projects
from backend.diffusioncontrol.slurm import Slurm
from backend.diffusioncontrol.workflow import Workflow
from .support import Fixture, request


class ProjectStorageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.store = self.fixture.store
        self.projects = Projects(self.fixture.settings, self.store, Workflow(self.fixture.settings, self.store))
        self.addCleanup(self.projects.close)

    def legacy_job(self):
        job = self.fixture.submit()
        self.fixture.video(job)
        self.fixture.service.finish(job, {'detail': '0:0'})
        job = self.store.get(job['id'])
        source = Path(job['directory'])
        destination = self.fixture.settings.state/'jobs'/job['id']
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(str(source), str(destination))
        job['directory'] = str(destination)
        job['plan']['outputDirectory'] = str(destination/'outputs')
        job = self.store.update(job['id'], directory=job['directory'], plan=job['plan'])
        # Include a path-bearing project snapshot to exercise versioning/rollback.
        project = {'id': 'project-1', 'name': '项目', 'demoScene': None, 'objects': [],
                   'generation': {'submissions': [], 'savedPath': str(destination/'outputs/video.mp4')}}
        self.projects.save(project, 0)
        return job, project

    def test_new_jobs_and_logs_are_project_owned_and_ids_isolate_same_names(self):
        job = self.fixture.submit()
        expected = self.fixture.settings.projects/'project-1'/'jobs'/job['id']
        self.assertEqual(Path(job['directory']), expected)
        self.assertEqual(job['plan']['outputDirectory'], str(expected/'outputs'))
        args = Slurm(self.fixture.settings).submit_argv(job)
        self.assertIn('--output='+str(expected/'stdout.log'), args)
        self.assertIn('--error='+str(expected/'stderr.log'), args)
        self.assertEqual(job['request'], request())
        other = request('other'); other['projectId'] = 'project-2'
        second = self.fixture.service.submit(other, 'other')
        self.assertNotEqual(Path(second['directory']).parents[1], expected.parents[1])

    def test_special_ids_cannot_escape_or_alias_normal_ids_and_symlinks_are_rejected(self):
        directory = self.store.project_directory('../../outside')
        self.assertEqual(directory.parent, self.fixture.settings.projects)
        self.assertTrue(directory.name.startswith('~'))
        self.assertNotEqual(self.store.project_directory(directory.name), directory)
        self.fixture.settings.projects.mkdir(exist_ok=True)
        (self.fixture.settings.projects/'linked').symlink_to(self.fixture.root/'model', target_is_directory=True)
        with self.assertRaises(Problem): self.store.note_project('linked', 'name')

    def test_legacy_migration_preserves_urls_inputs_and_package_reimport(self):
        job, project = self.legacy_job()
        package = self.projects.export(project)
        old_path = self.store.output_path(job, 'video.mp4')
        inode = old_path.stat().st_ino
        result = migrate_completed(self.fixture.settings, self.store, self.projects, self.fixture.root/'migration')
        self.assertTrue(result['succeeded'])
        migrated = self.store.get(job['id'])
        self.assertEqual(migrated['request'], job['request'])
        self.assertEqual(migrated['outputs'], job['outputs'])
        self.assertEqual(self.store.output_path(migrated, 'video.mp4').stat().st_ino, inode)
        self.assertFalse(old_path.exists())
        snapshot = self.projects.snapshot(self.projects.key(project['id']))
        self.assertEqual(snapshot['revision'], 2)
        self.assertIn(str(self.fixture.settings.projects), snapshot['project']['generation']['savedPath'])
        self.assertEqual(self.projects.restore(package['name'], 2)['revision'], 3)
        self.assertEqual(self.fixture.scheduler.submissions, [])

    def test_migration_failure_restores_database_and_original_inodes(self):
        job, project = self.legacy_job()
        directory = Path(job['directory'])
        paths = [directory/'execution-plan.json', directory/'outputs.json', directory/'outputs/video.mp4']
        before = [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in paths]
        with patch.object(self.projects, 'save', side_effect=RuntimeError('simulated snapshot failure')):
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                migrate_completed(self.fixture.settings, self.store, self.projects, self.fixture.root/'rollback')
        self.assertEqual(self.store.get(job['id']), job)
        self.assertEqual(before, [(p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in paths])
        self.assertTrue(json.loads((self.fixture.root/'rollback/result.json').read_text())['rolledBack'])
        self.assertEqual(self.projects.snapshot(self.projects.key(project['id']))['revision'], 1)

    def test_migration_refuses_live_jobs(self):
        job = self.fixture.submit()
        with self.assertRaisesRegex(Problem, '未结束'):
            migrate_completed(self.fixture.settings, self.store, self.projects, self.fixture.root/'blocked')
        self.assertTrue(Path(job['directory']).is_dir())
