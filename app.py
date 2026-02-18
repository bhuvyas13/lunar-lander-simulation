import json
import copy
import math
from pathlib import Path
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify, render_template, send_from_directory

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR     = PROJECT_ROOT / "data"

app = Flask(__name__, template_folder="templates", static_folder="static")

SIM_DT         = 0.1
SENSOR_VEL     = 0.08
ACTUATOR_NOISE = 0.02
SIGMA_MARGIN   = 3.0


# ── helpers ──────────────────────────────────────────────────────────────────
def load_locations():
    return json.loads((DATA_DIR / "locations.json").read_text())

def load_spacecraft():
    return json.loads((DATA_DIR / "spacecraft_reference.json").read_text())


# ── simulation ───────────────────────────────────────────────────────────────
def simulate_one_with_trace(cfg, rng):
    dt            = SIM_DT
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
    throttle_ff   = (mass * float(cfg["gravity"])) / max_thrust

    time  = 0.0
    trace = [(time, altitude, fuel, velocity, 0.0)]

    while altitude > 0.0 and fuel > 0.0 and time < max_time:
        measured_vel = velocity + rng.normal(0, vel_noise_std)
        vel_error    = target_vel - measured_vel
        throttle     = float(np.clip(throttle_ff + kp * vel_error, min_thr, max_thr))
        thrust_mult  = 1.0 + rng.normal(0, thrust_rstd)
        thrust       = max(throttle * max_thrust * thrust_mult, 0.0)
        wind_acc     = rng.normal(0, wind_std)
        accel        = (thrust / mass) + gravity + wind_acc
        velocity    += accel * dt
        altitude    += velocity * dt
        fuel        -= throttle * dt
        time        += dt
        trace.append((time, altitude, max(fuel, 0.0), velocity, throttle))
        if len(trace) > int(max_time / dt) + 10:
            break

    landed = altitude <= 0.0
    if landed:
        speed  = abs(velocity)
        reason = "safe" if speed <= safe_speed else "too_fast"
    else:
        speed  = None
        reason = "out_of_fuel" if fuel <= 0.0 else "time_limit"

    return {
        "landed": bool(landed), "safe": bool(reason == "safe"),
        "landing_speed_mps": speed, "fuel_left_kg": float(max(fuel, 0.0)),
        "time_s": float(time), "reason": reason, "trace": trace,
    }

def simulate_one(cfg, rng):
    r = simulate_one_with_trace(cfg, rng)
    r.pop("trace", None)
    return r

def run_monte_carlo(cfg, n_runs, seed):
    rng = np.random.default_rng(int(seed))
    return pd.DataFrame([simulate_one(cfg, rng) for _ in range(int(n_runs))])

def summarize(df):
    n          = len(df)
    safe_rate  = float(df["safe"].mean()   * 100) if n else 0.0
    touch_rate = float(df["landed"].mean() * 100) if n else 0.0
    landed_df  = df[df["landed"]]
    avg_speed  = float(landed_df["landing_speed_mps"].mean()) if len(landed_df) else None
    std_speed  = float(landed_df["landing_speed_mps"].std(ddof=1)) if len(landed_df) > 1 else 0.0
    avg_fuel   = float(df["fuel_left_kg"].mean()) if n else 0.0
    breakdown     = df["reason"].value_counts().to_dict()
    breakdown_pct = {k: round(v * 100 / n, 2) for k, v in breakdown.items()} if n else {}
    dominant      = max(breakdown.items(), key=lambda kv: kv[1])[0] if breakdown else "none"
    return {
        "runs": n, "safe_rate": round(safe_rate, 2), "touchdown_rate": round(touch_rate, 2),
        "avg_speed": None if avg_speed is None else round(avg_speed, 3),
        "std_speed": round(std_speed, 3), "avg_fuel_left": round(avg_fuel, 3),
        "breakdown": breakdown, "breakdown_pct": breakdown_pct, "dominant_reason": dominant,
    }


