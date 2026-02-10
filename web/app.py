import json
import copy
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, request, jsonify, render_template, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parent
CFG_PATH = PROJECT_ROOT / "config.json"

app = Flask(__name__, template_folder="templates", static_folder="static")


# ----------------------------
# Landing Zones Configuration
# ----------------------------
LANDING_ZONES = {
    "A": {  # Ocean Landing
        "name": "Ocean Zone",
        "safe_zone": {"x": 450, "y": 380, "radius": 80, "color": "#4ade80"},
        "caution_zone": {"x": 450, "y": 380, "radius": 140, "color": "#fbbf24"},
        "danger_zone": {"x": 450, "y": 380, "radius": 200, "color": "#f87171"},
        "wind_std": 0.12,
        "safe_speed": 2.2,
    },
    "B": {  # Land Zone
        "name": "Land Zone",
        "safe_zone": {"x": 450, "y": 380, "radius": 70, "color": "#4ade80"},
        "caution_zone": {"x": 450, "y": 380, "radius": 130, "color": "#fbbf24"},
        "danger_zone": {"x": 450, "y": 380, "radius": 190, "color": "#f87171"},
        "wind_std": 0.18,
        "safe_speed": 2.0,
    },
    "C": {  # Mountain Zone
        "name": "Mountain Zone",
        "safe_zone": {"x": 450, "y": 380, "radius": 60, "color": "#4ade80"},
        "caution_zone": {"x": 450, "y": 380, "radius": 110, "color": "#fbbf24"},
        "danger_zone": {"x": 450, "y": 380, "radius": 170, "color": "#f87171"},
        "wind_std": 0.25,
        "safe_speed": 1.8,
    }
}


# ----------------------------
# Core simulation (vertical 1D + trace)
# Convention: +up, -down
# ----------------------------
def simulate_one_with_trace(cfg, rng):
    dt = float(cfg["sim"]["dt_seconds"])
    max_time = float(cfg["sim"]["max_time_seconds"])

    mass = float(cfg["satellite"]["mass_kg"])
    altitude = float(cfg["satellite"]["initial_altitude_m"])
    velocity = float(cfg["satellite"]["initial_velocity_mps"])
    fuel = float(cfg["satellite"]["fuel_kg"])
    max_thrust = float(cfg["satellite"]["max_thrust_newton"])

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
    trace = [(time, altitude, velocity, fuel, 0.0)]

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

        fuel -= throttle * dt
        time += dt

        trace.append((time, altitude, velocity, max(fuel, 0.0), throttle))

        # guardrail
        if len(trace) > 200000:
            break

    landed = altitude <= 0.0
    if landed:
        landing_speed = abs(velocity)
        reason = "safe" if landing_speed <= safe_speed else "too_fast"
    else:
        landing_speed = None
        if fuel <= 0.0:
            reason = "out_of_fuel"
        else:
            reason = "time_limit"

    return {
        "landed": bool(landed),
        "safe": bool(reason == "safe"),
        "landing_speed_mps": landing_speed,
        "fuel_left_kg": float(max(fuel, 0.0)),
        "time_s": float(time),
        "reason": reason,
        "trace": trace,
    }


def simulate_one(cfg, rng):
    r = simulate_one_with_trace(cfg, rng)
    r.pop("trace", None)
    return r


def run_monte_carlo(cfg, n_runs, seed):
    rng = np.random.default_rng(int(seed))
    rows = [simulate_one(cfg, rng) for _ in range(int(n_runs))]
    return pd.DataFrame(rows)


def summarize(df):
    n = len(df)
    safe_rate = float(df["safe"].mean() * 100.0) if n else 0.0
    touchdown_rate = float(df["landed"].mean() * 100.0) if n else 0.0

    landed_df = df[df["landed"]]
    if len(landed_df):
        avg_speed = float(landed_df["landing_speed_mps"].mean())
        std_speed = float(landed_df["landing_speed_mps"].std(ddof=1)) if len(landed_df) > 1 else 0.0
    else:
        avg_speed, std_speed = None, None

    avg_fuel = float(df["fuel_left_kg"].mean()) if n else 0.0

    breakdown = df["reason"].value_counts().to_dict()
    breakdown_pct = {k: round(v * 100.0 / n, 2) for k, v in breakdown.items()} if n else {}
    dominant_reason = max(breakdown.items(), key=lambda kv: kv[1])[0] if breakdown else "none"

    return {
        "runs": n,
        "safe_rate": round(safe_rate, 2),
        "touchdown_rate": round(touchdown_rate, 2),
        "avg_speed": None if avg_speed is None else round(avg_speed, 3),
        "std_speed": None if std_speed is None else round(std_speed, 3),
        "avg_fuel_left": round(avg_fuel, 3),
        "breakdown": breakdown,
        "breakdown_pct": breakdown_pct,
        "dominant_reason": dominant_reason,
    }


