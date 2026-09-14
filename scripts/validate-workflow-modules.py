"""Run real workflow workers and numerical assertions only inside Slurm."""
import argparse
import ast
import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def check_outputs(spec, output):
    import numpy as np
    from backend.diffusioncontrol.workflow import validate_outputs
    result = json.loads((output/'result.json').read_text())
    validate_outputs(output, {'kind': spec['kind'], 'requestId': spec['requestId'], 'source': spec['source']})
    checks = {'publishedArtifactContract': True}
    if spec['kind'] == 'depth':
        import torch
        import kornia
        with np.load(output/'scene.npz', allow_pickle=False) as data:
            scene = dict(data)
        depth = scene['depth']
        assert depth.shape == (result['height'], result['width'])
        valid = np.isfinite(depth) & (depth > 0)
        assert valid.mean() > .99
        assert np.isfinite(scene['xyz']).all()
        assert len(np.unique(scene['point_ids'])) == result['pointCount']
        tree = ast.parse((ROOT/'third_party/SymphoMotion/src/pointcloud.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'get_boundaries_mask')
        namespace = {'torch': torch, 'kornia': kornia}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'pinned-pointcloud.py', 'exec'), namespace)
        reference = torch.tensor(np.where(valid, depth, np.median(depth[valid])))[None, None]
        middle = reference.flatten().median()*spec['options']['contract']
        far = reference > middle
        reference[far] = 2*middle-middle**2/(reference[far]+1e-6)
        boundary = namespace['get_boundaries_mask'](1/(reference+1e-7), spec['options']['sobelThreshold'])[0, 0].numpy()
        np.testing.assert_allclose(scene['processed_depth'][valid], reference.numpy()[0, 0][valid], rtol=2e-6, atol=1e-6)
        disagreements = int(np.count_nonzero(scene['keep'] != (valid & ~boundary)))
        checks.update(validDepthFraction=float(valid.mean()), depthPercentiles=np.percentile(depth[valid], [1, 50, 99]).tolist(),
                      pointCount=result['pointCount'], upstreamBoundaryDisagreements=disagreements,
                      upstreamComparedPixels=depth.size, focalLengthPx=result['focalLengthPx'])
        # A threshold decision can differ within float32 rounding, so preserve
        # the exact count and separately reject material geometric differences.
        assert disagreements <= max(2, depth.size*1e-5), checks
    elif spec['kind'] == 'sam2':
        with np.load(output/'masks.npz', allow_pickle=False) as data:
            masks, scores = data['masks'], data['scores']
        assert masks.dtype == bool and masks.shape[1:] == (result['height'], result['width'])
        assert np.isfinite(scores).all() and len(masks) == len(result['candidates'])
        selected = int(result['suggestedCandidate'])
        mask = masks[selected]
        assert .01 < mask.mean() < .95
        for x, y, label in spec['options']['points']:
            assert mask[round(y), round(x)] == bool(label), (x, y, label)
        checks.update(candidateCount=len(masks), scores=scores.tolist(), selectedCandidate=selected,
                      foregroundPixels=int(mask.sum()), foregroundFraction=float(mask.mean()), promptPixelsRespected=True)
    elif spec['kind'] == 'associate':
        with np.load(spec['scenePath'], allow_pickle=False) as data:
            scene = dict(data)
        with np.load(spec['masksPath'], allow_pickle=False) as data:
            mask = data['masks'][spec['options']['candidate']]
        with np.load(output/'object.npz', allow_pickle=False) as data:
            obj = dict(data)
        selected = mask.reshape(-1)[scene['point_ids']]
        np.testing.assert_array_equal(obj['point_ids'], scene['point_ids'][selected])
        np.testing.assert_array_equal(obj['xyz'], scene['xyz'][selected])
        np.testing.assert_array_equal(obj['rgb'], scene['rgb'][selected])
        assert (np.abs(obj['xyz']-obj['center']) <= obj['half_extents']+2e-6).all()
        np.testing.assert_array_equal(np.fromfile(output/'point-ids.bin', '<u4'), obj['point_ids'])
        checks.update(exactScenePointIds=True, exactSceneCoordinates=True, aabbContainsAllPoints=True,
                      pointCount=len(obj['point_ids']), center=obj['center'].tolist(), halfExtents=obj['half_extents'].tolist())
    elif spec['kind'] == 'export':
        import imageio.v2 as imageio
        from PIL import Image
        options = spec['options']
        n, h, w = options['numFrames'], options['height'], options['width']
        sample = output/'sample'
        decoded = {}
        for name in ('render_with_2d_bbox', 'render_mask'):
            reader = imageio.get_reader(str(sample/'render_output'/(name+'.mp4')))
            try:
                frames = np.stack([frame for frame in reader])
            finally:
                reader.close()
            assert frames.shape == (n, h, w, 3), frames.shape
            decoded[name] = frames
            Image.fromarray(frames[-1]).save(output/(name+'-last.png'))
        masks = decoded['render_mask'][..., 0] >= 128
        assert not masks[0].any()
        assert masks[-1].any() and not masks[-1].all()
        reference = np.array(Image.open(spec['referencePath']).convert('RGB').resize((w, h), Image.Resampling.LANCZOS))
        np.testing.assert_array_equal(np.array(Image.open(sample/'first_image.png')), reference)
        first_error = float(np.abs(decoded['render_with_2d_bbox'][0].astype(float)-reference).mean())
        assert first_error < 8, first_error  # H.264 / YUV420 is lossy.
        with np.load(sample/'spatialtracker2.npz', allow_pickle=False) as data:
            arrays = dict(data)
        # This fixture deliberately uses a fixed identity camera and translation
        # only, so expected coordinates do not reuse the worker's pose helpers.
        np.testing.assert_allclose(arrays['cam_c2w'], np.tile(np.eye(4), (n, 1, 1)), atol=1e-6)
        with np.load(spec['scenePath'], allow_pickle=False) as data:
            original_k = data['intrinsic']
            sh, sw = data['image_size']
        expected_k = original_k.copy()
        expected_k[:2, 2] += .5
        expected_k[0] *= w/sw
        expected_k[1] *= h/sh
        np.testing.assert_allclose(arrays['intrinsic'], expected_k, atol=1e-4)
        displacements = []
        for index, descriptor in enumerate(spec['objects']):
            with np.load(descriptor['path'], allow_pickle=False) as data:
                obj = dict(data)
            ids = arrays['source_point_ids_%d' % index]
            positions = np.searchsorted(obj['point_ids'], ids)
            np.testing.assert_array_equal(obj['point_ids'][positions], ids)
            tracks = arrays['camera_3d_pred_%d_sampled' % index]
            delta = np.asarray(spec['validation']['objectTranslations'][index])
            expected = obj['xyz'][positions][None] + np.linspace(0, 1, n)[:, None, None]*delta
            np.testing.assert_allclose(tracks, expected, atol=2e-6)
            displacements.append((tracks[-1]-tracks[0]).mean(axis=0).tolist())
        checks.update(decodedFrames=n, width=w, height=h, firstFrameMeanAbsoluteError=first_error,
                      holePixelsPerFrame=masks.sum(axis=(1, 2)).tolist(), stableSourcePointIds=True,
                      objectDisplacements=displacements, fixedReferenceCamera=True, resizedIntrinsic=True)
        audit_file = output/'raster-audit.json'
        if audit_file.is_file():
            audit = json.loads(audit_file.read_text())
            assert len(audit) == n
            assert all(row['exactPointCount'] and row['exactBackground'] and row['expectedObjectMotion'] for row in audit)
            checks['fullCloudRasterAudit'] = audit
    return checks


