import json
import pandas as pd
from pathlib import Path

print("\n=== REPORT TABLE GENERATOR ===\n")

config_path = Path("config.json")
summary_path = Path("outputs/monte_carlo/runs_summary.csv")

if not config_path.exists():
    raise FileNotFoundError("config.json not found. Run setup first.")
if not summary_path.exists():
    raise FileNotFoundError("runs_summary.csv not found. Run 02_monte_carlo.py first.")

# Load config
with open(config_path, "r") as f:
    cfg = json.load(f)

# Flatten config into assumptions table
assumptions_rows = []

def add_section(section_name, section_dict):
    for k, v in section_dict.items():
        assumptions_rows.append({
            "Section": section_name,
            "Parameter": k,
            "Value": v
        })

for section in ["sim", "lander", "environment", "noise", "control", "safety"]:
    add_section(section, cfg[section])

assumptions_df = pd.DataFrame(assumptions_rows)

# Load Monte Carlo results
df = pd.read_csv(summary_path)

n = len(df)
safe_rate = df["safe"].mean() * 100.0
landed_rate = df["landed"].mean() * 100.0
avg_speed = df["landing_speed_mps"].mean()
std_speed = df["landing_speed_mps"].std()
min_speed = df["landing_speed_mps"].min()
max_speed = df["landing_speed_mps"].max()
avg_fuel_left = df["fuel_left_kg"].mean()
avg_time = df["time_s"].mean()

results_summary_df = pd.DataFrame([{
    "Runs": n,
    "Landed_rate_%": round(landed_rate, 2),
    "Safe_landing_rate_%": round(safe_rate, 2),
    "Avg_landing_speed_mps": round(avg_speed, 4),
    "Std_landing_speed_mps": round(std_speed, 4),
    "Min_landing_speed_mps": round(min_speed, 4),
    "Max_landing_speed_mps": round(max_speed, 4),
    "Avg_fuel_left_kg": round(avg_fuel_left, 3),
    "Avg_time_s": round(avg_time, 2)
}])

breakdown = (
    df["reason"]
    .value_counts()
    .rename_axis("reason")
    .reset_index(name="count")
)
breakdown["percent_%"] = (breakdown["count"] / n * 100.0).round(2)

out_dir = Path("outputs/monte_carlo")
out_dir.mkdir(parents=True, exist_ok=True)

assumptions_out = out_dir / "assumptions_table.csv"
results_out = out_dir / "results_summary_table.csv"
breakdown_out = out_dir / "outcome_breakdown_table.csv"

assumptions_df.to_csv(assumptions_out, index=False)
results_summary_df.to_csv(results_out, index=False)
breakdown.to_csv(breakdown_out, index=False)

print("Saved tables:")
print(f"- {assumptions_out}")
print(f"- {results_out}")
print(f"- {breakdown_out}\n")
