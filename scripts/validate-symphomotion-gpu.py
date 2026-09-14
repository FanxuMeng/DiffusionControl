#!/usr/bin/env python3
"""Real Slurm model smoke test with explicitly synthetic input; retain all artifacts."""
import argparse
import csv
import importlib.metadata
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path('/home/225015066/PretrainedModels')


def main():
    if not os.environ.get('SLURM_JOB_ID'):
        raise SystemExit('Run this validation with sbatch on a compute node')
    parser = argparse.ArgumentParser()
    parser.add_argument('--memory-mode', choices=['native', 'multi_gpu'], default='native')
    options = parser.parse_args()
    os.environ.update(HF_HOME=str(MODELS/'cache/huggingface'), TORCH_HOME=str(MODELS/'cache/torch'),
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
    import numpy as np
    import imageio.v2 as imageio
    from PIL import Image, ImageDraw
    job_id = os.environ['SLURM_JOB_ID']
    output = ROOT/'var/validation/20260909-gpu'/('generation-'+job_id)
    output.mkdir(parents=True, exist_ok=False)
    sample = output/'synthetic_sample'
    videos = sample/'render_output'
    videos.mkdir(parents=True)
    width, height, frames, fps = 256, 144, 5, 4
    reference = Image.new('RGB', (width, height), (185, 195, 200))
    draw = ImageDraw.Draw(reference)
    draw.rectangle([0, 90, 255, 143], fill=(145, 130, 110))
    draw.rectangle([80, 48, 119, 95], fill=(50, 95, 210))
    reference.save(sample/'first_image.png')
    k = np.array([[256, 0, 128], [0, 256, 72], [0, 0, 1]], np.float32)
    yy, xx = np.mgrid[48:96, 80:120]
    pixels = np.stack([xx.ravel()+.5, yy.ravel()+.5, np.ones(xx.size)], axis=1)
    points = (pixels @ np.linalg.inv(k).T * 2).astype(np.float32)
    selected = np.random.default_rng(42).choice(len(points), 500, replace=False)
    tracks = []
    writer = dict(fps=fps, codec='libx264', quality=9, macro_block_size=1, pixelformat='yuv420p')
    with imageio.get_writer(str(videos/'render_with_2d_bbox.mp4'), **writer) as rgb_writer, imageio.get_writer(str(videos/'render_mask.mp4'), **writer) as mask_writer:
        for frame in range(frames):
            offset = frame*4
            image = reference.copy()
            paint = ImageDraw.Draw(image)
            paint.rectangle([80, 48, 119, 95], fill=(128, 128, 128))
            paint.rectangle([80+offset, 48, 119+offset, 95], fill=(50, 95, 210), outline=(255, 0, 0), width=2)
            holes = np.zeros((height, width, 3), np.uint8)
            holes[48:96, 80:80+offset] = 255
            rgb_writer.append_data(np.asarray(reference if frame == 0 else image))
            mask_writer.append_data(holes)
            moved = points[selected].copy()
            moved[:, 0] += offset*2/256
            tracks.append(moved)
    np.savez_compressed(sample/'spatialtracker2.npz', cam_c2w=np.repeat(np.eye(4, dtype=np.float32)[None], frames, axis=0),
                        intrinsic=k, camera_3d_pred_0_sampled=np.asarray(tracks, np.float32))
    (sample/'full_prompt.json').write_text(json.dumps({'full_prompt': 'A blue rectangular object moves slowly to the right on a neutral background.'}))
    (sample/'prompt-didi.json').write_text(json.dumps({'objects': {'0': 'A blue rectangular object moves to the right.'}, 'object_number': 1}))
    with (output/'validation.csv').open('w', newline='') as stream:
        writer_csv = csv.writer(stream)
        writer_csv.writerow(['path'])
        writer_csv.writerow([str(sample)])
    source = ROOT/'third_party/SymphoMotion'
    argv = [sys.executable, str(source/'infer.py'), '--validation_csv_path', str(output/'validation.csv'),
            '--pretrained_model_path', str(MODELS/'Diffusers/Wan2.1-I2V-14B-720P-Diffusers'),
            '--controlnet_path', str(MODELS/'Symphomotion/pretrained_checkpoints/camera_control/controlnet.pth'),
            '--obj_injector_path', str(MODELS/'Symphomotion/pretrained_checkpoints/object_control/object_injector.pth'),
            '--config_path', str(source/'configs/uni3c_controlnet_config.json'), '--output_dir', str(output/'outputs'),
            '--num_frames', str(frames), '--fps', str(fps), '--max_area', str(width*height), '--num_inference_steps', '2',
            '--max_samples', '1', '--use_object_prompt', '--use_camera_embedding', '--seed', '42']
    if options.memory_mode != 'native':
        argv[1] = str(ROOT/'backend/workers/symphomotion.py')
        argv.extend(['--memory_mode', options.memory_mode])
    (output/'command.json').write_text(json.dumps(argv, indent=2))
    gpu_name = subprocess.check_output(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'], text=True).strip()
    result = {'slurmId': job_id, 'fixture': 'synthetic_interface_smoke_not_model_quality', 'torch': importlib.metadata.version('torch'),
              'gpu': gpu_name, 'frames': frames, 'steps': 2, 'width': width, 'height': height, 'argv': argv,
              'memoryMode': options.memory_mode}
    started = time.monotonic()
    with (output/'inference.log').open('w') as log:
        completed = subprocess.run(argv, cwd=source, stdout=log, stderr=subprocess.STDOUT)
    result.update(returncode=completed.returncode, elapsedSeconds=round(time.monotonic()-started, 2), succeeded=False)
    for line in (output/'inference.log').read_text(errors='replace').splitlines():
        if 'DiffusionControl placement: ' in line:
            result['placement'] = json.loads(line.split('DiffusionControl placement: ', 1)[1])
        if line.startswith('{"memoryMode":'):
            result['memoryUsage'] = json.loads(line)
    generated = output/'outputs/generated_videos/synthetic_sample.mp4'
    if completed.returncode == 0 and generated.is_file():
        try:
            reader = imageio.get_reader(str(generated))
            decoded = [frame for frame in reader]
            reader.close()
            result.update(decodedFrames=len(decoded), output=str(generated), bytes=generated.stat().st_size,
                          succeeded=len(decoded) == frames and all(frame.shape[:2] == (height, width) for frame in decoded))
            if decoded:
                Image.fromarray(decoded[-1]).save(output/'generated-last-frame.png')
        except Exception as error:
            result['decodeError'] = str(error)
    (output/'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result['succeeded'] else 1


if __name__ == '__main__':
    sys.exit(main())
