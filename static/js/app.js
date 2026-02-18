/* ═══════════════════════════════════════════
   SATELLITE LANDING MISSION PLANNER — APP.JS
═══════════════════════════════════════════ */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICAL CONSTANTS — hardware specs, mirrored from app.py
// These represent real sensor/actuator specifications, not tuning choices.
// Change them here AND in app.py together if hardware assumptions change.
// ─────────────────────────────────────────────────────────────────────────────
const SIM_DT         = 0.1;    // s   — simulation timestep
const SENSOR_VEL     = 0.08;   // m/s — velocity sensor noise std (IMU spec)
const ACTUATOR_NOISE = 0.02;   // rel — thrust actuator noise (engine variability)
const SIGMA_MARGIN   = 3.0;    // σ   — 3-sigma safety margin (99.7% confidence)

/**
 * Derive mission parameters from first principles.
 * Mirrors compute_physics() in app.py exactly — same formulas, no magic numbers.
 */
function computePhysics(mass, F_max, gravity, altitude, v_safe, wind_std) {
  const m = mass, g = gravity, h = altitude, F = F_max;

  // Hover thrust and thrust-to-weight ratio
  const F_hover     = m * g;
  const TWR         = F > 0 ? F / F_hover : 0;

  // Net braking deceleration at full throttle: (F/m) - g
  const a_brake_max = (F / m) - g;

  // Steady-state wind velocity uncertainty with controller active:
  //   σ_wind = wind_std / a_brake_max
  //   (equilibrium: controller correction rate = wind perturbation rate)
  const sigma_wind  = a_brake_max > 0 ? wind_std / a_brake_max : v_safe;
  const sigma_total = Math.sqrt(sigma_wind ** 2 + SENSOR_VEL ** 2);

  // Target descent rate: largest v such that v + 3σ ≤ v_safe
  const v_target = Math.max(v_safe - SIGMA_MARGIN * sigma_total, 0.05);

  // Gravity feedforward: FF = F_hover/F_max = 1/TWR
  // throttle = FF + kp*(target - measured) — FF cancels gravity, kp corrects errors
  const FF         = Math.min(1.0 / Math.max(TWR, 0.001), 1.0);

  // kp constraints:
  //   ideal:    tau = t_descent/10  →  kp = 10*m*v_target/(F*h)
  //   sat upper: FF + kp*3σ ≤ 1   →  kp ≤ (1-FF)/(3σ)
  //   sat lower: FF - kp*3σ ≥ 0   →  kp ≤ FF/(3σ)
  //   wind reject: kp*F/m ≥ wind_std  →  kp ≥ wind_std*m/F
  const kp_ideal      = (F > 0 && h > 0) ? (10 * m * v_target / (F * h)) : 0.1;
  const kp_sat        = Math.min(1.0 - FF, FF) / (SIGMA_MARGIN * Math.max(sigma_total, 0.001));
  const kp_wind_min   = (wind_std * m / F) || 0.001;
  const kp            = Math.max(Math.min(kp_ideal, kp_sat), kp_wind_min, 0.001);

  // Time budget: descent + 3 time constants (95% settling) + 5 final steps
  const t_descent = h / v_target;
  const tau       = (kp > 0 && F > 0) ? (m / (kp * F)) : t_descent;
  const t_budget  = Math.ceil(t_descent + 3 * tau + 5 * SIM_DT);

  return {
    v_target:    Math.round(v_target * 1000) / 1000,
    kp:          Math.round(kp * 10000) / 10000,
    t_budget,
    TWR:         Math.round(TWR * 1000) / 1000,
    F_hover,
    a_brake_max,
    sigma_wind,
    sigma_total,
    t_descent:   Math.round(t_descent * 10) / 10,
    tau:         Math.round(tau * 100) / 100,
  };
}

// Canvas roundRect polyfill
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    r = Math.min(r, w/2, h/2);
    this.beginPath();
    this.moveTo(x+r, y);
    this.arcTo(x+w, y, x+w, y+h, r);
    this.arcTo(x+w, y+h, x, y+h, r);
    this.arcTo(x, y+h, x, y, r);
    this.arcTo(x, y, x+w, y, r);
    this.closePath();
    return this;
  };
}

/* ─────────── STATE ─────────── */
const STATE = {
  selectedPlanet:   null,
  selectedSite:     null,
  spacecraft:       null,
  spacecraftList:   [],
  lastPayload:      null,
};

