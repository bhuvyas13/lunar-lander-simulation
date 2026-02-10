import json
import copy
import numpy as np
import pandas as pd
from pathlib import Path

# ----------------------------
# Helpers: safe input parsing
# ----------------------------
def ask_str(prompt, default):
    s = input(f"{prompt} [{default}]: ").strip()
    return s if s else default

def ask_int(prompt, default, lo=None, hi=None):
    while True:
        s = input(f"{prompt} [{default}]: ").strip()
        if not s:
            return int(default)
        try:
            v = int(s)
            if lo is not None and v < lo:
                print(f"  ⚠ Must be >= {lo}")
                continue
            if hi is not None and v > hi:
                print(f"  ⚠ Must be <= {hi}")
                continue
            return v
        except ValueError:
            print("  ⚠ Enter a valid integer.")

def ask_float(prompt, default, lo=None, hi=None):
    while True:
        s = input(f"{prompt} [{default}]: ").strip()
        if not s:
            return float(default)
        try:
            v = float(s)
            if lo is not None and v < lo:
                print(f"  ⚠ Must be >= {lo}")
                continue
            if hi is not None and v > hi:
                print(f"  ⚠ Must be <= {hi}")
                continue
            return v
        except ValueError:
            print("  ⚠ Enter a valid number.")

def press_enter():
    input("\nPress Enter to continue...")

# ----------------------------
# Core simulation (vertical 1D)
# Convention: +up, -down
# ----------------------------
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

    vel_noise = float(cfg["noise"]["vel_sensor_std_mps"])
    thrust_rel_std = float(cfg["noise"]["thrust_rel_std"])

    target_vel = -float(cfg["control"]["target_descent_rate_mps"])  # downward target => negative
    kp = float(cfg["control"]["kp"])
    min_throttle = float(cfg["control"]["min_throttle"])
    max_throttle = float(cfg["control"]["max_throttle"])

    safe_speed = float(cfg["safety"]["safe_landing_speed_mps"])

    time = 0.0
    reason = "time_limit"

    while altitude > 0.0 and fuel > 0.0 and time < max_time:
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

        # simple burn model
        fuel -= throttle * dt
        time += dt

    landed = altitude <= 0.0
    landing_speed = abs(velocity) if landed else np.nan

    if landed:
        reason = "safe" if landing_speed <= safe_speed else "too_fast"
    elif fuel <= 0.0:
        reason = "out_of_fuel"
    else:
        reason = "time_limit"

    return {
        "landed": bool(landed),
        "safe": bool(reason == "safe"),
        "landing_speed_mps": float(landing_speed) if landed else np.nan,
        "fuel_left_kg": float(max(fuel, 0.0)),
        "time_s": float(time),
        "reason": reason,
    }

def run_monte_carlo(cfg, n_runs, seed):
    rng = np.random.default_rng(int(seed))
    rows = [simulate_one(cfg, rng) for _ in range(int(n_runs))]
    return pd.DataFrame(rows)

# ----------------------------
# Suggestion engine
# - NOT "do X always"
# - We simulate each candidate and rank by improvement
# ----------------------------
def evaluate_safe_rate(cfg, n_test, seed):
    df = run_monte_carlo(cfg, n_test, seed)
    return float(df["safe"].mean() * 100.0), df

