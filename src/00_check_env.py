import sys
import json
from pathlib import Path

print("=" * 50)
print("LUNAR LANDER SIMULATION :: ENV CHECK")
print("=" * 50)

# 1. Python version check
print("\n[1] Python version check")
major, minor = sys.version_info[:2]
print(f"Python version: {major}.{minor}")

if major < 3 or (major == 3 and minor < 8):
    print("ERROR: Python >= 3.8 required")
    sys.exit(1)
else:
    print("OK")

# 2. Library imports
print("\n[2] Library check")
try:
    import numpy as np
    import pandas as pd
    import matplotlib.pyplot as plt
    print("numpy, pandas, matplotlib: OK")
except ImportError as e:
    print("ERROR: Missing library")
    print(e)
    sys.exit(1)

# 3. Config file check
print("\n[3] config.json check")
config_path = Path("config.json")

if not config_path.exists():
    print("ERROR: config.json not found")
    sys.exit(1)

with open(config_path, "r") as f:
    config = json.load(f)

print("config.json loaded successfully")

# 4. Output directories check
print("\n[4] Output directory check")
output_dirs = [
    "outputs/single_run",
    "outputs/monte_carlo",
    "outputs/logs"
]

for d in output_dirs:
    path = Path(d)
    path.mkdir(parents=True, exist_ok=True)
    print(f"✔ {d}")

print("\nEnvironment check PASSED ✅")
print("You are ready to run simulations.")
print("=" * 50)
