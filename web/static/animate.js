const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");

// UI
const stTime = document.getElementById("stTime");
const stAlt  = document.getElementById("stAlt");
const stVel  = document.getElementById("stVel");
const stFuel = document.getElementById("stFuel");
const stThr  = document.getElementById("stThr");
const outcomeText = document.getElementById("outcomeText");
const outcomeMeta = document.getElementById("outcomeMeta");

const btnPlay = document.getElementById("btnPlay");
const btnPause = document.getElementById("btnPause");
const btnRestart = document.getElementById("btnRestart");
const speedSlider = document.getElementById("speed");
const speedVal = document.getElementById("speedVal");

let trace = null;
let meta = null;

let idx = 0;
let playing = false;
let speed = 1.0;

// Scene constants
const W = canvas.width;
const H = canvas.height;

const groundY = Math.floor(H * 0.82);
const horizonY = Math.floor(H * 0.55);

let stars = [];
let dust = []; // particles on touchdown
let shakeT = 0;

// Create stars once
function initStars() {
  stars = [];
  const n = 220;
  for (let i = 0; i < n; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * (groundY - 40),
      r: Math.random() * 1.8 + 0.2,
      a: Math.random() * 0.8 + 0.2,
      tw: Math.random() * 0.02 + 0.005
    });
  }
}

function lerp(a,b,t){ return a + (b-a)*t; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

function format(num, digits=2) {
  if (typeof num !== "number" || Number.isNaN(num)) return "—";
  return num.toFixed(digits);
}

function computeOutcomeLabel(outcome) {
  if (outcome === "safe") return "SAFE LANDING ✅";
  if (outcome === "crash_too_fast") return "CRASH ❌ (Too fast)";
  return "NOT LANDED";
}

// Map altitude -> screen Y (higher altitude = higher on screen)
function altitudeToY(alt) {
  const h0 = meta.initial_altitude_m || 1000;
  const t = clamp(alt / h0, 0, 1);
  // when t=1 => high up near top; when t=0 => ground
  return lerp(80, groundY - 35, 1 - t);
}

// Lander drawing
function drawLander(x, y, throttle, vel) {
  // Body
  const bodyW = 32, bodyH = 42;
  const leg = 16;

  // Engine flame depends on throttle
  if (throttle > 0.02) {
    const flameH = 10 + throttle * 38;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x, y + bodyH/2);
    ctx.lineTo(x - 8, y + bodyH/2 + flameH);
    ctx.lineTo(x + 8, y + bodyH/2 + flameH);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,190,90,0.9)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x, y + bodyH/2);
    ctx.lineTo(x - 5, y + bodyH/2 + flameH*0.7);
    ctx.lineTo(x + 5, y + bodyH/2 + flameH*0.7);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,80,40,0.9)";
    ctx.fill();
    ctx.restore();
  }

  // Slight tilt based on vertical velocity (tiny)
  const tilt = clamp((-vel) * 0.01, -0.18, 0.18);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);

  // legs
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-bodyW/2, bodyH/2 - 2);
  ctx.lineTo(-bodyW/2 - leg, bodyH/2 + leg);
  ctx.moveTo(bodyW/2, bodyH/2 - 2);
  ctx.lineTo(bodyW/2 + leg, bodyH/2 + leg);
  ctx.stroke();

  // body
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, -bodyW/2, -bodyH/2, bodyW, bodyH, 10);
  ctx.fill();

  // window
  ctx.fillStyle = "rgba(120,200,255,0.8)";
  roundRect(ctx, -8, -10, 16, 14, 6);
  ctx.fill();

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Moon surface
function drawMoon() {
  // subtle horizon glow
  const grd = ctx.createLinearGradient(0, 0, 0, groundY);
  grd.addColorStop(0, "rgba(110,140,255,0.08)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, groundY);

  // ground
  ctx.fillStyle = "rgba(210,210,220,0.16)";
  ctx.fillRect(0, groundY, W, H - groundY);

  // craters
  for (let i = 0; i < 10; i++) {
    const x = (i * 110 + 60) % W;
    const y = groundY + 35 + (i % 3) * 28;
    const r = 24 + (i % 4) * 6;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.10)";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x - 6, y - 3, r * 0.65, r * 0.38, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
  }

  // ground line
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(W, groundY);
  ctx.stroke();
}

