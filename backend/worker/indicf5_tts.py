#!/usr/bin/env python3
"""
IndicF5 — owned, local zero-shot TTS (the voice-clone engine).

    python worker/indicf5_tts.py \
        --ref  reference.wav \
        --ref-text "the exact words spoken in reference.wav" \
        --text "what the cloned voice should now say" \
        --out  out.wav

Zero-shot: it mimics the voice in the reference clip, so there is no separate
"train a voice" step and nothing leaves the machine. AI4Bharat IndicF5 is MIT
licensed and covers 11 Indian languages. This is the durable, India-resident,
owned voice asset (decision-voice-tts.md); Sarvam/ElevenLabs are the vendor
fallbacks we deliberately are NOT using for a real person's biometric voice.

Reads the model id from INDICF5_MODEL (default ai4bharat/IndicF5) and the output
sample rate from INDICF5_SR (default 24000). Prints a single JSON line to stdout
on success: {"ok": true, "out": "<path>", "sr": <int>, "seconds": <float>}.
Any failure exits non-zero with a human-readable message on stderr — the Node
voice stage surfaces it.

NB: IndicF5's exact call signature can move between releases (the decision doc
flags this). If a release changes it, adjust `synthesize()` below only — the CLI
contract stays the same.
"""

import argparse
import json
import os
import sys


def eprint(*a):
    print(*a, file=sys.stderr)


def synthesize(model, text, ref_audio_path, ref_text):
    """
    Call IndicF5. The documented usage is a single callable that takes the
    target text plus a reference audio path and its transcript, and returns a
    waveform (numpy float array). Kept isolated so a release change is a
    one-function edit.
    """
    return model(text, ref_audio_path=ref_audio_path, ref_text=ref_text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="reference audio (wav) to mimic")
    ap.add_argument("--ref-text", required=True, help="exact transcript of the reference audio")
    ap.add_argument("--text", required=True, help="text the cloned voice should speak")
    ap.add_argument("--out", required=True, help="output wav path")
    ap.add_argument("--lang", default=os.environ.get("INDICF5_LANG", "hi"))
    args = ap.parse_args()

    if not os.path.exists(args.ref):
        eprint(f"reference audio not found: {args.ref}")
        sys.exit(2)
    if not str(args.text).strip():
        eprint("nothing to say (empty --text)")
        sys.exit(2)

    model_id = os.environ.get("INDICF5_MODEL", "ai4bharat/IndicF5")
    sr = int(os.environ.get("INDICF5_SR", "24000"))

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from transformers import AutoModel
    except Exception as e:  # noqa: BLE001
        eprint(
            "IndicF5 dependencies missing. Install them on this machine:\n"
            "  python3 -m venv ~/indicf5 && source ~/indicf5/bin/activate\n"
            "  pip install torch transformers soundfile numpy\n"
            f"  (import error: {e})"
        )
        sys.exit(3)

    device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    try:
        model = AutoModel.from_pretrained(model_id, trust_remote_code=True)
        try:
            model = model.to(device)
        except Exception:  # some builds pin their own device
            device = "cpu"
    except Exception as e:  # noqa: BLE001
        eprint(f"could not load {model_id}: {e}")
        sys.exit(4)

    try:
        wav = synthesize(model, args.text, args.ref, args.ref_text)
    except Exception as e:  # noqa: BLE001
        eprint(f"synthesis failed: {e}")
        sys.exit(5)

    try:
        import numpy as np  # noqa: F811
        arr = np.asarray(wav, dtype="float32").reshape(-1)
        # Normalise if the model returned ints or a hot signal.
        peak = float(abs(arr).max()) if arr.size else 0.0
        if peak > 1.0:
            arr = arr / peak
        import soundfile as sf  # noqa: F811
        sf.write(args.out, arr, sr)
        seconds = round(len(arr) / float(sr), 2)
    except Exception as e:  # noqa: BLE001
        eprint(f"could not write output: {e}")
        sys.exit(6)

    print(json.dumps({"ok": True, "out": args.out, "sr": sr, "seconds": seconds, "device": device}))


if __name__ == "__main__":
    main()