# ── physics engine ────────────────────────────────────────────────────────────
def compute_physics(cfg):
    m         = float(cfg["mass"])
    g         = float(cfg["gravity"])
    h         = float(cfg["altitude"])
    F_max     = float(cfg["thrust"])
    v_safe    = float(cfg["safe_speed"])
    wind_std  = float(cfg["wind_std"])
    vel_noise = float(cfg.get("vel_noise", SENSOR_VEL))

    F_hover     = m * g
    TWR         = F_max / F_hover if F_hover > 0 else 0.0
    a_brake_max = (F_max / m) - g
    v_freefall  = math.sqrt(2.0 * g * h)

    h_brake_emergency = (
        (v_freefall**2 - v_safe**2) / (2.0 * a_brake_max)
        if a_brake_max > 0 else None
    )

    FF = min(1.0 / TWR, 1.0) if TWR > 0 else 1.0

    sigma_wind  = wind_std / a_brake_max if a_brake_max > 0 else max(wind_std * 10.0, v_safe)
    sigma_total = math.sqrt(sigma_wind**2 + vel_noise**2)
    v_target    = max(v_safe - SIGMA_MARGIN * sigma_total, 0.05)

    sigma_wind_c  = (2.0 * wind_std / a_brake_max) if a_brake_max > 0 else sigma_wind * 2.0
    sigma_total_c = math.sqrt(sigma_wind_c**2 + vel_noise**2)
    v_target_cons = max(v_safe - SIGMA_MARGIN * sigma_total_c, 0.05)

    kp_sat      = min(1.0 - FF, FF) / (SIGMA_MARGIN * max(sigma_total, 0.001))
    kp_wind_min = (wind_std * m / F_max) if F_max > 0 else 0.001
    kp_ideal    = (10.0 * m * v_target / (F_max * h)) if (F_max > 0 and h > 0) else 0.1
    kp          = round(max(min(kp_ideal, kp_sat), kp_wind_min, 0.001), 4)

    kp_cons_ideal = (10.0 * m * v_target_cons / (F_max * h) * 1.2) if (F_max > 0 and h > 0) else 0.1
    kp_cons_sat   = min(1.0 - FF, FF) / (SIGMA_MARGIN * max(sigma_total_c, 0.001))
    kp_cons       = round(max(min(kp_cons_ideal, kp_cons_sat), kp_wind_min, 0.001), 4)

    t_descent      = h / v_target
    t_descent_cons = h / v_target_cons
    tau            = m / (kp      * F_max) if (kp      > 0 and F_max > 0) else t_descent
    tau_cons       = m / (kp_cons * F_max) if (kp_cons > 0 and F_max > 0) else t_descent_cons
    t_budget       = math.ceil(t_descent      + 3 * tau      + 5 * SIM_DT)
    t_budget_cons  = math.ceil(t_descent_cons + 3 * tau_cons + 5 * SIM_DT)

    correction_overhead = min(sigma_wind / max(v_target, 0.001), 0.5)
    avg_throttle   = min(FF + correction_overhead * (1.0 - FF),       1.0) if TWR > 0 else 1.0
    avg_throttle_c = min(FF + correction_overhead * 1.5 * (1.0 - FF), 1.0) if TWR > 0 else 1.0
    fuel_needed      = round(avg_throttle   * t_budget,      1)
    fuel_needed_cons = round(avg_throttle_c * t_budget_cons, 1)

    a_req    = (v_freefall**2 - v_safe**2) / (2.0 * h) if h > 0 else 0.0
    F_needed = round(max(m * (g + a_req), F_hover), 0)

    return {
        "F_hover": round(F_hover, 2), "TWR": round(TWR, 3), "FF": round(FF, 4),
        "a_brake_max": round(a_brake_max, 4), "v_freefall": round(v_freefall, 3),
        "h_brake_emergency": round(h_brake_emergency, 2) if h_brake_emergency is not None else None,
        "sigma_wind": round(sigma_wind, 4), "sigma_total": round(sigma_total, 4),
        "feasible": TWR >= 1.0, "marginal": 1.0 <= TWR < 1.5, "impossible": TWR < 1.0,
        "v_target": round(v_target, 3), "kp": kp, "kp_wind_min": round(kp_wind_min, 6),
        "t_descent": round(t_descent, 1), "tau": round(tau, 2), "t_budget": t_budget,
        "fuel_needed": fuel_needed, "avg_throttle": round(avg_throttle, 4),
        "v_target_cons": round(v_target_cons, 3), "kp_cons": kp_cons,
        "t_budget_cons": t_budget_cons, "fuel_needed_cons": fuel_needed_cons,
        "F_needed": F_needed, "a_req": round(a_req, 4),
    }


