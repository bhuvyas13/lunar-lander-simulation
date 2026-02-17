import json
import copy
import math
from pathlib import Path
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify, render_template, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"

app = Flask(__name__, template_folder="templates", static_folder="static")


# ─────────────────────────────────────────────
# Load data
# ─────────────────────────────────────────────
def load_locations():
    return json.loads((DATA_DIR / "locations.json").read_text())

def load_spacecraft():
    return json.loads((DATA_DIR / "spacecraft_reference.json").read_text())


# ─────────────────────────────────────────────
# Physics simulation — 1D vertical descent
# Convention: velocity +up / -down
# ─────────────────────────────────────────────
def simulate_one_with_trace(cfg, rng):
    dt            = float(cfg["dt"])
    max_time      = float(cfg["max_time"])
    mass          = float(cfg["mass"])
    altitude      = float(cfg["altitude"])
    velocity      = float(cfg["initial_velocity"])
    fuel          = float(cfg["fuel"])
    max_thrust    = float(cfg["thrust"])
    gravity       = -float(cfg["gravity"])
    wind_std      = float(cfg["wind_std"])
    vel_noise_std = float(cfg["vel_noise"])
    thrust_rstd   = float(cfg["thrust_noise"])
    target_vel    = -float(cfg["target_descent"])
    kp            = float(cfg["kp"])
    min_thr       = float(cfg["min_throttle"])
    max_thr       = float(cfg["max_throttle"])
    safe_speed    = float(cfg["safe_speed"])

    time = 0.0
    trace = [(time, altitude, fuel, velocity, 0.0)]

    while altitude > 0.0 and fuel > 0.0 and time < max_time:
        measured_vel  = velocity + rng.normal(0, vel_noise_std)
        vel_error     = target_vel - measured_vel
        throttle      = kp * vel_error
        throttle      = float(np.clip(throttle, min_thr, max_thr))

        thrust_mult   = 1.0 + rng.normal(0, thrust_rstd)
        thrust        = max(throttle * max_thrust * thrust_mult, 0.0)
        wind_acc      = rng.normal(0, wind_std)

        accel         = (thrust / mass) + gravity + wind_acc
        velocity     += accel * dt
        altitude     += velocity * dt
        fuel         -= throttle * dt
        time         += dt

        trace.append((time, altitude, max(fuel, 0.0), velocity, throttle))

        if len(trace) > 250_000:
            break

    landed = altitude <= 0.0
    if landed:
        speed  = abs(velocity)
        reason = "safe" if speed <= safe_speed else "too_fast"
    else:
        speed  = None
        reason = "out_of_fuel" if fuel <= 0.0 else "time_limit"

    return {
        "landed":  bool(landed),
        "safe":    bool(reason == "safe"),
        "landing_speed_mps": speed,
        "fuel_left_kg": float(max(fuel, 0.0)),
        "time_s":  float(time),
        "reason":  reason,
        "trace":   trace,
    }


def simulate_one(cfg, rng):
    r = simulate_one_with_trace(cfg, rng)
    r.pop("trace", None)
    return r


def run_monte_carlo(cfg, n_runs, seed):
    rng = np.random.default_rng(int(seed))
    return pd.DataFrame([simulate_one(cfg, rng) for _ in range(int(n_runs))])


def summarize(df):
    n = len(df)
    safe_rate  = float(df["safe"].mean() * 100) if n else 0.0
    touch_rate = float(df["landed"].mean() * 100) if n else 0.0

    landed_df  = df[df["landed"]]
    avg_speed  = float(landed_df["landing_speed_mps"].mean()) if len(landed_df) else None
    std_speed  = float(landed_df["landing_speed_mps"].std(ddof=1)) if len(landed_df) > 1 else 0.0
    avg_fuel   = float(df["fuel_left_kg"].mean()) if n else 0.0

    breakdown     = df["reason"].value_counts().to_dict()
    breakdown_pct = {k: round(v * 100 / n, 2) for k, v in breakdown.items()} if n else {}
    dominant      = max(breakdown.items(), key=lambda kv: kv[1])[0] if breakdown else "none"

    return {
        "runs":           n,
        "safe_rate":      round(safe_rate, 2),
        "touchdown_rate": round(touch_rate, 2),
        "avg_speed":      None if avg_speed is None else round(avg_speed, 3),
        "std_speed":      round(std_speed, 3),
        "avg_fuel_left":  round(avg_fuel, 3),
        "breakdown":      breakdown,
        "breakdown_pct":  breakdown_pct,
        "dominant_reason": dominant,
    }


