"""Slurm-only model entry point. Assets and commands are resolved by the API."""
import argparse
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
from PIL import Image

from .geometry import associate, associate_box, reconstruct, write_preview

ROOT = Path(__file__).resolve().parents[2]


def json_write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")


def gpu():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("This worker requires a Slurm GPU allocation with working CUDA")
    return torch


def depth_task(spec, output):
    torch = gpu()
    sys.path.insert(0, str(ROOT / "third_party/ml-depth-pro/src"))
    import depth_pro
    from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT

    options = spec["options"]
    config = replace(DEFAULT_MONODEPTH_CONFIG_DICT, checkpoint_uri=spec["checkpoint"])
    precision = torch.float16 if options.get("precision", "float16") == "float16" else torch.float32
    model, transform = depth_pro.create_model_and_transforms(config=config, device=torch.device("cuda"), precision=precision)
    model.eval()
    image = Image.open(spec["referencePath"]).convert("RGB")
    focal = options.get("focalLengthPx")
    # The official infer() calls squeeze() on f_px, so supply a tensor, not float.
    focal = torch.tensor(float(focal), device="cuda") if focal is not None else None
    with torch.inference_mode():
        prediction = model.infer(transform(image), f_px=focal)
    depth = prediction["depth"].float().cpu().numpy()
    focal = float(prediction["focallength_px"].item())
    if not np.isfinite(focal) or focal <= 0:
        raise ValueError("Depth Pro produced an invalid focal length")
    width, height = image.size
    intrinsic = np.array([[focal, 0, (width-1)/2], [0, focal, (height-1)/2], [0, 0, 1]], dtype=np.float32)
    scene = reconstruct(depth, np.asarray(image), intrinsic, options.get("contract", 8), options.get("sobelThreshold", .35))
    if len(scene["point_ids"]) <= 8:
        raise ValueError("Reconstruction has too few valid points")
    np.savez_compressed(output / "scene.npz", **scene)
    write_preview(output / "preview.bin", scene["xyz"], scene["rgb"], scene["point_ids"])
    valid = depth[np.isfinite(depth) & (depth > 0)]
    lo, hi = np.percentile(valid, [1, 99])
    display = np.clip((np.nan_to_num(depth, nan=hi)-lo)/max(float(hi-lo), 1e-6), 0, 1)
    Image.fromarray(((1-display)*255).astype(np.uint8)).save(output / "depth.png")
    return {"width": width, "height": height, "intrinsic": intrinsic.tolist(), "focalLengthPx": focal,
            "focalSource": "provided" if spec["options"].get("focalLengthPx") is not None else "depthpro_estimated",
            "pointCount": len(scene["point_ids"]), "preview": "preview.bin", "scene": "scene.npz",
            "pixelCenters": "integer_coordinates", "depthUnits": "metres", "depthDefinition": "camera_z",
            "invalidDepthPolicy": "exclude_and_fill_valid_median_for_filter", "options": options}


