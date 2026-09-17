#!/usr/bin/env python3
"""
Whole-image embedding extractor — the CHARACTER counterpart to faceEmbed.py.

A person is judged by their face (insightface / ArcFace). A CHARACTER — a
personified mango, a mascot, an animated fruit — has no face to detect, so its
identity has to ride on the whole frame. This process embeds the whole image
with CLIP and reports the vector; faceQc.js decides whether it is the same
character, exactly as it does for a face, because CLIP vectors compare by angle
too.

Same wire protocol as faceEmbed.py so the Node side is the same class pointed at
a different script: one JSON request per line on stdin, one JSON result per line
on stdout, diagnostics to stderr, a `ready` line before any work so the model
load never sits inside a job's lease.

    {"id": "job-42-1", "path": "/tmp/still.png", "expect_aspect": 0.8}
    → {"id": "job-42-1", "ok": true, "embedding": [...512 floats...],
       "width": 1024, "height": 1280, "aspect": 0.8, "aspect_ok": true}

Unlike the face extractor there is NO detection step and no `faces` count: a
whole-image embedding always exists for any image that opens, so a character
frame is never rejected for "no face" — the identity judgement is the cosine
alone. The face-only structural rejects (no_face, multiple_faces, hands) are
skipped for characters on the judgement side too (faceQc, subjectType).

Model: openai/clip-vit-base-patch32 — 512-d image features, the same width as
ArcFace by coincidence, not by design; the two vector spaces are unrelated and a
character's reference mean must be built from CLIP vectors, never mixed with a
face mean.

Setup (shares the torch env with indicf5_tts.py):
    pip install torch transformers pillow
"""

import json
import sys


MODEL_NAME = "openai/clip-vit-base-patch32"
EMBED_DIM = 512


def log(message):
    """Diagnostics go to stderr — stdout carries only JSON results."""
    print(message, file=sys.stderr, flush=True)


def load_model():
    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor
    except ImportError:
        log("torch/transformers not installed — pip install torch transformers pillow")
        raise

    # CPU is fine: one 224x224 forward pass is milliseconds, and this avoids
    # fighting ComfyUI/IndicF5 for unified memory on the Mac.
    model = CLIPModel.from_pretrained(MODEL_NAME)
    model.eval()
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)
    return {"torch": torch, "model": model, "processor": processor}


def analyse(ctx, path, expect_aspect=None, aspect_tolerance=0.02):
    from PIL import Image

    torch = ctx["torch"]
    model = ctx["model"]
    processor = ctx["processor"]

    with Image.open(path) as img:
        img = img.convert("RGB")
        width, height = img.size
        inputs = processor(images=img, return_tensors="pt")

    with torch.no_grad():
        feats = model.get_image_features(**inputs)

    # L2-normalise so the stored vector is a direction. cosineSimilarity would
    # normalise anyway, but a unit vector is what the mean-of-a-seed-set wants:
    # averaging raw-magnitude CLIP features lets a brighter frame weigh more.
    feats = feats / feats.norm(p=2, dim=-1, keepdim=True)
    embedding = [float(v) for v in feats[0].tolist()]

    result = {
        "ok": True,
        "embedding": embedding,
        "width": width,
        "height": height,
    }

    if expect_aspect is not None:
        actual = width / height if height else 0
        result["aspect"] = round(actual, 4)
        result["aspect_ok"] = abs(actual - expect_aspect) <= aspect_tolerance

    return result


def main():
    ctx = load_model()
    log(f"clipEmbed ready — {MODEL_NAME}")
    # The worker waits for this line before sending work, so it never pays the
    # model load time inside a job's lease.
    print(json.dumps({"ready": True, "model": MODEL_NAME, "dim": EMBED_DIM}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            out = analyse(
                ctx,
                request["path"],
                expect_aspect=request.get("expect_aspect"),
                aspect_tolerance=request.get("aspect_tolerance", 0.02),
            )
            out["id"] = request_id
        except Exception as err:  # noqa: BLE001 — one bad image must not kill the process
            out = {"id": request_id, "ok": False, "error": f"{type(err).__name__}: {err}"}

        try:
            payload = json.dumps(out)
        except Exception as err:  # noqa: BLE001
            payload = json.dumps({
                "id": request_id,
                "ok": False,
                "error": f"result was not serialisable: {type(err).__name__}: {err}",
            })

        print(payload, flush=True)


def probe():
    """
    Can this machine embed whole images?

    Imports the dependencies and exits — it does NOT load the model, which pulls
    ~600MB the first time and several hundred MB into memory after. The API asks
    this once at boot to decide whether to claim character `qc`/`embed` jobs
    itself or leave them for a worker on a machine that can.
    """
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        print(json.dumps({"ok": True, "model": MODEL_NAME}), flush=True)
        return 0
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(err).__name__}: {err}"}), flush=True)
        return 1


if __name__ == "__main__":
    if "--probe" in sys.argv:
        sys.exit(probe())
    main()