# ─────────────────────────────────────────────
# Physics formulas for suggestions
# ─────────────────────────────────────────────
def compute_physics(cfg):
    """
    Derive correct landing parameters from first principles.

    THRUST:
      Free-fall entry velocity: v = sqrt(2 * g * h)  [kinematics, u=0]
      Braking deceleration needed: a = v² / (2*h) = g  [from v²=u²+2as]
      Net thrust needed = m * (g + a_brake)
        minimum viable = m * 2g  (1g decel, no margin)
        recommended    = m * 4g  (2g decel, handles noise)
        robust         = m * 6g  (3g decel, handles wind+noise)

    DESCENT SPEED:
      Target must be well below safe_speed threshold.
        nominal      = safe_speed * 0.5  (50% margin)
        conservative = safe_speed * 0.3  (70% margin)

    CONTROLLER GAIN (kp):
      kp determines throttle response per m/s of velocity error.
      Rule: kp = 1 / target_descent
        → 1 m/s error corrects in ~1 second at nominal descent
      Aggressive: kp = 1.5 / target_descent

    TIME BUDGET:
      t = (altitude / target_descent) * 1.5  (50% buffer)
    """
    m          = cfg["mass"]
    g          = cfg["gravity"]
    alt        = cfg["altitude"]
    safe_speed = cfg["safe_speed"]

    # Thrust levels (Newtons)
    F_hover        = round(m * g)          # just hovers, no braking
    F_brake_min    = round(m * 2 * g)      # 1g net deceleration
    F_brake_good   = round(m * 4 * g)      # 2g net decel — recommended
    F_brake_robust = round(m * 6 * g)      # 3g net decel — wind/noise safe

    # Descent speeds (m/s)
    v_nominal      = round(safe_speed * 0.5, 1)
    v_conservative = round(safe_speed * 0.3, 1)

    # Controller gains
    kp_nominal    = round(1.0 / max(v_nominal, 0.1), 2)
    kp_aggressive = round(1.5 / max(v_nominal, 0.1), 2)

    # Time budgets (seconds)
    t_nominal      = int(alt / max(v_nominal, 0.1) * 1.5)
    t_conservative = int(alt / max(v_conservative, 0.1) * 1.5)

    return {
        "F_hover":         F_hover,
        "F_brake_min":     F_brake_min,
        "F_brake_good":    F_brake_good,
        "F_brake_robust":  F_brake_robust,
        "v_nominal":       v_nominal,
        "v_conservative":  v_conservative,
        "kp_nominal":      kp_nominal,
        "kp_aggressive":   kp_aggressive,
        "t_nominal":       t_nominal,
        "t_conservative":  t_conservative,
    }


# ─────────────────────────────────────────────
# Suggestion engine
# ─────────────────────────────────────────────
def apply_patch(cfg, patch):
    c = copy.deepcopy(cfg)
    for key, val in patch.items():
        c[key] = val
    return c