def base_candidates(cfg):
    base = cfg
    cands = []

    def add(name, mut):
        c = copy.deepcopy(base)
        mut(c)
        cands.append((name, c))

    # General knobs
    add("Increase fuel (+50%)", lambda c: c["lander"].__setitem__("fuel_kg", c["lander"]["fuel_kg"] * 1.5))
    add("Increase max thrust (+25%)", lambda c: c["lander"].__setitem__("max_thrust_newton", c["lander"]["max_thrust_newton"] * 1.25))

    add("Faster descent (+25% target rate)", lambda c: c["control"].__setitem__("target_descent_rate_mps", c["control"]["target_descent_rate_mps"] * 1.25))
    add("Slower descent (-25% target rate)", lambda c: c["control"].__setitem__("target_descent_rate_mps", c["control"]["target_descent_rate_mps"] * 0.75))

    add("Increase kp (+25%)", lambda c: c["control"].__setitem__("kp", c["control"]["kp"] * 1.25))
    add("Decrease kp (-25%)", lambda c: c["control"].__setitem__("kp", c["control"]["kp"] * 0.75))

    add("Reduce wind uncertainty (-30%)", lambda c: c["environment"].__setitem__("wind_accel_std_mps2", c["environment"]["wind_accel_std_mps2"] * 0.7))
    add("Reduce velocity sensor noise (-30%)", lambda c: c["noise"].__setitem__("vel_sensor_std_mps", c["noise"]["vel_sensor_std_mps"] * 0.7))

    add("Increase max time (+25%)", lambda c: c["sim"].__setitem__("max_time_seconds", c["sim"]["max_time_seconds"] * 1.25))

    return cands

def expanded_search_if_stuck(cfg, dominant_reason):
    """
    If everything is failing, expand the search around the dominant failure mode.
    Still data-driven: the expansion is triggered by observed dominant_reason.
    """
    base = cfg
    cands = []

    def add(name, mut):
        c = copy.deepcopy(base)
        mut(c)
        cands.append((name, c))

    if dominant_reason == "out_of_fuel":
        for mult in [1.5, 2.0, 3.0]:
            add(f"Fuel ×{mult}", lambda c, m=mult: c["lander"].__setitem__("fuel_kg", c["lander"]["fuel_kg"] * m))
        for mult in [1.2, 1.4, 1.7]:
            add(f"Max thrust ×{mult}", lambda c, m=mult: c["lander"].__setitem__("max_thrust_newton", c["lander"]["max_thrust_newton"] * m))
        for mult in [1.2, 1.5]:
            add(f"Target rate ×{mult} (descend faster)", lambda c, m=mult: c["control"].__setitem__("target_descent_rate_mps", c["control"]["target_descent_rate_mps"] * m))

    elif dominant_reason == "too_fast":
        for mult in [0.8, 0.6]:
            add(f"Target rate ×{mult} (descend slower)", lambda c, m=mult: c["control"].__setitem__("target_descent_rate_mps", c["control"]["target_descent_rate_mps"] * m))
        for mult in [1.2, 1.5]:
            add(f"Max thrust ×{mult}", lambda c, m=mult: c["lander"].__setitem__("max_thrust_newton", c["lander"]["max_thrust_newton"] * m))
        for mult in [1.2, 1.4]:
            add(f"kp ×{mult}", lambda c, m=mult: c["control"].__setitem__("kp", c["control"]["kp"] * m))

    elif dominant_reason == "time_limit":
        for mult in [1.5, 2.0]:
            add(f"Max time ×{mult}", lambda c, m=mult: c["sim"].__setitem__("max_time_seconds", c["sim"]["max_time_seconds"] * m))
        for mult in [1.2]:
            add(f"Target rate ×{mult} (descend faster)", lambda c, m=mult: c["control"].__setitem__("target_descent_rate_mps", c["control"]["target_descent_rate_mps"] * m))

    return cands

def rank_suggestions(cfg, base_rate, dominant_reason, n_test, seed, top_k=6):
    pool = base_candidates(cfg)
    if base_rate < 1.0:  # basically stuck
        pool += expanded_search_if_stuck(cfg, dominant_reason)

    # score each candidate by quick Monte Carlo
    scored = []
    for name, c2 in pool:
        rate, _ = evaluate_safe_rate(c2, n_test, seed + 777)
        scored.append((rate - base_rate, rate, name, c2))

    scored.sort(key=lambda x: x[0], reverse=True)

    # keep improvements first, but if none improve, still show the top ones
    improved = [x for x in scored if x[0] > 0.0]
    if improved:
        return improved[:top_k]
    return scored[:top_k]

