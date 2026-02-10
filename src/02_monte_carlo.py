import json
import argparse
import numpy as np
import pandas as pd
from pathlib import Path

def simulate_one(cfg, rng):
    dt = float(cfg["sim"]["dt_seconds"])
    max_time = float(cfg["sim"]["max_time_seconds"])

    mass = float(cfg["lander"]["mass_kg"])
    altitude = float(cfg["lander"]["initial_altitude_m"])
    velocity = float(cfg["lander"]["initial_velocity_mps"])
    fuel = float(cfg["lander"]["fuel_kg"])
    max_thrust = float(cfg["lander"]["max_thrust_newton"])

    gravity = -float(cfg["environment"]["gravity_mps2"])
    wind_std = float(cfg["environment"]["wind_accel_std_mps2"])

    alt_noise = float(cfg["noise"]["altimeter_std_m"])
    vel_noise = float(cfg["noise"]["vel_sensor_std_mps"])
    thrust_rel_std = float(cfg["noise"]["thrust_rel_std"])

    target_vel = -float(cfg["control"]["target_descent_rate_mps"])
    kp = float(cfg["control"]["kp"])
    min_throttle = float(cfg["control"]["min_throttle"])
    max_throttle = float(cfg["control"]["max_throttle"])

    safe_speed = float(cfg["safety"]["safe_landing_speed_mps"])

    time = 0.0
    landed = False
    reason = "time_limit"

    while altitude > 0.0 and fuel > 0.0 and time < max_time:
        measured_alt = altitude + rng.normal(0.0, alt_noise)
        measured_vel = velocity + rng.normal(0.0, vel_noise)

        vel_error = target_vel - measured_vel
        throttle = kp * vel_error
        throttle = max(min(throttle, max_throttle), min_throttle)

        thrust_multiplier = 1.0 + rng.normal(0.0, thrust_rel_std)
        thrust = throttle * max_thrust * thrust_multiplier
        thrust = max(thrust, 0.0)

        wind_acc = rng.normal(0.0, wind_std)

        acceleration = (thrust / mass) + gravity + wind_acc
        velocity += acceleration * dt
        altitude += velocity * dt

        fuel -= throttle * dt
        time += dt

    if altitude <= 0.0:
        landed = True
        landing_speed = abs(velocity)
        if landing_speed <= safe_speed:
            reason = "safe"
        else:
            reason = "too_fast"
    elif fuel <= 0.0:
        landed = False
        landing_speed = abs(velocity)
        reason = "out_of_fuel"
    else:
        landed = False
        landing_speed = abs(velocity)
        reason = "time_limit"

    safe = (reason == "safe")

    return {
        "landed": landed,
        "safe": safe,
        "landing_speed_mps": landing_speed,
        "fuel_left_kg": max(fuel, 0.0),
        "time_s": time,
        "reason": reason,
    }

def main():
    parser = argparse.ArgumentParser(description="Monte Carlo lunar lander simulation")
    parser.add_argument("--n", type=int, default=None, help="Number of runs (overrides config.json)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed (overrides config.json)")
    args = parser.parse_args()

    with open("config.json", "r") as f:
        cfg = json.load(f)

    n = int(args.n) if args.n is not None else int(cfg["sim"]["runs_monte_carlo"])
    seed = int(args.seed) if args.seed is not None else int(cfg["sim"]["seed"])

    rng = np.random.default_rng(seed)

    rows = []
    for i in range(1, n + 1):
        result = simulate_one(cfg, rng)
        result["run_id"] = i
        rows.append(result)

    df = pd.DataFrame(rows)

    out_path = Path("outputs/monte_carlo/runs_summary.csv")
    df.to_csv(out_path, index=False)

    # Terminal summary
    success_rate = df["safe"].mean() * 100.0
    landed_rate = df["landed"].mean() * 100.0
    avg_speed = df["landing_speed_mps"].mean()

    print("\n=== MONTE CARLO RESULTS ===")
    print(f"Runs: {n}")
    print(f"Landed (touchdown) rate: {landed_rate:.2f}%")
    print(f"Safe landing rate:       {success_rate:.2f}%")
    print(f"Average landing speed:   {avg_speed:.3f} m/s\n")

    print("Reason breakdown:")
    reason_counts = df["reason"].value_counts(dropna=False)
    for reason, count in reason_counts.items():
        print(f"  {reason:12s} : {count} ({(count/n)*100:.2f}%)")

    print(f"\nSaved summary to {out_path}\n")

if __name__ == "__main__":
    main()