/* ─────────── DOM HELPERS ─────────── */
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

function showPage(n) {
  [1,2,3].forEach(i => $(`page${i}`).classList.toggle("hidden", i !== n));
}

/* ─────────── PAGE 1 — PLANET SELECTION ─────────── */
async function initPage1() {
  const res = await fetch("/api/planets");
  const { planets } = await res.json();
  const grid = $("planetsGrid");
  grid.innerHTML = "";

  const atmLabels = {
    "none":          "None (vacuum)",
    "thin_co2":      "Thin CO₂",
    "thick":         "Dense Nitrogen/O₂",
    "dense_nitrogen":"Dense Nitrogen",
    "crushing":      "Crushing CO₂ (90 atm)",
  };

  planets.forEach(p => {
    const card = el("div", "planet-card");
    card.style.setProperty("--card-accent", p.accent);
    card.style.setProperty("--card-glow", `radial-gradient(ellipse at 50% 0%, ${p.accent}14 0%, transparent 70%)`);

    card.innerHTML = `
      <div class="card-top">
        <div class="planet-emoji">${p.emoji}</div>
        <div class="planet-badges">
          <span class="diff-badge ${p.difficulty}">${p.difficulty.toUpperCase()}</span>
          <span class="site-count">${p.site_count} SITES</span>
        </div>
      </div>
      <div class="planet-name">${p.name}</div>
      <div class="planet-desc">${p.description}</div>
      <div class="planet-stats">
        <div class="pstat">
          <span>Gravity</span>
          <b>${p.gravity} m/s²</b>
        </div>
        <div class="pstat">
          <span>Atmosphere</span>
          <b>${atmLabels[p.atmosphere] || p.atmosphere}</b>
        </div>
      </div>
      <div class="card-arrow">EXPLORE SITES →</div>
    `;

    card.addEventListener("click", () => loadPlanet(p.id));
    grid.appendChild(card);
  });
}

/* ─────────── PAGE 2 — SITE SELECTION ─────────── */
async function loadPlanet(planetId) {
  const res = await fetch(`/api/planet/${planetId}`);
  const { planet, spacecraft } = await res.json();

  STATE.selectedPlanet  = planet;
  STATE.spacecraftList  = spacecraft;
  STATE.selectedSite    = null;
  STATE.spacecraft      = spacecraft[0] || null;

  $("p2PlanetEmoji").textContent = planet.emoji;
  $("p2PlanetName").textContent  = planet.name.toUpperCase();

  const orb = $("p2PlanetOrb");
  orb.style.setProperty("--orb-color", planet.color);
  orb.style.setProperty("--orb-glow", `${planet.accent}66`);

  const atmLabels = {
    "none":          "None (vacuum)",
    "thin_co2":      "Thin CO₂",
    "thick":         "Dense",
    "dense_nitrogen":"Dense N₂",
    "crushing":      "Crushing (90 atm)",
  };
  $("p2Gravity").textContent    = `${planet.gravity} m/s²`;
  $("p2Atmosphere").textContent = atmLabels[planet.atmosphere] || planet.atmosphere;
  $("p2Difficulty").textContent = planet.difficulty.toUpperCase();
  $("p2Desc").textContent       = planet.description;

  const list = $("sitesList");
  list.innerHTML = "";
  planet.sites.forEach(site => {
    const card = el("div", `site-card${site.impossible ? " site-impossible" : ""}`);
    card.innerHTML = `
      <div class="site-top">
        <div class="site-icon">${site.icon}</div>
        <span class="site-diff ${site.difficulty}">${site.difficulty_label}</span>
      </div>
      <div class="site-name">${site.name}</div>
      <div class="site-mission">${site.mission}</div>
      <div class="site-desc">${site.description}</div>
      <div class="site-stats">
        <div class="site-stat"><span>Gravity: </span><b>${site.gravity} m/s²</b></div>
        <div class="site-stat"><span>Safe Speed: </span><b>≤ ${site.safe_speed} m/s</b></div>
        <div class="site-stat"><span>Altitude: </span><b>${site.altitude} m</b></div>
      </div>
      ${site.impossible ? '<div class="impossible-overlay">☠️</div>' : ""}
    `;
    card.addEventListener("click", () => {
      if (site.impossible) showImpossibleModal(site);
      else selectSiteAndGoP3(site);
    });
    list.appendChild(card);
  });

  showPage(2);
}

