#!/usr/bin/env python3
"""Slurm-only dependency and CUDA probe; does not load model checkpoints."""
import argparse
import importlib
import importlib.metadata
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=["sam2", "depth", "associate", "export", "symphomotion"])
    args = parser.parse_args()
    if not os.environ.get("SLURM_JOB_ID"):
        parser.error("Submit this probe with sbatch; GPU checks do not run on the login node")
    os.environ.update({"HF_HOME": "/home/225015066/PretrainedModels/cache/huggingface",
                       "TORCH_HOME": "/home/225015066/PretrainedModels/cache/torch", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    sys.path[:0] = [str(ROOT), str(ROOT / "third_party/sam2"), str(ROOT / "third_party/ml-depth-pro/src"), str(ROOT / "third_party/SymphoMotion")]
    result = {"task": args.task, "slurmId": os.environ["SLURM_JOB_ID"], "python": sys.version.split()[0], "executable": sys.executable}
    try:
        import torch
        import numpy as np
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in this allocation")
        result.update(torch=torch.__version__, cuda=torch.version.cuda, gpu=torch.cuda.get_device_name(0),
                      memoryBytes=torch.cuda.get_device_properties(0).total_memory, bf16=torch.cuda.is_bf16_supported(),
                      capability=list(torch.cuda.get_device_capability(0)), compiledArchitectures=torch.cuda.get_arch_list())
        result["cudaTensor"] = float(torch.ones(4, device="cuda").sum().cpu())
        modules = {"sam2": ["sam2.build_sam", "sam2.sam2_image_predictor"], "depth": ["depth_pro", "timm", "pillow_heif"],
                   "associate": ["backend.workers.geometry"], "export": ["pytorch3d", "imageio_ffmpeg"],
                   "symphomotion": ["infer", "diffusers", "transformers"]}[args.task]
        for name in modules:
            importlib.import_module(name)
        if args.task == "symphomotion":
            from src.pipelines.pipeline_pcd import prompt_clean
            result["promptClean"] = prompt_clean("  DiffusionControl &amp; SymphoMotion  ")
        if args.task == "export":
            from backend.workers.export import render_points
            xyz = np.array([[x, y, 2] for x in (-.1, 0, .1) for y in (-.1, 0, .1)], np.float32)
            rgb, holes = render_points(xyz, np.full((9, 3), 200, np.uint8), np.array([[16, 0, 8], [0, 16, 8], [0, 0, 1]], np.float32),
                                       np.eye(4), 16, 16, .1, 8)
            if not np.isfinite(rgb).all() or holes.all():
                raise RuntimeError("CUDA rasterizer did not cover any test pixels")
            result["coveredPixels"] = int((~holes).sum())
        result.update(ready=True, scope="dependencies_and_cuda_only_not_model_quality")
    except Exception as error:
        result.update(ready=False, error=type(error).__name__ + ": " + str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return 0 if result["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