# ----------------------------
# Suggestion engine (ranked by testing)
# ----------------------------
def apply_patch(cfg, patch):
    c = copy.deepcopy(cfg)
    for path, val in patch.items():
        keys = path.split(".")
        obj = c
        for k in keys[:-1]:
            obj = obj[k]
        obj[keys[-1]] = val
    return c


def estimate_required_time_seconds(cfg):
    alt0 = float(cfg["satellite"]["initial_altitude_m"])
    target = float(cfg["control"]["target_descent_rate_mps"])
    target = max(target, 0.2)
    base = alt0 / target
    return float(max(30.0, base * 1.35))


def candidate_patches(cfg, dominant_reason):
    patches = []

    def add(label, patch):
        patches.append({"label": label, "patch": patch})

    # General knobs
    add("Increase fuel (+50%)", {"satellite.fuel_kg": cfg["satellite"]["fuel_kg"] * 1.5})
    add("Increase max thrust (+25%)", {"satellite.max_thrust_newton": cfg["satellite"]["max_thrust_newton"] * 1.25})
    add("Faster descent (+25% target rate)", {"control.target_descent_rate_mps": cfg["control"]["target_descent_rate_mps"] * 1.25})
    add("Slower descent (-25% target rate)", {"control.target_descent_rate_mps": cfg["control"]["target_descent_rate_mps"] * 0.75})
    add("Increase kp (+25%)", {"control.kp": cfg["control"]["kp"] * 1.25})
    add("Decrease kp (-25%)", {"control.kp": cfg["control"]["kp"] * 0.75})
    add("Reduce wind uncertainty (-30%)", {"environment.wind_accel_std_mps2": cfg["environment"]["wind_accel_std_mps2"] * 0.7})
    add("Reduce velocity sensor noise (-30%)", {"noise.vel_sensor_std_mps": cfg["noise"]["vel_sensor_std_mps"] * 0.7})

    if dominant_reason == "time_limit":
        req = estimate_required_time_seconds(cfg)
        add(f"Set max time ≈ {int(req)} s (computed)", {"sim.max_time_seconds": req})
        add("Max time ×2.0", {"sim.max_time_seconds": cfg["sim"]["max_time_seconds"] * 2.0})
        add("Max time ×5.0", {"sim.max_time_seconds": cfg["sim"]["max_time_seconds"] * 5.0})

    if dominant_reason == "out_of_fuel":
        add("Fuel ×2.0", {"satellite.fuel_kg": cfg["satellite"]["fuel_kg"] * 2.0})
        add("Max thrust ×1.6", {"satellite.max_thrust_newton": cfg["satellite"]["max_thrust_newton"] * 1.6})
        add("Target rate ×1.5 (descend faster)", {"control.target_descent_rate_mps": cfg["control"]["target_descent_rate_mps"] * 1.5})

    if dominant_reason == "too_fast":
        add("Target rate ×0.6 (descend slower)", {"control.target_descent_rate_mps": cfg["control"]["target_descent_rate_mps"] * 0.6})
        add("Max thrust ×1.5", {"satellite.max_thrust_newton": cfg["satellite"]["max_thrust_newton"] * 1.5})
        add("kp ×1.4", {"control.kp": cfg["control"]["kp"] * 1.4})

    return patches


def rank_suggestions(cfg, base_safe_rate, dominant_reason, seed, quick_runs=150, top_k=6):
    cands = candidate_patches(cfg, dominant_reason)
    scored = []
    for c in cands:
        cfg2 = apply_patch(cfg, c["patch"])
        df2 = run_monte_carlo(cfg2, quick_runs, seed + 777)
        s2 = summarize(df2)
        delta = s2["safe_rate"] - base_safe_rate
        scored.append({
            "label": c["label"],
            "patch": c["patch"],
            "est_safe_rate": s2["safe_rate"],
            "delta": round(delta, 2),
        })
    scored.sort(key=lambda x: x["delta"], reverse=True)
    improved = [x for x in scored if x["delta"] > 0]
    return (improved[:top_k] if improved else scored[:top_k])


# ----------------------------
# Presets (landing sites)
# ----------------------------
def apply_site(cfg, site_code):
    c = copy.deepcopy(cfg)
    site_code = (site_code or "A").upper()
    
    if site_code not in LANDING_ZONES:
        site_code = "A"
    
    zone_data = LANDING_ZONES[site_code]
    c["environment"]["wind_accel_std_mps2"] = zone_data["wind_std"]
    c["safety"]["safe_landing_speed_mps"] = zone_data["safe_speed"]
    
    return c, zone_data["name"], zone_data


# ----------------------------
# Routes
# ----------------------------
@app.get("/")
def home():
    return render_template("index.html")


@app.get("/static/assets/<path:filename>")
def serve_assets(filename):
    return send_from_directory(PROJECT_ROOT / "static" / "assets", filename)