def audited_export(spec, output, run):
    """Observe real CUDA renderer inputs/outputs without replacing its algorithm."""
    import numpy as np
    from PIL import Image
    from unittest.mock import patch
    from backend.workers import export
    with np.load(spec['scenePath'], allow_pickle=False) as data:
        scene = dict(data)
    objects = []
    for descriptor in spec['objects']:
        with np.load(descriptor['path'], allow_pickle=False) as data:
            objects.append(dict(data))
    occupied = np.concatenate([obj['point_ids'] for obj in objects])
    background = ~np.isin(scene['point_ids'], occupied)
    original = export.render_points
    rows = []

    def observe(xyz, rgb, intrinsic, c2w, height, width, radius, layers):
        frame = len(rows)
        factor = frame/(spec['options']['numFrames']-1)
        expected = np.concatenate([scene['xyz'][background]] + [
            obj['xyz'] + factor*np.asarray(delta) for obj, delta in zip(objects, spec['validation']['objectTranslations'])])
        row = {'frame': frame, 'pointCount': len(xyz), 'exactPointCount': len(xyz) == len(scene['xyz']),
               'exactBackground': bool(np.array_equal(xyz[:background.sum()], scene['xyz'][background])),
               'expectedObjectMotion': bool(np.allclose(xyz, expected, atol=2e-6, rtol=0))}
        image, holes = original(xyz, rgb, intrinsic, c2w, height, width, radius, layers)
        assert np.isfinite(image).all()
        row['rawHolePixels'] = int(holes.sum())
        rows.append(row)
        Image.fromarray(np.clip(image*255, 0, 255).astype(np.uint8)).save(output/('raw-rgb-%02d.png' % frame))
        Image.fromarray(holes.astype(np.uint8)*255).save(output/('raw-holes-%02d.png' % frame))
        (output/'raster-audit.json').write_text(json.dumps(rows, indent=2)+'\n')
        return image, holes

    with patch.object(export, 'render_points', side_effect=observe):
        run(spec, output)


def main():
    if not os.environ.get('SLURM_JOB_ID'):
        raise SystemExit('Submit module validation through sbatch')
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check-only', action='store_true', help='Validate existing outputs without running the worker again')
    args = parser.parse_args()
    from backend.workers.run import run
    import torch
    spec = json.loads(args.task.read_text())
    report = {'slurmId': os.environ['SLURM_JOB_ID'], 'kind': spec['kind'], 'succeeded': False,
              'torch': torch.__version__, 'gpu': torch.cuda.get_device_name(0)}
    started = time.monotonic()
    if not args.check_only:
        args.output.mkdir(parents=True, exist_ok=False)
    try:
        if args.check_only:
            assert args.output.is_dir(), 'Existing output directory is required'
        elif spec['kind'] == 'export':
            audited_export(spec, args.output, run)
        else:
            run(spec, args.output)
        report['checks'] = check_outputs(spec, args.output)
        report['succeeded'] = True
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
        traceback.print_exc()
    finally:
        report.update(elapsedSeconds=round(time.monotonic()-started, 2), peakAllocatedBytes=torch.cuda.max_memory_allocated())
        report['checkOnly'] = args.check_only
        filename = 'validation-check-%s.json' % os.environ['SLURM_JOB_ID'] if args.check_only else 'validation.json'
        (args.output/filename).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return 0 if report['succeeded'] else 1


if __name__ == '__main__':
    sys.exit(main())
