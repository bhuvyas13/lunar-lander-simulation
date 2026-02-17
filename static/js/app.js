/* ═══════════════════════════════════════════
   SATELLITE LANDING MISSION PLANNER — APP.JS
═══════════════════════════════════════════ */

"use strict";

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
  selectedPlanet:   null,   // planet data object
  selectedSite:     null,   // site data object
  spacecraft:       null,   // spacecraft data object (selected)
  spacecraftList:   [],     // spacecraft available for planet
  lastPayload:      null,   // last simulation result
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

  // Populate header
  $("p2PlanetEmoji").textContent = planet.emoji;
  $("p2PlanetName").textContent  = planet.name.toUpperCase();

  // Planet orb
  const orb = $("p2PlanetOrb");
  orb.style.setProperty("--orb-color",  planet.color);
  orb.style.setProperty("--orb-glow", `${planet.accent}66`);

  // Stats
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

  // Sites list
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
      if (site.impossible) {
        showImpossibleModal(site);
      } else {
        selectSiteAndGoP3(site);
      }
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
  const site    = STATE.selectedSite;
  const planet  = STATE.selectedPlanet;
  const sc      = STATE.spacecraftList;

  // Badge
  $("badgeSite").textContent = `${planet.emoji} ${planet.name} — ${site.name}`;

  // Spacecraft cards
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

  // Set first spacecraft as default
  if (sc.length > 0) {
    STATE.spacecraft = sc[0];
  }

  // Populate params
  populateParams(STATE.spacecraft || makeFallbackSC(planet), site, planet);

  // Canvas setup
  ANIM.reset();
  ANIM.drawIdleScene(planet, site);  // ← FIXED: use ANIM.drawIdleScene
}

function makeFallbackSC(planet) {
  return { mass_kg: 1200, fuel_kg: 100, thrust_n: 8000, kp: 0.8 };
}

function populateParams(sc, site, planet) {
  if (!sc) return;
  $("pMass").value    = sc ? sc.mass_kg    : 1200;
  $("pFuel").value    = sc ? sc.fuel_kg    : 100;
  $("pThrust").value  = sc ? sc.thrust_n   : 8000;
  $("pKp").value      = sc ? sc.kp         : 0.8;
  $("pDescent").value = 3.5;
  $("pWind").value    = site.wind_std;
  $("pMaxTime").value = Math.max(100, Math.ceil(site.altitude / 3.5 * 1.5 / 10) * 10);
}

function getSimConfig() {
  const site   = STATE.selectedSite;
  const planet = STATE.selectedPlanet;
  return {
    mass:           parseFloat($("pMass").value)    || 1200,
    fuel:           parseFloat($("pFuel").value)    || 100,
    thrust:         parseFloat($("pThrust").value)  || 8000,
    kp:             parseFloat($("pKp").value)      || 0.8,
    target_descent: parseFloat($("pDescent").value) || 3.5,
    wind_std:       parseFloat($("pWind").value)    || 0.12,
    max_time:       parseFloat($("pMaxTime").value) || 200,
    n_runs:         parseInt($("pRuns").value)       || 500,
    seed:           parseInt($("pSeed").value)       || 42,
    gravity:        site.gravity,
    altitude:       site.altitude,
    safe_speed:     site.safe_speed,
    vel_noise:      0.08,
    thrust_noise:   0.02,
    // Pass planet visuals
    bg_color:      planet.bg_color,
    terrain_color: planet.terrain_color,
    sky_color:     planet.sky_color,
    star_density:  planet.star_density,
  };
}

