import copy
import json
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from backend.diffusioncontrol.common import Problem
from backend.workers.geometry import associate_box, quaternion_matrix, reconstruct, transform_object
from backend.workers.run import associate_task
from . import test_workflow as workflow_tests


class BoxGeometryTests(unittest.TestCase):
    def test_oriented_selection_preserves_user_box_and_scene_ids_and_excludes_other_objects(self):
        q = [0, 0, np.sin(.4), np.cos(.4)]
        local = np.array([[x, y, 0] for x in np.linspace(-1, 1, 7) for y in np.linspace(-.5, .5, 7)], np.float32)
        center = np.array([2, 3, 5], np.float32)
        xyz = local @ quaternion_matrix(q).T + center
        scene = dict(xyz=xyz, point_ids=np.arange(49, dtype=np.uint32), rgb=np.zeros((49, 3), np.uint8), image_size=np.array([7, 7]))
        box = dict(center=center.tolist(), halfExtents=[1, .5, .01], quaternion=q)
        original = xyz.copy()
        obj = associate_box(scene, box, [0, 1, 2])
        self.assertEqual(len(obj['point_ids']), 46)
        self.assertEqual(obj['excluded_point_count'], 3)
        self.assertEqual(int(obj['mask'].sum()), 46)
        np.testing.assert_array_equal(scene['xyz'], original)
        np.testing.assert_allclose(obj['center'], center)
        np.testing.assert_allclose(obj['half_extents'], box['halfExtents'])
        pose = dict(position=obj['center'], quaternion=obj['box_quaternion'])
        np.testing.assert_allclose(transform_object(obj['xyz'], pose, pose), obj['xyz'], atol=1e-6)
        with self.assertRaises(ValueError):
            associate_box(scene, dict(box, center=[100, 0, 0]))
        with self.assertRaises(ValueError):
            associate_box(scene, dict(box, halfExtents=[0, 1, 1]))


class BoxWorkflowTests(unittest.TestCase):
    setUp = workflow_tests.WorkflowTests.setUp
    request = workflow_tests.WorkflowTests.request
    publish_depth = workflow_tests.WorkflowTests.publish_depth
    def publish_inputs(self):
        depth = self.publish_depth()
        request = self.request('sam2', 'sam-box')
        request['options'] = dict(points=[[12, 8, 1]])
        sam = self.workflow.submit(request, request['requestId'])
        output = self.store.output_path(sam, '')
        mask = np.ones((16, 24), bool)
        np.savez_compressed(output/'masks.npz', masks=np.array([mask]), scores=np.array([1.0]))
        Image.fromarray(mask.astype(np.uint8)*255).save(output/'mask-0.png')
        Image.new('RGBA', (24, 16)).save(output/'overlay-0.png')
        (output/'result.json').write_text(json.dumps(dict(version=1, kind='sam2', requestId=request['requestId'], width=24, height=16,
            candidates=[dict(index=0, score=1.0, pixels=384, mask='mask-0.png', overlay='overlay-0.png')], source=request['inputs'])))
        self.fixture.service.finish(sam, dict(detail='0:0'))
        request = self.request('associate', 'old-object')
        request['inputs'].update(sceneJobId=depth, segmentationJobId=sam['id'], objectJobIds=[])
        request['options'] = dict(candidate=0)
        old = self.workflow.submit(request, request['requestId'])
        output = self.store.output_path(old, '')
        spec = json.loads((Path(old['directory'])/'submission/task.json').read_text())
        result = associate_task(spec, output)
        (output/'result.json').write_text(json.dumps(dict(result, version=1, requestId=request['requestId'], source=request['inputs'], kind='associate')))
        self.fixture.service.finish(old, dict(detail='0:0'))
        self.assertEqual(self.store.get(old['id'])['status'], 'succeeded')
        return request, old

    def test_box_request_validates_parent_persists_selection_and_produces_compatible_outputs(self):
        original, old = self.publish_inputs()
        request = copy.deepcopy(original)
        request['requestId'] = 'box-replacement'
        request['inputs']['replaceObjectJobId'] = old['id']
        box = dict(center=[0, 0, 1], halfExtents=[.3, .3, .1], quaternion=[0, 0, 0, 1])
        request['options']['selectionBox'] = box
        new = self.workflow.submit(request, request['requestId'])
        self.assertEqual(self.workflow.submit(request, request['requestId'])['id'], new['id'])
        spec = json.loads((Path(new['directory'])/'submission/task.json').read_text())
        self.assertEqual(spec['options']['selectionBox'], box)
        result = associate_task(spec, self.store.output_path(new, ''))
        (self.store.output_path(new, '')/'result.json').write_text(json.dumps(dict(result, version=1, requestId=request['requestId'], kind='associate', source=request['inputs'])))
        self.fixture.service.finish(new, dict(detail='0:0'))
        self.assertEqual(self.store.get(new['id'])['status'], 'succeeded')
        self.assertEqual(result['fit'], 'user_edited_obb')
        self.assertGreater(result['pointCount'], 9)
        self.assertEqual(result['center'], box['center'])
        self.assertTrue((self.store.output_path(old, '')/'object.npz').exists())
        for mutate in ('missing-parent', 'self-excluded', 'invalid-quaternion', 'negative-size', 'wrong-parent'):
            bad = copy.deepcopy(request); bad['requestId'] = mutate
            if mutate == 'missing-parent': del bad['inputs']['replaceObjectJobId']
            elif mutate == 'self-excluded': bad['inputs']['objectJobIds'] = [old['id']]
            elif mutate == 'invalid-quaternion': bad['options']['selectionBox']['quaternion'] = [0, 0, 0, 2]
            elif mutate == 'negative-size': bad['options']['selectionBox']['halfExtents'][0] = -1
            else: bad['inputs']['replaceObjectJobId'] = 'missing'
            with self.assertRaises(Problem): self.workflow.submit(bad, bad['requestId'])