# ── suggestion engine — human-friendly ───────────────────────────────────────
def _fmt(val, param):
    """Format a parameter value for display to a normal user."""
    if param == "thrust":
        return f"{int(val):,} N"
    if param == "max_time":
        return f"{int(val)} seconds"
    if param == "fuel":
        return f"{round(val, 1)} kg"
    if param == "target_descent":
        return f"{round(val, 2)} m/s"
    if param == "kp":
        # Show kp as a plain number but never show raw scientific notation
        return str(round(val, 4))
    return str(round(val, 2))

def _change(param, old_val, new_val):
    return f"{_fmt(old_val, param)}  →  {_fmt(new_val, param)}"


def apply_patch(cfg, patch):
    c = copy.deepcopy(cfg)
    for key, val in patch.items():
        c[key] = val
    return c


def make_suggestions(cfg, breakdown, base_rate):
    """
    Returns human-friendly suggestion dicts. No physics jargon.
    Each suggestion has:
      title      — plain English: what is the problem
      action     — what to do about it
      change_str — "old → new" for the relevant field(s)
      why        — real-world analogy explanation
      patch      — dict to apply to cfg
    """
    p           = compute_physics(cfg)
    cur_descent = float(cfg["target_descent"])
    cur_kp      = float(cfg["kp"])
    cur_time    = float(cfg["max_time"])
    cur_fuel    = float(cfg["fuel"])
    cur_thrust  = float(cfg["thrust"])
    v_safe      = float(cfg["safe_speed"])
    altitude    = float(cfg["altitude"])
    kp_opt      = float(p["kp"])

    total    = max(sum(breakdown.values()), 1)
    severity = 1.0 - (base_rate / 100.0)
    nudge    = 0.08 + 0.22 * severity   # 8% near-working → 30% completely failing

    too_fast = breakdown.get("too_fast",    0) / total
    time_lim = breakdown.get("time_limit",  0) / total
    fuel_dry = breakdown.get("out_of_fuel", 0) / total

    suggs = []

    # ── 1. FIX EVERYTHING AT ONCE (always first, always positive delta) ───────
    new_fuel      = max(cur_fuel, p["fuel_needed"])
    physics_patch = {
        "target_descent": p["v_target"],
        "kp":             p["kp"],
        "max_time":       p["t_budget"],
        "fuel":           new_fuel,
    }
    # Build a concise summary of what changes
    changes = []
    if abs(cur_descent - p["v_target"]) > 0.05:
        changes.append(f"Descent speed: {_fmt(cur_descent,'target_descent')} → {_fmt(p['v_target'],'target_descent')}")
    if abs(cur_kp - p["kp"]) > 0.001:
        changes.append(f"Autopilot: {_fmt(cur_kp,'kp')} → {_fmt(p['kp'],'kp')}")
    if cur_time < p["t_budget"] - 5:
        changes.append(f"Time limit: {_fmt(cur_time,'max_time')} → {_fmt(p['t_budget'],'max_time')}")
    if new_fuel > cur_fuel + 1:
        changes.append(f"Fuel: {_fmt(cur_fuel,'fuel')} → {_fmt(new_fuel,'fuel')}")

    suggs.append({
        "title":      "✨ Fix everything at once",
        "action":     "Apply all recommended settings",
        "change_str": " · ".join(changes) if changes else "All settings already optimal",
        "why": (
            "This applies every setting that the physics of this landing requires: "
            "the right descent speed, autopilot response, time budget, and fuel load. "
            "It's the fastest way to get a safe landing — one click."
        ),
        "patch": physics_patch,
    })

    # ── 2. KP TOO LOW — controller can't steer ───────────────────────────────
    if cur_kp < kp_opt * 0.2 and kp_opt > 0:
        suggs.append({
            "title":      "🎮 Your autopilot is too sluggish to steer",
            "action":     "Make the autopilot more responsive",
            "change_str": _change("kp", cur_kp, kp_opt),
            "why": (
                "Think of steering a car where the wheel barely responds — "
                "no matter how hard you turn, the car barely reacts and drifts off the road. "
                "Your autopilot is set so low it can't correct the spacecraft's speed in time. "
                "Turning it up lets it react fast enough to stay on target."
            ),
            "patch": {"kp": kp_opt},
        })

    # ── 3. LANDING TOO FAST ───────────────────────────────────────────────────
    if too_fast > 0.1 or cur_descent >= v_safe:
        new_d = round(max(cur_descent * (1 - nudge), 0.1), 2)
        pct   = round(too_fast * 100)
        suggs.append({
            "title":      "💥 Your spacecraft hits the ground too fast",
            "action":     "Slow down the descent speed",
            "change_str": _change("target_descent", cur_descent, new_d),
            "why": (
                f"Your target descent speed ({_fmt(cur_descent,'target_descent')}) is as fast as — "
                f"or faster than — what counts as a safe landing ({_fmt(v_safe,'target_descent')}). "
                f"There is no margin: any sensor glitch or gust of wind and you crash. "
                f"Slow it down so the engines have room to brake gently."
            ) if cur_descent >= v_safe else (
                f"{pct}% of your missions crashed on impact. "
                f"Like a plane coming in too steep — arriving that fast gives the "
                f"engines no time to brake. A slower descent lets them stop you gradually."
            ),
            "patch": {"target_descent": new_d},
        })

    # ── 4. TIME LIMIT ─────────────────────────────────────────────────────────
    if time_lim > 0.15:
        new_t   = math.ceil(cur_time * (1 + nudge * 1.5))
        pct     = round(time_lim * 100)
        need_t  = int(altitude / max(cur_descent, 0.1))
        suggs.append({
            "title":      "⏱️ Your mission ends before the spacecraft lands",
            "action":     "Give the mission more time",
            "change_str": _change("max_time", cur_time, new_t),
            "why": (
                f"{pct}% of missions hit the time limit before touching down. "
                f"Descending from {int(altitude)} m at {_fmt(cur_descent,'target_descent')} "
                f"takes about {need_t} seconds — but your mission cuts off at "
                f"{_fmt(cur_time,'max_time')}. "
                f"The spacecraft is forced to abort mid-flight. "
                f"Simply allow more time to complete the landing."
            ),
            "patch": {"max_time": new_t},
        })

    # ── 5. DESCENT TOO SLOW (time-limited with plenty of speed headroom) ──────
    if time_lim > 0.3 and cur_descent < v_safe * 0.7:
        new_d = round(max(cur_descent * (1 + nudge * 0.5), cur_descent + 0.1), 2)
        if new_d > cur_descent + 0.05:
            suggs.append({
                "title":      "🐌 Your spacecraft is descending too slowly",
                "action":     "Increase the descent speed slightly",
                "change_str": _change("target_descent", cur_descent, new_d),
                "why": (
                    f"You're descending at only {_fmt(cur_descent,'target_descent')}, "
                    f"but a safe landing allows up to {_fmt(v_safe,'target_descent')} — "
                    f"there's room to go faster without crashing. "
                    f"Speeding up slightly will get you to the ground "
                    f"before the mission timer runs out."
                ),
                "patch": {"target_descent": new_d},
            })

    # ── 6. AUTOPILOT NOT BRAKING HARD ENOUGH ─────────────────────────────────
    if too_fast > 0.3 and cur_descent < v_safe and cur_kp >= kp_opt * 0.2:
        new_kp = round(min(cur_kp * (1 + nudge), kp_opt * 6), 4)
        pct    = round(too_fast * 100)
        suggs.append({
            "title":      "🛑 Your autopilot isn't braking hard enough",
            "action":     "Increase autopilot sensitivity",
            "change_str": _change("kp", cur_kp, new_kp),
            "why": (
                f"{pct}% of missions landed too fast even though the target speed looks safe. "
                f"The autopilot isn't reacting aggressively enough to slow down "
                f"in the final seconds before touchdown. "
                f"Increasing sensitivity makes it brake harder when it detects "
                f"the spacecraft moving too fast."
            ),
            "patch": {"kp": new_kp},
        })

    # ── 7. AUTOPILOT OVERCORRECTING ───────────────────────────────────────────
    if (time_lim > 0.3 or fuel_dry > 0.3) and cur_kp > kp_opt * 4:
        new_kp = round(cur_kp * (1 - nudge), 4)
        suggs.append({
            "title":      "🌊 Your autopilot is overcorrecting and wasting fuel",
            "action":     "Reduce autopilot sensitivity",
            "change_str": _change("kp", cur_kp, new_kp),
            "why": (
                "Your autopilot is set very high — it keeps swinging between "
                "full thrust and zero thrust, fighting itself instead of descending smoothly. "
                "Like a driver who yanks the steering wheel left and right constantly, "
                "it burns through fuel and never settles. Turning it down "
                "produces a calmer, more fuel-efficient descent."
            ),
            "patch": {"kp": new_kp},
        })

    # ── 8. OUT OF FUEL ────────────────────────────────────────────────────────
    if fuel_dry > 0.2:
        new_f = round(cur_fuel * (1 + nudge * 1.5), 1)
        pct   = round(fuel_dry * 100)
        suggs.append({
            "title":      "🔥 Your spacecraft runs out of fuel mid-descent",
            "action":     "Load more fuel before launch",
            "change_str": _change("fuel", cur_fuel, new_f),
            "why": (
                f"{pct}% of missions ran out of fuel before touching down. "
                f"The engines need to fire continuously to slow the descent — "
                f"think of it as riding the brakes all the way down a long hill. "
                f"Running out means the spacecraft free-falls the rest of the way "
                f"and crashes. More fuel keeps the engines firing all the way to landing."
            ),
            "patch": {"fuel": new_f},
        })

    # ── 9. ENGINES TOO WEAK ───────────────────────────────────────────────────
    if not p["feasible"]:
        new_thr = round(cur_thrust * (1 + nudge * 2), 0)
        suggs.append({
            "title":      "💪 Your engines are too weak to slow down",
            "action":     "Increase engine thrust",
            "change_str": _change("thrust", cur_thrust, new_thr),
            "why": (
                "Your engines can barely support the spacecraft's own weight — "
                "there's nothing left over to actually brake. "
                "It's like trying to stop a heavy truck with a bicycle brake. "
                "You need significantly more thrust just to have any "
                "braking force available near the ground."
            ),
            "patch": {"thrust": new_thr},
        })
    elif too_fast > 0.4 and p["TWR"] < 1.4:
        new_thr = round(cur_thrust * (1 + nudge), 0)
        suggs.append({
            "title":      "💪 Your engines need more braking power",
            "action":     "Boost engine thrust",
            "change_str": _change("thrust", cur_thrust, new_thr),
            "why": (
                "Your engines are only marginally stronger than gravity — "
                "there isn't much thrust available to slow you down in the final approach. "
                "More thrust gives the autopilot more braking force to work with "
                "as you get close to the ground."
            ),
            "patch": {"thrust": new_thr},
        })

    return suggs


