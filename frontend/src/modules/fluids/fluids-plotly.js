/**
 * frontend/src/modules/fluids/fluids-plotly.js
 * ================================================
 * Plotly.js chart renderers for the Fluid Mechanics dashboard.
 *
 * Ported from the inline controller in templates/app_fluids/pipe_flow.html,
 * which was the version users actually ran. The comparison-mode overlay (a
 * pinned reference velocity profile drawn dashed behind the current one) only
 * existed there and is preserved here.
 *
 * Exports:
 *   PlotlyCharts.renderPressureDrop(result, operatingFlowLPM)
 *   PlotlyCharts.renderVelocityProfile(result, referenceResult)
 */

// THREE, OrbitControls and Plotly are read from the globals installed by the
// vendored <script> tags in the template. The vendored three build is r128
// (2021); npm's `three` would resolve to 0.166, ~38 revisions ahead and
// including r155's redefinition of light intensity units, so the two are not
// interchangeable and this code targets the vendored one. (The vendored plotly
// is plotly.js-dist@2.33.0 — the same major version npm resolves to; only three
// actually differs. Neither package is a dependency any more.)

// Shared dark-mode Plotly layout base
const PLOTLY_DARK_LAYOUT = {
  paper_bgcolor: 'transparent',
  plot_bgcolor:  '#0d1526',
  font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 11 },
  margin: { t: 10, r: 16, b: 48, l: 64 },
  xaxis: {
    gridcolor:     'rgba(255,255,255,0.05)',
    zerolinecolor: 'rgba(255,255,255,0.1)',
    tickfont: { family: 'JetBrains Mono, monospace', size: 10 },
  },
  yaxis: {
    gridcolor:     'rgba(255,255,255,0.05)',
    zerolinecolor: 'rgba(255,255,255,0.1)',
    tickfont: { family: 'JetBrains Mono, monospace', size: 10 },
  },
  legend: { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0 },
};

const PLOTLY_CONFIG = {
  responsive: true,
  displayModeBar: true,
  modeBarButtonsToRemove: ['sendDataToCloud'],
  displaylogo: false,
};

export const PlotlyCharts = {
  pressureChartRendered: false,
  profileChartRendered: false,

  /**
   * Render the pressure-drop-vs-flow-rate sweep with the operating point.
   *
   * @param {Object} result           — API response data
   * @param {number} operatingFlowLPM — current operating flow rate [L/min]
   */
  renderPressureDrop(result, operatingFlowLPM) {
    const qLPM  = result.sweep_flow_rates_m3_s.map(q => q * 60000); // m³/s → L/min
    const dpBar = result.sweep_pressure_drops_pa.map(p => p / 1e5); // Pa → bar

    // Operating point marker
    const opDp = result.pressure_drop_total_bar;

    const traces = [
      {
        x: qLPM, y: dpBar,
        mode: 'lines',
        name: 'ΔP vs Q',
        line: { color: '#3b82f6', width: 2.5, shape: 'spline' },
        fill: 'tozeroy',
        fillcolor: 'rgba(59,130,246,0.05)',
      },
      {
        // Current operating point
        x: [operatingFlowLPM],
        y: [opDp],
        mode: 'markers',
        name: 'Operating Point',
        marker: { color: '#ef4444', size: 10, symbol: 'circle', line: { color: '#fff', width: 1.5 } },
      },
    ];

    const layout = {
      ...PLOTLY_DARK_LAYOUT,
      xaxis: {
        ...PLOTLY_DARK_LAYOUT.xaxis,
        title: { text: 'Flow Rate (L/min)', font: { size: 11, color: '#64748b' } },
      },
      yaxis: {
        ...PLOTLY_DARK_LAYOUT.yaxis,
        title: { text: 'Pressure Drop (bar)', font: { size: 11, color: '#64748b' } },
      },
    };

    document.getElementById('chart-placeholder')?.remove();

    if (!this.pressureChartRendered) {
      Plotly.newPlot('plotly-chart', traces, layout, PLOTLY_CONFIG);
      this.pressureChartRendered = true;
    } else {
      Plotly.react('plotly-chart', traces, layout, PLOTLY_CONFIG);
    }
  },

  /**
   * Render the radial velocity profile, optionally overlaying a pinned
   * reference profile for comparison mode.
   *
   * @param {Object} result           — API response data
   * @param {Object|null} referenceResult — pinned profile, or null
   */
  renderVelocityProfile(result, referenceResult = null) {
    if (!result) return;

    const traces = [
      {
        x: result.velocity_profile,
        y: result.radial_positions,
        mode: 'lines',
        name: 'v(r)',
        line: { color: '#8b5cf6', width: 2.5, shape: 'spline' },
        fill: 'tozerox',
        fillcolor: 'rgba(139,92,246,0.08)',
      },
    ];

    // Comparison mode: overlay the pinned reference velocity profile,
    // faded and dashed, alongside the current one.
    if (referenceResult) {
      traces.push({
        x: referenceResult.velocity_profile,
        y: referenceResult.radial_positions,
        mode: 'lines',
        name: 'Reference v(r)',
        line: { color: '#94a3b8', width: 2, dash: 'dot', shape: 'spline' },
        opacity: 0.6,
      });
    }

    const layout = {
      ...PLOTLY_DARK_LAYOUT,
      margin: { t: 10, r: 16, b: 48, l: 56 },
      xaxis: {
        ...PLOTLY_DARK_LAYOUT.xaxis,
        title: { text: 'Velocity (m/s)', font: { size: 10, color: '#64748b' } },
      },
      yaxis: {
        ...PLOTLY_DARK_LAYOUT.yaxis,
        title: { text: 'r/R (0=centre, 1=wall)', font: { size: 10, color: '#64748b' } },
        range: [0, 1],
        autorange: false,
      },
    };

    document.getElementById('profile-placeholder')?.remove();

    if (!this.profileChartRendered) {
      Plotly.newPlot('profile-chart', traces, layout, PLOTLY_CONFIG);
      this.profileChartRendered = true;
    } else {
      Plotly.react('profile-chart', traces, layout, PLOTLY_CONFIG);
    }
  },
};
