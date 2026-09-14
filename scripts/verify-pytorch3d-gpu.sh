#!/bin/bash
# Verify the PyTorch3D CUDA rasterizer works on a compute node in the depthpro env.
set -euo pipefail
source /home/225015066/miniconda3/etc/profile.d/conda.sh
conda activate depthpro
cd /home/225015066/dev-projects/DiffusionControl
python scripts/probe-workflow-environment.py export