/* ─────────── SIMULATION API CALL ─────────── */
async function runSimulation() {
  const btn = $("btnLaunch");
  btn.disabled = true;
  btn.querySelector(".launch-text").textContent = "SIMULATING…";

  // Show loading overlay
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
function renderResults(payload) {
  const s = payload.summary;

  $("resultsEmpty").classList.add("hidden");
  $("resultsData").classList.remove("hidden");

  const safeClass = s.safe_rate >= 80 ? "success" : s.safe_rate >= 40 ? "warning" : "danger";

  $("resultsData").innerHTML = `
    <div class="results-kpis">
      <div class="kpi-card">
        <div class="kpi-label">Safe Landing Rate</div>
        <div class="kpi-value ${safeClass}">${s.safe_rate}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Touchdown Rate</div>
        <div class="kpi-value">${s.touchdown_rate}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Runs</div>
        <div class="kpi-value">${s.runs}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Fuel Left</div>
        <div class="kpi-value">${s.avg_fuel_left} kg</div>
      </div>
    </div>

    <div class="diagnosis-box">${payload.diagnosis}</div>

    ${s.avg_speed !== null ? `
      <p style="font-family:var(--font-mono);font-size:0.8125rem;color:var(--muted);margin-bottom:1rem">
        Landing speed: <strong style="color:var(--text)">${s.avg_speed} ± ${s.std_speed} m/s</strong>
        &nbsp;|&nbsp; Safe threshold: ≤ ${STATE.selectedSite?.safe_speed} m/s
      </p>` : `
      <p style="color:var(--warning);font-size:0.875rem;margin-bottom:1rem">⚠️ No successful touchdowns in this run.</p>`}

    <table class="breakdown-table">
      <thead><tr><th>Outcome</th><th>Count</th><th>%</th></tr></thead>
      <tbody>
        ${Object.entries(s.breakdown_pct).sort((a,b)=>b[1]-a[1]).map(([k,v]) => {
          const emojis = {safe:"✅",too_fast:"⚠️",out_of_fuel:"🔥",time_limit:"⏱️"};
          return `<tr><td>${emojis[k]||"?"} ${k.replace(/_/g," ")}</td>
                      <td>${s.breakdown[k]}</td>
                      <td><strong>${v}%</strong></td></tr>`;
        }).join("")}
      </tbody>
    </table>
  `;

  // Suggestions
  if (payload.suggestions && payload.suggestions.length > 0) {
    const sidebar = $("suggestionsSidebar");
    sidebar.classList.remove("hidden");
    const layout = document.querySelector(".p3-layout");
    if (layout) layout.classList.add("with-suggestions");

    $("suggSub").textContent = `Each suggestion tested with ${payload.quick_runs} MC runs`;
    $("suggList").innerHTML = payload.suggestions.map((s, i) => `
      <div class="sugg-item">
        <div class="sugg-rank-row">
          <div class="sugg-rank">${i+1}</div>
          <div class="sugg-label">${s.label}</div>
        </div>
        <div class="sugg-delta">
          Est. ${s.est_safe_rate}%
          <span class="${s.delta>=0?'pos':'neg'}">(${s.delta>=0?'+':''}${s.delta}%)</span>
        </div>
        <button class="apply-btn" data-patch='${JSON.stringify(s.patch)}'>
          APPLY THIS CHANGE
        </button>
      </div>
    `).join("");

    // Wire apply buttons
    document.querySelectorAll(".apply-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const patch = JSON.parse(btn.dataset.patch);
        applyPatch(patch);
        runSimulation();
      });
    });
  }
}

