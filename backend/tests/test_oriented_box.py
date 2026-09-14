import itertools
import unittest
import numpy as np
from backend.workers.oriented_box import fit_oriented_box
from backend.workers.geometry import quaternion_matrix, transform_object


class OrientedBoxTests(unittest.TestCase):
    def assert_enclosed(self, points, box):
        rotation = quaternion_matrix(box['box_quaternion'])
        np.testing.assert_allclose(rotation.T @ rotation, np.eye(3), atol=1e-6)
        self.assertGreater(np.linalg.det(rotation), .999999)
        local = (points-box['center']) @ rotation
        self.assertTrue(np.all(np.abs(local) <= box['half_extents']+1e-6))

    def test_rotated_cuboid_recovers_known_volume_and_rigid_containment(self):
        q = np.array([.17, .31, -.22, .86]); q /= np.linalg.norm(q)
        rotation = quaternion_matrix(q)
        corners = np.array(list(itertools.product((-2, 2), (-.7, .7), (-.2, .2))))
        points = corners @ rotation.T + [3, -1, 8]
        box = fit_oriented_box(points)
        self.assert_enclosed(points, box)
        volume = float(np.prod(2*box['half_extents']))
        self.assertLess(abs(volume-4*1.4*.4)/(4*1.4*.4), .002)
        self.assertLess(volume, np.prod(np.ptp(points, axis=0))*.5)
        initial = {'position': box['center'], 'quaternion': box['box_quaternion']}
        np.testing.assert_allclose(transform_object(points, initial, initial), points, atol=1e-6)

    def test_extreme_point_is_not_lost_by_support_subset(self):
        rng = np.random.default_rng(99)
        points = rng.uniform(-1, 1, (2400, 3))*[3, .5, .2]
        points[1701] = [6, -2, 1]
        box = fit_oriented_box(points)
        self.assert_enclosed(points, box)
        self.assertLessEqual(np.prod(box['half_extents']*2), np.prod(np.maximum(np.ptp(points, axis=0), .002))*1.0001)

    def test_planar_line_and_coincident_sets_remain_editable(self):
        for points in (np.zeros((9, 3)), np.array([[i, i*2, 0] for i in range(9)]),
                       np.array([[x, y, x+y] for x in range(3) for y in range(3)])):
            box = fit_oriented_box(points)
            self.assert_enclosed(points, box)
            self.assertTrue(np.all(box['half_extents'] >= .001))
        with self.assertRaises(ValueError):
            fit_oriented_box([[0, 1, np.nan]])
