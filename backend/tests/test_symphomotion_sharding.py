import unittest
import tempfile
import json
import logging
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from backend.diffusioncontrol.config import PROJECT_ROOT
from backend.workers.symphomotion import (finalize_inference_audit, plan_block_devices, run_audited_sample,
                                         stage_pipeline_encoders, validate_object_sample)

GIB = 1024**3


class StagedEncoderTests(unittest.TestCase):
    def test_prompt_entity_and_image_encoding_run_on_gpu_then_release_weights(self):
        moves, calls = [], []

        class Module:
            def __init__(self, name): self.name, self.device = name, 'cpu'
            def to(self, device): self.device = device; moves.append((self.name, device))

        text, image = Module('text'), Module('image')

        def encode(module, value, device):
            self.assertEqual(device, 'cuda:0')
            self.assertEqual(module.device, device)
            calls.append(value)
            if value == 'fail': raise ValueError('encoder failed')
            return {'embedding': value, 'device': device}

        pipeline = SimpleNamespace(text_encoder=text, image_encoder=image,
            encode_prompt=lambda prompt, device=None: encode(text, prompt, device),
            encode_object_prompts=lambda prompts, device=None: encode(text, prompts, device),
            encode_image=lambda pixels, device=None: encode(image, pixels, device))
        fake_torch = SimpleNamespace(device=lambda d: d, cuda=SimpleNamespace(device=lambda d: nullcontext(),
            empty_cache=lambda: None, memory_allocated=lambda i: 0, memory_reserved=lambda i: 0))
        with patch.dict('sys.modules', torch=fake_torch):
            stage_pipeline_encoders(pipeline, logging.getLogger(__name__))
            for method, name in ((pipeline.encode_prompt, 'text'), (pipeline.encode_image, 'image'),
                                 (pipeline.encode_object_prompts, 'text')):
                self.assertEqual(method('positional', 'cpu')['device'], 'cuda:0')
                self.assertEqual(method('keyword', device='cpu')['device'], 'cuda:0')
                self.assertEqual(method('default')['device'], 'cuda:0')
                self.assertEqual(moves[-2:], [(name, 'cuda:0'), (name, 'cpu')])
                with self.assertRaisesRegex(ValueError, 'encoder failed'): method('fail')
                self.assertEqual(moves[-1], (name, 'cpu'))
        self.assertEqual(len(calls), 12)


class InferenceFailureTests(unittest.TestCase):
    def audit(self, enabled=True):
        return {'enabled': enabled, 'encoderCalls': 0, 'attentionCalls': 0, 'completed': False}

    def test_original_oom_is_retained_even_when_upstream_catches_the_exception(self):
        for enabled in (True, False):
            audit = self.audit(enabled)
            def fail(): raise MemoryError('VAE CUDA out of memory')
            with self.assertRaises(MemoryError): run_audited_sample(audit, '/sample', fail)
            with self.assertRaisesRegex(RuntimeError, 'MemoryError: VAE CUDA out of memory'):
                finalize_inference_audit(audit)
            self.assertFalse(audit['completed'])
            self.assertIn('Traceback', audit['sampleRuns'][0]['traceback'])
            self.assertNotIn('OMM was enabled', audit['sampleRuns'][0]['error'])

    def test_omm_is_verified_per_sample_and_skipped_inputs_fail(self):
        audit = self.audit()
        def success():
            audit['encoderCalls'] += 1; audit['attentionCalls'] += 20
            return True
        self.assertTrue(run_audited_sample(audit, '/first', success))
        with self.assertRaisesRegex(RuntimeError, 'OMM was enabled'):
            run_audited_sample(audit, '/second', lambda: True)
        with self.assertRaisesRegex(RuntimeError, '/second'): finalize_inference_audit(audit)
        for operation in (lambda: False,):
            with self.assertRaisesRegex(RuntimeError, 'skipped'): run_audited_sample(self.audit(False), '/skipped', operation)
        with self.assertRaisesRegex(RuntimeError, 'No samples'): finalize_inference_audit(self.audit())

    def test_completed_requires_all_samples_to_succeed(self):
        audit = self.audit(False)
        run_audited_sample(audit, '/first', lambda: True)
        run_audited_sample(audit, '/second', lambda: True)
        finalize_inference_audit(audit)
        self.assertTrue(audit['completed'])


class ObjectInputTests(unittest.TestCase):
    def test_missing_nonfinite_and_mismatched_tracks_cannot_silently_disable_omm(self):
        root = PROJECT_ROOT/'var/tests'; root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            folder=Path(temporary)
            (folder/'prompt-didi.json').write_text(json.dumps({'objects': {'0': 'truck'}, 'object_number': 1}))
            np.savez(folder/'spatialtracker2.npz', cam_c2w=np.tile(np.eye(4), (5,1,1)), camera_3d_pred_0_sampled=np.ones((5,500,3)))
            self.assertEqual(validate_object_sample(folder/'render_output',5,2),1)
            with self.assertRaises(ValueError): validate_object_sample(folder/'render_output',9,2)
            for points in (np.ones((5,0,3)),np.full((5,500,3),np.nan),np.ones((4,500,3))):
                np.savez(folder/'spatialtracker2.npz',cam_c2w=np.tile(np.eye(4),(5,1,1)),camera_3d_pred_0_sampled=points)
                with self.assertRaises(ValueError): validate_object_sample(folder/'render_output',5,2)
            np.savez(folder/'spatialtracker2.npz',cam_c2w=np.tile(np.eye(4),(5,1,1)))
            with self.assertRaises(KeyError): validate_object_sample(folder/'render_output',5,2)


class ShardingPlanTests(unittest.TestCase):
    def test_accounts_for_fixed_modules_and_activation_reserve(self):
        assignments, used, reserves = plan_block_devices(16*GIB, [GIB]*28, [32*GIB, 32*GIB])
        self.assertEqual(set(assignments), {0, 1})
        self.assertEqual(sum(used), 44*GIB)
        self.assertLessEqual(abs(used[0]-used[1]), GIB)
        self.assertTrue(all(weight+reserve <= 32*GIB for weight, reserve in zip(used, reserves)))

    def test_rejects_insufficient_gpu_count_or_capacity(self):
        for fixed, blocks, capacities in [(GIB, [GIB], [32*GIB]),
                                          (28*GIB, [GIB], [32*GIB]*2),
                                          (20*GIB, [GIB]*35, [32*GIB]*2)]:
            with self.assertRaises(ValueError):
                plan_block_devices(fixed, blocks, capacities)

    def test_uses_all_visible_gpus_without_exceeding_smallest_budget(self):
        assignments, used, reserves = plan_block_devices(10*GIB, [GIB]*36, [24*GIB, 32*GIB, 32*GIB])
        self.assertEqual(set(assignments), {0, 1, 2})
        self.assertTrue(all(w+r <= c for w, r, c in zip(used, reserves, [24*GIB, 32*GIB, 32*GIB])))


if __name__ == '__main__':
    unittest.main()