# ----------------------------
# User-facing config editor
# ----------------------------
def edit_params(cfg):
    print("\n--- Edit Parameters (press Enter to keep) ---")
    cfg["sim"]["runs_monte_carlo"] = ask_int("Monte Carlo runs", cfg["sim"]["runs_monte_carlo"], lo=50, hi=50000)
    cfg["sim"]["seed"] = ask_int("Seed", cfg["sim"]["seed"], lo=0, hi=10**9)

    cfg["lander"]["fuel_kg"] = ask_float("Fuel (kg)", cfg["lander"]["fuel_kg"], lo=1)
    cfg["lander"]["max_thrust_newton"] = ask_float("Max thrust (N)", cfg["lander"]["max_thrust_newton"], lo=100)

    cfg["control"]["target_descent_rate_mps"] = ask_float("Target descent rate (m/s)", cfg["control"]["target_descent_rate_mps"], lo=0.2, hi=10.0)
    cfg["control"]["kp"] = ask_float("Controller kp", cfg["control"]["kp"], lo=0.01, hi=10.0)

    cfg["environment"]["wind_accel_std_mps2"] = ask_float("Wind accel std (m/s^2)", cfg["environment"]["wind_accel_std_mps2"], lo=0.0, hi=5.0)
    cfg["noise"]["vel_sensor_std_mps"] = ask_float("Velocity sensor std (m/s)", cfg["noise"]["vel_sensor_std_mps"], lo=0.0, hi=5.0)
    cfg["noise"]["thrust_rel_std"] = ask_float("Thrust relative std", cfg["noise"]["thrust_rel_std"], lo=0.0, hi=0.5)

    cfg["sim"]["max_time_seconds"] = ask_float("Max time (s)", cfg["sim"]["max_time_seconds"], lo=10.0, hi=5000.0)
    cfg["safety"]["safe_landing_speed_mps"] = ask_float("Safe landing speed threshold (m/s)", cfg["safety"]["safe_landing_speed_mps"], lo=0.1, hi=10.0)

def apply_site_preset(cfg):
    print("\nChoose landing site preset:")
    print("  A) Flat (easier)")
    print("  B) Slope (medium)")
    print("  C) Rocky (harder)")
    site = ask_str("Enter A/B/C", "A").upper()

    if site == "A":
        cfg["environment"]["wind_accel_std_mps2"] = 0.12
        cfg["safety"]["safe_landing_speed_mps"] = 2.2
        return "Flat"
    if site == "B":
        cfg["environment"]["wind_accel_std_mps2"] = 0.18
        cfg["safety"]["safe_landing_speed_mps"] = 2.0
        return "Slope"
    cfg["environment"]["wind_accel_std_mps2"] = 0.25
    cfg["safety"]["safe_landing_speed_mps"] = 1.8
    return "Rocky"

