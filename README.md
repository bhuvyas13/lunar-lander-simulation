# 🛰️ Satellite Landing Mission Planner

An educational Monte Carlo simulation tool for satellite landing optimization, inspired by real NASA, ISRO, ESA, and JAXA missions.

## Features

- **6 Planetary Destinations** — Moon, Mars, Earth, Titan, Asteroid Ryugu, Venus
- **18 Landing Sites** — Real mission sites (Chandrayaan-3, Apollo 11, Perseverance, etc.)
- **Impossible Locations** — Educational "why you can't land on Olympus Mons"
- **9 Real Spacecraft** — From Vikram Lander to SpaceX Falcon 9
- **500 Monte Carlo Simulations** — Statistical confidence in your mission plan
- **Live 2D Animation** — Watch your satellite descend with realistic physics
- **AI-Ranked Suggestions** — Each suggestion tested with real simulations
- **Real-time HUD** — Altitude, velocity, fuel, throttle during animation

## Installation

```bash
pip install flask numpy pandas --break-system-packages
```

## Run

```bash
python app.py
```

Open: **http://127.0.0.1:5055**

## How to Use

### Step 1: Select Planet
Choose from 6 destinations — each with different gravity, atmosphere, and challenge level.

### Step 2: Select Landing Site
Pick from real mission sites. Click impossible locations to learn why they're dangerous.

### Step 3: Configure Mission
- Select a real spacecraft (pre-fills realistic parameters)
- Adjust fuel, thrust, descent rate, controller gain
- Set Monte Carlo runs (500 recommended)

### Step 4: Launch Simulation
Watch 500 simulations run. See success rate, failure analysis, and AI-ranked improvements.

### Step 5: Optimize
Click "Apply This Change" on any suggestion. Parameters update automatically.

## Physics

```
Acceleration = (Thrust / Mass) - Gravity + Wind
Velocity    += Acceleration × dt
Altitude    += Velocity × dt
```

Controller:
```
Error    = Target_Velocity - Measured_Velocity
Throttle = kp × Error
```

## File Structure

```
satellite_planner/
├── app.py                    # Flask backend + simulation engine
├── requirements.txt
├── data/
│   ├── locations.json        # 6 planets × 18 sites
│   └── spacecraft_reference.json  # 9 real spacecraft
├── templates/
│   └── index.html           # Single-page app (3 views)
└── static/
    ├── css/styles.css       # Space-themed dark UI
    └── js/app.js            # All frontend logic + canvas animation
```

## Landing Sites by Planet

| Planet | Sites | Real Missions |
|--------|-------|---------------|
| 🌙 Moon | 4 | Chandrayaan-3, Apollo 11, Artemis |
| 🔴 Mars | 5 | Curiosity, Perseverance, InSight |
| 🌍 Earth | 4 | SpaceX Falcon 9 drone ship |
| 🪐 Titan | 2 | Huygens probe, Dragonfly |
| ☄️ Asteroid | 1 | Hayabusa2 |
| 🟡 Venus | 2 | Venera 7 |