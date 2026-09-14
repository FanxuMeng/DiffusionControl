#!/usr/bin/env python3
"""Stop the backend first. Requires --apply; never cancels or submits a job."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.diffusioncontrol.config import Settings
from backend.diffusioncontrol.store import Store
from backend.diffusioncontrol.workflow import Workflow
from backend.diffusioncontrol.projects import Projects
from backend.diffusioncontrol.migration import migrate_completed

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply', action='store_true', required=True)
parser.add_argument('--report', required=True, help='New backup/report directory inside DiffusionControl')
args = parser.parse_args()
settings = Settings.load()
store = Store(settings.state, settings.projects)
projects = None
try:
    # Check before Projects startup can mark interrupted operations failed.
    for path in (settings.state/'projects/operations').glob('*.json'):
        if json.loads(path.read_text())['status'] in ('queued', 'running'):
            raise RuntimeError('Unfinished project operation: '+path.name)
    projects = Projects(settings, store, Workflow(settings, store))
    result = migrate_completed(settings, store, projects, ROOT/args.report)
    print(json.dumps(result, ensure_ascii=False, indent=2))
finally:
    if projects: projects.close()
    store.close()