function applyPatch(patch) {
  const map = {
    fuel:           "pFuel",
    thrust:         "pThrust",
    target_descent: "pDescent",
    kp:             "pKp",
    wind_std:       "pWind",
    vel_noise:      null,
    max_time:       "pMaxTime",
    safe_speed:     null,
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

  // ── STARS ──
  function initStars(density=1.0) {
    stars = [];
    const n = Math.floor(200 * density);
    for (let i=0; i<n; i++) {
      stars.push({
        x: Math.random()*W,
        y: Math.random()*(H*0.75),
        r: Math.random()*1.8+0.3,
        a: Math.random()*0.8+0.2,
        tw: Math.random()*0.015+0.003,
      });
    }
  }

  function drawStars() {
    stars.forEach(s => {
      s.a += (Math.random()-0.5)*s.tw;
      s.a = Math.max(0.15, Math.min(0.95, s.a));
      ctx.globalAlpha = s.a;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // ── BACKGROUND ──
  function drawBackground() {
    const bgColor  = planet?.bg_color     || "#080811";
    const skyColor = planet?.sky_color    || "#000000";

    // Sky gradient
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, bgColor);
    grad.addColorStop(0.7, skyColor + "80");
    grad.addColorStop(1, bgColor);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  const groundY = Math.floor(H * 0.86);

  // ── GROUND ──
  function drawGround() {
    const tColor = planet?.terrain_color || "#444455";

    ctx.fillStyle = tColor + "55";
    ctx.fillRect(0, groundY, W, H-groundY);

    // Ground line
    ctx.strokeStyle = tColor + "cc";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(W, groundY);
    ctx.stroke();

    // Craters / features (simple decorative)
    ctx.fillStyle = tColor + "33";
    for (let i=0; i<8; i++) {
      const cx = (i*130+80)%W;
      const cy = groundY + 30 + (i%3)*25;
      const r  = 18+(i%4)*8;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r*0.5, 0, 0, Math.PI*2);
      ctx.fill();
    }

    // Landing pad marker
    ctx.strokeStyle = "#38bdf840";
    ctx.lineWidth = 1;
    ctx.setLineDash([6,4]);
    ctx.beginPath();
    ctx.moveTo(W/2-60, groundY);
    ctx.lineTo(W/2+60, groundY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#38bdf8";
    ctx.font = "12px 'Space Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("▼ LANDING ZONE ▼", W/2, groundY-8);
    ctx.textAlign = "left";
  }

  // ── SATELLITE ──
  function drawSatellite(x, y, thr, vel, altVal) {
    const size = 50;
    const tilt = Math.max(-0.2, Math.min(0.2, -vel*0.012));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    // Thruster flame
    if (thr > 0.03 && altVal > 0) {
      const fh = 15 + 60*thr;
      const fGrad = ctx.createLinearGradient(0, size/2, 0, size/2+fh);
      fGrad.addColorStop(0, "rgba(255,200,80,0.9)");
      fGrad.addColorStop(0.5, "rgba(255,100,40,0.7)");
      fGrad.addColorStop(1, "rgba(255,50,0,0)");

      ctx.fillStyle = fGrad;
      ctx.beginPath();
      ctx.moveTo(-10, size/2);
      ctx.lineTo(10, size/2);
      ctx.lineTo(0, size/2+fh);
      ctx.closePath();
      ctx.fill();
    }

    // Body — sleek spacecraft shape
    ctx.fillStyle = "#d0daea";
    ctx.beginPath();
    ctx.roundRect(-size/3, -size/2, size*0.67, size, 8);
    ctx.fill();

    // Solar panels
    ctx.fillStyle = "#1a4a8a";
    // Left
    ctx.fillRect(-size*0.9, -size/5, size*0.55, size/2.5);
    // Right
    ctx.fillRect(size/3, -size/5, size*0.55, size/2.5);

    // Panel lines
    ctx.strokeStyle = "#3a8aca44";
    ctx.lineWidth = 1;
    for (let i=1; i<4; i++) {
      ctx.beginPath();
      ctx.moveTo(-size*0.9 + i*size*0.55/4, -size/5);
      ctx.lineTo(-size*0.9 + i*size*0.55/4, -size/5 + size/2.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(size/3 + i*size*0.55/4, -size/5);
      ctx.lineTo(size/3 + i*size*0.55/4, -size/5 + size/2.5);
      ctx.stroke();
    }

    // Window
    ctx.fillStyle = "#60c0ff";
    ctx.beginPath();
    ctx.ellipse(0, -size/6, 8, 7, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = "#a0e0ff44";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Antenna
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -size/2);
    ctx.lineTo(0, -size*0.85);
    ctx.stroke();
    ctx.fillStyle = "#f87171";
    ctx.beginPath();
    ctx.arc(0, -size*0.85, 3, 0, Math.PI*2);
    ctx.fill();

    // Landing legs
    ctx.strokeStyle = "#aaa";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-size/3, size/2-2);
    ctx.lineTo(-size/3-14, size/2+16);
    ctx.moveTo(size/3, size/2-2);
    ctx.lineTo(size/3+14, size/2+16);
    ctx.stroke();

    ctx.restore();
  }

  // ── PARTICLES ──
  function spawnParticles(x, y, outcome) {
    const n = outcome==="safe" ? 80 : 120;
    for (let i=0; i<n; i++) {
      const angle = Math.random()*Math.PI*2;
      const speed = Math.random()*5+1;
      particles.push({
        x, y,
        vx: Math.cos(angle)*speed,
        vy: -Math.random()*6-1,
        life: 50+Math.random()*40,
        color: outcome==="safe" ? `hsl(${140+Math.random()*30},80%,60%)` : `hsl(${20+Math.random()*30},90%,60%)`,
        r: Math.random()*4+1,
      });
    }
  }

  function updateParticles() {
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18;
      p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life/40);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // ── FULL FRAME ──
  function drawFrame(row) {
    ctx.clearRect(0,0,W,H);
    drawBackground();
    drawStars();
    drawGround();

    if (!row) return;

    const [t, alt, fuel, vel, thr] = row;
    const alt0 = traceMeta.initial_altitude_m || 500;

    const topM    = 50;
    const bottomM = 80;
    const usable  = (groundY - bottomM) - topM;
    const a       = Math.max(-30, Math.min(alt0, alt));
    const y       = topM + (1 - a/alt0) * usable;
    const x       = W * 0.5;

    // Shadow
    const shadowAlpha = 0.4 - (alt/alt0)*0.3;
    ctx.globalAlpha = Math.max(0.05, shadowAlpha);
    ctx.fillStyle = "#000";
    const sSize = 60*(1-alt/alt0)+15;
    ctx.beginPath();
    ctx.ellipse(x, groundY+12, sSize, sSize*0.3, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

    drawSatellite(x, y, thr, vel, alt);
    updateParticles();

    // Impact overlays
    if (alt <= 0) {
      if (missionOut === "safe") {
        ctx.save();
        ctx.fillStyle = "rgba(52,211,153,0.15)";
        ctx.fillRect(0,0,W,H);
        ctx.fillStyle = "#34d399";
        ctx.font = "bold 42px 'Orbitron', monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = "#34d399";
        ctx.shadowBlur = 20;
        ctx.fillText("✅ SAFE LANDING", W/2, H/2);
        ctx.restore();
      } else {
        impactT += 0.12;
        ctx.fillStyle = `rgba(239,68,68,${Math.min(0.3, impactT/10)})`;
        ctx.fillRect(0,0,W,H);
        ctx.save();
        ctx.fillStyle = "#f87171";
        ctx.font = "bold 42px 'Orbitron', monospace";
        ctx.textAlign = "center";
        ctx.shadowColor = "#f87171";
        ctx.shadowBlur = 20;
        ctx.fillText("❌ CRASH", W/2, H/2);
        ctx.restore();
      }
    }

    // HUD
    updateHUD(t, alt, vel, fuel, thr);
    updateWarnings(alt, vel, fuel);

    ctx.textAlign = "left";
  }

  // ── HUD UPDATE ──
  function updateHUD(t, alt, vel, fuel, thr) {
    $("hudTime").textContent  = `${t.toFixed(1)} s`;
    $("hudAlt").textContent   = `${Math.max(0,alt).toFixed(1)} m`;
    $("hudVel").textContent   = `${vel.toFixed(2)} m/s`;
    $("hudFuel").textContent  = `${Math.max(0,fuel).toFixed(1)} kg`;
    $("hudThr").textContent   = thr.toFixed(3);

    const st = $("hudStatus");
    if (playing && alt > 0) {
      st.textContent = "IN FLIGHT"; st.style.color = "#38bdf8";
    } else if (alt <= 0) {
      if (missionOut==="safe") { st.textContent="LANDED ✅"; st.style.color="#34d399"; }
      else                     { st.textContent="CRASHED ❌"; st.style.color="#f87171"; }
    } else {
      st.textContent="READY"; st.style.color="#94a3b8";
    }
  }

  function updateWarnings(alt, vel, fuel) {
    const ov = $("warningOverlay");
    const w = [];
    const f = Math.max(0, fuel);
    const a = Math.max(0, alt);

    if (f < 20 && a > 100) w.push(`<div class="warn-badge caution">⚠️ FUEL LOW</div>`);
    if (f < 5  && a > 50)  w.push(`<div class="warn-badge danger">🔥 FUEL CRITICAL</div>`);
    if (Math.abs(vel) > 7 && a < 200) w.push(`<div class="warn-badge caution">⚠️ HIGH SPEED</div>`);
    if (Math.abs(vel) > 5 && a < 100) w.push(`<div class="warn-badge danger">⚠️ EXCESSIVE DESCENT RATE</div>`);

    ov.innerHTML = w.join("");
  }

  // ── ANIMATION LOOP ──
  function step(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dtMs = ts - lastTs;
    lastTs = ts;

    const advance = Math.max(1, Math.floor(dtMs * 0.06));
    idx = Math.min(idx + advance, traceRows.length-1);

    drawFrame(traceRows[idx]);

    if (idx >= traceRows.length-1) {
      playing = false;
      if (particles.length === 0) {
        spawnParticles(W/2, groundY, missionOut);
      }
      return;
    }
    requestAnimationFrame(step);
  }

  // ── IDLE SCENE ──
  function drawIdleScene(p, s) {
    planet = p;
    site   = s;
    initStars(p?.star_density ?? 1);
    ctx.clearRect(0,0,W,H);
    drawBackground();
    drawStars();
    drawGround();
    // Draw parked satellite
    drawSatellite(W/2, groundY-60, 0, 0, 1);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(200,220,255,0.4)";
    ctx.font = "13px 'Space Mono',monospace";
    ctx.fillText("CONFIGURE MISSION → LAUNCH SIMULATION", W/2, H-20);
    ctx.textAlign = "left";
  }

  // ── PUBLIC INTERFACE ──
  return {
    loadTrace(tracePayload, p, s) {
      planet     = p;
      site       = s;
      traceMeta  = { initial_altitude_m: tracePayload.initial_altitude_m };
      missionOut = tracePayload.outcome || "none";
      traceRows  = tracePayload.rows || [];
      impactT    = 0;
      particles  = [];
      initStars(p?.star_density ?? 1);
    },
    reset() {
      playing = false;
      idx     = 0;
      lastTs  = 0;
      impactT = 0;
      particles = [];
      if (traceRows.length > 0) {
        drawFrame(traceRows[0]);
      }
    },
    play() {
      if (!traceRows.length) return;
      playing = true;
      requestAnimationFrame(step);
    },
    pause() { playing = false; },
    drawIdleScene(p, s) { drawIdleScene(p, s); },  // ← EXPOSED to public
  };
})();


/* ─────────── BUTTON WIRING ─────────── */
$("btnPlay").addEventListener("click",    () => ANIM.play());
$("btnPause").addEventListener("click",   () => ANIM.pause());
$("btnReset").addEventListener("click",   () => ANIM.reset());
$("btnNewRun").addEventListener("click",  () => {
  $("pSeed").value = (parseInt($("pSeed").value)||42) + 1;
  runSimulation();
});
$("btnLaunch").addEventListener("click",  runSimulation);
$("backToP1").addEventListener("click",   () => showPage(1));
$("backToP2").addEventListener("click",   () => showPage(2));


/* ─────────── INIT ─────────── */
initPage1();