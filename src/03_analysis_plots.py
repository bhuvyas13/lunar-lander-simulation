import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path

print("\n=== ANALYSIS PLOTS ===\n")

in_path = Path("outputs/monte_carlo/runs_summary.csv")
if not in_path.exists():
    raise FileNotFoundError(f"Missing file: {in_path}. Run 02_monte_carlo.py first.")

df = pd.read_csv(in_path)

out_dir = Path("outputs/monte_carlo")
out_dir.mkdir(parents=True, exist_ok=True)

# 1) Histogram of landing speeds
plt.figure()
df["landing_speed_mps"].plot(kind="hist", bins=30)
plt.xlabel("Landing speed (m/s)")
plt.ylabel("Count")
plt.title("Distribution of Landing Speeds (Monte Carlo)")
hist_path = out_dir / "landing_speed_hist.png"
plt.savefig(hist_path, dpi=200, bbox_inches="tight")
plt.close()

# 2) Outcome counts bar plot
plt.figure()
df["reason"].value_counts().plot(kind="bar")
plt.xlabel("Outcome reason")
plt.ylabel("Count")
plt.title("Outcome Breakdown (Monte Carlo)")
bar_path = out_dir / "outcome_breakdown.png"
plt.savefig(bar_path, dpi=200, bbox_inches="tight")
plt.close()

# 3) Empirical CDF of landing speed
speeds = df["landing_speed_mps"].sort_values().to_numpy()
cdf = (pd.Series(range(1, len(speeds) + 1)) / len(speeds)).to_numpy()

plt.figure()
plt.plot(speeds, cdf)
plt.xlabel("Landing speed (m/s)")
plt.ylabel("P(landing speed ≤ x)")
plt.title("Empirical CDF of Landing Speed")
cdf_path = out_dir / "landing_speed_cdf.png"
plt.savefig(cdf_path, dpi=200, bbox_inches="tight")
plt.close()

print(f"Saved:\n- {hist_path}\n- {bar_path}\n- {cdf_path}\n")
