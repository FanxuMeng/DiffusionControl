"""Deterministic geometry, matching SymphoMotion's valid-depth preprocessing.

The Sobel/contract formula is adapted from SymphoMotion src/pointcloud.py at
bf9af6666c0f8cbb594e64f165be79b44c962763. No model or GPU imports here.
"""
import struct

import numpy as np


def finite_array(value, shape=None, name="array"):
    result = np.asarray(value, dtype=np.float32)
    if (shape is not None and result.shape != shape) or not np.isfinite(result).all():
        raise ValueError(name + " shape or finite values invalid")
    return result


def lower_median(values):
    values = np.asarray(values).reshape(-1)
    if not values.size:
        raise ValueError("No valid depth pixels")
    k = (values.size - 1) // 2  # torch.median chooses the lower element for even N.
    return np.partition(values, k)[k]


def preprocess_depth(depth, contract=8.0, threshold=0.35):
    depth = np.asarray(depth, dtype=np.float32)
    if depth.ndim != 2 or not depth.size:
        raise ValueError("Depth must be a nonempty H x W array")
    if not np.isfinite(contract) or contract <= 0 or not 0 < threshold < 1:
        raise ValueError("Invalid contract or Sobel threshold")
    valid = np.isfinite(depth) & (depth > 0)
    if not valid.any():
        return np.zeros_like(depth), np.zeros_like(valid)
    # Invalid inputs are excluded; finite positive inputs reproduce the upstream
    # median, contraction, inverse-depth normalization and replicate-padded Sobel.
    median = lower_median(depth[valid])
    processed = np.where(valid, depth, median).copy()
    middle = np.float32(median * contract)
    far = processed > middle
    processed[far] = 2 * middle - middle ** 2 / (processed[far] + np.float32(1e-6))
    disparity = 1 / (processed + np.float32(1e-7))
    disparity = (disparity - disparity.min()) / (disparity.max() - disparity.min() + np.float32(1e-6))
    p = np.pad(disparity, 1, mode="edge")
    gx = -p[:-2, :-2] + p[:-2, 2:] - 2 * p[1:-1, :-2] + 2 * p[1:-1, 2:] - p[2:, :-2] + p[2:, 2:]
    gy = -p[:-2, :-2] - 2 * p[:-2, 1:-1] - p[:-2, 2:] + p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]
    boundary = np.exp(-10 * np.sqrt(gx * gx + gy * gy)) < threshold
    processed[~valid] = 0
    return processed, valid & ~boundary


def legacy_intrinsic(intrinsic):
    result = finite_array(intrinsic, (3, 3), "intrinsic").copy()
    if result[0, 0] <= 0 or result[1, 1] <= 0 or not np.allclose(result[2], [0, 0, 1]):
        raise ValueError("Invalid pinhole intrinsic")
    result[:2, 2] += .5
    return result


