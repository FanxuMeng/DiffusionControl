import tempfile
import unittest
from pathlib import Path

import numpy as np

from backend.diffusioncontrol.config import PROJECT_ROOT
from backend.workers.geometry import (associate, lower_median, preprocess_depth, reconstruct,
                                      resize_intrinsic, sample_pose, transform_object, write_preview)


class GeometryTests(unittest.TestCase):
    def test_median_matches_torch_lower_even_element(self):
        self.assertEqual(lower_median([1, 2, 100, 200]), 2)

    def test_depth_step_removes_both_sides_of_edge_without_mutating_input(self):
        depth = np.ones((7, 9), np.float32)
        depth[:, 4:] = 4
        original = depth.copy()
        processed, keep = preprocess_depth(depth)
        np.testing.assert_array_equal(depth, original)
        np.testing.assert_array_equal(processed, original)
        self.assertFalse(keep[:, 3:5].any())
        self.assertTrue(keep[:, :3].all())
        self.assertTrue(keep[:, 5:].all())

    def test_far_depth_is_contracted_not_discarded_by_distance(self):
        depth = np.ones((7, 9), np.float32)
        depth[:, 6:] = 100
        processed, keep = preprocess_depth(depth, 8)
        self.assertAlmostEqual(float(processed[3, 8]), 16-64/100, places=5)
        self.assertTrue(keep[3, 8])

    def test_invalid_depth_does_not_poison_other_points(self):
        depth = np.ones((7, 9), np.float32)
        depth[1, 1], depth[2, 2], depth[3, 3] = np.nan, np.inf, -1
        processed, keep = preprocess_depth(depth)
        self.assertTrue(np.isfinite(processed).all())
        self.assertFalse(keep[1, 1] or keep[2, 2] or keep[3, 3])
        self.assertTrue(keep[5, 5])
        self.assertFalse(preprocess_depth(np.zeros((3, 5)))[1].any())

    def scene(self):
        depth = np.full((5, 7), 2, np.float32)
        rgb = np.arange(105, dtype=np.uint8).reshape(5, 7, 3)
        return reconstruct(depth, rgb, [[4, 0, 3], [0, 5, 2], [0, 0, 1]])

    def test_non_square_backprojection_preserves_pixel_identity_and_color(self):
        scene = self.scene()
        np.testing.assert_array_equal(scene["point_ids"], np.arange(35))
        np.testing.assert_allclose(scene["xyz"][17], [0, 0, 2], atol=1e-6)
        np.testing.assert_allclose(scene["xyz"][0], [-1.5, -.8, 2], atol=1e-6)
        np.testing.assert_array_equal(scene["rgb"][17], [51, 52, 53])

    def test_mask_selects_existing_indices_and_obb_contains_entire_cluster(self):
        scene = self.scene()
        mask = np.zeros((5, 7), bool)
        mask[1:4, 2:5] = True
        obj = associate(scene, mask)
        np.testing.assert_array_equal(obj["point_ids"], [9, 10, 11, 16, 17, 18, 23, 24, 25])
        from backend.workers.geometry import quaternion_matrix
        local = (obj["xyz"]-obj["center"]) @ quaternion_matrix(obj["box_quaternion"])
        self.assertTrue(np.all(np.abs(local) <= obj["half_extents"]+1e-6))
        self.assertGreater(float(obj["half_extents"][2]), 0)
        with self.assertRaises(ValueError):
            associate(scene, mask.astype(np.uint8)*255)
        with self.assertRaises(ValueError):
            associate(scene, np.zeros((5, 7), bool))

    def test_preview_has_stable_pixel_ids_and_explicit_binary_layout(self):
        root = PROJECT_ROOT / "var/tests"
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            scene, path = self.scene(), Path(directory)/"preview.bin"
            write_preview(path, scene["xyz"], scene["rgb"], scene["point_ids"], limit=5)
            raw = path.read_bytes()
            self.assertEqual(raw[:4], b"DCP1")
            self.assertEqual(len(raw), 12+5*28)
            self.assertEqual(int.from_bytes(raw[8:12], "little"), 28)
            self.assertEqual(int.from_bytes(raw[-4:], "little"), 34)

    def test_time_mapping_holds_endpoints_and_slerps_rotation(self):
        trajectory = {"duration": 2, "samples": [
            {"t": 0, "position": [0, 0, 0], "quaternion": [0, 0, 0, 1]},
            {"t": 2, "position": [4, 0, 0], "quaternion": [0, 0, 1, 0]}]}
        clip = {"start": 1, "duration": 4}
        pose = sample_pose(trajectory, clip, 3)
        np.testing.assert_allclose(pose["position"], [2, 0, 0])
        np.testing.assert_allclose(pose["quaternion"], [0, 0, 2**-.5, 2**-.5], atol=1e-6)
        self.assertEqual(sample_pose(trajectory, clip, 0)["position"], [0, 0, 0])
        self.assertEqual(sample_pose(trajectory, clip, 9)["position"], [4, 0, 0])

    def test_object_rotation_uses_initial_pose_and_does_not_duplicate_translation(self):
        initial = {"position": [3, 4, 5], "quaternion": [0, 0, 2**-.5, 2**-.5]}
        points = np.array([[4, 4, 5]], np.float32)
        np.testing.assert_allclose(transform_object(points, initial, initial), points, atol=1e-6)
        final = {"position": [8, 4, 5], "quaternion": [0, 0, 1, 0]}
        np.testing.assert_allclose(transform_object(points, initial, final), [[8, 5, 5]], atol=1e-6)

    def test_resize_keeps_pixel_center_mapping(self):
        k = resize_intrinsic([[100, 0, 49.5], [0, 100, 24.5], [0, 0, 1]], (50, 100), (100, 200))
        np.testing.assert_allclose(k, [[200, 0, 99.5], [0, 200, 49.5], [0, 0, 1]])
