import json
from pathlib import Path
import pandas as pd

trace_csv = Path("outputs/single_run/trace.csv")
if not trace_csv.exists():
    raise FileNotFoundError("Missing outputs/single_run/trace.csv. Run: python src/01_single_run.py")

df = pd.read_csv(trace_csv)

# Keep only what the animation needs (smaller = faster)
trace = {
    "time_s": df["time_s"].round(3).tolist(),
    "altitude_m": df["altitude_m"].round(3).tolist(),
    "velocity_mps": df["velocity_mps"].round(3).tolist(),
    "fuel_kg": df["fuel_kg"].round(3).tolist(),
    "throttle": df["throttle"].round(4).tolist(),
}

# Compute outcome from last row
last_alt = float(df["altitude_m"].iloc[-1])
last_vel = float(df["velocity_mps"].iloc[-1])

# Read safety threshold from config.json
cfg = json.loads(Path("config.json").read_text())
safe_speed = float(cfg["safety"]["safe_landing_speed_mps"])

landing_speed = abs(last_vel)
if last_alt <= 0.0:
    outcome = "safe" if landing_speed <= safe_speed else "crash_too_fast"
else:
    outcome = "not_landed"

meta = {
    "safe_speed_mps": safe_speed,
    "landing_speed_mps": round(landing_speed, 3),
    "outcome": outcome,
    "initial_altitude_m": float(cfg["lander"]["initial_altitude_m"]),
}

out_dir = Path("outputs/single_run")
out_dir.mkdir(parents=True, exist_ok=True)

(out_dir / "trace.json").write_text(json.dumps(trace, indent=2))
(out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

print("✅ Wrote:")
print(f"- {out_dir / 'trace.json'}")
print(f"- {out_dir / 'meta.json'}")
print(f"Outcome: {outcome} | landing_speed={landing_speed:.3f} m/s (safe<= {safe_speed:.2f})")