def reconstruct(depth, rgb, intrinsic, contract=8.0, threshold=0.35):
    rgb = np.asarray(rgb)
    if rgb.shape != (*np.shape(depth), 3) or rgb.dtype != np.uint8:
        raise ValueError("RGB must be uint8 at the exact depth resolution")
    processed, keep = preprocess_depth(depth, contract, threshold)
    ids = np.flatnonzero(keep).astype(np.uint32)
    height, width = processed.shape
    pixels = np.column_stack((ids % width + .5, ids // width + .5, np.ones(len(ids)))).astype(np.float32)
    xyz = (pixels @ np.linalg.inv(legacy_intrinsic(intrinsic)).T) * processed.reshape(-1)[ids, None]
    return {"depth": np.asarray(depth, dtype=np.float32), "processed_depth": processed,
            "keep": keep, "point_ids": ids, "xyz": xyz.astype(np.float32),
            "rgb": rgb.reshape(-1, 3)[ids], "intrinsic": np.asarray(intrinsic, dtype=np.float32),
            "image_size": np.array([height, width], dtype=np.int32), "reference_c2w": np.eye(4, dtype=np.float32)}


def associate(scene, mask, minimum_points=9, minimum_thickness=.002):
    height, width = (int(value) for value in scene["image_size"])
    mask = np.asarray(mask)
    if mask.shape != (height, width) or not np.isin(mask, [0, 1, False, True]).all():
        raise ValueError("Mask must be binary at the original image resolution")
    ids = np.asarray(scene["point_ids"])
    if ids.ndim != 1 or (ids.size and (ids.min() < 0 or ids.max() >= height * width)):
        raise ValueError("Scene point-to-pixel indices invalid")
    selected = mask.reshape(-1)[ids].astype(bool)
    xyz = np.asarray(scene["xyz"])[selected]
    if len(xyz) < minimum_points:
        raise ValueError("Mask contains fewer than %d valid reconstructed points; refine the mask" % minimum_points)
    from .oriented_box import fit_oriented_box
    box = fit_oriented_box(xyz, minimum_thickness)
    return {"point_ids": ids[selected], "xyz": xyz, "rgb": np.asarray(scene["rgb"])[selected],
            **box,
            "image_size": np.asarray(scene["image_size"]), "mask": mask.astype(bool)}


def write_preview(path, xyz, rgb, point_ids, limit=180000):
    n = len(xyz)
    indices = np.linspace(0, n - 1, min(n, limit), dtype=np.int64) if n else np.empty(0, dtype=np.int64)
    dtype = np.dtype([("xyz", "<f4", (3,)), ("rgb", "<f4", (3,)), ("id", "<u4")])
    records = np.empty(len(indices), dtype=dtype)
    records["xyz"] = xyz[indices]
    records["rgb"] = np.asarray(rgb)[indices].astype(np.float32) / 255
    records["id"] = np.asarray(point_ids)[indices]
    with open(path, "wb") as stream:
        stream.write(struct.pack("<4sII", b"DCP1", len(records), dtype.itemsize))
        stream.write(records.tobytes())


def associate_box(scene, box, excluded_ids=(), minimum_points=9):
    center = finite_array(box["center"], (3,), "box center")
    half = finite_array(box["halfExtents"], (3,), "box half extents")
    quaternion = finite_array(box["quaternion"], (4,), "box quaternion")
    if np.any(half < .0001):
        raise ValueError("Box dimensions must be positive")
    rotation = quaternion_matrix(quaternion)
    xyz = finite_array(scene["xyz"], name="scene points")
    ids = np.asarray(scene["point_ids"])
    local = (xyz.astype(np.float64) - center.astype(np.float64)) @ rotation.astype(np.float64)
    tolerance = np.maximum(1e-6, half * 1e-6)
    selected = np.all(np.abs(local) <= half + tolerance, axis=1)
    occupied = np.isin(ids, np.asarray(excluded_ids, dtype=ids.dtype))
    excluded_count = int(np.count_nonzero(selected & occupied))
    selected &= ~occupied
    if np.count_nonzero(selected) < minimum_points:
        raise ValueError("Edited box contains fewer than %d available scene points; enlarge or move the box" % minimum_points)
    mask = np.zeros(tuple(int(v) for v in scene["image_size"]), dtype=bool)
    mask.reshape(-1)[ids[selected]] = True
    return {"point_ids": ids[selected], "xyz": xyz[selected], "rgb": np.asarray(scene["rgb"])[selected],
            "center": center, "half_extents": half, "box_quaternion": quaternion / np.linalg.norm(quaternion),
            "local_xyz": local[selected].astype(np.float32),
            "image_size": np.asarray(scene["image_size"]), "mask": mask, "excluded_point_count": excluded_count}


def quaternion_matrix(q):
    q = finite_array(q, (4,), "quaternion").astype(np.float64)
    length = np.linalg.norm(q)
    if abs(length - 1) > .001:
        raise ValueError("Quaternion must be normalized")
    x, y, z, w = q / length
    return np.array([[1 - 2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1 - 2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1 - 2*(x*x+y*y)]], dtype=np.float32)


def pose_matrix(pose):
    matrix = np.eye(4, dtype=np.float32)
    matrix[:3, :3] = quaternion_matrix(pose["quaternion"])
    matrix[:3, 3] = finite_array(pose["position"], (3,), "position")
    return matrix


def sample_pose(trajectory, clip, time):
    duration, start, length = (float(trajectory["duration"]), float(clip["start"]), float(clip["duration"]))
    if not np.isfinite([duration, start, length, time]).all() or min(duration, length) <= 0:
        raise ValueError("Invalid timeline duration")
    samples = trajectory["samples"]
    if not 2 <= len(samples) <= 72001:
        raise ValueError("Invalid trajectory samples")
    times = np.asarray([sample["t"] for sample in samples], dtype=float)
    if not np.isfinite(times).all() or np.any(np.diff(times) <= 0) or abs(times[0]) > 1e-6 or abs(times[-1]-duration) > 1e-5:
        raise ValueError("Trajectory timestamps must cover its duration monotonically")
    source_time = np.clip((time-start)*duration/length, 0, duration)
    index = max(0, min(len(samples)-2, int(np.searchsorted(times, source_time, side="right"))-1))
    a, b = samples[index:index+2]
    factor = np.clip((source_time-times[index])/(times[index+1]-times[index]), 0, 1)
    qa, qb = finite_array(a["quaternion"], (4,)), finite_array(b["quaternion"], (4,))
    quaternion_matrix(qa)
    quaternion_matrix(qb)
    dot = np.dot(qa, qb)
    if dot < 0:
        qb, dot = -qb, -dot
    if dot > .9995:
        q = qa + factor * (qb-qa)
    else:
        angle = np.arccos(np.clip(dot, -1, 1))
        q = (np.sin((1-factor)*angle)*qa + np.sin(factor*angle)*qb)/np.sin(angle)
    q /= np.linalg.norm(q)
    pa, pb = finite_array(a["position"], (3,)), finite_array(b["position"], (3,))
    return {"position": (pa+factor*(pb-pa)).tolist(), "quaternion": q.tolist()}


def transform_object(points, initial_pose, pose):
    initial = pose_matrix(initial_pose)
    current = pose_matrix(pose)
    rotation = current[:3, :3] @ initial[:3, :3].T
    return (np.asarray(points)-initial[:3, 3]) @ rotation.T + current[:3, 3]


def resize_intrinsic(intrinsic, source_size, target_size):
    result = finite_array(intrinsic, (3, 3)).copy()
    sy, sx = np.asarray(target_size) / np.asarray(source_size)
    result[0] *= sx
    result[1] *= sy
    result[0, 2] += (sx-1)*.5
    result[1, 2] += (sy-1)*.5
    return result
