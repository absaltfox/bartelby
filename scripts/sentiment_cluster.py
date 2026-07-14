#!/usr/bin/env python3
"""
Sentiment phrase clustering — Phase 2a.

Input: pass `--input <path>` (preferred; avoids stdin pipe-buffer thrash on
large payloads) OR pipe JSON via stdin (fallback for ad-hoc invocation).

Input JSON shape:
  {
    "phrases": [{"id": int, "embedding": [float, ...]}, ...],
    "params": {
      "umap_n_components": int,
      "umap_n_neighbors": int,
      "hdbscan_min_cluster_size": int,
      "hdbscan_min_samples": int,
      "random_state": int
    }
  }

Writes JSON to stdout:
  {
    "status": "ok",
    "clusters": [
      {"cluster_index": int, "members": [{"phrase_id": int, "distance_to_centroid": float}, ...]},
      ...
    ],
    "noise_phrase_ids": [int, ...]
  }

On failure: traceback on stderr, non-zero exit code.

Per docs/superpowers/specs/2026-05-23-sentiment-phase-2a-clustering-design.md § 4.
"""
import argparse
import json
import sys

import numpy as np
from umap import UMAP
import hdbscan


def main():
    parser = argparse.ArgumentParser(description="Sentiment phrase clustering")
    parser.add_argument("--input", help="Path to JSON input file (preferred over stdin for large payloads)")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "r") as f:
            payload = json.load(f)
    else:
        payload = json.load(sys.stdin)

    phrases = payload["phrases"]
    params = payload["params"]

    if len(phrases) < params["hdbscan_min_cluster_size"]:
        json.dump({
            "status": "ok",
            "clusters": [],
            "noise_phrase_ids": [p["id"] for p in phrases]
        }, sys.stdout)
        return

    ids = [p["id"] for p in phrases]
    X = np.array([p["embedding"] for p in phrases], dtype=np.float32)

    # Guard against 0-feature input: if embedding BLOBs failed to decode
    # upstream the matrix is (N, 0), and UMAP would raise an opaque
    # "Found array with 0 feature(s)" trace. Fail with a clear, actionable
    # message instead. (The Node reader now decodes Turso ArrayBuffers and
    # drops empty rows, so this is defense in depth.)
    if X.ndim < 2 or X.shape[1] == 0:
        sys.stderr.write(
            "clustering aborted: embeddings decoded to 0 features "
            f"(shape={X.shape}). The embedding BLOBs likely failed to decode "
            "before reaching this script.\n"
        )
        sys.exit(2)

    # Dim reduction — UMAP from 384 → params.umap_n_components
    reducer = UMAP(
        n_components=params["umap_n_components"],
        n_neighbors=min(params["umap_n_neighbors"], len(phrases) - 1),
        metric="cosine",
        random_state=params["random_state"],
    )
    X_reduced = reducer.fit_transform(X)

    # Clustering — HDBSCAN on the reduced space
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=params["hdbscan_min_cluster_size"],
        min_samples=params["hdbscan_min_samples"],
        metric="euclidean",
    )
    labels = clusterer.fit_predict(X_reduced)

    # Group phrases by cluster label
    clusters = {}
    for i, label in enumerate(labels):
        if label == -1:
            continue
        clusters.setdefault(int(label), []).append(i)

    # Per-cluster centroid + member distances (in UMAP-reduced space)
    out_clusters = []
    for label, member_indices in sorted(clusters.items()):
        member_vecs = X_reduced[member_indices]
        centroid = member_vecs.mean(axis=0)
        distances = np.linalg.norm(member_vecs - centroid, axis=1)
        members = [
            {"phrase_id": ids[idx], "distance_to_centroid": float(d)}
            for idx, d in zip(member_indices, distances)
        ]
        members.sort(key=lambda m: m["distance_to_centroid"])
        out_clusters.append({"cluster_index": label, "members": members})

    noise_ids = [ids[i] for i, l in enumerate(labels) if l == -1]
    json.dump({
        "status": "ok",
        "clusters": out_clusters,
        "noise_phrase_ids": noise_ids
    }, sys.stdout)


if __name__ == "__main__":
    main()