function showImpossibleModal(site) {
  $("modalText").textContent = site.description;
  $("modalFact").textContent = `🔬 Fun Fact: ${site.fun_fact}`;
  $("impossibleModal").classList.remove("hidden");
}

$("modalClose").addEventListener("click", () => {
  $("impossibleModal").classList.add("hidden");
});

/* ─────────── PAGE 3 — MISSION CONTROL ─────────── */
function selectSiteAndGoP3(site) {
  STATE.selectedSite = site;
  buildPage3();
  showPage(3);
}

function buildPage3() {
  const site   = STATE.selectedSite;
  const planet = STATE.selectedPlanet;
  const sc     = STATE.spacecraftList;

  $("badgeSite").textContent = `${planet.emoji} ${planet.name} — ${site.name}`;

  const scList = $("spacecraftList");
  scList.innerHTML = "";
  if (sc.length === 0) {
    scList.innerHTML = `<p style="color:var(--muted);font-size:0.8rem">No suggested spacecraft for this destination.</p>`;
  } else {
    sc.forEach((s, i) => {
      const card = el("div", `sc-card${i===0 ? " selected" : ""}`);
      card.innerHTML = `
        <div class="sc-icon">${s.icon}</div>
        <div class="sc-info">
          <div class="sc-name">${s.name}</div>
          <div class="sc-meta">${s.agency} · ${s.year} · ${(s.mass_kg/1000).toFixed(1)}t</div>
        </div>
        <div class="sc-check">✓</div>
      `;
      card.addEventListener("click", () => {
        document.querySelectorAll(".sc-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        STATE.spacecraft = s;
        populateParams(s, site, planet);
      });
      scList.appendChild(card);
    });
  }

  if (sc.length > 0) STATE.spacecraft = sc[0];
  populateParams(STATE.spacecraft || { mass_kg:1200, fuel_kg:100, thrust_n:8000, kp:0.8 }, site, planet);

  ANIM.reset();
  ANIM.drawIdleScene(planet, site);
}

/**
 * Populate all parameter fields using physics-derived defaults.
 * Populate UI with RANDOMISED starting values — deliberately wrong.
 * Every page load is different so users cannot memorise correct inputs.
 * Suggestions then show physics-correct improvements with real positive deltas.
 */
function populateParams(sc, site, planet) {
  if (!sc) return;

  // Always use real spacecraft specs for mass/thrust (these are physical facts)
  $("pMass").value   = sc.mass_kg;
  $("pThrust").value = sc.thrust_n;
  $("pWind").value   = site.wind_std;

  // ── RANDOMISE everything the user can tune ──
  // Use crypto random so it's different every single time (not seeded, not learnable)
  const r = () => Math.random();

  // kp: 0.01 to 4.0 — spacecraft kp is usually 0.6–1.2, so this spans 10x under to 3x over
  const kp = parseFloat((r() * 3.99 + 0.01).toFixed(3));

  // Descent rate: 0.5 to 8.0 m/s — correct is usually 1–2 m/s, so often dangerously fast
  const descent = parseFloat((r() * 7.5 + 0.5).toFixed(1));

  // Max time: 30 to 300s — correct is usually 200–300s, so often way too short
  const maxTime = Math.floor(r() * 271 + 30);

  // Fuel: 30%–100% of spacecraft spec — sometimes critically low
  const fuel = parseFloat((sc.fuel_kg * (r() * 0.7 + 0.3)).toFixed(1));

  $("pKp").value      = kp;
  $("pDescent").value = descent;
  $("pMaxTime").value = maxTime;
  $("pFuel").value    = fuel;
}

/**
 * Build simulation config from current UI values.
 * gravity, altitude, safe_speed always come from the selected site.
 * Sensor noise values are named constants, not magic numbers.
 */
function getSimConfig() {
  const site   = STATE.selectedSite;
  const planet = STATE.selectedPlanet;

  return {
    mass:           parseFloat($("pMass").value)    || 1200,
    fuel:           parseFloat($("pFuel").value)    || 100,
    thrust:         parseFloat($("pThrust").value)  || 8000,
    kp:             parseFloat($("pKp").value)      || 0.8,
    target_descent: parseFloat($("pDescent").value) || (site.safe_speed * 0.5),
    wind_std:       parseFloat($("pWind").value)    !== undefined
                      ? parseFloat($("pWind").value) : site.wind_std,
    max_time:       parseFloat($("pMaxTime").value) || 200,
    n_runs:         parseInt($("pRuns").value)       || 500,
    seed:           parseInt($("pSeed").value)       || 42,
    gravity:        site.gravity,       // always from site data
    altitude:       site.altitude,      // always from site data
    safe_speed:     site.safe_speed,    // always from site data
    vel_noise:      SENSOR_VEL,         // hardware constant (matched with app.py)
    thrust_noise:   ACTUATOR_NOISE,     // hardware constant (matched with app.py)
    bg_color:       planet.bg_color,
    terrain_color:  planet.terrain_color,
    sky_color:      planet.sky_color,
    star_density:   planet.star_density,
  };
}

/* ─────────── SIMULATION API CALL ─────────── */
async function runSimulation() {
  const btn = $("btnLaunch");
  btn.disabled = true;
  btn.querySelector(".launch-text").textContent = "SIMULATING…";

  const nRuns = parseInt($("pRuns").value) || 500;
  $("loadingSub").textContent = `Simulating ${nRuns} descent trajectories…`;
  $("loadingOverlay").classList.remove("hidden");

  try {
    const cfg = getSimConfig();
    const res = await fetch("/api/run", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(cfg),
    });

    if (!res.ok) throw new Error("API error");
    const payload = await res.json();
    STATE.lastPayload = payload;

    renderResults(payload);
    ANIM.loadTrace(payload.trace, STATE.selectedPlanet, STATE.selectedSite);
    ANIM.reset();

  } catch (err) {
    console.error("Simulation error:", err);
    alert("Simulation failed — check console.");
  } finally {
    $("loadingOverlay").classList.add("hidden");
    btn.disabled = false;
    btn.querySelector(".launch-text").textContent = "LAUNCH SIMULATION";
  }
}