# ----------------------------
# Main interactive loop
# ----------------------------
def main():
    print("\n=== MISSION CONSOLE (Hybrid) ===")
    print("Decide → simulate → diagnose → suggested improvements → try again.\n")

    cfg_path = Path("config.json")
    if not cfg_path.exists():
        raise FileNotFoundError("config.json not found in project root.")

    base_cfg = json.loads(cfg_path.read_text())
    cfg = copy.deepcopy(base_cfg)

    site_name = apply_site_preset(cfg)
    print(f"\nPreset applied: {site_name}\n")

    # First-time edits
    edit_params(cfg)

    out_dir = Path("outputs/console_sessions")
    out_dir.mkdir(parents=True, exist_ok=True)

    while True:
        n_runs = int(cfg["sim"]["runs_monte_carlo"])
        seed = int(cfg["sim"]["seed"])

        print("\nRunning Monte Carlo…")
        df = run_monte_carlo(cfg, n_runs, seed)

        safe_rate = float(df["safe"].mean() * 100.0)
        landed_rate = float(df["landed"].mean() * 100.0)

        landed_df = df[df["landed"]]
        avg_speed = float(landed_df["landing_speed_mps"].mean()) if len(landed_df) else float("nan")
        std_speed = float(landed_df["landing_speed_mps"].std()) if len(landed_df) else float("nan")
        avg_fuel = float(df["fuel_left_kg"].mean())

        breakdown = df["reason"].value_counts().rename_axis("reason").reset_index(name="count")
        breakdown["percent_%"] = (breakdown["count"] / n_runs * 100.0).round(2)

        dominant_reason = str(breakdown.iloc[0]["reason"])

        print("\n=== RESULTS ===")
        print(f"Site: {site_name}")
        print(f"Runs: {n_runs}")
        print(f"Touchdown rate: {landed_rate:.2f}%")
        print(f"Safe landing rate: {safe_rate:.2f}%")
        print(f"Landing speed (touchdowns only): {avg_speed:.3f} ± {std_speed:.3f} m/s")
        print(f"Avg fuel left: {avg_fuel:.3f} kg\n")

        print("Outcome breakdown:")
        for _, row in breakdown.iterrows():
            print(f"  {row['reason']:12s} : {int(row['count']):5d} ({row['percent_%']:6.2f}%)")

        # Save session
        df.to_csv(out_dir / "last_session_runs.csv", index=False)
        breakdown.to_csv(out_dir / "last_session_breakdown.csv", index=False)

        # Diagnose in human terms (still based on dominant reason)
        print("\n=== DIAGNOSIS ===")
        if dominant_reason == "out_of_fuel":
            print("Most runs failed because fuel ran out before touchdown.")
            print("This usually means the controller demanded sustained thrust for too long.")
        elif dominant_reason == "too_fast":
            print("Most runs reached touchdown but exceeded the safe speed threshold.")
            print("This usually means braking was insufficient near the end.")
        elif dominant_reason == "time_limit":
            print("Most runs hit the time limit before touchdown.")
            print("This usually means descent rate is too slow or max_time is too small.")
        else:
            print("Mixed outcomes. We'll still test improvements.")

        # Suggestions
        print("\n=== SUGGESTED IMPROVEMENTS (ranked) ===")
        n_test = int(min(300, max(120, n_runs // 5)))
        ranked = rank_suggestions(cfg, safe_rate, dominant_reason, n_test=n_test, seed=seed, top_k=6)

        for i, (delta, rate, name, _) in enumerate(ranked, start=1):
            sign = "+" if delta >= 0 else ""
            print(f"{i}. {name}")
            print(f"   Est. safe rate: {rate:.2f}% ({sign}{delta:.2f}%)")

        # Menu: real interactivity
        print("\n=== WHAT NEXT? ===")
        print("  1) Apply one suggestion (by number)")
        print("  2) Edit parameters manually")
        print("  3) Change landing site preset")
        print("  4) Run again (same settings)")
        print("  5) Exit")

        choice = ask_str("Choose 1-5", "4")

        if choice == "1":
            pick = ask_int("Enter suggestion number", 1, lo=1, hi=len(ranked))
            _, _, name, new_cfg = ranked[pick - 1]
            cfg = new_cfg
            print(f"\n✅ Applied: {name}")
            press_enter()
            continue

        if choice == "2":
            edit_params(cfg)
            press_enter()
            continue

        if choice == "3":
            site_name = apply_site_preset(cfg)
            print(f"\n✅ Preset applied: {site_name}")
            press_enter()
            continue

        if choice == "4":
            continue

        if choice == "5":
            print("\nDone. Session outputs saved to outputs/console_sessions/")
            break

        print("⚠ Invalid choice.")
        press_enter()

if __name__ == "__main__":
    main()
