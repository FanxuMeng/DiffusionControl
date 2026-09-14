"""Read real exported conditions with the pinned SymphoMotion loader in Slurm."""
import argparse
import json
import os
import sys
import time
import traceback
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    if not os.environ.get('SLURM_JOB_ID'):
        raise SystemExit('Submit this validation through sbatch')
    parser = argparse.ArgumentParser()
    parser.add_argument('--conditions', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--generated', type=Path, help='Also decode the actual generated video')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(ROOT/'third_party/SymphoMotion'))
    result = {'slurmId': os.environ['SLURM_JOB_ID'], 'succeeded': False, 'conditions': str(args.conditions)}
    start = time.monotonic()
    try:
        import numpy as np
        import torch
        import imageio.v2 as imageio
        from src.dataset_from_npz import load_dataset
        manifest = json.loads((args.conditions/'manifest.json').read_text())
        options = manifest['options']
        n, h, w = options['numFrames'], options['height'], options['width']
        sample = args.conditions/'sample'
        # Only shape metadata is needed by load_dataset; no model is replaced.
        pipe = types.SimpleNamespace(vae_scale_factor_spatial=8,
            transformer=types.SimpleNamespace(config=types.SimpleNamespace(patch_size=[1, 2, 2])))
        loaded = load_dataset(str(sample/'first_image.png'), str(sample/'render_output'), n, h*w,
                              pipe, True, 'cuda', use_object_prompt=True, max_entities=2)
        _, video, mask, camera, height, width, tracks, prompts, entities = loaded
        assert (height, width) == (h, w)
        assert tuple(video.shape) == (1, 3, n, h, w)
        assert tuple(mask.shape) == (1, 1, n, h, w)
        assert tuple(camera.shape) == (1, 6, n, h, w)
        assert entities == len(manifest['entityMapping']) == 1
        assert tuple(tracks.shape) == (2, n, options['pointsPerObject'], 3)
        for tensor in (video, mask, camera, tracks):
            assert torch.isfinite(tensor).all()
        with np.load(sample/'spatialtracker2.npz', allow_pickle=False) as data:
            expected = data['camera_3d_pred_0_sampled']
            np.testing.assert_allclose(data['cam_c2w'], np.tile(np.eye(4), (n, 1, 1)), atol=1e-6)
        np.testing.assert_allclose(tracks[0].numpy(), expected, atol=1e-6)
        reader = imageio.get_reader(str(sample/'render_output/render_mask.mp4'))
        try:
            expected_mask = np.stack([frame[..., 0] >= 128 for frame in reader])
        finally:
            reader.close()
        np.testing.assert_array_equal(mask[0, 0].cpu().numpy(), expected_mask)
        assert not expected_mask[0].any() and expected_mask[-1].any()
        recorded_prompts = json.loads((sample/'prompt-didi.json').read_text())['objects']
        assert prompts == [recorded_prompts['0'], '']
        result.update(succeeded=True, gpu=torch.cuda.get_device_name(0), torch=torch.__version__,
                      videoShape=list(video.shape), maskShape=list(mask.shape), cameraShape=list(camera.shape),
                      tracksShape=list(tracks.shape), entities=entities, prompts=prompts,
                      exactMaskAfterDecode=True, exactObjectTracks=True, finiteCameraEmbedding=True,
                      scope='real_pinned_loader_and_cuda_camera_embedding_not_generation_quality')
        if args.generated:
            from PIL import Image
            reader = imageio.get_reader(str(args.generated))
            try:
                frames = np.stack([frame for frame in reader])
            finally:
                reader.close()
            assert frames.shape == (n, h, w, 3), frames.shape
            assert frames.std() > 1
            for index in (0, n-1):
                Image.fromarray(frames[index]).save(args.output/('generated-frame-%02d.png' % index))
            result['generated'] = {'path': str(args.generated), 'decodedFrames': len(frames), 'width': w, 'height': h,
                                   'bytes': args.generated.stat().st_size, 'pixelStd': float(frames.std()),
                                   'steps': 2, 'qualityEvaluation': 'not_performed'}
    except Exception as error:
        result['succeeded'] = False
        result['error'] = type(error).__name__+': '+str(error)
        traceback.print_exc()
    result['elapsedSeconds'] = round(time.monotonic()-start, 2)
    (args.output/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result['succeeded'] else 1


if __name__ == '__main__':
    sys.exit(main())
