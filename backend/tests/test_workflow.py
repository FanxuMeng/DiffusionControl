import base64
import copy
import io
import json
import unittest

import numpy as np
from PIL import Image

from backend.diffusioncontrol.common import Problem
from backend.diffusioncontrol.workflow import Workflow, npz_shapes, validate_export_project
from backend.workers.geometry import reconstruct, write_preview
from .support import Fixture, SCRIPT


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.temporary.cleanup)
        self.addCleanup(self.fixture.store.close)
        self.settings, self.store = self.fixture.settings, self.fixture.store
        checkpoint = self.fixture.root / "checkpoint.pt"
        checkpoint.write_bytes(b"test fixture, never loaded")
        self.settings.workflow = {"modelRoot": str(self.fixture.root), "tasks": {
            kind: {"enabled": True, "environment": "base", "checkpoint": str(checkpoint)}
            for kind in ("depth", "sam2", "associate", "export")}}
        for file in ("third_party/ml-depth-pro/src/depth_pro/depth_pro.py", "third_party/sam2/sam2/build_sam.py"):
            path = self.fixture.root/file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# fixture")
        self.workflow = Workflow(self.settings, self.store)
        data = io.BytesIO()
        Image.new("RGB", (24, 16), "red").save(data, format="PNG")
        self.upload = {"image": "data:image/png;base64," + base64.b64encode(data.getvalue()).decode()}
        self.asset = self.workflow.upload(self.upload)

    def request(self, kind="depth", request_id="depth-1"):
        return {"version": 1, "requestId": request_id, "createdAt": "2026-09-09T00:00:00Z", "projectId": "p1",
                "projectName": "test", "kind": kind, "inputs": {"referenceAssetId": self.asset["id"]}, "options": {},
                "execution": {"kind": "slurm_sbatch", "version": 1, "envName": "base", "scriptName": "job.gpu", "scriptContent": SCRIPT}}

    def publish_depth(self):
        raw = self.request()
        job = self.workflow.submit(raw, raw["requestId"])
        directory = self.fixture.store.output_path(job, '')
        scene = reconstruct(np.ones((16, 24), np.float32), np.zeros((16, 24, 3), np.uint8), [[24, 0, 11.5], [0, 24, 7.5], [0, 0, 1]])
        np.savez_compressed(directory/"scene.npz", **scene)
        write_preview(directory/"preview.bin", scene["xyz"], scene["rgb"], scene["point_ids"])
        Image.new("L", (24, 16)).save(directory/"depth.png")
        (directory/"result.json").write_text(json.dumps({"version": 1, "kind": "depth", "requestId": raw["requestId"], "source": raw["inputs"],
            "width": 24, "height": 16, "intrinsic": scene["intrinsic"].tolist(), "pointCount": len(scene["point_ids"])}))
        self.fixture.service.finish(job, {"detail": "0:0"})
        self.assertEqual(self.store.get(job["id"])["status"], "succeeded")
        return job["id"]

    def test_upload_is_normalized_idempotent_and_rejects_active_content(self):
        self.assertEqual(self.workflow.upload(self.upload), self.asset)
        self.assertEqual(self.asset["width"], 24)
        with self.assertRaises(Problem):
            self.workflow.upload({"image": "data:image/svg+xml;base64,PHN2Zz4="})
        with self.assertRaises(Problem):
            self.workflow.asset("../../access-token")

    def test_workflow_uses_existing_store_and_does_not_submit_on_post(self):
        raw = self.request()
        first = self.workflow.submit(raw, "depth-1")
        second = self.workflow.submit(raw, "depth-1")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["phase"], "prepared")
        self.assertIn("backend.workers.run", first["plan"]["argv"])
        changed = copy.deepcopy(raw)
        changed["options"] = {"contract": 9}
        with self.assertRaises(Problem) as context:
            self.workflow.submit(changed, "depth-1")
        self.assertEqual(context.exception.status, 409)

    def test_global_script_revision_prevents_lost_updates(self):
        raw = {"revision": 0, "scriptName": "shared.gpu", "scriptContent": SCRIPT}
        saved = self.workflow.save_execution(raw)
        self.assertEqual(saved["revision"], 1)
        with self.assertRaises(Problem) as context:
            self.workflow.save_execution(raw)
        self.assertEqual(context.exception.status, 409)
        self.assertEqual(self.workflow.global_execution(), saved)

    def test_sam_rejects_negative_only_or_out_of_image_prompts(self):
        raw = self.request("sam2", "sam-1")
        for points in ([[1, 1, 0]], [[24, 1, 1]]):
            raw["options"] = {"points": points}
            with self.assertRaises(Problem):
                self.workflow.submit(raw, "sam-1")
        raw["options"] = {"points": [[12, 8, 1]]}
        self.assertEqual(self.workflow.submit(raw, "sam-1")["status"], "queued")

    def test_dependency_must_match_project_image_and_published_source(self):
        depth = self.publish_depth()
        reference = self.asset["id"]
        self.assertTrue(self.workflow.dependency(depth, "depth", "p1", reference, "scene.npz").is_file())
        for project_id, reference_id in (("other-project", reference), ("p1", "a"*64)):
            with self.assertRaises(Problem):
                self.workflow.dependency(depth, "depth", project_id, reference_id, "scene.npz")
        with self.assertRaises(Problem):
            self.workflow.dependency(depth, "depth", "p1", reference, "../request.json")

    def test_completed_without_required_artifacts_is_failed(self):
        raw = self.request()
        job = self.workflow.submit(raw, raw["requestId"])
        self.fixture.service.finish(job, {"detail": "0:0"})
        self.assertEqual(self.store.get(job["id"])["status"], "failed")

    def test_malformed_kind_and_object_ids_return_validation_errors(self):
        raw = self.request()
        raw["kind"] = []
        with self.assertRaises(Problem):
            self.workflow.submit(raw, raw["requestId"])
        depth = self.publish_depth()
        raw = self.request("associate", "associate-1")
        raw["inputs"].update(sceneJobId=depth, objectJobIds=[{}])
        with self.assertRaises(Problem):
            self.workflow.submit(raw, raw["requestId"])

    def test_replaced_asset_symlink_and_removed_dependency_are_rejected(self):
        depth = self.publish_depth()
        _, image = self.workflow.asset(self.asset["id"])
        image.unlink()
        image.symlink_to(self.fixture.root / "checkpoint.pt")
        with self.assertRaises(Problem):
            self.workflow.asset(self.asset["id"])
        with self.assertRaises(Problem):
            self.workflow.upload(self.upload)
        self.fixture.store.output_path(self.fixture.store.get(depth), 'scene.npz').unlink()
        with self.assertRaises(Problem):
            self.workflow.dependency(depth, "depth", "p1", self.asset["id"], "scene.npz")

    def test_npz_header_reader_rejects_pickle_arrays_without_loading_them(self):
        path = self.fixture.root / "unsafe.npz"
        np.savez_compressed(path, unsafe=np.array([{"x": 1}], dtype=object))
        with self.assertRaises(ValueError):
            npz_shapes(path)

    def test_export_rejects_unaligned_camera_and_out_of_duration_before_queueing(self):
        project = {"prompt": "test", "duration": 5, "calibration": {"intrinsic": [[24, 0, 11.5], [0, 24, 7.5], [0, 0, 1]],
            "imageWidth": 24, "imageHeight": 16, "distortion": {"coefficients": [0]*5}}, "camera": None, "cameraClip": None, "objects": []}
        options = {"numFrames": 81, "fps": 16}
        validate_export_project(project, options, self.asset)
        with self.assertRaises(Problem):
            validate_export_project(project, {"numFrames": 85, "fps": 16}, self.asset)
        project["camera"] = {"duration": 5, "samples": [{"t": t, "position": [1, 0, 0], "quaternion": [0, 0, 0, 1]} for t in (0, 5)]}
        project["cameraClip"] = {"start": 0, "duration": 5}
        with self.assertRaises(Problem):
            validate_export_project(project, options, self.asset)