def sam_task(spec, output):
    torch = gpu()
    sys.path.insert(0, str(ROOT / "third_party/sam2"))
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    model = build_sam2("configs/sam2.1/sam2.1_hiera_l.yaml", spec["checkpoint"], device="cuda",
                       apply_postprocessing=False)
    predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
    image = np.array(Image.open(spec["referencePath"]).convert("RGB"), copy=True)
    options = spec["options"]
    points = np.array([p[:2] for p in options["points"]], dtype=np.float32) if options["points"] else None
    labels = np.array([p[2] for p in options["points"]], dtype=np.int32) if options["points"] else None
    box = np.asarray(options["box"], dtype=np.float32) if options.get("box") else None
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    with torch.inference_mode(), torch.autocast("cuda", dtype=dtype):
        predictor.set_image(image)
        masks, scores, _ = predictor.predict(point_coords=points, point_labels=labels, box=box, multimask_output=True)
    # The pinned predictor returns binary values in a float32 NumPy array.
    # Normalize once so artifact writing and RGBA indexing share boolean masks.
    masks = np.asarray(masks, dtype=bool)
    np.savez_compressed(output / "masks.npz", masks=masks, scores=scores.astype(np.float32))
    candidates = []
    for index, (mask, score) in enumerate(zip(masks, scores)):
        Image.fromarray(mask.astype(np.uint8)*255).save(output / ("mask-%d.png" % index))
        rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
        rgba[mask] = [90, 225, 170, 170]
        Image.fromarray(rgba).save(output / ("overlay-%d.png" % index))
        candidates.append({"index": index, "score": float(score), "pixels": int(mask.sum()),
                           "mask": "mask-%d.png" % index, "overlay": "overlay-%d.png" % index})
    return {"width": image.shape[1], "height": image.shape[0], "candidates": candidates,
            "suggestedCandidate": int(np.argmax(scores)), "prompts": options,
            "model": "sam2.1_hiera_large", "postprocessing": "disabled"}


def associate_task(spec, output):
    with np.load(spec["scenePath"], allow_pickle=False) as data:
        scene = dict(data)
    occupied = []
    for dependency in spec.get("existingObjectPaths", []):
        with np.load(dependency, allow_pickle=False) as data:
            occupied.append(data["point_ids"])
    occupied = np.concatenate(occupied) if occupied else np.empty(0, dtype=np.uint32)
    edited = spec["options"].get("selectionBox")
    if edited is not None:
        obj = associate_box(scene, edited, occupied)
        mask = obj["mask"]
    else:
        with np.load(spec["masksPath"], allow_pickle=False) as data:
            mask = data["masks"][spec["options"]["candidate"]]
        obj = associate(scene, mask)
        if np.intersect1d(obj["point_ids"], occupied).size:
            raise ValueError("Object mask overlaps an existing object's points; refine the mask")
    np.savez_compressed(output / "object.npz", **obj)
    write_preview(output / "preview.bin", obj["xyz"], obj["rgb"], obj["point_ids"], limit=100000)
    obj["point_ids"].astype("<u4").tofile(output / "point-ids.bin")
    Image.fromarray(mask.astype(np.uint8)*255).save(output / "mask.png")
    rgba = np.zeros((*mask.shape, 4), dtype=np.uint8)
    rgba[mask] = [90, 225, 170, 170]
    Image.fromarray(rgba).save(output / "overlay.png")
    return {"center": obj["center"].tolist(), "halfExtents": obj["half_extents"].tolist(),
            "boxQuaternion": obj["box_quaternion"].tolist(),
            "pointCount": len(obj["point_ids"]), "fit": "user_edited_obb" if edited else "multistart_support_refined_obb", "minimumThickness": .0002 if edited else .002,
            "excludedPointCount": int(obj.get("excluded_point_count", 0)),
            "preview": "preview.bin", "pointIds": "point-ids.bin", "object": "object.npz"}


def run(spec, output):
    if not os.environ.get("SLURM_JOB_ID"):
        raise RuntimeError("Model workers must be launched using sbatch, not on the login node")
    cache = Path(spec["modelRoot"]) / "cache"
    os.environ.update({"HF_HOME": str(cache / "huggingface"), "TORCH_HOME": str(cache / "torch"),
                       "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    output.mkdir(parents=True, exist_ok=True)
    if spec["kind"] == "export":
        from .export import export_task
        result = export_task(spec, output)
    else:
        result = {"depth": depth_task, "sam2": sam_task, "associate": associate_task}[spec["kind"]](spec, output)
    result.update({"version": 1, "kind": spec["kind"], "source": spec["source"], "requestId": spec["requestId"]})
    json_write(output / "result.json", result)
    print(json.dumps({"status": "completed", "kind": spec["kind"], "requestId": spec["requestId"]}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    run(json.loads(args.task.read_text()), args.output_dir)


if __name__ == "__main__":
    main()