/* ─────────── RESULTS RENDERING ─────────── */
/* ── Human-readable labels for breakdown outcomes ── */
const OUTCOME_META = {
  safe:         { emoji: "✅", label: "Safe landing",              cls: "safe"       },
  too_fast:     { emoji: "💥", label: "Crashed — hit too fast",    cls: "too_fast"   },
  out_of_fuel:  { emoji: "🔥", label: "Crashed — ran out of fuel", cls: "out_of_fuel"},
  time_limit:   { emoji: "⏱️", label: "Timed out mid-descent",     cls: "time_limit" },
};

function renderResults(payload) {
  const s = payload.summary;

  $("resultsEmpty").classList.add("hidden");
  $("resultsData").classList.remove("hidden");

  const safeClass = s.safe_rate >= 80 ? "success" : s.safe_rate >= 40 ? "warning" : "danger";

  // ── Split diagnosis emoji from text ──
  // The diagnosis starts with an emoji — split it off for the icon
  const diagFull = payload.diagnosis || "";
  const diagMatch = diagFull.match(/^([\u{1F000}-\u{1FFFF}⚠️❌🔥⏱️📊✅💥🎮💪🌊🛑🐌]+)\s*/u);
  const diagIcon = diagMatch ? diagMatch[1] : "📊";
  const diagText = diagFull.replace(/^[\u{1F000}-\u{1FFFF}⚠️❌🔥⏱️📊✅💥🎮💪🌊🛑🐌]+\s*/u, "");

  // ── Breakdown rows (visual bars) ──
  const breakdownRows = Object.entries(s.breakdown_pct)
    .sort((a,b) => b[1] - a[1])
    .map(([k, pct]) => {
      const meta = OUTCOME_META[k] || { emoji: "❓", label: k.replace(/_/g," "), cls: "other" };
      const count = s.breakdown[k] || 0;
      return `
        <div class="breakdown-row">
          <div class="breakdown-emoji">${meta.emoji}</div>
          <div class="breakdown-bar-wrap">
            <div class="breakdown-bar-fill ${meta.cls}" style="width:${pct}%"></div>
          </div>
          <div class="breakdown-pct">${pct}%</div>
          <div class="breakdown-label">${meta.label} &nbsp;·&nbsp; ${count} runs</div>
        </div>`;
    }).join("");

  // ── Speed row ──
  const speedHtml = s.avg_speed !== null
    ? `<div class="speed-row">
        <span class="speed-label">Avg landing speed</span>
        <span class="speed-value ${s.avg_speed <= STATE.selectedSite?.safe_speed ? 'success' : 'danger'}">${s.avg_speed} m/s</span>
        <span class="speed-sep">±</span>
        <span class="speed-value neutral">${s.std_speed} m/s</span>
        <span class="speed-threshold">Safe: ≤ ${STATE.selectedSite?.safe_speed} m/s</span>
      </div>`
    : `<div class="no-touchdown-notice">⚠️ No spacecraft reached the ground in this run. Check your parameters or click a suggestion below.</div>`;

  $("resultsData").innerHTML = `
    <div class="results-kpis">
      <div class="kpi-card kpi-safe">
        <div class="kpi-label">Safe Landing Rate</div>
        <div class="kpi-value ${safeClass}">${s.safe_rate}%</div>
        <div class="kpi-hint">Landed safely out of ${s.runs} runs</div>
      </div>
      <div class="kpi-card kpi-touch">
        <div class="kpi-label">Reached the Ground</div>
        <div class="kpi-value neutral">${s.touchdown_rate}%</div>
        <div class="kpi-hint">Touched down (safely or not)</div>
      </div>
      <div class="kpi-card kpi-fuel">
        <div class="kpi-label">Avg Fuel Remaining</div>
        <div class="kpi-value neutral">${s.avg_fuel_left} kg</div>
        <div class="kpi-hint">Left in tank at end</div>
      </div>
      <div class="kpi-card kpi-runs">
        <div class="kpi-label">Simulations Run</div>
        <div class="kpi-value neutral">${s.runs}</div>
        <div class="kpi-hint">Independent scenarios</div>
      </div>
    </div>

    <div class="diagnosis-box">
      <div class="diagnosis-icon">${diagIcon}</div>
      <div class="diagnosis-text">
        <div class="diagnosis-title">What went wrong</div>
        ${diagText}
      </div>
    </div>

    ${speedHtml}

    <div class="breakdown-section">
      <div class="breakdown-title">
        <span>OUTCOME BREAKDOWN</span>
        <span>${s.runs} total simulations</span>
      </div>
      <div class="breakdown-rows">${breakdownRows}</div>
    </div>
  `;

  const sidebar = $("suggestionsSidebar");
  const layout  = document.querySelector(".p3-layout");
  const hasSuggestions = payload.suggestions && payload.suggestions.length > 0;

  if (hasSuggestions) {
    sidebar.classList.remove("hidden");
    if (layout) layout.classList.add("with-suggestions");

    $("suggSub").textContent =
      `Each suggestion below was tested against ${payload.quick_runs} simulations — the improvement shown is real.`;

    $("suggList").innerHTML = payload.suggestions.map((sg, i) => {
      const deltaSign  = sg.delta >= 0 ? "+" : "";
      const deltaClass = sg.delta >= 0 ? "pos" : "neg";
      const isFeatured = i === 0;

      // Meter fill: show how good the estimated safe rate is (0–100%)
      const meterFill  = Math.min(sg.est_safe_rate, 100);
      const meterClass = sg.delta >= 0 ? "pos" : "neg";

      // Format the change string: if it contains "→", make the new value stand out
      const changeFormatted = sg.change_str
        ? sg.change_str
            .split(" · ")
            .map(part => {
              if (part.includes("→")) {
                const [before, after] = part.split(" → ");
                return `<span style="color:rgba(255,255,255,0.45)">${before}</span> → <strong style="color:var(--warning)">${after}</strong>`;
              }
              return part;
            })
            .join("<br>")
        : "—";

      return `
        <div class="sugg-item${isFeatured ? ' sugg-featured' : ''}">
          <div class="sugg-featured-badge">BEST FIX</div>
          <div class="sugg-head">
            <div class="sugg-num">${i + 1}</div>
            <div class="sugg-title">${sg.title}</div>
          </div>
          <div class="sugg-action">${sg.action}</div>

          ${sg.change_str ? `
          <div class="sugg-change-wrap">
            <div class="sugg-change-label">What changes</div>
            <div class="sugg-change">${changeFormatted}</div>
          </div>` : ""}

          <div class="sugg-why">${sg.why}</div>

          <div class="sugg-footer">
            <div class="sugg-meter">
              <div class="sugg-meter-label">
                <span>Success rate after fix</span>
                <span>
                  <span class="sugg-rate-val">${sg.est_safe_rate}%</span>
                  &nbsp;
                  <span class="sugg-delta-pill ${deltaClass}">${deltaSign}${sg.delta}%</span>
                </span>
              </div>
              <div class="sugg-meter-bar">
                <div class="sugg-meter-fill ${meterClass}" style="width:${meterFill}%"></div>
              </div>
            </div>
            <button class="apply-btn" data-patch='${JSON.stringify(sg.patch)}'>
              ✓ Apply
            </button>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll(".apply-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const patch = JSON.parse(btn.dataset.patch);
        applyPatch(patch);
        runSimulation();
      });
    });

  } else {
    // No suggestions — mission is already great
    sidebar.classList.remove("hidden");
    if (layout) layout.classList.add("with-suggestions");
    $("suggSub").textContent = "";
    $("suggList").innerHTML = `
      <div class="sugg-all-good">
        <div class="sugg-all-good-icon">🏆</div>
        <h4>MISSION OPTIMISED</h4>
        <p>Your safe landing rate is already excellent — no improvements needed. Try a harder site or different spacecraft!</p>
      </div>`;
  }
}

function applyPatch(patch) {
  const map = {
    fuel:           "pFuel",
    thrust:         "pThrust",
    target_descent: "pDescent",
    kp:             "pKp",
    wind_std:       "pWind",
    max_time:       "pMaxTime",
  };
  Object.entries(patch).forEach(([k, v]) => {
    const id = map[k];
    if (id) $(id).value = Math.round(v * 1000) / 1000;
  });
}


/* ═══════════════════════════════════════════
   CANVAS ANIMATION ENGINE
═══════════════════════════════════════════ */
const ANIM = (() => {
  const canvas = $("simCanvas");
  const ctx    = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  let traceRows  = [];
  let traceMeta  = {};
  let idx        = 0;
  let playing    = false;
  let lastTs     = 0;
  let missionOut = "none";
  let impactT    = 0;
  let particles  = [];
  let stars      = [];
  let planet     = null;
  let site       = null;

  // Number of base stars scaled by density from locations.json
  const BASE_STARS = 200;

  function initStars(density = 1.0) {
    stars = [];
    const n = Math.floor(BASE_STARS * density);
    for (let i = 0; i < n; i++) {
      stars.push({
        x:  Math.random() * W,
        y:  Math.random() * (H * 0.75),
        r:  Math.random() * 1.8 + 0.3,
        a:  Math.random() * 0.8 + 0.2,
        tw: Math.random() * 0.015 + 0.003,
      });
    }
  }

  function drawStars() {
    stars.forEach(s => {
      s.a += (Math.random() - 0.5) * s.tw;
      s.a = Math.max(0.15, Math.min(0.95, s.a));
      ctx.globalAlpha = s.a;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawBackground() {
    const bgColor  = planet?.bg_color  || "#080811";
    const skyColor = planet?.sky_color || "#000000";
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   bgColor);
    grad.addColorStop(0.7, skyColor + "80");
    grad.addColorStop(1,   bgColor);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // groundY is a visual layout constant — where the ground line sits in the canvas
  const groundY = Math.floor(H * 0.86);

  function drawGround() {
    const tColor = planet?.terrain_color || "#444455";
    ctx.fillStyle = tColor + "55";
    ctx.fillRect(0, groundY, W, H - groundY);

    ctx.strokeStyle = tColor + "cc";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(W, groundY);
    ctx.stroke();

    ctx.fillStyle = tColor + "33";
    for (let i = 0; i < 8; i++) {
      const cx = (i * 130 + 80) % W;
      const cy = groundY + 30 + (i % 3) * 25;
      const r  = 18 + (i % 4) * 8;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "#38bdf840";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(W / 2 - 60, groundY);
    ctx.lineTo(W / 2 + 60, groundY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#38bdf8";
    ctx.font = "12px 'Space Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("▼ LANDING ZONE ▼", W / 2, groundY - 8);
    ctx.textAlign = "left";
  }

  function drawSatellite(x, y, thr, vel, altVal) {
    const size = 50;   // satellite sprite size in pixels (visual constant)
    const tilt = Math.max(-0.2, Math.min(0.2, -vel * 0.012));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    if (thr > 0.03 && altVal > 0) {
      const fh = 15 + 60 * thr;
      const fGrad = ctx.createLinearGradient(0, size / 2, 0, size / 2 + fh);
      fGrad.addColorStop(0,   "rgba(255,200,80,0.9)");
      fGrad.addColorStop(0.5, "rgba(255,100,40,0.7)");
      fGrad.addColorStop(1,   "rgba(255,50,0,0)");
      ctx.fillStyle = fGrad;
      ctx.beginPath();
      ctx.moveTo(-10, size / 2);
      ctx.lineTo(10,  size / 2);
      ctx.lineTo(0,   size / 2 + fh);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = "#d0daea";
    ctx.beginPath();
    ctx.roundRect(-size / 3, -size / 2, size * 0.67, size, 8);
    ctx.fill();

    ctx.fillStyle = "#1a4a8a";
    ctx.fillRect(-size * 0.9, -size / 5, size * 0.55, size / 2.5);
    ctx.fillRect(size / 3,    -size / 5, size * 0.55, size / 2.5);

    ctx.strokeStyle = "#3a8aca44";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-size * 0.9 + i * size * 0.55 / 4, -size / 5);
      ctx.lineTo(-size * 0.9 + i * size * 0.55 / 4, -size / 5 + size / 2.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(size / 3 + i * size * 0.55 / 4, -size / 5);
      ctx.lineTo(size / 3 + i * size * 0.55 / 4, -size / 5 + size / 2.5);
      ctx.stroke();
    }

    ctx.fillStyle = "#60c0ff";
    ctx.beginPath();
    ctx.ellipse(0, -size / 6, 8, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#a0e0ff44";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "#999";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -size / 2);
    ctx.lineTo(0, -size * 0.85);
    ctx.stroke();
    ctx.fillStyle = "#f87171";
    ctx.beginPath();
    ctx.arc(0, -size * 0.85, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#aaa";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-size / 3, size / 2 - 2);
    ctx.lineTo(-size / 3 - 14, size / 2 + 16);
    ctx.moveTo(size / 3,  size / 2 - 2);
    ctx.lineTo(size / 3 + 14, size / 2 + 16);
    ctx.stroke();

    ctx.restore();
  }

  function spawnParticles(x, y, outcome) {
    const n = outcome === "safe" ? 80 : 120;
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 1;
      particles.push({
        x, y,
        vx:   Math.cos(angle) * speed,
        vy:  -Math.random() * 6 - 1,
        life: 50 + Math.random() * 40,
        color: outcome === "safe"
          ? `hsl(${140 + Math.random() * 30},80%,60%)`
          : `hsl(${20  + Math.random() * 30},90%,60%)`,
        r: Math.random() * 4 + 1,
      });
    }
  }

  function updateParticles() {
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.18;
      p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life / 40);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawFrame(row) {
    ctx.clearRect(0, 0, W, H);
    drawBackground();
    drawStars();
    drawGround();
    if (!row) return;

    const [t, alt, fuel, vel, thr] = row;
    const alt0  = traceMeta.initial_altitude_m || 500;
    const topM  = 50;
    const botM  = 80;
    const usable = (groundY - botM) - topM;
    const a     = Math.max(-30, Math.min(alt0, alt));
    const y     = topM + (1 - a / alt0) * usable;
    const x     = W * 0.5;

    const shadowAlpha = 0.4 - (alt / alt0) * 0.3;
    ctx.globalAlpha = Math.max(0.05, shadowAlpha);
    ctx.fillStyle = "#000";
    const sSize = 60 * (1 - alt / alt0) + 15;
    ctx.beginPath();
    ctx.ellipse(x, groundY + 12, sSize, sSize * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    drawSatellite(x, y, thr, vel, alt);
    updateParticles();

    if (alt <= 0) {
      if (missionOut === "safe") {
        ctx.save();
        ctx.fillStyle = "rgba(52,211,153,0.15)";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#34d399";
        ctx.font = "bold 42px 'Orbitron', monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = "#34d399";
        ctx.shadowBlur = 20;
        ctx.fillText("✅ SAFE LANDING", W / 2, H / 2);
        ctx.restore();
      } else {
        impactT += 0.12;
        ctx.fillStyle = `rgba(239,68,68,${Math.min(0.3, impactT / 10)})`;
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.fillStyle = "#f87171";
        ctx.font = "bold 42px 'Orbitron', monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = "#f87171";
        ctx.shadowBlur = 20;
        ctx.fillText("❌ CRASH", W / 2, H / 2);
        ctx.restore();
      }
    }

    updateHUD(t, alt, vel, fuel, thr);
    updateWarnings(alt, vel, fuel);
    ctx.textAlign = "left";
  }

  function updateHUD(t, alt, vel, fuel, thr) {
    $("hudTime").textContent  = `${t.toFixed(1)} s`;
    $("hudAlt").textContent   = `${Math.max(0, alt).toFixed(1)} m`;
    $("hudVel").textContent   = `${vel.toFixed(2)} m/s`;
    $("hudFuel").textContent  = `${Math.max(0, fuel).toFixed(1)} kg`;
    $("hudThr").textContent   = thr.toFixed(3);

    const st = $("hudStatus");
    if (playing && alt > 0) {
      st.textContent = "IN FLIGHT"; st.style.color = "#38bdf8";
    } else if (alt <= 0) {
      if (missionOut === "safe") { st.textContent = "LANDED ✅"; st.style.color = "#34d399"; }
      else                       { st.textContent = "CRASHED ❌"; st.style.color = "#f87171"; }
    } else {
      st.textContent = "READY"; st.style.color = "#94a3b8";
    }
  }

  function updateWarnings(alt, vel, fuel) {
    const ov = $("warningOverlay");
    const w  = [];
    const f  = Math.max(0, fuel);
    const a  = Math.max(0, alt);

    if (f < 20 && a > 100) w.push(`<div class="warn-badge caution">⚠️ FUEL LOW</div>`);
    if (f < 5  && a > 50)  w.push(`<div class="warn-badge danger">🔥 FUEL CRITICAL</div>`);
    if (Math.abs(vel) > 7 && a < 200) w.push(`<div class="warn-badge caution">⚠️ HIGH SPEED</div>`);
    if (Math.abs(vel) > 5 && a < 100) w.push(`<div class="warn-badge danger">⚠️ EXCESSIVE DESCENT RATE</div>`);

    ov.innerHTML = w.join("");
  }

  // Animation playback speed: advance this many trace rows per millisecond of real time.
  // Derived so that the animation plays at roughly real-time speed:
  //   advance_rate = 1 / (SIM_DT * 1000)  frames per ms
  //   = 1 / (0.1 * 1000) = 0.01 → but we accelerate by 6× for watchability
  const ANIM_SPEED = 1 / (SIM_DT * 1000) * 6;   // ~6× real-time

  function step(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dtMs = ts - lastTs;
    lastTs = ts;

    const advance = Math.max(1, Math.floor(dtMs * ANIM_SPEED));
    idx = Math.min(idx + advance, traceRows.length - 1);

    drawFrame(traceRows[idx]);

    if (idx >= traceRows.length - 1) {
      playing = false;
      if (particles.length === 0) spawnParticles(W / 2, groundY, missionOut);
      return;
    }
    requestAnimationFrame(step);
  }

  function drawIdleScene(p, s) {
    planet = p;
    site   = s;
    initStars(p?.star_density ?? 1);
    ctx.clearRect(0, 0, W, H);
    drawBackground();
    drawStars();
    drawGround();
    drawSatellite(W / 2, groundY - 60, 0, 0, 1);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(200,220,255,0.4)";
    ctx.font = "13px 'Space Mono',monospace";
    ctx.fillText("CONFIGURE MISSION → LAUNCH SIMULATION", W / 2, H - 20);
    ctx.textAlign = "left";
  }

  return {
    loadTrace(tracePayload, p, s) {
      planet     = p;
      site       = s;
      traceMeta  = { initial_altitude_m: tracePayload.initial_altitude_m };
      missionOut = tracePayload.outcome || "none";
      traceRows  = tracePayload.rows    || [];
      impactT    = 0;
      particles  = [];
      initStars(p?.star_density ?? 1);
    },
    reset() {
      playing   = false;
      idx       = 0;
      lastTs    = 0;
      impactT   = 0;
      particles = [];
      if (traceRows.length > 0) drawFrame(traceRows[0]);
    },
    play()  { if (!traceRows.length) return; playing = true; requestAnimationFrame(step); },
    pause() { playing = false; },
    drawIdleScene(p, s) { drawIdleScene(p, s); },
  };
})();


/* ─────────── BUTTON WIRING ─────────── */
$("btnPlay").addEventListener("click",   () => ANIM.play());
$("btnPause").addEventListener("click",  () => ANIM.pause());
$("btnReset").addEventListener("click",  () => ANIM.reset());
$("btnNewRun").addEventListener("click", () => {
  $("pSeed").value = (parseInt($("pSeed").value) || 42) + 1;
  runSimulation();
});
$("btnLaunch").addEventListener("click", runSimulation);
$("backToP1").addEventListener("click",  () => showPage(1));
$("backToP2").addEventListener("click",  () => showPage(2));


/* ─────────── INIT ─────────── */
initPage1();