def rank_suggestions(cfg, base_rate, breakdown, seed, quick_runs=150, top_k=6):
    suggs  = make_suggestions(cfg, breakdown, base_rate)
    scored = []
    for s in suggs:
        cfg2  = apply_patch(cfg, s["patch"])
        df3   = run_monte_carlo(cfg2, quick_runs, seed + 777)
        s3    = summarize(df3)
        delta = s3["safe_rate"] - base_rate
        scored.append({
            "title":         s["title"],
            "action":        s["action"],
            "change_str":    s["change_str"],
            "why":           s["why"],
            "patch":         s["patch"],
            "est_safe_rate": s3["safe_rate"],
            "delta":         round(delta, 2),
        })

    positive = sorted([x for x in scored if x["delta"] > 0],  key=lambda x: -x["delta"])
    zero_neg = sorted([x for x in scored if x["delta"] <= 0], key=lambda x: -x["delta"])
    result   = positive[:top_k]
    if len(result) < top_k:
        result += zero_neg[:top_k - len(result)]
    return result[:top_k]


def build_diagnosis(dominant, cfg):
    p = compute_physics(cfg)
    if p["impossible"]:
        return (
            f"❌ Your engines ({int(cfg['thrust']):,} N) can't support the spacecraft's "
            f"weight ({int(cfg['mass']):,} kg) against this planet's gravity. "
            f"You need at least {int(p['F_needed']):,} N of thrust to have any braking power."
        )
    if dominant == "out_of_fuel":
        return (
            f"🔥 The spacecraft runs out of fuel before it reaches the ground. "
            f"The descent needs roughly {p['fuel_needed']} kg of fuel, "
            f"but only {cfg['fuel']} kg was loaded."
        )
    if dominant == "too_fast":
        return (
            f"💥 The spacecraft hits the ground too fast. "
            f"The safe landing speed is {cfg['safe_speed']} m/s, "
            f"but most missions are arriving much faster than that. "
            f"The brakes aren't slowing it down enough in time."
        )
    if dominant == "time_limit":
        need = int(cfg["altitude"] / max(float(cfg["target_descent"]), 0.1))
        return (
            f"⏱️ The mission timer runs out before the spacecraft lands. "
            f"At the current descent speed, the landing takes about {need} seconds — "
            f"but the mission is set to end at {int(cfg['max_time'])} seconds."
        )
    return (
        f"📊 Mixed results across {cfg.get('n_runs', 500)} simulations. "
        f"Check the suggestions below to improve your success rate."
    )


