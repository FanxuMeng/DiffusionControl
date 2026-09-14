#!/bin/bash
# Build PyTorch3D CUDA extension for RTX 5090 (sm_120) using the cluster CUDA 12.8 toolkit.
set -euo pipefail

source /home/225015066/miniconda3/etc/profile.d/conda.sh
conda activate depthpro
cd /home/225015066/dev-projects/DiffusionControl

# CUDA 12.8 toolkit is only present on compute nodes (not the login node).
export CUDA_HOME=/home/share/software/cuda/cuda-12.8
export PATH="$CUDA_HOME/bin:$PATH"

# The default PATH resolves `gcc` to a conda-forge 16.2.0 (too new for CUDA 12.8).
# Pin the host compiler to the system GCC 11.4.1 that CUDA 12.8 supports.
export CC=/usr/bin/gcc
export CXX=/usr/bin/g++
export CUDAHOSTCXX=/usr/bin/g++

export FORCE_CUDA=1
export TORCH_CUDA_ARCH_LIST="12.0"
export MAX_JOBS=4

echo "=== toolchain ==="
nvcc --version | tail -2
gcc --version | head -1
g++ --version | head -1
echo "CUDA_HOME=$CUDA_HOME"
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

echo "=== building pytorch3d ==="
python -m pip install --no-build-isolation -r backend/environments/depthpro/requirements-render.txt

echo "=== pip check ==="
python -m pip check

echo "=== import test ==="
python -c "import pytorch3d; print('pytorch3d', pytorch3d.__version__)"
python -c "from pytorch3d import _C; print('pytorch3d._C OK')"

echo "=== BUILD DONE ==="