@app.get("/api/default")
def api_default():
    base = json.loads(CFG_PATH.read_text())
    base, site_name, zone_data = apply_site(base, "A")
    return jsonify({
        "site": "A",
        "site_name": site_name,
        "zone_data": zone_data,
        "n_runs": int(base["sim"]["runs_monte_carlo"]),
        "seed": int(base["sim"]["seed"]),
        "fuel_kg": float(base["satellite"]["fuel_kg"]),
        "max_thrust_newton": float(base["satellite"]["max_thrust_newton"]),
        "target_descent_rate_mps": float(base["control"]["target_descent_rate_mps"]),
        "kp": float(base["control"]["kp"]),
        "wind_accel_std_mps2": float(base["environment"]["wind_accel_std_mps2"]),
        "vel_sensor_std_mps": float(base["noise"]["vel_sensor_std_mps"]),
        "thrust_rel_std": float(base["noise"]["thrust_rel_std"]),
        "max_time_seconds": float(base["sim"]["max_time_seconds"]),
        "safe_landing_speed_mps": float(base["safety"]["safe_landing_speed_mps"]),
        "initial_altitude_m": float(base["satellite"]["initial_altitude_m"]),
    })


@app.post("/api/run")
def api_run():
    data = request.get_json(force=True)

    base = json.loads(CFG_PATH.read_text())
    base, site_name, zone_data = apply_site(base, data.get("site", "A"))

    # overwrite from UI
    base["sim"]["runs_monte_carlo"] = int(data.get("n_runs", base["sim"]["runs_monte_carlo"]))
    base["sim"]["seed"] = int(data.get("seed", base["sim"]["seed"]))
    base["satellite"]["fuel_kg"] = float(data.get("fuel_kg", base["satellite"]["fuel_kg"]))
    base["satellite"]["max_thrust_newton"] = float(data.get("max_thrust_newton", base["satellite"]["max_thrust_newton"]))
    base["control"]["target_descent_rate_mps"] = float(data.get("target_descent_rate_mps", base["control"]["target_descent_rate_mps"]))
    base["control"]["kp"] = float(data.get("kp", base["control"]["kp"]))
    base["environment"]["wind_accel_std_mps2"] = float(data.get("wind_accel_std_mps2", base["environment"]["wind_accel_std_mps2"]))
    base["noise"]["vel_sensor_std_mps"] = float(data.get("vel_sensor_std_mps", base["noise"]["vel_sensor_std_mps"]))
    base["noise"]["thrust_rel_std"] = float(data.get("thrust_rel_std", base["noise"]["thrust_rel_std"]))
    base["sim"]["max_time_seconds"] = float(data.get("max_time_seconds", base["sim"]["max_time_seconds"]))
    base["safety"]["safe_landing_speed_mps"] = float(data.get("safe_landing_speed_mps", base["safety"]["safe_landing_speed_mps"]))

    n_runs = int(base["sim"]["runs_monte_carlo"])
    seed = int(base["sim"]["seed"])

    df = run_monte_carlo(base, n_runs, seed)
    summ = summarize(df)

    # single run trace for animation
    rng = np.random.default_rng(seed + 1)
    one = simulate_one_with_trace(base, rng)
    trace = one["trace"]

    # downsample trace for web
    if len(trace) > 2000:
        step = max(1, len(trace) // 2000)
        trace = trace[::step]

    quick_runs = int(max(120, min(250, n_runs // 4 if n_runs >= 400 else 150)))
    suggestions = rank_suggestions(
        base,
        base_safe_rate=summ["safe_rate"],
        dominant_reason=summ["dominant_reason"],
        seed=seed,
        quick_runs=quick_runs,
        top_k=6
    )

    dom = summ["dominant_reason"]
    if dom == "out_of_fuel":
        diag = "⚠️ Main issue: FUEL DEPLETED before touchdown. You need more fuel, more thrust efficiency, or a faster descent profile."
    elif dom == "too_fast":
        diag = "⚠️ Main issue: EXCESSIVE SPEED at touchdown. You need stronger braking near the end (more thrust / better control / slower target speed)."
    elif dom == "time_limit":
        req = estimate_required_time_seconds(base)
        diag = f"⚠️ Main issue: TIME LIMIT exceeded. With altitude≈{int(base['satellite']['initial_altitude_m'])} m and target rate≈{base['control']['target_descent_rate_mps']:.2f} m/s, you need max_time around {int(req)} s."
    else:
        diag = "✓ Mixed outcomes. Review suggestions below for tested improvements."

    return jsonify({
        "site_name": site_name,
        "zone_data": zone_data,
        "summary": summ,
        "diagnosis": diag,
        "suggestions": suggestions,
        "quick_runs_used_for_suggestions": quick_runs,
        "trace": {
            "dt": float(base["sim"]["dt_seconds"]),
            "initial_altitude_m": float(base["satellite"]["initial_altitude_m"]),
            "outcome": one["reason"],
            "landing_speed_mps": one["landing_speed_mps"],
            "rows": trace,  # (t, alt, vel, fuel, throttle)
        },
    })


if __name__ == "__main__":
    print("🛰️ Satellite Landing Mission Console")
    print("Open: http://127.0.0.1:5055")
    app.run(host="127.0.0.1", port=5055, debug=False)