def candidate_patches(cfg, dominant_reason):
    patches = []
    def add(label, patch):
        patches.append({"label": label, "patch": patch})

    p = compute_physics(cfg)

    # ── 1. PHYSICS-BASED COMBINED FIXES ──
    # These set all parameters to scientifically correct values together.
    # Single-parameter tweaks won't work when multiple things are wrong.

    add(
        f"Minimum viable — thrust {p['F_brake_min']}N, descent {p['v_nominal']}m/s",
        {
            "thrust":         p["F_brake_min"],
            "target_descent": p["v_nominal"],
            "kp":             p["kp_nominal"],
            "max_time":       p["t_nominal"],
        }
    )

    add(
        f"Recommended — thrust {p['F_brake_good']}N, descent {p['v_nominal']}m/s",
        {
            "thrust":         p["F_brake_good"],
            "target_descent": p["v_nominal"],
            "kp":             p["kp_nominal"],
            "max_time":       p["t_nominal"],
        }
    )

    add(
        f"Robust (wind-safe) — thrust {p['F_brake_robust']}N, descent {p['v_conservative']}m/s",
        {
            "thrust":         p["F_brake_robust"],
            "target_descent": p["v_conservative"],
            "kp":             p["kp_aggressive"],
            "max_time":       p["t_conservative"],
        }
    )

    add(
        f"Fuel-efficient — thrust {p['F_brake_good']}N, slower descent {p['v_conservative']}m/s",
        {
            "thrust":         p["F_brake_good"],
            "target_descent": p["v_conservative"],
            "kp":             p["kp_nominal"],
            "max_time":       p["t_conservative"],
            "fuel":           cfg["fuel"] * 1.5,
        }
    )

    # ── 2. SINGLE PARAMETER FIXES ──
    # Useful when only one thing is slightly off.

    add(f"Thrust only → {p['F_brake_good']}N (recommended)",
        {"thrust": p["F_brake_good"]})

    add(f"Descent speed only → {p['v_nominal']}m/s",
        {"target_descent": p["v_nominal"]})

    add(f"Controller gain only → kp={p['kp_nominal']}",
        {"kp": p["kp_nominal"]})

    add(f"Time budget only → {p['t_nominal']}s",
        {"max_time": p["t_nominal"]})

    # ── 3. DOMINANT REASON SPECIFIC ──
    if dominant_reason == "out_of_fuel":
        add(
            f"Double fuel + recommended thrust {p['F_brake_good']}N",
            {"fuel": cfg["fuel"] * 2.0, "thrust": p["F_brake_good"]}
        )

    if dominant_reason == "time_limit":
        add(
            f"More time ({p['t_conservative']}s) + slow descent {p['v_conservative']}m/s",
            {"max_time": p["t_conservative"], "target_descent": p["v_conservative"]}
        )

    if dominant_reason == "too_fast":
        add(
            f"Full braking fix — thrust {p['F_brake_robust']}N + all params",
            {
                "thrust":         p["F_brake_robust"],
                "target_descent": p["v_conservative"],
                "kp":             p["kp_aggressive"],
                "max_time":       p["t_conservative"],
                "fuel":           cfg["fuel"] * 1.5,
            }
        )

    return patches


def rank_suggestions(cfg, base_rate, dominant_reason, seed, quick_runs=150, top_k=6):
    cands = candidate_patches(cfg, dominant_reason)
    scored = []
    for c in cands:
        cfg2 = apply_patch(cfg, c["patch"])
        df2  = run_monte_carlo(cfg2, quick_runs, seed + 777)
        s2   = summarize(df2)
        delta = s2["safe_rate"] - base_rate
        scored.append({
            "label":          c["label"],
            "patch":          c["patch"],
            "est_safe_rate":  s2["safe_rate"],
            "delta":          round(delta, 2),
        })
    scored.sort(key=lambda x: x["delta"], reverse=True)
    improved = [x for x in scored if x["delta"] > 0]
    return (improved[:top_k] if improved else scored[:top_k])


def build_diagnosis(dominant, cfg):
    p   = compute_physics(cfg)
    twr = cfg["thrust"] / (cfg["mass"] * cfg["gravity"])

    physics_note = (
        f" Thrust/weight ratio: {twr:.2f} "
        f"(need ≥ 2.0 for braking — recommended {p['F_brake_good']}N "
        f"for {cfg['mass']}kg at {cfg['gravity']}m/s² gravity)."
    )

    if dominant == "out_of_fuel":
        return "⚠️ FUEL DEPLETED — Controller demanded sustained thrust. Try more fuel, higher thrust, or faster descent." + physics_note
    if dominant == "too_fast":
        return "⚠️ EXCESSIVE TOUCHDOWN SPEED — Braking insufficient. Try slower target descent, more thrust, or higher kp." + physics_note
    if dominant == "time_limit":
        needed = max(30, cfg["altitude"] / max(cfg["target_descent"], 0.2) * 1.4)
        return f"⚠️ TIME LIMIT HIT — Need ~{int(needed)}s for altitude={cfg['altitude']}m at {cfg['target_descent']}m/s." + physics_note
    return "✓ Mixed outcomes — review ranked suggestions." + physics_note


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────
@app.get("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.ico",
                               mimetype="image/vnd.microsoft.icon")