// Stars
function drawStars() {
  for (const s of stars) {
    s.a += (Math.random() - 0.5) * s.tw;
    s.a = clamp(s.a, 0.15, 0.95);
    ctx.globalAlpha = s.a;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;
}

// particles on touchdown
function spawnDust(x, y, count, kind) {
  for (let i=0; i<count; i++) {
    dust.push({
      x, y,
      vx: (Math.random() - 0.5) * 4.0,
      vy: -Math.random() * 3.8 - 1.2,
      life: 40 + Math.random() * 30,
      kind
    });
  }
}

function drawDust() {
  const next = [];
  for (const p of dust) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12; // gravity-ish
    p.life -= 1;

    if (p.life > 0) {
      next.push(p);
      ctx.globalAlpha = clamp(p.life / 70, 0, 1);
      ctx.fillStyle = (p.kind === "safe")
        ? "rgba(160,255,200,0.9)"
        : "rgba(255,210,140,0.9)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  }
  dust = next;
}

function applyShake() {
  if (shakeT <= 0) return {dx:0, dy:0};
  shakeT -= 1;
  return {
    dx: (Math.random() - 0.5) * 10,
    dy: (Math.random() - 0.5) * 8
  };
}

function updateStats(i) {
  stTime.textContent = `${format(trace.time_s[i], 1)} s`;
  stAlt.textContent = `${format(trace.altitude_m[i], 2)} m`;
  stVel.textContent = `${format(trace.velocity_mps[i], 2)} m/s`;
  stFuel.textContent = `${format(trace.fuel_kg[i], 2)} kg`;
  stThr.textContent = `${format(trace.throttle[i], 3)}`;
}

function drawUIBadges() {
  // small HUD line
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  roundRect(ctx, 18, 18, 290, 44, 14);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "14px ui-sans-serif, system-ui";
  ctx.fillText(`Safe speed ≤ ${format(meta.safe_speed_mps,2)} m/s`, 32, 46);

  ctx.restore();
}

function drawScene() {
  // background
  ctx.clearRect(0, 0, W, H);

  // shake on crash
  const {dx, dy} = applyShake();
  ctx.save();
  ctx.translate(dx, dy);

  drawStars();
  drawMoon();

  // lander x fixed mid
  const x = Math.floor(W * 0.5);

  // current state
  const alt = trace.altitude_m[idx];
  const vel = trace.velocity_mps[idx];
  const thr = trace.throttle[idx];

  const y = altitudeToY(Math.max(alt, 0));

  // shadow
  const sh = clamp(1 - (alt / (meta.initial_altitude_m || 1000)), 0, 1);
  ctx.globalAlpha = 0.25 + sh * 0.35;
  ctx.beginPath();
  ctx.ellipse(x, groundY + 18, 30 * sh + 8, 10 * sh + 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fill();
  ctx.globalAlpha = 1.0;

  drawLander(x, y, thr, vel);
  drawDust();
  drawUIBadges();

  ctx.restore();

  // banner on end
  if (!playing && idx >= trace.time_s.length - 1) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(ctx, W/2 - 240, 90, 480, 70, 18);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "22px ui-sans-serif, system-ui";
    ctx.fillText(computeOutcomeLabel(meta.outcome), W/2 - 210, 134);
    ctx.restore();
  }
}

let lastFrameTs = 0;
function tick(ts) {
  if (!trace || !meta) {
    requestAnimationFrame(tick);
    return;
  }

  const dtMs = ts - lastFrameTs;
  lastFrameTs = ts;

  if (playing) {
    // Advance index based on speed and frame time (approx)
    const step = Math.max(1, Math.floor(speed));
    // Use dtMs to keep stable at different refresh rates
    const extra = dtMs > 25 ? 2 : 1;
    idx = Math.min(idx + step * extra, trace.time_s.length - 1);

    if (idx >= trace.time_s.length - 1) {
      playing = false;
      // touchdown effect
      const kind = meta.outcome === "safe" ? "safe" : "crash";
      spawnDust(W*0.5, groundY + 10, meta.outcome === "safe" ? 120 : 180, kind);
      if (meta.outcome !== "safe") shakeT = 20;
    }
  }

  updateStats(idx);
  drawScene();

  requestAnimationFrame(tick);
}

function setOutcomeText() {
  outcomeText.textContent = computeOutcomeLabel(meta.outcome);
  outcomeMeta.textContent =
    `Landing speed: ${format(meta.landing_speed_mps, 3)} m/s | Safe threshold: ≤ ${format(meta.safe_speed_mps,2)} m/s`;
}

function bindUI() {
  btnPlay.onclick = () => { playing = true; };
  btnPause.onclick = () => { playing = false; };
  btnRestart.onclick = () => {
    playing = false;
    idx = 0;
    dust = [];
    shakeT = 0;
    setOutcomeText();
  };

  speedSlider.oninput = (e) => {
    speed = Number(e.target.value);
    speedVal.textContent = `${speed.toFixed(1)}×`;
  };
}

async function loadData() {
  const res = await fetch("/api/trace");
  if (!res.ok) {
    const err = await res.json();
    outcomeText.textContent = "Missing data ❌";
    outcomeMeta.textContent = err.error || "Run simulation first.";
    return;
  }
  const payload = await res.json();
  trace = payload.trace;
  meta = payload.meta;

  initStars();
  bindUI();
  setOutcomeText();

  // Start paused at beginning; user hits Play
  idx = 0;
  playing = false;
}

loadData();
requestAnimationFrame(tick);
