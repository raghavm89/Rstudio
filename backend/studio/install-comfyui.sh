#!/usr/bin/env bash
#
# ComfyUI + Flux on Apple Silicon — one script.
#
#   bash studio/install-comfyui.sh
#
# Run this in Terminal on macOS, not through any tooling: ComfyUI needs native
# Metal access, which a VM does not have.
#
# Idempotent and resumable. It is ~18 GB of models; a dropped connection at
# 90% should not restart the download, so every step checks whether it is
# already done and Hugging Face's cache handles partial files.
#
# Three things this does that a copy-pasted runbook usually gets wrong:
#
#   1. PyTorch nightly is installed BEFORE requirements.txt. requirements.txt
#      pulls stable torch, which quietly replaces the nightly build you just
#      installed, and you find out weeks later when an MPS op is missing.
#   2. No fp8 anywhere. PyTorch has no float8 kernels for Metal — an fp8
#      checkpoint on MPS errors or silently produces noise. GGUF is the working
#      quantised route on Mac.
#   3. The launch script carries three flags that are NOT optional on Mac.
#      Without --fp32-vae you get solid black images and no error.

set -euo pipefail

COMFY_DIR="${COMFY_DIR:-$HOME/ai/ComfyUI}"


bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m    %s\n" "$1"; }
warn() { printf "  \033[33mwarn\033[0m  %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
die()  { printf "\n  \033[31m%s\033[0m\n\n" "$1"; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
step "Checking this machine"

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On Linux/NVIDIA use the CUDA template instead."
[ "$(uname -m)" = "arm64" ]  || die "This needs Apple Silicon. Intel Macs have no MPS backend."
ok "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"

MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$MEM_GB" -lt 24 ]; then
  die "$MEM_GB GB of memory. Flux at Q8 needs ~24 GB free; this will swap and be unusable."
fi
ok "${MEM_GB} GB unified memory"

# 18 GB of models plus ~6 GB of Python packages, with room to unpack.
FREE_GB=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if [ "$FREE_GB" -lt 30 ]; then
  die "Only ${FREE_GB} GB free. This needs about 30 GB (18 GB models, ~6 GB packages, headroom)."
fi
ok "${FREE_GB} GB free"

if ! xcode-select -p >/dev/null 2>&1; then
  die "Command line tools missing. Run:  xcode-select --install   then re-run this script."
fi
ok "command line tools"

# ── Network ──────────────────────────────────────────────────────────────────
step "Checking network access"

# Checked FIRST, and only for hosts this script genuinely needs. A filtered or
# intercepted connection should be named in the first ten seconds, not surface
# as a certificate error twelve gigabytes into a download.
# What matters is whether TLS completes, NOT whether the URL serves a page.
# `curl -f` fails on any HTTP >= 400, and download.pytorch.org is a bucket root
# with no index — it answers 403 while being perfectly reachable. Testing with
# -f reported a working host as blocked.
#
# So: curl WITHOUT -f. It exits 0 on any HTTP response, and non-zero only for
# DNS, connection or TLS failure — which is exactly the question being asked.
# Exit 60 is a certificate problem specifically, which is the interception case
# and worth naming separately.
NET_OK=1
CERT_PROBLEM=0

for host in github.com huggingface.co download.pytorch.org; do
  err="$(curl -sS --max-time 20 -o /dev/null "https://$host" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    ok "$host"
  elif [ $rc -eq 60 ]; then
    warn "$host — TLS certificate rejected"
    CERT_PROBLEM=1
    NET_OK=0
  else
    warn "$host — ${err:-curl exit $rc}"
    NET_OK=0
  fi
done

if [ "$NET_OK" -eq 0 ]; then
  if [ "$CERT_PROBLEM" -eq 1 ]; then
    die "A TLS certificate was rejected — something is intercepting this connection.

  Almost always a VPN or a filtered network. Disconnect and re-run. This is the
  same failure Homebrew hit on raw.githubusercontent.com."
  fi
  die "One or more required hosts could not be reached.

  Check the connection and re-run. If you are on a VPN, disconnect first."
fi

# ── Python ───────────────────────────────────────────────────────────────────
step "Finding a usable Python"

# Homebrew is deliberately NOT required.
#
# Two things go wrong with it often enough to be worth routing around. An
# Intel Homebrew on an Apple Silicon Mac cannot build arm64 packages — it fails
# with "dependencies not built for the arm64 CPU architecture" — and when it
# falls back to building from source it fetches formulae from
# raw.githubusercontent.com, a host that some ISPs and VPNs intercept, which
# surfaces as an SSL certificate error rather than a block.
#
# ComfyUI needs Python 3.10+ and git. git ships with the command line tools.
# Python we can find, or install standalone, without brew touching it.

find_python() {
  # Check by VERSION, not by executable name. A conda base environment provides
  # `python3` and no `python3.13` symlink at all, so a name-only search walks
  # straight past a perfectly good interpreter — which is exactly what happened
  # the first time this script ran here.
  local candidates=(
    python3.13 python3.12 python3.11 python3.10
    python3 python
    /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11
    /Library/Frameworks/Python.framework/Versions/3.13/bin/python3
    /Library/Frameworks/Python.framework/Versions/3.12/bin/python3
    "$HOME/.local/bin/python3.13"
  )
  for c in "${candidates[@]}"; do
    local bin
    bin="$(command -v "$c" 2>/dev/null || true)"
    [ -x "$bin" ] || continue
    # Must be a native arm64 build. A Rosetta Python installs x86_64 wheels and
    # MPS is never available — you get a working install that generates at CPU
    # speed, hours per image, with nothing explaining why.
    file -L "$bin" 2>/dev/null | grep -q arm64 || continue
    if "$bin" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
      echo "$bin"; return 0
    fi
  done
  return 1
}

PY_BIN="$(find_python || true)"

if [ -z "$PY_BIN" ]; then
  warn "no native arm64 Python 3.10+ on PATH"

  # Conda first, if it is here. It is already installed, already has a package
  # index that works on this network, and needs no new tooling — which matters
  # when the reason we are in this branch is a filtered connection.
  CONDA="$(command -v conda || true)"
  if [ -n "$CONDA" ]; then
    printf "  ...   conda found, creating a Python 3.13 environment\n"
    if "$CONDA" create -y -n comfy-studio python=3.13 >/dev/null 2>&1 \
       || "$CONDA" create -y -n comfy-studio python=3.12 >/dev/null 2>&1; then
      CONDA_BASE="$("$CONDA" info --base 2>/dev/null)"
      CAND="$CONDA_BASE/envs/comfy-studio/bin/python3"
      if [ -x "$CAND" ] && file -L "$CAND" 2>/dev/null | grep -q arm64; then
        PY_BIN="$CAND"
        ok "conda env comfy-studio"
      else
        warn "the conda env is not arm64 — your conda is running under Rosetta"
      fi
    else
      warn "conda could not create the environment"
    fi
  fi
fi

if [ -z "$PY_BIN" ]; then
  # uv is a single static binary from astral.sh — no compiling, and it does not
  # touch raw.githubusercontent.com.
  if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
    printf "  ...   installing uv (a standalone Python installer, ~15 MB)\n"
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
  fi
  UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
  if [ -x "$UV" ]; then
    printf "  ...   installing Python 3.13 via uv\n"
    "$UV" python install 3.13 >/dev/null 2>&1 && PY_BIN="$("$UV" python find 3.13 2>/dev/null || true)"
    [ -n "$PY_BIN" ] && ok "uv-managed Python"
  fi
fi

if [ ! -x "${PY_BIN:-}" ]; then
  die "No usable Python 3.10+ found, and none of the fallbacks worked.

  Easiest fix, no Homebrew and no command line involved:

    1. Download the macOS universal2 installer for Python 3.13:
         https://www.python.org/downloads/macos/
    2. Run the .pkg
    3. Re-run this script

  It installs to /Library/Frameworks/Python.framework, which this script
  already checks."
fi
ok "$("$PY_BIN" --version) at $PY_BIN"
ok "native arm64"

step "Checking git"
command -v git >/dev/null 2>&1 || die "git not found. It ships with the command line tools: xcode-select --install"
ok "$(git --version)"

# ── ComfyUI ──────────────────────────────────────────────────────────────────
step "Setting up ComfyUI at $COMFY_DIR"

if [ -d "$COMFY_DIR/.git" ]; then
  git -C "$COMFY_DIR" pull --ff-only >/dev/null 2>&1 || warn "could not fast-forward; keeping what is there"
  ok "repo present, updated"
else
  mkdir -p "$(dirname "$COMFY_DIR")"
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR" >/dev/null
  ok "cloned"
fi

cd "$COMFY_DIR"

if [ ! -d venv ]; then
  "$PY_BIN" -m venv venv
  ok "venv created"
else
  ok "venv present"
fi
# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --quiet --upgrade pip

# ── PyTorch ──────────────────────────────────────────────────────────────────
step "Installing PyTorch nightly"

# ORDER MATTERS. requirements.txt depends on torch, and pip will happily install
# the stable wheel over the nightly one if nightly is not already satisfied.
# Installing nightly first means requirements.txt sees the dependency as met and
# leaves it alone.
if python -c "import torch, sys; sys.exit(0 if 'dev' in torch.__version__ else 1)" 2>/dev/null; then
  ok "nightly already installed ($(python -c 'import torch; print(torch.__version__)'))"
else
  python -m pip install --quiet --pre torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/nightly/cpu
  ok "installed $(python -c 'import torch; print(torch.__version__)')"
fi

python - <<'PYCHECK' || die "MPS is not available — PyTorch cannot see the GPU. Do not continue; generation would fall back to CPU and take hours per image."
import sys, torch
if not torch.backends.mps.is_available():
    sys.exit(1)
print(f"  \033[32mok\033[0m    MPS available, built: {torch.backends.mps.is_built()}")
PYCHECK

step "Installing ComfyUI requirements"
python -m pip install --quiet -r requirements.txt
ok "requirements installed"

# Guard against the silent downgrade described above.
python -c "import torch, sys; sys.exit(0 if 'dev' in torch.__version__ else 1)" 2>/dev/null \
  || warn "requirements.txt replaced nightly torch with stable — re-run this script to restore it"

# ── GGUF custom node ─────────────────────────────────────────────────────────
step "Installing the GGUF loader"

# Required, not optional. fp8 is the usual way to fit Flux in memory and it does
# not work on Metal at all. GGUF stores quantised and dequantises to bf16 on the
# fly, which MPS does support.
if [ -d custom_nodes/ComfyUI-GGUF ]; then
  git -C custom_nodes/ComfyUI-GGUF pull --ff-only >/dev/null 2>&1 || true
  ok "ComfyUI-GGUF present"
else
  git clone --depth 1 https://github.com/city96/ComfyUI-GGUF custom_nodes/ComfyUI-GGUF >/dev/null
  ok "ComfyUI-GGUF cloned"
fi
python -m pip install --quiet gguf
ok "gguf installed in this venv"

# ── Models ───────────────────────────────────────────────────────────────────
step "Downloading models (~18 GB)"

# The `hf` command ships with huggingface_hub itself. The old `[cli]` extra was
# removed in 1.x and asking for it only prints a warning.
python -m pip install --quiet --upgrade huggingface_hub
HF="$COMFY_DIR/venv/bin/hf"
[ -x "$HF" ] || HF="$COMFY_DIR/venv/bin/huggingface-cli"

mkdir -p models/unet models/clip models/vae

fetch() { # repo file destdir label
  local repo="$1" file="$2" dest="$3" label="$4"
  if [ -f "$dest/$(basename "$file")" ]; then
    ok "$label (already downloaded)"
    return 0
  fi
  printf "  ...   %s\n" "$label"
  "$HF" download "$repo" "$file" --local-dir "$dest" >/dev/null
  ok "$label"
}

fetch city96/FLUX.1-dev-gguf              flux1-dev-Q8_0.gguf            models/unet "flux1-dev-Q8_0.gguf (12.5 GB)"
fetch city96/t5-v1_1-xxl-encoder-GGUF     t5-v1_1-xxl-encoder-Q8_0.gguf  models/clip "t5 encoder (4.9 GB)"
fetch comfyanonymous/flux_text_encoders   clip_l.safetensors             models/clip "clip_l (246 MB)"

# The VAE lives in a gated repo: you must accept the FLUX.1-dev licence on
# Hugging Face and be logged in. That gate is the licence acceptance itself —
# these are non-commercial weights, and accepting is how you legitimately obtain
# them for the R&D this pipeline uses them for.
if [ -f models/vae/ae.safetensors ]; then
  ok "ae.safetensors (already downloaded)"
else
  printf "  ...   ae.safetensors (335 MB, gated repo)\n"

  # A non-interactive path, so this can run unattended.
  [ -n "${HF_TOKEN:-}" ] && "$HF" auth login --token "$HF_TOKEN" >/dev/null 2>&1 || true

  # Both FLUX repos are gated — schnell as well as dev, despite schnell being
  # Apache 2.0 — so there is no ungated mirror of this file to fall back to.
  # Accepting is the correct step regardless: the UNet in use here is dev, and
  # that agreement is the non-commercial licence this whole local path relies on.
  # Capture rather than discard. Swallowing this hid the one line that says
  # WHICH of the three steps is missing — "restricted", "awaiting approval" and
  # "invalid token" are different problems with different fixes, and guessing
  # between them costs a round trip each time.
  HF_ERR="$("$HF" download black-forest-labs/FLUX.1-dev ae.safetensors --local-dir models/vae 2>&1)" || {
    printf "\n  \033[33mHugging Face said:\033[0m\n"
    printf "%s\n" "$HF_ERR" | tail -5 | sed 's/^/    /'

    WHO="$("$HF" auth whoami 2>&1 | head -1)"
    printf "\n  Logged in as: %s\n" "$WHO"

    die "Could not download ae.safetensors — the repo is gated.

  Three one-time steps, then re-run this script. It will pick up where it left
  off; the other 17.7 GB is already on disk.

    1. Accept the licence — sign in, then click Agree:
         https://huggingface.co/black-forest-labs/FLUX.1-dev

    2. Create a token with READ access:
         https://huggingface.co/settings/tokens

    3. Log in and paste the token when asked:
         $HF auth login

  Or skip step 3 entirely and pass the token straight in:

    HF_TOKEN=hf_xxx bash studio/install-comfyui.sh

  If it still fails after that, the licence acceptance has not gone through —
  open the model page again and check it does not still show an Agree button.

  Note: accepting the licence is per-ACCOUNT. If you are logged in above as a
  different account from the one you clicked Agree with, that is the problem."
  }
  ok "ae.safetensors"
fi

# ── Launch script ────────────────────────────────────────────────────────────
step "Writing the launch script"

cat > start.sh <<'LAUNCH'
#!/usr/bin/env bash
# Start ComfyUI for Studio. Three of these settings are not optional on Mac.
set -euo pipefail
cd "$(dirname "$0")"
source venv/bin/activate

# Unimplemented MPS ops fall back to CPU instead of crashing mid-render.
export PYTORCH_ENABLE_MPS_FALLBACK=1
# Let MPS use all of unified memory rather than a fraction of it.
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0

# --fp32-vae is the one that matters most: half-precision VAE decode on MPS
# produces a solid black image, with no error to tell you why.
exec python main.py \
  --listen 127.0.0.1 --port 8188 \
  --fp32-vae \
  --use-pytorch-cross-attention
LAUNCH
chmod +x start.sh
ok "$COMFY_DIR/start.sh"

# ── Done ─────────────────────────────────────────────────────────────────────
step "Installed"

cat <<DONE

  ComfyUI    $COMFY_DIR
  models     $(du -sh models 2>/dev/null | cut -f1) in models/

  Start it:

    $COMFY_DIR/start.sh

  Wait for "To see the GUI go to: http://127.0.0.1:8188", then in another
  terminal, from the backend repo:

    npm run studio:seed-set -- --avatar 2 --count 300

  First image will be slow — the model loads from disk. Expect roughly 60-100s
  per image after that at 880x1104. Time ten and write the number down; it
  settles whether local generation survives real use.

DONE
