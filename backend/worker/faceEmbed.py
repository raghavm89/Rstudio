#!/usr/bin/env python3
"""
Face embedding extractor.

Reads image paths on stdin (one JSON request per line), writes one JSON result
per line to stdout. This is the ONLY Python in the stack, and it exists because
ArcFace has no usable JavaScript implementation — not because a second runtime
was wanted.

    {"id": "job-42-1", "path": "/tmp/still.png", "expect_aspect": 0.8}
    → {"id": "job-42-1", "ok": true, "faces": 1, "embedding": [...512 floats...],
       "bbox": [x1,y1,x2,y2], "det_score": 0.87, "face_fraction": 0.11,
       "width": 1024, "height": 1280, "aspect_ok": true}

Line-delimited over a long-lived process rather than one invocation per image:
insightface takes 3-8 seconds to load its models, and a four-candidate shoot
would spend more time loading than inferring. The worker starts this once and
keeps it.

This script makes NO judgement. It reports what it measured — how many faces,
the embedding, how much of the frame the face occupies — and faceQc.js decides
whether that passes. Keeping measurement and judgement apart is what lets the
thresholds be per-(avatar, LoRA, expression, framing) and re-calibrated without
touching this file.

Setup:
    python3 -m venv .venv && . .venv/bin/activate
    pip install insightface onnxruntime numpy pillow

On Apple Silicon, onnxruntime uses CoreML when available and CPU otherwise. The
model is small; CPU is fine and avoids fighting ComfyUI for unified memory.
"""

import json
import sys


MODEL_NAME = "buffalo_l"   # ArcFace r100, 512-d embeddings
DET_SIZE = (640, 640)


def log(message):
    """Diagnostics go to stderr — stdout carries only JSON results."""
    print(message, file=sys.stderr, flush=True)


def load_model():
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        log("insightface is not installed — pip install insightface onnxruntime numpy pillow")
        raise

    app = FaceAnalysis(name=MODEL_NAME, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=DET_SIZE)
    return app


def analyse(app, path, expect_aspect=None, aspect_tolerance=0.02):
    import numpy as np
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGB")
        width, height = img.size
        # insightface expects BGR, the same convention as cv2.
        array = np.asarray(img)[:, :, ::-1]

    faces = app.get(array)

    result = {
        "ok": True,
        "faces": len(faces),
        "width": width,
        "height": height,
    }

    if expect_aspect is not None:
        actual = width / height if height else 0
        result["aspect"] = round(actual, 4)
        result["aspect_ok"] = abs(actual - expect_aspect) <= aspect_tolerance

    if not faces:
        # Not an error. "No face" is a legitimate measurement and a structural
        # rejection the judgement layer already knows how to name.
        result["embedding"] = None
        return result

    # Largest face by bbox area. A reflection or a background passer-by is
    # smaller than the subject, and picking the biggest is both the common case
    # and the one that fails loudly when wrong — `faces` is reported so the
    # judgement layer can reject a two-face frame outright rather than quietly
    # scoring whichever one happened to be larger.
    def area(f):
        # float() on each corner, not on the product: `bbox` is a numpy float32
        # array, and float32 arithmetic stays float32 all the way through — which
        # `json.dumps` then refuses, from a line that has nothing to do with the
        # measurement.
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)

    face = max(faces, key=area)
    x1, y1, x2, y2 = [float(v) for v in face.bbox]

    result["embedding"] = [float(v) for v in face.normed_embedding]
    result["bbox"] = [x1, y1, x2, y2]
    result["det_score"] = float(face.det_score)
    # How much of the frame the face occupies. A wide shot legitimately scores
    # lower on similarity because there are fewer face pixels, so the judgement
    # layer wants this alongside the declared framing rather than trusting the
    # label alone.
    result["face_fraction"] = float(round(area(face) / (width * height), 5)) if width and height else 0.0

    return result


def _jsonable(value):
    """Last resort for numpy scalars and arrays.

    Every field here is cast explicitly where it is produced, which is where a
    reader can see it. This exists so that the day one is not, the process
    answers the request instead of dying — a long-lived embedder serving a queue
    should not be brought down by a type.
    """
    if hasattr(value, "item"):          # numpy scalar
        try:
            return value.item()
        except Exception:               # noqa: BLE001
            pass
    if hasattr(value, "tolist"):        # numpy array
        try:
            return value.tolist()
        except Exception:               # noqa: BLE001
            pass
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def main():
    app = load_model()
    log(f"faceEmbed ready — {MODEL_NAME}")
    # The worker waits for this line before sending work, so it never pays the
    # model load time inside a job's lease.
    print(json.dumps({"ready": True, "model": MODEL_NAME, "dim": 512}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            out = analyse(
                app,
                request["path"],
                expect_aspect=request.get("expect_aspect"),
                aspect_tolerance=request.get("aspect_tolerance", 0.02),
            )
            out["id"] = request_id
        except Exception as err:  # noqa: BLE001 — one bad image must not kill the process
            out = {"id": request_id, "ok": False, "error": f"{type(err).__name__}: {err}"}

        # Serialisation is INSIDE the protection. It used to sit outside, so a
        # value json could not encode — a numpy scalar that slipped through —
        # escaped the handler and killed the process, taking every queued request
        # with it. The comment above already promised this could not happen; the
        # promise just stopped one line short of the code that broke it.
        try:
            payload = json.dumps(out, default=_jsonable)
        except Exception as err:  # noqa: BLE001
            payload = json.dumps({
                "id": request_id,
                "ok": False,
                "error": f"result was not serialisable: {type(err).__name__}: {err}",
            })

        print(payload, flush=True)


def probe():
    """
    Can this machine embed faces at all?

    Imports the dependencies and exits — it does NOT load the model, which takes
    three to eight seconds and several hundred megabytes. The API asks this once
    at boot to decide whether to claim `embed` jobs itself or leave them for a
    worker on a machine that can, so it has to be cheap enough to run on every
    start and honest enough to be worth trusting.
    """
    try:
        import insightface  # noqa: F401
        import numpy  # noqa: F401
        print(json.dumps({"ok": True, "model": MODEL_NAME}), flush=True)
        return 0
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(err).__name__}: {err}"}), flush=True)
        return 1


if __name__ == "__main__":
    if "--probe" in sys.argv:
        sys.exit(probe())
    main()
