#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Set up the face embedder — insightface, in its own environment.
#
#     bash studio/setup-embedder.sh
#
# `worker/faceEmbed.py` needs insightface, onnxruntime, numpy and pillow. This
# puts them in a dedicated virtualenv rather than in whatever `python3` happens
# to be, for three reasons that all bite on a Mac:
#
#   1. Homebrew's Python refuses `pip install` outright (PEP 668,
#      "externally-managed-environment"), and the suggested `--break-system-
#      packages` is exactly what its name says.
#   2. `python3` on a Mac can be Xcode's, Homebrew's, conda's or python.org's
#      depending on PATH order, and which one you got is not obvious from the
#      error when it goes wrong later.
#   3. insightface pulls a compiler and a pile of transitive dependencies. That
#      belongs somewhere you can delete in one line.
#
# The venv lands at studio/.venv-embed and the script prints the one line to add
# to .env so the worker and studio/train.js both use it.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV="$HERE/.venv-embed"

# Pinned deliberately. insightface went 0.7.3 → 1.0 → 2.0 inside four months and
# 2.0 landed the day this was written; `faceEmbed.py` is written against the
# FaceAnalysis API, which 2.0 still has, but an unannounced major version
# arriving mid-project is how a pipeline breaks for a reason nobody changed.
# Raise it on purpose, not by accident.
INSIGHTFACE_VERSION="${INSIGHTFACE_VERSION:-2.0}"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  ✗ %s\n\n' "$*"; exit 1; }

printf '\nFace embedder setup\n\n'

# ── 1. Find a Python by VERSION, not by name ─────────────────────────────────
#
# The lesson from the ComfyUI installer: `python3` is a name, not a version, and
# conda's python3 answered to the same name while being a different interpreter.
# Ask each candidate what it actually is.

PY=""
for candidate in python3.12 python3.11 python3.10 python3 "$(command -v python3 2>/dev/null)"; do
  [ -z "$candidate" ] && continue
  command -v "$candidate" >/dev/null 2>&1 || continue
  ver="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
  case "$ver" in
    3.9|3.10|3.11|3.12)
      # insightface has wheels or builds cleanly on these. 3.13 is newer than
      # onnxruntime's wheel matrix in places, which surfaces as a baffling
      # "no matching distribution" rather than a version complaint.
      PY="$candidate"; PYVER="$ver"; break;;
  esac
done

[ -z "$PY" ] && fail "No Python 3.9–3.12 found.
    Checked python3.12, python3.11, python3.10 and python3.
    Xcode's command line tools ship one:  xcode-select --install"

ARCH="$("$PY" -c 'import platform; print(platform.machine())')"
say "Python     $("$PY" -V 2>&1) at $(command -v "$PY")"
say "Arch       $ARCH"

if [ "$ARCH" != "arm64" ] && [ "$(uname -m)" = "arm64" ]; then
  # An x86_64 Python under Rosetta on Apple Silicon installs x86_64 wheels and
  # then runs everything through translation — slow, and the cause of the
  # Homebrew mess earlier in this project.
  say "!  This is an x86_64 Python on an arm64 Mac (Rosetta). It will work but"
  say "   will be slow. An arm64 Python is worth finding."
fi

# ── 2. A clean venv ──────────────────────────────────────────────────────────

if [ -d "$VENV" ]; then
  say "Reusing    $VENV"
else
  say "Creating   $VENV"
  "$PY" -m venv "$VENV" || fail "Could not create a virtualenv with $PY.
    On a stock macOS Python this usually means the command line tools are
    missing:  xcode-select --install"
fi

VPY="$VENV/bin/python"
[ -x "$VPY" ] || fail "The virtualenv has no python at $VPY"

# ── 3. Install ───────────────────────────────────────────────────────────────
#
# numpy first and on its own: insightface builds against it, and a build that
# starts before numpy is importable fails with a compiler error rather than a
# missing-dependency one.

