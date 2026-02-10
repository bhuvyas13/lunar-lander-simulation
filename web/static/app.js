/* ========================================
   SATELLITE LANDING SIMULATOR - APP LOGIC
   ======================================== */

   const ids = [
    "site", "n_runs", "seed", "fuel_kg", "max_thrust_newton",
    "target_descent_rate_mps", "kp", "wind_accel_std_mps2",
    "vel_sensor_std_mps", "thrust_rel_std", "max_time_seconds", "safe_landing_speed_mps"
  ];
  
  function $(id) { return document.getElementById(id); }
  
  function getState() {
    const s = {};
    ids.forEach(id => {
      const el = $(id) || document.querySelector(`input[name="${id}"]:checked`);
      if (!el) return;
      s[id] = (el.tagName === "SELECT" || el.type === "radio") ? el.value : Number(el.value);
    });
    return s;
  }
  
  function setState(obj) {
    ids.forEach(id => {
      if (obj[id] === undefined) return;
      const el = $(id);
      if (!el) {
        // Handle radio buttons
        const radio = document.querySelector(`input[name="${id}"][value="${obj[id]}"]`);
        if (radio) radio.checked = true;
        return;
      }
      if (el.tagName === "SELECT") el.value = obj[id];
      else el.value = obj[id];
    });
  }
  
  function applyPatchToUI(currentState, patch) {
    const map = {
      "satellite.fuel_kg": "fuel_kg",
      "satellite.max_thrust_newton": "max_thrust_newton",
      "control.target_descent_rate_mps": "target_descent_rate_mps",
      "control.kp": "kp",
      "environment.wind_accel_std_mps2": "wind_accel_std_mps2",
      "noise.vel_sensor_std_mps": "vel_sensor_std_mps",
      "noise.thrust_rel_std": "thrust_rel_std",
      "sim.max_time_seconds": "max_time_seconds",
      "safety.safe_landing_speed_mps": "safe_landing_speed_mps"
    };
  
    const next = {...currentState};
    Object.entries(patch).forEach(([k,v]) => {
      const uiKey = map[k];
      if (uiKey) next[uiKey] = v;
    });
    return next;
  }
  
  /* ========================================
     CANVAS ANIMATION
     ======================================== */
  
  const canvas = $("simCanvas");
  const ctx = canvas.getContext("2d");
  
  let traceRows = [];
  let traceIdx = 0;
  let playing = false;
  let lastFrameTs = 0;
  let missionOutcome = "none";
  let impactFlash = 0;
  let currentZoneData = null;
  
  // Load satellite image
  let satelliteImg = new Image();
  let satelliteLoaded = false;
  
  satelliteImg.onload = () => {
    satelliteLoaded = true;
    console.log("✅ Satellite image loaded");
  };
  
  satelliteImg.onerror = () => {
    console.warn("⚠️ satellite.png not found, using fallback rendering");
    satelliteLoaded = false;
  };
  
  satelliteImg.src = "/static/assets/satellite.png";
  
  // Stars for space background
  let stars = [];
  function initStars() {
    stars = [];
    const W = canvas.width;
    const H = canvas.height;
    for (let i = 0; i < 200; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * (H * 0.75),
        r: Math.random() * 2 + 0.5,
        a: Math.random() * 0.8 + 0.2,
        twinkle: Math.random() * 0.02
      });
    }
  }
  
  initStars();
  
  function updateHUD(row) {
    if (!row) return;
    const [t, alt, vel, fuel, thr] = row;
    
    $("hudT").textContent = `${t.toFixed(1)} s`;
    $("hudAlt").textContent = `${alt.toFixed(1)} m`;
    $("hudVel").textContent = `${vel.toFixed(2)} m/s`;
    $("hudFuel").textContent = `${fuel.toFixed(1)} kg`;
    $("hudThr").textContent = thr.toFixed(3);
    
    // Update status
    const statusEl = $("hudStatus");
    if (playing && alt > 0) {
      statusEl.textContent = "IN FLIGHT";
      statusEl.style.color = "#3b82f6";
    } else if (alt <= 0) {
      if (missionOutcome === "safe") {
        statusEl.textContent = "LANDED ✅";
        statusEl.style.color = "#10b981";
      } else {
        statusEl.textContent = "CRASHED ❌";
        statusEl.style.color = "#ef4444";
      }
    } else {
      statusEl.textContent = "READY";
      statusEl.style.color = "#94a3b8";
    }
    
    // Update warnings
    updateWarnings(alt, vel, fuel);
  }
  
  function updateWarnings(alt, vel, fuel) {
    const overlay = $("warningOverlay");
    const warnings = [];
    
    if (fuel < 15 && alt > 100) {
      warnings.push('<div class="warning-badge">⚠️ FUEL LOW</div>');
    }
    if (fuel < 5 && alt > 50) {
      warnings.push('<div class="warning-badge">🔥 FUEL CRITICAL</div>');
    }
    if (Math.abs(vel) > 6 && alt < 150) {
      warnings.push('<div class="warning-badge caution">⚠️ HIGH SPEED</div>');
    }
    if (Math.abs(vel) > 4 && alt < 80) {
      warnings.push('<div class="warning-badge">⚠️ EXCESSIVE DESCENT RATE</div>');
    }
    
    overlay.innerHTML = warnings.join('');
  }
  
  function drawLandingZones() {
    if (!currentZoneData) return;
    
    const W = canvas.width;
    const H = canvas.height;
    const groundY = H * 0.88;
    
    // Draw zones (danger → caution → safe)
    const zones = [
      currentZoneData.danger_zone,
      currentZoneData.caution_zone,
      currentZoneData.safe_zone
    ];
    
    zones.forEach(zone => {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = zone.color;
      ctx.beginPath();
      ctx.arc(zone.x, groundY, zone.radius, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = zone.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });
    
    // Target marker
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 8;
    ctx.fillText("🎯 TARGET", currentZoneData.safe_zone.x, groundY - currentZoneData.danger_zone.radius - 25);
    ctx.restore();
  }
  
  function drawSatellite(x, y, thr, vel, alt) {
    const size = 60;
    const rotation = Math.max(-0.25, Math.min(0.25, -vel * 0.015));
    
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    
    if (satelliteLoaded) {
      // Draw actual satellite image
      const scale = size / Math.max(satelliteImg.width, satelliteImg.height);
      const w = satelliteImg.width * scale;
      const h = satelliteImg.height * scale;
      
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 20;
      ctx.drawImage(satelliteImg, -w/2, -h/2, w, h);
      ctx.shadowBlur = 0;
    } else {
      // Fallback: draw stylized satellite
      ctx.fillStyle = "#e0e0e0";
      ctx.fillRect(-size/3, -size/2, size*0.66, size);
      
      // Solar panels
      ctx.fillStyle = "#4a90e2";
      ctx.fillRect(-size, -size/4, size*0.6, size/2);
      ctx.fillRect(size*0.4, -size/4, size*0.6, size/2);
      
      // Antenna
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -size/2);
      ctx.lineTo(0, -size);
      ctx.stroke();
      ctx.fillStyle = "#ff6b6b";
      ctx.beginPath();
      ctx.arc(0, -size, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Thruster flame
    if (thr > 0.05 && fuel > 0 && alt > 0) {
      const flameH = 20 + 70 * thr;
      
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ff9f40";
      ctx.beginPath();
      ctx.moveTo(-14, size/2);
      ctx.lineTo(14, size/2);
      ctx.lineTo(0, size/2 + flameH);
      ctx.closePath();
      ctx.fill();
      
      ctx.fillStyle = "#ff6b35";
      ctx.beginPath();
      ctx.moveTo(-9, size/2);
      ctx.lineTo(9, size/2);
      ctx.lineTo(0, size/2 + flameH * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
    
    ctx.restore();
  }
  
  function drawScene(row, meta) {
    const W = canvas.width;
    const H = canvas.height;
    
    // Clear
    ctx.clearRect(0, 0, W, H);
    
    // Space background
    const bgGrad = ctx.createRadialGradient(W/2, H/4, 0, W/2, H/2, W);
    bgGrad.addColorStop(0, "#1a2332");
    bgGrad.addColorStop(1, "#050810");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
    
    // Stars
    stars.forEach(s => {
      s.a += (Math.random() - 0.5) * s.twinkle;
      s.a = Math.max(0.2, Math.min(0.95, s.a));
      ctx.globalAlpha = s.a;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;
    
    // Ground/Surface
    const groundY = H * 0.88;
    ctx.fillStyle = "rgba(100,100,120,0.3)";
    ctx.fillRect(0, groundY, W, H - groundY);
    
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(W, groundY);
    ctx.stroke();
    
    // Landing zones
    drawLandingZones();
    
    if (!row) return;
    
    const [t, alt, vel, fuel, thr] = row;
    const alt0 = meta.initial_altitude_m || 500;
    
    const topMargin = 50;
    const bottomMargin = 100;
    const usable = (groundY - bottomMargin) - topMargin;
    
    const a = Math.max(-30, Math.min(alt0, alt));
    const y = topMargin + (1 - (a / alt0)) * usable;
    const x = W * 0.5;
    
    // Shadow
    if (alt > 0) {
      const shadowAlpha = 0.4 - (alt / alt0) * 0.3;
      ctx.globalAlpha = Math.max(0.1, shadowAlpha);
      ctx.fillStyle = "#000";
      const shadowSize = 70 * (1 - alt/alt0) + 25;
      ctx.beginPath();
      ctx.ellipse(x, groundY + 15, shadowSize, shadowSize * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
    
    // Draw satellite
    drawSatellite(x, y, thr, vel, alt);
    
    // Impact effects
    if (alt <= 0) {
      if (missionOutcome === "safe") {
        // Success particles
        ctx.fillStyle = "#10b981";
        for (let i = 0; i < 25; i++) {
          const angle = (i / 25) * Math.PI * 2;
          const dist = 45 + Math.sin(impactFlash * 2) * 25;
          const px = x + Math.cos(angle) * dist;
          const py = groundY + Math.sin(angle) * dist * 0.4;
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1.0;
        
        // Success text
        ctx.save();
        ctx.fillStyle = "#10b981";
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 12;
        ctx.fillText("✅ SAFE LANDING", W/2, H/2);
        ctx.restore();
      } else {
        // Crash effect
        impactFlash += 0.15;
        ctx.fillStyle = `rgba(239,68,68,${Math.min(0.35, impactFlash/7)})`;
        ctx.fillRect(0, 0, W, H);
        
        // Debris
        ctx.fillStyle = "#ff9966";
        for (let i = 0; i < 20; i++) {
          const angle = (i / 20) * Math.PI * 2;
          const dist = 35 + Math.sin(impactFlash + i) * 30;
          const px = x + Math.cos(angle) * dist;
          const py = groundY + Math.sin(angle) * dist * 0.4 - 15;
          ctx.globalAlpha = 0.8;
          ctx.fillRect(px - 3, py - 3, 6, 6);
        }
        ctx.globalAlpha = 1.0;
        
        // Crash text
        ctx.save();
        ctx.fillStyle = "#ef4444";
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 12;
        ctx.fillText("❌ CRASH", W/2, H/2);
        ctx.restore();
      }
    }
  }
  
  function step(ts) {
    if (!playing) return;
    if (!lastFrameTs) lastFrameTs = ts;
    
    const dtMs = ts - lastFrameTs;
    lastFrameTs = ts;
    
    const advance = Math.max(1, Math.floor(dtMs * 0.05));
    traceIdx = Math.min(traceIdx + advance, traceRows.length - 1);
    
    const row = traceRows[traceIdx];
    updateHUD(row);
    drawScene(row, window._traceMeta || {});
    
    if (traceIdx >= traceRows.length - 1) {
      playing = false;
      return;
    }
    requestAnimationFrame(step);
  }
  
  function resetAnim() {
    traceIdx = 0;
    lastFrameTs = 0;
    impactFlash = 0;
    if (traceRows.length > 0) {
      updateHUD(traceRows[0]);
      drawScene(traceRows[0], window._traceMeta || {});
    }
  }
  
  // Button handlers
  $("btnPlay").onclick = () => {
    if (!traceRows.length) return;
    playing = true;
    requestAnimationFrame(step);
  };
  
  $("btnPause").onclick = () => { playing = false; };
  
  $("btnReset").onclick = () => {
    playing = false;
    resetAnim();
  };
  
  $("btnNew").onclick = async () => {
    $("seed").value = Number($("seed").value) + 1;
    await runSimulation();
  };
  
  /* ========================================
     RESULTS RENDERING
     ======================================== */
  
  function renderResults(payload) {
    const s = payload.summary;
    currentZoneData = payload.zone_data;
    
    // Update header stats
    $("currentZone").textContent = payload.site_name;
    $("currentSuccess").textContent = `${s.safe_rate}%`;
    
    // Build results HTML
    const resultsHTML = `
      <div class="results-grid">
        <div class="result-card">
          <div class="result-label">Safe Landing Rate</div>
          <div class="result-value ${s.safe_rate >= 80 ? 'success' : s.safe_rate >= 50 ? 'warning' : 'danger'}">
            ${s.safe_rate}%
          </div>
        </div>
        <div class="result-card">
          <div class="result-label">Touchdown Rate</div>
          <div class="result-value">${s.touchdown_rate}%</div>
        </div>
        <div class="result-card">
          <div class="result-label">Simulations Run</div>
          <div class="result-value">${s.runs}</div>
        </div>
        <div class="result-card">
          <div class="result-label">Avg Fuel Left</div>
          <div class="result-value">${s.avg_fuel_left} kg</div>
        </div>
      </div>
      
      <div class="diagnosis-box">
        ${payload.diagnosis}
      </div>
      
      ${s.avg_speed !== null ? `
        <p style="color: var(--text-secondary); margin: 1rem 0;">
          <strong>Landing Speed:</strong> ${s.avg_speed} ± ${s.std_speed} m/s 
          (safe threshold: ≤ ${payload.zone_data.safe_speed} m/s)
        </p>
      ` : '<p style="color: var(--warning);">⚠️ No successful touchdowns recorded.</p>'}
      
      <table class="breakdown-table">
        <thead>
          <tr>
            <th>Outcome Type</th>
            <th>Percentage</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(s.breakdown_pct)
            .sort((a, b) => b[1] - a[1])
            .map(([outcome, pct]) => {
              const emoji = outcome === 'safe' ? '✅' :
                           outcome === 'too_fast' ? '⚠️' :
                           outcome === 'out_of_fuel' ? '🔥' : '⏱️';
              return `<tr><td>${emoji} ${outcome}</td><td><strong>${pct}%</strong></td></tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;
    
    $("resultsContent").innerHTML = resultsHTML;
    
    // Render suggestions
    if (payload.suggestions && payload.suggestions.length > 0) {
      $("suggestionsSidebar").style.display = "block";
      renderSuggestions(payload.suggestions, payload.quick_runs_used_for_suggestions);
    }
    
    // Load trace
    const tr = payload.trace;
    window._traceMeta = { initial_altitude_m: tr.initial_altitude_m };
    missionOutcome = tr.outcome || "none";
    impactFlash = 0;
    traceRows = tr.rows || [];
    resetAnim();
  }
  
  function renderSuggestions(suggestions, quickRuns) {
    const html = `
      <p style="color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1rem;">
        Each suggestion tested with ${quickRuns} Monte Carlo runs
      </p>
      ${suggestions.map((sug, idx) => `
        <div class="suggestion-item">
          <div class="suggestion-header">
            <div class="suggestion-rank">${idx + 1}</div>
            <div class="suggestion-title">${sug.label}</div>
          </div>
          <div class="suggestion-stats">
            Est. safe rate: <strong>${sug.est_safe_rate}%</strong> 
            (<span class="suggestion-delta ${sug.delta < 0 ? 'negative' : ''}">${sug.delta >= 0 ? '+' : ''}${sug.delta}%</span>)
          </div>
          <button class="apply-btn" data-patch='${JSON.stringify(sug.patch)}'>
            Apply This Change
          </button>
        </div>
      `).join('')}
    `;
    
    $("suggestionsContent").innerHTML = html;
    
    // Add click handlers
    document.querySelectorAll('.apply-btn').forEach(btn => {
      btn.onclick = async () => {
        const patch = JSON.parse(btn.getAttribute('data-patch'));
        const current = getState();
        const next = applyPatchToUI(current, patch);
        setState(next);
        await runSimulation();
      };
    });
  }
  
  /* ========================================
     API CALLS
     ======================================== */
  
  async function runSimulation() {
    const btn = $("btnRun");
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span><span class="btn-text">Running...</span>';
    
    try {
      const state = getState();
      const res = await fetch("/api/run", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(state)
      });
      
      if (!res.ok) throw new Error("Simulation failed");
      
      const payload = await res.json();
      renderResults(payload);
    } catch (error) {
      console.error("Simulation error:", error);
      alert("Simulation failed. Check console for details.");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">🚀</span><span class="btn-text">Run Simulation</span>';
    }
  }
  
  async function loadDefaults() {
    try {
      const res = await fetch("/api/default");
      const data = await res.json();
      setState(data);
      currentZoneData = data.zone_data;
      
      // Initialize canvas
      window._traceMeta = { initial_altitude_m: data.initial_altitude_m || 500 };
      missionOutcome = "none";
      traceRows = [[0, data.initial_altitude_m || 500, 0, data.fuel_kg || 80, 0]];
      resetAnim();
    } catch (error) {
      console.error("Failed to load defaults:", error);
    }
  }
  
  // Initialize
  $("btnRun").onclick = runSimulation;
  loadDefaults();