# ── routes ────────────────────────────────────────────────────────────────────
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
    return jsonify({"planets": [
        {"id": p["id"], "name": p["name"], "emoji": p["emoji"],
         "description": p["description"], "gravity": p["gravity"],
         "atmosphere": p["atmosphere"], "difficulty": p["difficulty"],
         "color": p["color"], "accent": p["accent"], "site_count": len(p["sites"])}
        for p in data["planets"]
    ]})

@app.get("/api/planet/<planet_id>")
def api_planet(planet_id):
    data   = load_locations()
    planet = next((p for p in data["planets"] if p["id"] == planet_id), None)
    if not planet:
        return jsonify({"error": "Planet not found"}), 404
    sc = load_spacecraft()
    return jsonify({
        "planet":     planet,
        "spacecraft": [s for s in sc["spacecraft"] if planet_id in s["suitable_for"]],
    })

@app.post("/api/run")
def api_run():
    data    = request.get_json(force=True)
    gravity = data.get("gravity")
    if gravity is None:
        return jsonify({"error": "gravity is required"}), 400

    base_phys = {
        "mass": float(data.get("mass", 1200)), "gravity": float(gravity),
        "altitude": float(data.get("altitude", 500)), "thrust": float(data.get("thrust", 8000)),
        "safe_speed": float(data.get("safe_speed", 2.0)), "wind_std": float(data.get("wind_std", 0.12)),
        "vel_noise": SENSOR_VEL,
    }
    phys = compute_physics(base_phys)

    cfg = {
        "dt": SIM_DT,
        "max_time":         float(data.get("max_time",       phys["t_budget"])),
        "mass":             float(data.get("mass",           1200)),
        "altitude":         float(data.get("altitude",        500)),
        "initial_velocity": 0.0,
        "fuel":             float(data.get("fuel",            100)),
        "thrust":           float(data.get("thrust",         8000)),
        "gravity":          float(gravity),
        "wind_std":         float(data.get("wind_std",       0.12)),
        "vel_noise":        SENSOR_VEL,
        "thrust_noise":     ACTUATOR_NOISE,
        "target_descent":   float(data.get("target_descent", phys["v_target"])),
        "kp":               float(data.get("kp",             phys["kp"])),
        "min_throttle":     0.0,
        "max_throttle":     1.0,
        "safe_speed":       float(data.get("safe_speed",      2.0)),
    }

    n_runs = int(data.get("n_runs", 500))
    seed   = int(data.get("seed",    42))

    df   = run_monte_carlo(cfg, n_runs, seed)
    summ = summarize(df)

    rng   = np.random.default_rng(seed + 1)
    one   = simulate_one_with_trace(cfg, rng)
    trace = one["trace"]
    target_frames = int(min(cfg["max_time"] / SIM_DT, 2000))
    if len(trace) > target_frames:
        step  = max(1, len(trace) // target_frames)
        trace = trace[::step]

    quick_runs  = max(80, min(300, n_runs * 30 // 100))
    suggestions = [] if summ["safe_rate"] >= 95.0 else rank_suggestions(
        cfg, summ["safe_rate"], summ["breakdown"], seed,
        quick_runs=quick_runs, top_k=6,
    )

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
            "rows":               trace,
        },
        "planet_visual": {
            "bg_color":      data.get("bg_color",      "#0a0a14"),
            "terrain_color": data.get("terrain_color", "#8a8a9a"),
            "sky_color":     data.get("sky_color",     "#000000"),
            "star_density":  data.get("star_density",  1.0),
        },
    })

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5055))
    print("🛰️  Satellite Landing Mission Planner")
    print(f"   http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)