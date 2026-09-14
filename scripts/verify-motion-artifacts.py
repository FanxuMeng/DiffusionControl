"""Verify real retained geometry/render/OMM artifacts on an allocated node."""
import argparse
import json
import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
parser = argparse.ArgumentParser()
parser.add_argument('part', choices=['render', 'consumer'])
args = parser.parse_args()
if not os.environ.get('SLURM_JOB_ID'): raise SystemExit('Use sbatch for verification')
folder = ROOT/'var/validation/20260911-motion'
output = folder/('verify-'+args.part); output.mkdir(exist_ok=True)
read = lambda name: json.loads((folder/name).read_text())
exported = Path(read('export/job.json')['outputDirectory'])
associated = Path(read('associate/job.json')['outputDirectory'])
source = read('associate/request.json')
scene_path = ROOT/'projects'/source['projectId']/'jobs'/source['inputs']['sceneJobId']/'outputs/scene.npz'
report = {'succeeded': False, 'slurmId': os.environ['SLURM_JOB_ID'], 'environment': Path(sys.prefix).name}
try:
    import numpy as np
    import torch
    import imageio.v2 as imageio
    from PIL import Image
    from backend.workers.geometry import quaternion_matrix, sample_pose, transform_object
    assert torch.cuda.is_available()
    with np.load(associated/'object.npz', allow_pickle=False) as data: obj = dict(data)
    with np.load(exported/'sample/spatialtracker2.npz', allow_pickle=False) as data: tracks = dict(data)
    manifest = json.loads((exported/'manifest.json').read_text())
    project = read('snapshot.json'); item = project['objects'][0]
    options = manifest['options']; n, h, w = options['numFrames'], options['height'], options['width']
    selected = np.searchsorted(obj['point_ids'], tracks['source_point_ids_0'])
    np.testing.assert_array_equal(obj['point_ids'][selected], tracks['source_point_ids_0'])
    expected = np.stack([transform_object(obj['xyz'][selected], item['initialPose'], sample_pose(item['trajectory'], item['clip'], f/options['fps'])) for f in range(n)])
    stored_world = np.stack([points @ c2w[:3, :3].T + c2w[:3, 3] for points, c2w in zip(tracks['camera_3d_pred_0_sampled'], tracks['cam_c2w'])])
    np.testing.assert_allclose(stored_world, expected, atol=3e-6)
    report['persistentPointIdentityAndRigidMotion'] = True
    if args.part == 'render':
        assert Path(sys.prefix).name == 'depthpro'
        from backend.workers.export import render_points, projected_box
        rotation = quaternion_matrix(obj['box_quaternion'])
        local = (obj['xyz']-obj['center']) @ rotation
        violation = float(np.max(np.abs(local)-obj['half_extents']))
        assert violation <= 1e-6, violation
        volume = float(np.prod(obj['half_extents']*2))
        aabb = float(np.prod(np.ptp(obj['xyz'], axis=0)))
        report.update(fullPointCount=len(local), allPointsEnclosed=True, maximumViolation=violation,
                      orientedVolume=volume, axisAlignedVolume=aabb, volumeReduction=1-volume/aabb)
        with np.load(scene_path, allow_pickle=False) as data: scene = dict(data)
        # Independently render the complete unchanged scene at the final camera.
        rgb, holes = render_points(scene['xyz'], scene['rgb'], tracks['intrinsic'], tracks['cam_c2w'][-1], h, w, options['radius'], options['pointsPerPixel'])
        reader = imageio.get_reader(str(exported/'sample/render_output/render_mask.mp4'))
        try: mask_frame = reader.get_data(n-1)[..., 0] >= 128
        finally: reader.close()
        np.testing.assert_array_equal(mask_frame, holes)
        reader = imageio.get_reader(str(exported/'sample/render_output/render_with_2d_bbox.mp4'))
        try: frames = [reader.get_data(i) for i in range(n)]
        finally: reader.close()
        expected_rgb = np.clip(rgb*255,0,255).astype(np.uint8)
        valid = np.ones((h,w),bool)
        for box in manifest['boxes'][-1]:
            if box:
                x0,y0,x1,y1=box
                valid[max(0,y0-5):min(h,y1+6),max(0,x0-5):min(w,x1+6)] = False
        error = float(np.abs(frames[-1].astype(float)-expected_rgb)[valid].mean())
        assert error < 8, error  # MP4 is lossy; masks/geometry use exact checks.
        Image.fromarray(expected_rgb).save(output/'reference-scene-final-camera.png')
        for i in (0,n-1): Image.fromarray(frames[i]).save(output/('rendered-frame-%02d.png'%i))
        Image.fromarray(mask_frame.astype(np.uint8)*255).save(output/'holes-last-frame.png')
        report.update(staticSceneCoverageExact=True, rgbMeanAbsoluteErrorOutsideBoxes=error,
                      boxMoves=manifest['boxes'][0]!=manifest['boxes'][-1])
        assert report['boxMoves']
    else:
        assert Path(sys.prefix).name == 'symphomotion'
        sys.path.insert(0,str(ROOT/'third_party/SymphoMotion'))
        from src.dataset_from_npz import load_dataset
        pipe=types.SimpleNamespace(vae_scale_factor_spatial=8,transformer=types.SimpleNamespace(config=types.SimpleNamespace(patch_size=[1,2,2])))
        loaded=load_dataset(str(exported/'sample/first_image.png'),str(exported/'sample/render_output'),n,h*w,pipe,True,'cuda',use_object_prompt=True,max_entities=2)
        _,video,mask,camera,height,width,points,prompts,count=loaded
        assert count==1 and points.shape==(2,n,500,3)
        np.testing.assert_allclose(points[0].numpy(),expected,atol=3e-6)
        assert prompts[0]==item['prompt'] and prompts[1]==''
        assert torch.isfinite(camera).all() and torch.isfinite(points).all()
        generated=Path(read('generation/job.json')['outputDirectory'])
        audit=json.loads((generated/'omm-audit.json').read_text())
        assert audit['completed'] and audit['enabled'] and audit['encoderCalls']>0 and audit['attentionCalls']>0
        assert audit['embeddingNorm']>0 and audit['attentionOutputNorm']>0 and audit['objScale']>0
        reader=imageio.get_reader(str(next((generated/'generated_videos').glob('*.mp4'))))
        try: frames=np.stack([frame for frame in reader])
        finally: reader.close()
        assert frames.shape==(n,h,w,3)
        for i in (0,n-1): Image.fromarray(frames[i]).save(output/('generated-frame-%02d.png'%i))
        report.update(referenceCameraTrajectoriesExact=True, entityTextsMatch=True,
                      cameraEmbeddingShape=list(camera.shape), pointShape=list(points.shape), omm=audit,
                      generatedShape=list(frames.shape), qualityEvaluation='not_performed_2_step_smoke_test')
        import unittest
        suite=unittest.defaultTestLoader.loadTestsFromName('backend.tests.test_export')
        contract=unittest.TextTestRunner(verbosity=1).run(suite)
        assert contract.wasSuccessful() and not contract.skipped
        report['upstreamLoaderContractPassed']=True
    report['succeeded']=True
finally:
    (output/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
