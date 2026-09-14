"""Slurm-only model sharding around the pinned SymphoMotion entry point."""
import argparse
import functools
import inspect
import json
import os
import sys
import traceback
from pathlib import Path


STAGED_ENCODERS = ('text_encoder', 'image_encoder')


def stage_pipeline_encoders(pipeline, logger):
    """Execute whole encoders on GPU, releasing their weights between phases."""
    import torch
    device = torch.device('cuda:0')

    def wrap(method, module, name):
        signature = inspect.signature(method)

        @functools.wraps(method)
        def staged(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            # Upstream caches the idle encoder's CPU device before calling us.
            bound.arguments['device'] = device
            try:
                module.to(device)
                return method(*bound.args, **bound.kwargs)
            finally:
                module.to('cpu')
                with torch.cuda.device(device):
                    torch.cuda.empty_cache()
                logger.info('DiffusionControl encoder released: %s; GPU 0 allocated=%d reserved=%d',
                            name, torch.cuda.memory_allocated(0), torch.cuda.memory_reserved(0))
        return staged

    for method_name, component in (('encode_prompt', 'text_encoder'),
                                   ('encode_object_prompts', 'text_encoder'),
                                   ('encode_image', 'image_encoder')):
        setattr(pipeline, method_name, wrap(getattr(pipeline, method_name), getattr(pipeline, component), method_name))


def run_audited_sample(audit, path, operation):
    """Record the first real failure before upstream catches it and continues."""
    run = {'path': str(path), 'completed': False}
    audit.setdefault('sampleRuns', []).append(run)
    before = {key: audit[key] for key in ('encoderCalls', 'attentionCalls')}
    try:
        success = operation()
        if not success:
            raise RuntimeError('Sample was skipped or did not produce a video')
        if audit['enabled'] and any(audit[key] == before[key] for key in before):
            raise RuntimeError('OMM was enabled but encoder/attention were never executed for this sample')
        run['completed'] = True
        return success
    except Exception as error:
        run.update(errorType=type(error).__name__, error=str(error), traceback=traceback.format_exc())
        raise
    finally:
        run.update({key: audit[key] - before[key] for key in before})


def finalize_inference_audit(audit):
    runs = audit.get('sampleRuns', [])
    failures = [run for run in runs if not run['completed']]
    if failures:
        first = failures[0]
        raise RuntimeError('Inference failed for %s: %s: %s' % (first['path'], first['errorType'], first['error']))
    if not runs:
        raise RuntimeError('No samples were generated')
    audit['completed'] = True


def validate_object_sample(render_path, nframe, max_entities):
    """Upstream catches malformed OMM inputs; reject them before that fallback."""
    import numpy as np
    sample = Path(render_path).parent
    prompts = json.loads((sample / 'prompt-didi.json').read_text())
    objects = prompts.get('objects')
    if not isinstance(objects, dict) or not 1 <= len(objects) <= max_entities or prompts.get('object_number') != len(objects):
        raise ValueError('OMM entity count is missing or exceeds max_entities')
    if any(not isinstance(value, str) or not value.strip() for value in objects.values()):
        raise ValueError('OMM requires a nonempty Entity Text for every object')
    with np.load(sample / 'spatialtracker2.npz', allow_pickle=False) as arrays:
        cameras = arrays['cam_c2w']
        if cameras.shape != (nframe, 4, 4) or not np.isfinite(cameras).all():
            raise ValueError('OMM camera frame count/values mismatch')
        shape = None
        for key in sorted(objects):
            points = arrays['camera_3d_pred_%s_sampled' % key]
            if points.ndim != 3 or points.shape[0] != nframe or points.shape[2] != 3 or points.shape[1] < 1 or not np.isfinite(points).all():
                raise ValueError('OMM point trajectories must be finite [frames, points, 3]')
            if shape is not None and points.shape != shape:
                raise ValueError('OMM entities must have matching point trajectory shapes')
            shape = points.shape
    return len(objects)


def plan_block_devices(fixed_bytes, block_bytes, capacities):
    """Place whole blocks using actual storage sizes, reserving activation space."""
    if len(capacities) < 2:
        raise ValueError('multi_gpu requires at least two GPUs in one Slurm task')
    reserves = [max(5 * 1024**3, int(capacity * .15)) for capacity in capacities]
    budgets = [capacity - reserve for capacity, reserve in zip(capacities, reserves)]
    used = [fixed_bytes] + [0] * (len(capacities) - 1)
    if any(amount > budget for amount, budget in zip(used, budgets)):
        raise ValueError('GPU 0 cannot fit the fixed modules with the activation reserve')
    assignments = []
    for size in block_bytes:
        candidates = [i for i in range(len(budgets)) if used[i] + size <= budgets[i]]
        if not candidates:
            raise ValueError('Allocated GPUs cannot fit all blocks with the activation reserve')
        selected = min(candidates, key=lambda i: (used[i] + size) / budgets[i])
        assignments.append(selected)
        used[selected] += size
    return assignments, used, reserves


def shard_pipeline(pipeline, logger):
    import torch
    from accelerate.hooks import AlignDevicesHook, add_hook_to_module

    def storage_bytes(module):
        return sum(t.numel() * t.element_size() for t in list(module.parameters()) + list(module.buffers()))

    devices = [torch.cuda.get_device_properties(i) for i in range(torch.cuda.device_count())]
    transformer = pipeline.transformer
    block_bytes = [storage_bytes(block) for block in transformer.blocks]
    components = {name: model for name, model in pipeline.components.items() if isinstance(model, torch.nn.Module)}
    total = sum(storage_bytes(model) for model in components.values())
    assignments, used, reserves = plan_block_devices(total - sum(block_bytes), block_bytes,
                                                     [device.total_memory for device in devices])
    staged_bytes = sum(storage_bytes(components[name]) for name in STAGED_ENCODERS)
    device_map = {name: 'cpu' if name in STAGED_ENCODERS else 'cuda:0' for name in components}
    for i, assignment in enumerate(assignments):
        device_map['transformer.blocks.' + str(i)] = 'cuda:' + str(assignment)
    report = {'mode': 'multi_gpu', 'deviceMap': device_map,
              'stagedEncoders': {name: {'idleDevice': 'cpu', 'executionDevice': 'cuda:0',
                                       'weightBytes': storage_bytes(components[name])} for name in STAGED_ENCODERS},
              'devices': [{'index': i, 'name': device.name, 'capacityBytes': device.total_memory,
                           'weightBytes': used[i] - (staged_bytes if i == 0 else 0),
                           'weightBudgetIncludingEncodersBytes': used[i], 'reservedForActivationsBytes': reserves[i]}
                          for i, device in enumerate(devices)]}
    logger.info('DiffusionControl placement: %s', json.dumps(report))
    for name, model in components.items():
        if name in STAGED_ENCODERS:
            model.to('cpu')
        elif name != 'transformer':
            model.to('cuda:0')
    # Do not call transformer.to() or pipeline.to() after splitting its blocks.
    for name, child in transformer.named_children():
        if name != 'blocks':
            child.to('cuda:0')
    for parameter in transformer.parameters(recurse=False):
        parameter.data = parameter.data.to('cuda:0')
    for name, buffer in transformer.named_buffers(recurse=False):
        transformer._buffers[name] = buffer.to('cuda:0')
    for block, assignment in zip(transformer.blocks, assignments):
        if assignment == 0:
            block.to('cuda:0')
        else:
            add_hook_to_module(block, AlignDevicesHook(execution_device='cuda:' + str(assignment),
                                                       io_same_device=True, place_submodules=True))
    pipeline._diffusioncontrol_placement = report
    stage_pipeline_encoders(pipeline, logger)
    return pipeline


def main():
    if not os.environ.get('SLURM_JOB_ID'):
        raise SystemExit('SymphoMotion inference must run through sbatch on a compute node')
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--memory_mode', choices=['native', 'multi_gpu'], default='native')
    options, remaining = parser.parse_known_args()
    root = Path(__file__).resolve().parents[2]
    source = root / 'third_party/SymphoMotion'
    models = Path('/home/225015066/PretrainedModels')
    os.environ.update(HF_HOME=str(models / 'cache/huggingface'), TORCH_HOME=str(models / 'cache/torch'),
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
    sys.path.insert(0, str(source))
    import torch
    if options.memory_mode == 'multi_gpu':
        if any(int(os.environ.get(key, '1')) != 1 for key in ('WORLD_SIZE', 'SLURM_NTASKS')):
            raise SystemExit('multi_gpu requires one process/task with multiple allocated GPUs')
        if torch.cuda.device_count() < 2:
            raise SystemExit('multi_gpu requires sbatch --gpus=2 or more')
        if int(os.environ.get('LOCAL_RANK', '0')) != 0 or int(os.environ.get('RANK', '0')) != 0:
            raise SystemExit('multi_gpu requires rank 0 in a single process')
    import infer
    from src.pipelines.pipeline_pcd import prompt_clean
    prompt_clean('DiffusionControl dependency preflight')
    original_builder = infer.build_pipeline
    original_loader = infer.load_validation_dataset
    original_runner = infer.run_single_sample
    runner_signature = inspect.signature(original_runner)
    audit = {'enabled': '--use_object_prompt' in remaining, 'completed': False,
             'samples': [], 'sampleRuns': [], 'encoderCalls': 0, 'attentionCalls': 0}

    def run_single_sample(*args, **kwargs):
        bound = runner_signature.bind(*args, **kwargs)
        return run_audited_sample(audit, bound.arguments['base_path'], lambda: original_runner(*args, **kwargs))

    def load_dataset(*args, **kwargs):
        count = validate_object_sample(kwargs['render_path'], kwargs['nframe'], kwargs['max_entities']) if kwargs.get('use_object_prompt') else 0
        loaded = original_loader(*args, **kwargs)
        if count:
            tracks, prompts, entities = loaded[-3:]
            if tracks is None or prompts is None or entities != count or not torch.isfinite(tracks).all():
                raise ValueError('OMM loader failed; refusing silent inference without object control')
            audit['samples'].append({'entities': entities, 'pointsShape': list(tracks.shape),
                                     'referenceCameraNormalized': kwargs.get('normalize_object_to_first_frame', True)})
        return loaded

    def encoder_hook(module, args, output):
        audit['encoderCalls'] += 1
        if audit['encoderCalls'] == 1:
            if not torch.isfinite(output).all():
                raise ValueError('OMM encoder produced nonfinite embeddings')
            audit['embeddingShape'] = list(output.shape)
            audit['embeddingNorm'] = float(output.float().norm())

    def attention_hook(module, args, output):
        audit['attentionCalls'] += 1
        if audit['attentionCalls'] == 1:
            if not torch.isfinite(output).all():
                raise ValueError('OMM attention produced nonfinite output')
            audit['attentionOutputShape'] = list(output.shape)
            audit['attentionOutputNorm'] = float(output.float().norm())

    def build_pipeline(args, device, logger):
        if options.memory_mode == 'native':
            pipeline, config = original_builder(args, device, logger)
        else:
            pipeline, config = original_builder(args, torch.device('cpu'), logger)
            pipeline = shard_pipeline(pipeline, logger)
        if args.use_object_prompt:
            pipeline.transformer.obj_traj_encoder.register_forward_hook(encoder_hook)
            for module in pipeline.transformer.obj_perceiver_cross_attention:
                module.register_forward_hook(attention_hook)
            audit['objScale'] = args.obj_scale
        return pipeline, config

    infer.build_pipeline = build_pipeline
    infer.load_validation_dataset = load_dataset
    infer.run_single_sample = run_single_sample
    sys.argv = [str(source / 'infer.py'), *remaining]
    parsed = infer.parse_args()
    audit_path = Path(parsed.output_dir) / 'omm-audit.json'
    try:
        infer.main()
        finalize_inference_audit(audit)
    except Exception as error:
        audit.update(errorType=type(error).__name__, error=str(error))
        raise
    finally:
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(json.dumps(audit, indent=2)+'\n')
        print('DiffusionControl OMM audit: '+json.dumps(audit), flush=True)
        if torch.cuda.is_initialized():
            print(json.dumps({'memoryMode': options.memory_mode, 'devices': [
                {'index': i, 'peakAllocatedBytes': torch.cuda.max_memory_allocated(i),
                 'peakReservedBytes': torch.cuda.max_memory_reserved(i)}
                for i in range(torch.cuda.device_count())]}), flush=True)


if __name__ == '__main__':
    main()
