from pathlib import Path
import pandas as pd
from flask import Flask, Response

# We will serve the existing outputs folder
OUTPUTS_DIR = Path("outputs")
MC_DIR = OUTPUTS_DIR / "monte_carlo"
SR_DIR = OUTPUTS_DIR / "single_run"

app = Flask(__name__, static_folder=str(OUTPUTS_DIR), static_url_path="/outputs")


def _read_csv_safe(path: Path) -> pd.DataFrame:
    if path.exists():
        return pd.read_csv(path)
    return pd.DataFrame({"info": [f"Missing: {path}"]})


@app.get("/")
def index():
    runs_path = MC_DIR / "runs_summary.csv"
    summary_path = MC_DIR / "results_summary_table.csv"
    breakdown_path = MC_DIR / "outcome_breakdown_table.csv"
    assumptions_path = MC_DIR / "assumptions_table.csv"

    runs = _read_csv_safe(runs_path)
    summary = _read_csv_safe(summary_path)
    breakdown = _read_csv_safe(breakdown_path)
    assumptions = _read_csv_safe(assumptions_path)

    safe_rate = None
    if "safe" in runs.columns and len(runs) > 0:
        safe_rate = float(runs["safe"].mean() * 100.0)

    # Images we already created
    images = [
        ("Monte Carlo Landing Speed Histogram", "monte_carlo/landing_speed_hist.png"),
        ("Monte Carlo Landing Speed CDF", "monte_carlo/landing_speed_cdf.png"),
        ("Monte Carlo Outcome Breakdown", "monte_carlo/outcome_breakdown.png"),
        ("Single Run: Altitude vs Time", "single_run/altitude_vs_time.png"),
        ("Single Run: Velocity vs Time", "single_run/velocity_vs_time.png"),
        ("Single Run: Fuel vs Time", "single_run/fuel_vs_time.png"),
    ]

    def img_tag(title, rel_path):
        file_path = OUTPUTS_DIR / rel_path
        if file_path.exists():
            return f"""
            <div class="card">
              <h3>{title}</h3>
              <img src="/outputs/{rel_path}" alt="{title}" />
            </div>
            """
        return f"""
        <div class="card">
          <h3>{title}</h3>
          <p style="color:#b00020;">Missing image: outputs/{rel_path}</p>
        </div>
        """

    html = f"""
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Lunar Lander Simulation Dashboard</title>
      <style>
        body {{ font-family: Arial, sans-serif; margin: 24px; background: #fafafa; }}
        .top {{ display:flex; gap:16px; flex-wrap:wrap; }}
        .pill {{ background:#111; color:#fff; padding:10px 14px; border-radius:999px; }}
        .grid {{ display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:16px; margin-top:16px; }}
        .card {{ background:#fff; border:1px solid #eee; border-radius:14px; padding:14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }}
        img {{ width:100%; height:auto; border-radius:10px; border:1px solid #eee; }}
        table {{ width:100%; border-collapse: collapse; font-size: 14px; }}
        th, td {{ border: 1px solid #e6e6e6; padding: 8px; text-align:left; }}
        th {{ background:#f3f3f3; }}
        .small {{ font-size: 12px; color:#555; }}
      </style>
    </head>
    <body>
      <h1>Lunar Lander Simulation Dashboard</h1>
      <div class="top">
        <div class="pill">Outputs folder: {OUTPUTS_DIR.resolve()}</div>
        <div class="pill">Monte Carlo runs: {len(runs) if len(runs.columns)>0 else 0}</div>
        <div class="pill">Safe landing rate: {safe_rate:.2f}%</div>
      </div>

      <p class="small">
        This is a local viewer. Run Monte Carlo + plots first if anything is missing.
      </p>

      <div class="grid">
        <div class="card">
          <h2>Results Summary</h2>
          {summary.to_html(index=False, escape=False)}
        </div>

        <div class="card">
          <h2>Outcome Breakdown</h2>
          {breakdown.to_html(index=False, escape=False)}
        </div>

        <div class="card">
          <h2>Assumptions (from config.json)</h2>
          {assumptions.to_html(index=False, escape=False)}
        </div>
      </div>

      <h2 style="margin-top:22px;">Graphs</h2>
      <div class="grid">
        {''.join([img_tag(t, p) for (t, p) in images])}
      </div>
    </body>
    </html>
    """
    return Response(html, mimetype="text/html")


if __name__ == "__main__":
    # Safety checks: show helpful message if outputs missing
    if not OUTPUTS_DIR.exists():
        print("ERROR: outputs/ folder not found. Run the simulation scripts first.")
    else:
        print("Starting local dashboard...")
        print("Open: http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
