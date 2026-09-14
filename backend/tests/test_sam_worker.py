import contextlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
from backend.diffusioncontrol.config import PROJECT_ROOT
from backend.workers.run import sam_task


class SamWorkerTests(unittest.TestCase):
    def test_float_binary_predictor_masks_produce_consistent_artifacts(self):
        masks = np.zeros((3, 16, 24), np.float32)
        masks[0, 2:8, 4:12] = 1
        masks[1, 4:12, 6:18] = 1
        masks[2, 6:10, 8:14] = 1
        scores = np.array([.2, .9, .4], np.float32)
        case = self

        class Predictor:
            def __init__(self, model, **kwargs):
                case.assertEqual(kwargs, {'max_hole_area': 0, 'max_sprinkle_area': 0})

            def set_image(self, image):
                case.assertTrue(image.flags.writeable)

            def predict(self, **kwargs):
                case.assertTrue(kwargs['multimask_output'])
                return masks, scores, None

        build = types.ModuleType('sam2.build_sam')
        build.build_sam2 = lambda *args, **kwargs: object()
        predictor = types.ModuleType('sam2.sam2_image_predictor')
        predictor.SAM2ImagePredictor = Predictor
        fake_torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_bf16_supported=lambda: True), bfloat16='bf16',
                                          inference_mode=contextlib.nullcontext, autocast=lambda *a, **kw: contextlib.nullcontext())
        folder = PROJECT_ROOT/'var/tests'
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as temporary:
            output = Path(temporary)
            reference = output/'reference.png'
            Image.new('RGB', (24, 16)).save(reference)
            with patch('backend.workers.run.gpu', return_value=fake_torch), patch.object(sys, 'path', list(sys.path)), \
                    patch.dict(sys.modules, {'sam2.build_sam': build, 'sam2.sam2_image_predictor': predictor}):
                result = sam_task({'referencePath': str(reference), 'checkpoint': 'unused',
                                   'options': {'points': [[10, 8, 1]], 'box': None}}, output)
            self.assertEqual(result['suggestedCandidate'], 1)
            with np.load(output/'masks.npz', allow_pickle=False) as arrays:
                self.assertEqual(arrays['masks'].dtype, bool)
                np.testing.assert_array_equal(arrays['masks'], masks.astype(bool))
            for i, candidate in enumerate(result['candidates']):
                binary = np.asarray(Image.open(output/candidate['mask']))
                overlay = np.asarray(Image.open(output/candidate['overlay']))
                np.testing.assert_array_equal(binary > 0, masks[i].astype(bool))
                np.testing.assert_array_equal(overlay[:, :, 3] > 0, masks[i].astype(bool))
                self.assertEqual(candidate['pixels'], int(masks[i].sum()))


if __name__ == '__main__':
    unittest.main()
