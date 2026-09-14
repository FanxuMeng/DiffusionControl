#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PYTHONDONTWRITEBYTECODE=1
exec /home/225015066/miniconda3/bin/python -m backend.diffusioncontrol "$@"
