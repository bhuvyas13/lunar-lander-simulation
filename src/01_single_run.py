import json
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path

print("\n=== SINGLE RUN: LUNAR LANDER DESCENT (FIXED SIGNS + PLOTS) ===\n")

# Load configuration
with open("config.json", "r") as f:
    cfg = json.load(f)

dt = float(cfg["sim"]["dt_seconds"])
max_time = float(cfg["sim"]["max_time_seconds"])

mass = float(cfg["lander"]["mass_kg"])
altitude = float(cfg["lander"]["initial_altitude_m"])       # meters above ground
velocity = float(cfg["lander"]["initial_velocity_mps"])      # +up, -down
fuel = float(cfg["lander"]["fuel_kg"])
max_thrust = float(cfg["lander"]["max_thrust_newton"])

gravity = -float(cfg["environment"]["gravity_mps2"])         # negative (down)
wind_std = float(cfg["environment"]["wind_accel_std_mps2"])

alt_noise = float(cfg["noise"]["altimeter_std_m"])
vel_noise = float(cfg["noise"]["vel_sensor_std_mps"])
thrust_rel_std = float(cfg["noise"]["thrust_rel_std"])

target_vel = -float(cfg["control"]["target_descent_rate_mps"])  # target is downward => negative
kp = float(cfg["control"]["kp"])
min_throttle = float(cfg["control"]["min_throttle"])
max_throttle = float(cfg["control"]["max_throttle"])

safe_speed = float(cfg["safety"]["safe_landing_speed_mps"])

np.random.seed(int(cfg["sim"]["seed"]))

records = []
time = 0.0

print(f"{'Time':>6} {'Alt(m)':>10} {'Vel(m/s)':>10} {'Fuel(kg)':>10} {'Throttle':>10} {'Thrust(N)':>10}")

reason = "time_limit"

while altitude > 0.0 and fuel > 0.0 and time < max_time:
    # Noisy sensors
    measured_alt = altitude + np.random.normal(0.0, alt_noise)
    measured_vel = velocity + np.random.normal(0.0, vel_noise)

    # Controller: if falling too fast (too negative), increase throttle
    vel_error = target_vel - measured_vel
    throttle = kp * vel_error
    throttle = max(min(throttle, max_throttle), min_throttle)

    # Thrust with small random relative error
    thrust_multiplier = 1.0 + np.random.normal(0.0, thrust_rel_std)
    thrust = throttle * max_thrust * thrust_multiplier
    thrust = max(thrust, 0.0)

    # Random wind disturbance (acceleration)
    wind_acc = np.random.normal(0.0, wind_std)

    # Physics update
    acceleration = (thrust / mass) + gravity + wind_acc
    velocity += acceleration * dt
    altitude += velocity * dt

    # Fuel burn (simple proportional)
    fuel -= throttle * dt

    records.append([time, altitude, velocity, fuel, throttle, thrust, measured_alt, measured_vel, acceleration])

    print(f"{time:6.1f} {altitude:10.2f} {velocity:10.2f} {fuel:10.2f} {throttle:10.3f} {thrust:10.0f}")

    time += dt

# Determine outcome
landing_speed = abs(velocity)

if altitude <= 0.0:
    if landing_speed <= safe_speed:
        reason = "safe"
    else:
        reason = "too_fast"
elif fuel <= 0.0:
    reason = "out_of_fuel"
else:
    reason = "time_limit"

# Clamp altitude at touchdown for cleaner plots
if altitude < 0.0:
    altitude = 0.0

print("\n=== RESULT ===")
if reason == "safe":
    print(f"SAFE LANDING ✅  (landing speed = {landing_speed:.2f} m/s)")
elif reason == "too_fast":
    print(f"CRASH ❌ (too fast)  (landing speed = {landing_speed:.2f} m/s)")
elif reason == "out_of_fuel":
    print("CRASH ❌ (out of fuel)")
else:
    print("TERMINATED (time limit reached)")

# Save trace
df = pd.DataFrame(
    records,
    columns=[
        "time_s", "altitude_m", "velocity_mps", "fuel_kg",
        "throttle", "thrust_N", "measured_alt_m", "measured_vel_mps", "accel_mps2"
    ],
)

out_dir = Path("outputs/single_run")
out_dir.mkdir(parents=True, exist_ok=True)

trace_path = out_dir / "trace.csv"
df.to_csv(trace_path, index=False)
print(f"\nTrace saved to {trace_path}")

# Plots for report screenshots
def save_line_plot(x, y, xlabel, ylabel, title, out_path):
    plt.figure()
    plt.plot(x, y)
    plt.xlabel(xlabel)
    plt.ylabel(ylabel)
    plt.title(title)
    plt.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close()

save_line_plot(df["time_s"], df["altitude_m"], "Time (s)", "Altitude (m)", "Altitude vs Time (Single Run)", out_dir / "altitude_vs_time.png")
save_line_plot(df["time_s"], df["velocity_mps"], "Time (s)", "Velocity (m/s)", "Velocity vs Time (Single Run)", out_dir / "velocity_vs_time.png")
save_line_plot(df["time_s"], df["fuel_kg"], "Time (s)", "Fuel (kg)", "Fuel vs Time (Single Run)", out_dir / "fuel_vs_time.png")

print("Saved plots:")
print(f"- {out_dir / 'altitude_vs_time.png'}")
print(f"- {out_dir / 'velocity_vs_time.png'}")
print(f"- {out_dir / 'fuel_vs_time.png'}\n")