say ""
say "Installing (this takes a few minutes — insightface compiles)"
"$VPY" -m pip install --quiet --upgrade pip setuptools wheel \
  || fail "Could not upgrade pip inside the venv. Is the network reachable?"

"$VPY" -m pip install --quiet "numpy<3" \
  || fail "numpy failed to install."

# scikit-image is pinned below 2.2 on purpose. insightface's face_align calls
# skimage's `estimate`, which 0.26 deprecates and 2.2 REMOVES — so an unpinned
# upgrade turns today's FutureWarning into tomorrow's AttributeError, inside a
# dependency of a dependency, during a training run.
"$VPY" -m pip install --quiet onnxruntime pillow "scikit-image<2.2" \
  || fail "onnxruntime, pillow or scikit-image failed to install.
    On Apple Silicon make sure this is an arm64 Python — an x86_64 one under
    Rosetta sometimes finds no matching onnxruntime wheel at all."

# insightface is the one that can genuinely fail, so its output is NOT hidden.
say ""
say "Installing insightface==$INSIGHTFACE_VERSION (output shown — this is the one that can fail)"
if ! "$VPY" -m pip install "insightface==$INSIGHTFACE_VERSION"; then
  fail "insightface failed to build.
    It compiles a Cython extension, so it needs a C compiler:
        xcode-select --install
    If that is already installed, the real error is in the output above — the
    last few lines of it, not the first."
fi

# ── 4. Prove it, rather than assume it ───────────────────────────────────────
#
# Importing is not the same as working: insightface downloads its model pack
# (buffalo_l, a few hundred MB) on FIRST USE, not at install. A setup that stops
# at "import ok" hands you the download failure later, in the middle of a
# training run, looking like something else.

say ""
say "Verifying — this downloads the buffalo_l model pack on first run"
"$VPY" - <<'PYCHECK'
import sys
try:
    import numpy, onnxruntime
    from PIL import Image
    from insightface.app import FaceAnalysis
except Exception as e:
    print(f"  import failed: {e}", file=sys.stderr); sys.exit(1)

print(f"  numpy {numpy.__version__} · onnxruntime {onnxruntime.__version__}")
try:
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
except Exception as e:
    print(f"  model load failed: {e}", file=sys.stderr); sys.exit(1)
print("  buffalo_l loaded")
PYCHECK
[ $? -eq 0 ] || fail "The packages installed but the model would not load.
    That is usually the download: it pulls buffalo_l from GitHub on first use.
    Check the network and re-run this script — it is safe to run again."

# ── 5. Tell the app where it is ──────────────────────────────────────────────

printf '\n  ✓ Ready.\n\n'

# Writing it rather than printing it. A setup that ends in "now go and add this
# line yourself" ends, reliably, in the same ModuleNotFoundError as before —
# because plain `python3` is still what runs, and nothing about the message says
# that loudly enough.
ENVFILE="$ROOT/.env"
if grep -q '^FACE_EMBED_PYTHON=' "$ENVFILE" 2>/dev/null; then
  say "FACE_EMBED_PYTHON is already set in .env — leaving it alone."
  say "If it points somewhere else, this venv is at:"
  printf '\n      %s\n' "$VPY"
elif [ -w "$ENVFILE" ]; then
  {
    printf '\n# The face embedder runs insightface, which lives in its own venv\n'
    printf '# (studio/setup-embedder.sh). Plain python3 does not have it.\n'
    printf 'FACE_EMBED_PYTHON=%s\n' "$VPY"
  } >> "$ENVFILE"
  say "Added FACE_EMBED_PYTHON to .env — appended, nothing else touched."
else
  say "Could not write $ENVFILE. Add this line yourself:"
  printf '\n      FACE_EMBED_PYTHON=%s\n' "$VPY"
fi

printf '\n'
say "Then:"
say "    node studio/train.js --avatar 2        # dry run, embeds and checks"
printf '\n'
