# 🛰️ Satellite Landing Simulation

An interactive Monte Carlo simulation for satellite landing optimization with real-time visualization and AI-powered suggestions.

## Features

✅ **Visual Landing Zones** - Color-coded safe (green), caution (yellow), and danger (red) zones  
✅ **Real-time Warnings** - Get alerts for fuel critical, high speed, and descent issues  
✅ **Satellite Animation** - Watch your satellite descend with realistic physics  
✅ **Monte Carlo Analysis** - Run hundreds of simulations to test reliability  
✅ **Smart Suggestions** - AI ranks parameter changes by tested improvement  
✅ **Multiple Landing Sites** - Ocean (easy), Land (medium), Mountain (hard)  

## Installation

### Requirements
- Python 3.8+
- pip

### Setup

1. Install dependencies:
```bash
pip install flask numpy pandas pillow --break-system-packages
```

2. Run the application:
```bash
python app.py
```

3. Open your browser:
```
http://127.0.0.1:5055
```

## How to Use

### 1. Configure Mission Parameters

**Landing Zone Selection:**
- **Ocean Zone** (Easy) - Larger safe zone, lower wind
- **Land Zone** (Medium) - Medium difficulty
- **Mountain Zone** (Hard) - Smallest safe zone, high wind

**Key Parameters:**
- **Fuel (kg)** - More fuel = longer burn time
- **Max Thrust (N)** - Higher thrust = better control
- **Target Descent Rate (m/s)** - Speed you're trying to maintain
- **Controller kp** - Response sensitivity (higher = more aggressive)

### 2. Run Simulation

Click **"🚀 Run Simulation"** to execute Monte Carlo analysis.

### 3. Analyze Results

**Results Panel Shows:**
- ✅ **Safe landing rate** - % of successful landings
- 🎯 **Touchdown rate** - % that reached the surface
- 📊 **Breakdown** - What went wrong in failed attempts

**Common Failure Modes:**
- ⚠️ **Out of Fuel** - Increase fuel or thrust, descend faster
- ⚠️ **Too Fast** - Increase thrust or slow descent rate
- ⏱️ **Time Limit** - Increase max time or descend faster

### 4. Watch Animation

Control the satellite landing visualization:
- **▶ Play** - Start descent animation
- **⏸ Pause** - Freeze current state
- **↺ Reset** - Return to start
- **🎲 New Run** - Generate new random scenario

**Visual Indicators:**
- Green zones = Safe landing area
- Yellow zones = Caution zone
- Red zones = High-risk area
- Flame intensity = Thrust level
- Warning badges = Real-time alerts

### 5. Apply Suggestions

The system automatically tests parameter changes and ranks them by improvement:

1. Review ranked suggestions (sorted by effectiveness)
2. Click **"Apply Change"** on any suggestion
3. Parameters update automatically
4. Run simulation again to verify improvement

## Understanding the Physics

### Descent Dynamics
```
Acceleration = (Thrust / Mass) - Gravity + Wind
Velocity += Acceleration × dt
Altitude += Velocity × dt
```

### Control System
The satellite uses a proportional controller:
```
Error = Target_Velocity - Measured_Velocity
Throttle = kp × Error
```

**kp Parameter Guide:**
- `kp = 0.5` - Gentle, slow response
- `kp = 0.8` - Balanced (default)
- `kp = 1.2` - Aggressive, fast response

### Safe Landing Criteria
- ✅ Touchdown velocity ≤ Safe speed threshold
- ✅ Landing within designated zones (bonus points for green zone)
- ✅ Fuel remaining > 0

## Tips for Success

### Starting Out
1. Begin with Ocean Zone (easiest)
2. Use default parameters first
3. Run 500+ simulations for reliable stats
4. Watch the animation to understand behavior

### Optimization Strategy
1. **If running out of fuel:**
   - Increase fuel capacity
   - Increase max thrust
   - Increase descent rate (land faster)

2. **If landing too fast:**
   - Decrease target descent rate
   - Increase max thrust
   - Increase kp for more responsive control

3. **If hitting time limit:**
   - Increase max_time parameter
   - Increase descent rate

### Advanced Tuning
- **Low kp (0.4-0.6)** - Smooth but may be too slow
- **Medium kp (0.7-1.0)** - Balanced performance
- **High kp (1.1-1.5)** - Very responsive but may oscillate

## File Structure

```
satellite_landing/
├── app.py              # Flask backend + simulation engine
├── config.json         # Default parameters
├── templates/
│   └── index.html      # Main UI
├── static/
│   ├── styles.css      # Styling
│   ├── app.js          # Frontend logic + animation
│   └── assets/
│       └── satellite.png  # Satellite sprite
```

## Customization

### Change Satellite Image
Replace `static/assets/satellite.png` with your own image (120x120px recommended)

### Modify Landing Zones
Edit `LANDING_ZONES` in `app.py`:
```python
"safe_zone": {"x": 450, "y": 380, "radius": 80, "color": "#4ade80"}
```

### Add New Suggestions
Extend `candidate_patches()` in `app.py`:
```python
def candidate_patches(cfg, dominant_reason):
    # Add your custom suggestion
    add("Your change name", {"satellite.fuel_kg": new_value})
```

## Troubleshooting

**Simulation won't run:**
- Check Python 3.8+ is installed
- Verify all dependencies installed
- Check console for errors

**Animation not showing:**
- Verify satellite.png exists in static/assets/
- Check browser console for errors
- Try refreshing the page

**Poor performance:**
- Reduce Monte Carlo runs (try 200-300)
- Close other browser tabs
- Use a modern browser (Chrome/Firefox/Safari)

## Technical Details

**Monte Carlo Method:**
- Runs N independent simulations with random noise
- Aggregates results for statistical confidence
- Each simulation uses different random seed

**Suggestion Ranking:**
- Tests each parameter change with 120-250 quick runs
- Calculates improvement delta vs baseline
- Ranks by effectiveness (highest improvement first)

**Physics Accuracy:**
- 0.1 second timestep (configurable)
- Includes gravity, thrust, wind, sensor noise
- Proportional controller for descent rate

## License

This project is for educational and research purposes.

---

**Need Help?** Check the console logs or adjust parameters incrementally to understand their effects.

**Pro Tip:** The best way to learn is to intentionally fail (set fuel=10) and watch what happens, then use suggestions to fix it!