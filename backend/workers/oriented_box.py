"""Deterministic numerical minimum-volume OBB; NumPy only, no point removal.

This is a multi-start approximation, not a certified global optimum. Optimization
uses support points, but every final candidate is measured on the complete cloud.
"""
import itertools
import numpy as np


def matrix_quaternion(rotation):
    # Largest-diagonal eigenvector formulation, stable near half turns.
    r = rotation
    k = np.array([[r[0, 0]-r[1, 1]-r[2, 2], r[0, 1]+r[1, 0], r[0, 2]+r[2, 0], r[2, 1]-r[1, 2]],
                  [r[0, 1]+r[1, 0], r[1, 1]-r[0, 0]-r[2, 2], r[1, 2]+r[2, 1], r[0, 2]-r[2, 0]],
                  [r[0, 2]+r[2, 0], r[1, 2]+r[2, 1], r[2, 2]-r[0, 0]-r[1, 1], r[1, 0]-r[0, 1]],
                  [r[2, 1]-r[1, 2], r[0, 2]-r[2, 0], r[1, 0]-r[0, 1], np.trace(r)]]) / 3
    q = np.linalg.eigh(k)[1][:, -1]
    return q if q[3] >= 0 else -q


def _measure(points, rotation, thickness):
    projected = points @ rotation
    low, high = projected.min(axis=0), projected.max(axis=0)
    return float(np.prod(np.maximum(high-low, thickness))), low, high


def _refine(points, rotation, thickness):
    best = _measure(points, rotation, thickness)[0]
    # Full SO(3), not gravity-constrained yaw. Bounded work per start.
    for angle in (.3, .1, .03, .01, .003, .001, .0003, .0001, .00003, .00001):
        moves = []
        for axis in range(3):
            a, b = (axis+1) % 3, (axis+2) % 3
            for sign in (-1, 1):
                step = np.eye(3)
                c, s = np.cos(angle), np.sin(angle)*sign
                step[a, a] = step[b, b] = c
                step[a, b], step[b, a] = -s, s
                moves.append(step)
        for _ in range(40):
            candidates = [rotation @ step for step in moves]
            scores = [_measure(points, candidate, thickness)[0] for candidate in candidates]
            winner = int(np.argmin(scores))
            if scores[winner] >= best*(1-1e-12):
                break
            best, rotation = scores[winner], candidates[winner]
    return rotation


def fit_oriented_box(xyz, minimum_thickness=.002):
    points = np.asarray(xyz, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or not len(points) or not np.isfinite(points).all():
        raise ValueError("OBB requires finite Nx3 points")
    if not np.isfinite(minimum_thickness) or minimum_thickness <= 0:
        raise ValueError("OBB minimum thickness must be positive")
    origin = points.mean(axis=0)
    points = points-origin
    _, pca = np.linalg.eigh(points.T @ points)
    if np.linalg.det(pca) < 0:
        pca[:, 0] *= -1
    rng = np.random.default_rng(20260911)
    seeds = [np.eye(3), pca]
    for _ in range(24):
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        if np.linalg.det(q) < 0:
            q[:, 0] *= -1
        seeds.append(q)
    directions = np.concatenate(seeds, axis=1)
    # Extremal points, not just a random subset: retain small protrusions.
    support_ids = set(np.linspace(0, len(points)-1, min(512, len(points)), dtype=int))
    for direction in directions.T:
        projection = np.einsum('ij,j->i', points, direction)
        support_ids.update((int(projection.argmin()), int(projection.argmax())))
    candidates = list(seeds)
    for round_index in range(3):
        support = points[sorted(support_ids)]
        starts = candidates if round_index == 0 else candidates[:8]
        refined = [_refine(support, rotation, minimum_thickness) for rotation in starts]
        # Full-cloud objective determines the winner and expansion points.
        ranked = sorted([( _measure(points, r, minimum_thickness)[0], i, r)
                         for i, r in enumerate([*refined, *seeds])], key=lambda item: (item[0], item[1]))
        candidates = [item[2] for item in ranked[:8]]
        before = len(support_ids)
        for rotation in candidates:
            projected = points @ rotation
            support_ids.update(projected.argmin(axis=0).tolist())
            support_ids.update(projected.argmax(axis=0).tolist())
        if len(support_ids) == before:
            break
    rotation = candidates[0]
    # Equivalent axis/sign choices are canonicalized towards the scene axes.
    equivalent = []
    for permutation in itertools.permutations(range(3)):
        for signs in itertools.product((-1, 1), repeat=3):
            trial = rotation[:, permutation] * np.asarray(signs)
            if np.linalg.det(trial) > 0:
                equivalent.append(trial)
    rotation = max(equivalent, key=lambda r: float(np.trace(r)))
    # Remove accumulated numerical drift before final bounds and serialization.
    u, _, vt = np.linalg.svd(rotation)
    rotation = u @ vt
    _, low, high = _measure(points, rotation, minimum_thickness)
    center = origin + ((low+high)*.5) @ rotation.T
    local = (np.asarray(xyz, np.float64)-center) @ rotation
    half = np.maximum(np.max(np.abs(local), axis=0), minimum_thickness*.5)
    half += max(1., float(np.abs(xyz).max())) * 1e-7
    return {"center": center, "half_extents": half, "box_quaternion": matrix_quaternion(rotation),
            "local_xyz": local.astype(np.float32)}
