"""CPU artifact-contract tests. The rasterizer is a test double, never a GPU run."""
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from backend.diffusioncontrol.config import PROJECT_ROOT
from backend.workers.geometry import associate, reconstruct

AVAILABLE = all(importlib.util.find_spec(name) for name in ("torch", "imageio", "torchvision", "scipy"))


@unittest.skipUnless(AVAILABLE, "Requires the existing symphomotion environment; no dependencies are installed by this test")
class ExportContractTests(unittest.TestCase):
    def test_reference_scene_with_motion_boxes_is_readable_by_the_pinned_upstream_loader(self):
        import torch  # Load before patch.dict restores sys.modules; PyTorch cannot be reimported.
        from backend.workers.export import export_task
        root = PROJECT_ROOT / "var/tests"
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            directory = Path(temporary)
            scene = reconstruct(np.full((16, 24), 2, np.float32), np.full((16, 24, 3), 80, np.uint8),
                                [[24, 0, 11.5], [0, 24, 7.5], [0, 0, 1]])
            np.savez_compressed(directory / "scene.npz", **scene)
            mask = np.zeros((16, 24), bool)
            mask[5:10, 8:13] = True
            obj = associate(scene, mask)
            np.savez_compressed(directory / "object.npz", **obj)
            Image.fromarray(np.full((16, 24, 3), 80, np.uint8)).save(directory / "reference.png")
            center = obj["center"].tolist()
            initial = {"position": center, "quaternion": [0, 0, 0, 1]}
            motion = {"duration": 2, "samples": [{"t": 0, **initial}, {"t": 2, "position": [center[0]+1, *center[1:]], "quaternion": [0, 0, 0, 1]}]}
            camera = {"duration": 2, "samples": [{"t": 0, "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]},
                {"t": 2, "position": [.25, 0, 0], "quaternion": [0, 0, 0, 1]}]}
            item = {"id": "entity", "prompt": "moving object", "initialPose": initial, "motion": "trajectory",
                    "trajectory": motion, "clip": {"start": 0, "duration": 2}}
            options = {"numFrames": 5, "fps": 2, "width": 96, "height": 64, "pointsPerObject": 16, "seed": 42,
                       "radius": .005, "pointsPerPixel": 8}
            spec = {"source": {"referenceAssetId": "fixture"}, "scenePath": str(directory / "scene.npz"), "referencePath": str(directory / "reference.png"),
                    "options": options, "objects": [{"object": item, "path": str(directory / "object.npz")}],
                    "project": {"prompt": "scene", "duration": 2, "camera": camera, "cameraClip": {"start": 0, "duration": 2},
                        "calibration": {"intrinsic": scene["intrinsic"].tolist(), "imageWidth": 24, "imageHeight": 16,
                            "distortion": {"coefficients": [0]*5}}}}
            seen = []

            def raster_double(xyz, rgb, k, pose, height, width, radius, layers):
                seen.append(xyz.copy())
                holes = np.zeros((height, width), bool)
                holes[:, :16] = True
                return np.full((height, width, 3), .5, np.float32), holes

            fake = types.ModuleType("pytorch3d")
            fake._C = types.SimpleNamespace(rasterize_points=True)
            output = directory / "outputs"
            output.mkdir()
            with patch.dict(sys.modules, {"pytorch3d": fake}), patch("torch.cuda.is_available", return_value=True), \
                    patch("backend.workers.export.render_points", side_effect=raster_double):
                result = export_task(spec, output)
            self.assertEqual(result["numEntities"], 1)
            for rendered_points in seen:
                np.testing.assert_array_equal(rendered_points, scene["xyz"])
            with np.load(output / "sample/spatialtracker2.npz", allow_pickle=False) as arrays:
                # Camera moves .25, object moves 1: stored camera coordinates move .75.
                np.testing.assert_allclose(arrays["camera_3d_pred_0_sampled"][-1]-arrays["camera_3d_pred_0_sampled"][0],
                                           np.tile([.75, 0, 0], (16, 1)), atol=1e-6)
                self.assertEqual(arrays["intrinsic"][0, 2], 48)
            source = PROJECT_ROOT / "third_party/SymphoMotion"
            if not (source / "src/dataset_from_npz.py").is_file():
                self.fail("Run scripts/prepare-symphomotion-source.py before this contract test")
            with patch.object(sys, "path", [str(source)] + sys.path):
                from src.dataset_from_npz import load_dataset
                pipe = types.SimpleNamespace(vae_scale_factor_spatial=8, transformer=types.SimpleNamespace(config=types.SimpleNamespace(patch_size=[1, 2, 2])))
                loaded = load_dataset(str(output / "sample/first_image.png"), str(output / "sample/render_output"),
                    5, 96*64, pipe, True, "cpu", use_object_prompt=True, max_entities=2)
            _, video, holes, embedding, height, width, tracks, prompts, entities = loaded
            self.assertEqual(tuple(video.shape), (1, 3, 5, 64, 96))
            self.assertEqual(tuple(embedding.shape), (1, 6, 5, 64, 96))
            self.assertEqual(entities, 1)
            self.assertEqual(prompts, ["moving object", ""])
            self.assertEqual(float(holes[:, :, 0].max()), 0)
            self.assertEqual(float(holes[:, :, 1:, :, :8].min()), 1)
            np.testing.assert_allclose((tracks[0, -1]-tracks[0, 0]).numpy(), np.tile([1, 0, 0], (16, 1)), atol=1e-6)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(manifest["maskOneMeans"], "no_point_coverage")
            self.assertEqual(manifest["strategy"], "reference_scene_with_projected_boxes_v2")
            self.assertNotEqual(manifest['boxes'][0], manifest['boxes'][-1])