@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/planets")
def api_planets():
    data = load_locations()
    planets = []
    for p in data["planets"]:
        planets.append({
            "id":          p["id"],
            "name":        p["name"],
            "emoji":       p["emoji"],
            "description": p["description"],
            "gravity":     p["gravity"],
            "atmosphere":  p["atmosphere"],
            "difficulty":  p["difficulty"],
            "color":       p["color"],
            "accent":      p["accent"],
            "site_count":  len(p["sites"]),
        })
    return jsonify({"planets": planets})


@app.get("/api/planet/<planet_id>")
def api_planet(planet_id):
    data = load_locations()
    planet = next((p for p in data["planets"] if p["id"] == planet_id), None)
    if not planet:
        return jsonify({"error": "Planet not found"}), 404

    spacecraft_data = load_spacecraft()
    spacecraft = [s for s in spacecraft_data["spacecraft"]
                  if planet_id in s["suitable_for"]]

    return jsonify({
        "planet":     planet,
        "spacecraft": spacecraft,
    })


@app.post("/api/run")
def api_run():
    data = request.get_json(force=True)

    cfg = {
        "dt":               0.1,
        "max_time":         float(data.get("max_time", 200)),
        "mass":             float(data.get("mass", 1200)),
        "altitude":         float(data.get("altitude", 500)),
        "initial_velocity": 0.0,
        "fuel":             float(data.get("fuel", 100)),
        "thrust":           float(data.get("thrust", 8000)),
        "gravity":          float(data.get("gravity", 1.62)),
        "wind_std":         float(data.get("wind_std", 0.12)),
        "vel_noise":        float(data.get("vel_noise", 0.08)),
        "thrust_noise":     float(data.get("thrust_noise", 0.02)),
        "target_descent":   float(data.get("target_descent", 3.5)),
        "kp":               float(data.get("kp", 0.8)),
        "min_throttle":     0.0,
        "max_throttle":     1.0,
        "safe_speed":       float(data.get("safe_speed", 2.0)),
    }

    n_runs = int(data.get("n_runs", 500))
    seed   = int(data.get("seed", 42))

    df   = run_monte_carlo(cfg, n_runs, seed)
    summ = summarize(df)

    rng = np.random.default_rng(seed + 1)
    one = simulate_one_with_trace(cfg, rng)
    trace = one["trace"]

    if len(trace) > 2000:
        step  = max(1, len(trace) // 2000)
        trace = trace[::step]

    quick_runs  = max(120, min(250, n_runs // 4 if n_runs >= 400 else 150))
    suggestions = rank_suggestions(cfg, summ["safe_rate"], summ["dominant_reason"], seed,
                                   quick_runs=quick_runs, top_k=6)

    return jsonify({
        "summary":     summ,
        "diagnosis":   build_diagnosis(summ["dominant_reason"], cfg),
        "suggestions": suggestions,
        "quick_runs":  quick_runs,
        "trace": {
            "initial_altitude_m": cfg["altitude"],
            "outcome":            one["reason"],
            "landing_speed_mps":  one["landing_speed_mps"],
            "safe_speed":         cfg["safe_speed"],
            "rows": trace,
        },
        "planet_visual": {
            "bg_color":      data.get("bg_color", "#0a0a14"),
            "terrain_color": data.get("terrain_color", "#8a8a9a"),
            "sky_color":     data.get("sky_color", "#000000"),
            "star_density":  data.get("star_density", 1.0),
        },
    })


if __name__ == "__main__":
    print("🛰️  Satellite Landing Mission Planner")
    print("   http://127.0.0.1:5055")
    app.run(host="127.0.0.1", port=5055, debug=False)