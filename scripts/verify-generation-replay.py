"""Decode a completed replay using the existing symphomotion environment (CPU only)."""
import argparse
import csv
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
folder = parser.parse_args().output.resolve()
folder.relative_to(ROOT)
original = json.loads((folder/'original-request.json').read_text())
request = json.loads((folder/'request.json').read_text())
job = json.loads((folder/'job.json').read_text())
assert job['status'] == 'succeeded', job['status']
assert original['parameters'] == request['parameters']
assert original['argv'] == request['argv']
assert original['execution'] == request['execution']
assert request['execution']['envName'] == 'symphomotion'
parameters = request['parameters']
outputs = Path(job['outputDirectory']).resolve()
outputs.relative_to(ROOT/'projects')
audit = json.loads((outputs/'omm-audit.json').read_text())
assert audit['completed'] and all(item['completed'] for item in audit['sampleRuns'])
if parameters.get('use_object_prompt'):
    assert audit['encoderCalls'] > 0 and audit['attentionCalls'] > 0
with Path(parameters['validation_csv_path']).open() as stream:
    samples = [Path(row['path']) for row in csv.DictReader(stream)]
if parameters.get('max_samples'): samples = samples[:parameters['max_samples']]
decoded = []
for sample in samples:
    with Image.open(sample/'first_image.png') as reference:
        aspect_ratio = reference.height/reference.width
    height = round(math.sqrt(parameters['max_area']*aspect_ratio))//16*16
    width = round(math.sqrt(parameters['max_area']/aspect_ratio))//16*16
    video = outputs/'generated_videos'/(sample.name+'.mp4')
    reader = imageio.get_reader(str(video))
    metadata = reader.get_meta_data()
    count = 0
    statistics = []
    try:
        for index, frame in enumerate(reader):
            count += 1
            assert frame.shape == (height, width, 3), frame.shape
            if index in (0, parameters['num_frames']//2, parameters['num_frames']-1):
                Image.fromarray(frame).save(folder/('%s-frame-%02d.png' % (sample.name, index)))
                statistics.append({'frame': index, 'mean': float(np.mean(frame)), 'std': float(np.std(frame))})
    finally:
        reader.close()
    assert count == parameters['num_frames'], count
    assert abs(metadata['fps']-parameters['fps']) < 1e-6
    decoded.append({'path': str(video), 'frames': count, 'width': width, 'height': height, 'fps': metadata['fps'],
                    'bytes': video.stat().st_size, 'sha256': hashlib.sha256(video.read_bytes()).hexdigest(),
                    'previewStatistics': statistics})
report = {'succeeded': True, 'jobId': job['id'], 'slurmId': job['slurmId'], 'environment': 'symphomotion',
          'modelSettingsUnchanged': True, 'parameters': parameters, 'videos': decoded, 'omm': audit,
          'versions': {name: importlib.metadata.version(name) for name in ('torch', 'diffusers', 'transformers', 'accelerate')}}
(folder/'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'succeeded': True, 'videos': decoded}, ensure_ascii=False), flush=True)
