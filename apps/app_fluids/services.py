"""
apps/app_fluids/services.py
=============================
PipeFlowService — Core scientific computation engine for pipe flow analysis.

This module implements:
    1. Reynolds Number calculation (laminar vs. turbulent classification)
    2. Darcy-Weisbach friction factor via Colebrook-White equation
       (solved iteratively) and Churchill explicit approximation
    3. Pressure drop calculation (Darcy-Weisbach + minor losses)
    4. Velocity profile across the pipe cross-section (parabolic for laminar,
       1/7th power law approximation for turbulent)
    5. Flow regime sweep: pressure drop vs. flow rate curve for Plotly.js

Scientific Libraries Used:
    - ``fluids``:  Authoritative pipe friction, flow regime, fittings library
    - ``numpy``:   Fast array operations for velocity profiles and sweep arrays
    - ``sympy``:   Used for exact symbolic expression of Hagen-Poiseuille law
    - ``mpmath``:  Used for high-precision Colebrook iteration verification

Units: every value reaching this module is already in SI — conversion happens in
the serializer. The maths below is therefore on plain floats; the header used to
claim pint made it unit-aware, but nothing here ever constructed a Quantity.

References:
    - Colebrook, C.F. (1939). Turbulent Flow in Pipes. J. Inst. Civil Engrs.
    - Moody, L.F. (1944). Friction Factors for Pipe Flow. Trans. ASME.
    - White, F.M. (2016). Fluid Mechanics, 8th Ed. McGraw-Hill.
"""

import logging
import math
from dataclasses import dataclass, field

import fluids
import mpmath
import numpy as np
import sympy as sp


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data Classes — typed input/output contracts
# ---------------------------------------------------------------------------

@dataclass
class PipeFlowInput:
    """
    Validated, SI-unit input parameters for a pipe flow calculation.

    All values are stored in SI units after conversion from user inputs.
    Unit conversion happens in the serializer / service entry point.
    """
    # Pipe geometry
    diameter_m: float          # Inner diameter [m]
    length_m: float            # Pipe length [m]
    roughness_m: float         # Absolute wall roughness [m]

    # Fluid properties
    density_kg_m3: float       # Fluid density [kg/m³]
    viscosity_pa_s: float      # Dynamic viscosity [Pa·s]

    # Operating conditions
    flow_rate_m3_s: float      # Volumetric flow rate [m³/s]

    # Optional: include minor losses (fittings, bends, valves)
    num_elbows_90: int = 0
    num_gate_valves_open: int = 0
    num_check_valves: int = 0


@dataclass
class PipeFlowResult:
    """
    Complete results from a pipe flow calculation, ready for JSON serialization.
    """
    # Flow characteristics
    velocity_m_s: float
    reynolds_number: float
    flow_regime: str           # 'Laminar', 'Transition', 'Turbulent'

    # Friction
    friction_factor: float     # Darcy friction factor (dimensionless)
    friction_method: str       # Which correlation was used

    # Pressure drop
    pressure_drop_major_pa: float    # Friction (pipe wall) losses [Pa]
    pressure_drop_minor_pa: float    # Minor losses (fittings) [Pa]
    pressure_drop_total_pa: float    # Total [Pa]
    pressure_drop_total_bar: float   # Total [bar] — user-friendly

    # Velocity profile (for Three.js visualisation)
    # radial_positions: normalised r/R from 0 (centre) to 1 (wall)
    radial_positions: list[float]
    velocity_profile: list[float]    # [m/s] at each radial position

    # Sweep data (for Plotly.js chart)
    sweep_flow_rates_m3_s: list[float]   # X-axis values
    sweep_pressure_drops_pa: list[float] # Y-axis values

    # Symbolic result (Hagen-Poiseuille — valid for laminar only)
    hagen_poiseuille_exact: str | None = None

    # Metadata
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# PipeFlowService
# ---------------------------------------------------------------------------

class PipeFlowService:
    """
    Computes full pipe flow analysis using the Darcy-Weisbach framework.

    Usage:
        service = PipeFlowService(pipe_input)
        result  = service.compute()
    """

    # Regime thresholds (standard engineering values)
    RE_LAMINAR_LIMIT = 2300
    RE_TURBULENT_LIMIT = 4000

    # Number of points for radial profile and flow-rate sweep
    PROFILE_POINTS = 60
    SWEEP_POINTS = 50

    def __init__(self, pipe_input: PipeFlowInput) -> None:
        self.inp = pipe_input
        self._warnings: list[str] = []

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def compute(self) -> PipeFlowResult:
        """
        Run the full pipe flow calculation pipeline and return results.

        Returns:
            PipeFlowResult: Fully populated result dataclass.
        """
        logger.debug(
            "PipeFlowService.compute(): D=%.4f m, L=%.2f m, Q=%.6f m³/s",
            self.inp.diameter_m, self.inp.length_m, self.inp.flow_rate_m3_s,
        )

        # 1. Derived geometry
        area_m2   = math.pi * (self.inp.diameter_m / 2) ** 2
        radius_m  = self.inp.diameter_m / 2

        # 2. Flow velocity
        if self.inp.flow_rate_m3_s == 0:
            velocity = 0.0
        else:
            velocity = self.inp.flow_rate_m3_s / area_m2

        # 3. Reynolds number
        re = self._reynolds_number(velocity)

        # 4. Flow regime
        regime = self._flow_regime(re)

        # 5. Friction factor
        ff, ff_method = self._friction_factor(re)

        # 6. Major pressure drop (Darcy-Weisbach)
        dp_major = self._pressure_drop_major(ff, velocity)

        # 7. Minor losses (fittings)
        dp_minor = self._pressure_drop_minor(velocity)

        # 8. Total pressure drop
        dp_total  = dp_major + dp_minor
        dp_bar    = dp_total / 1e5  # Pa → bar

        # 9. Velocity profile
        r_norm, v_profile = self._velocity_profile(velocity, re, radius_m)

        # 10. Symbolic Hagen-Poiseuille (laminar only)
        hp_expr = self._hagen_poiseuille_symbolic() if regime == 'Laminar' else None

        # 11. Pressure drop sweep (for Plotly chart)
        sweep_q, sweep_dp = self._pressure_drop_sweep()

        return PipeFlowResult(
            velocity_m_s=round(velocity, 6),
            reynolds_number=round(re, 2),
            flow_regime=regime,
            friction_factor=round(ff, 8),
            friction_method=ff_method,
            pressure_drop_major_pa=round(dp_major, 4),
            pressure_drop_minor_pa=round(dp_minor, 4),
            pressure_drop_total_pa=round(dp_total, 4),
            pressure_drop_total_bar=round(dp_bar, 6),
            radial_positions=[round(r, 4) for r in r_norm],
            velocity_profile=[round(v, 4) for v in v_profile],
            sweep_flow_rates_m3_s=[round(q, 8) for q in sweep_q],
            sweep_pressure_drops_pa=[round(p, 4) for p in sweep_dp],
            hagen_poiseuille_exact=hp_expr,
            warnings=self._warnings,
        )

    # ------------------------------------------------------------------
    # Step 1 — Reynolds Number
    # ------------------------------------------------------------------

    def _reynolds_number(self, velocity: float) -> float:
        """
        Re = ρ·v·D / μ

        Uses the ``fluids`` library for consistency with its other correlations.
        """
        if velocity == 0:
            return 0.0
        re = fluids.Reynolds(
            V=velocity,
            D=self.inp.diameter_m,
            rho=self.inp.density_kg_m3,
            mu=self.inp.viscosity_pa_s,
        )
        return float(re)

    # ------------------------------------------------------------------
    # Step 2 — Flow Regime
    # ------------------------------------------------------------------

    def _flow_regime(self, re: float) -> str:
        """Classify flow as Laminar, Transition, or Turbulent."""
        if re < self.RE_LAMINAR_LIMIT:
            return 'Laminar'
        if re < self.RE_TURBULENT_LIMIT:
            self._warnings.append(
                f"Re={re:.0f} is in the transition zone ({self.RE_LAMINAR_LIMIT}–"
                f"{self.RE_TURBULENT_LIMIT}). Results are approximate."
            )
            return 'Transition'
        return 'Turbulent'

    # ------------------------------------------------------------------
    # Step 3 — Friction Factor
    # ------------------------------------------------------------------

    def _friction_factor(self, re: float) -> tuple[float, str]:
        """
        Compute the Darcy-Weisbach friction factor.

        - Laminar  (Re < 2300): f = 64/Re  (exact analytical solution)
        - Turbulent (Re ≥ 4000): Churchill (1977) explicit approximation,
          accurate to within 0.5% of the implicit Colebrook-White equation.
        - Transition: Churchill with a warning.

        Returns:
            (friction_factor, method_name)
        """
        eD = self.inp.roughness_m / self.inp.diameter_m  # relative roughness

        if re == 0:
            return 0.0, 'zero_flow'

        if re < self.RE_LAMINAR_LIMIT:
            # Exact: Hagen-Poiseuille flow
            ff = 64.0 / re
            method = 'Hagen-Poiseuille (64/Re)'
        else:
            # Churchill (1977) — explicit, works for all Re > 0.
            # Method is passed explicitly: the library's default is Clamond, so
            # omitting it returned a Clamond value under a "Churchill" label,
            # which is the string this method hands to the UI.
            ff = fluids.friction.friction_factor(Re=re, eD=eD, Method='Churchill_1977')
            method = 'Churchill (1977) / Colebrook-White'

        # Validate with high-precision mpmath for turbulent (optional verification)
        if re >= self.RE_TURBULENT_LIMIT:
            ff_colebrook = self._colebrook_mpmath(re, eD)
            if ff_colebrook > 0:
                relative_error = abs(ff - ff_colebrook) / ff_colebrook
                if relative_error > 0.01:  # >1% discrepancy
                    self._warnings.append(
                        f"Friction factor discrepancy {relative_error:.2%} between "
                        f"Churchill ({ff:.6f}) and Colebrook ({ff_colebrook:.6f})."
                    )

        return float(ff), method

    def _colebrook_mpmath(self, re: float, eD: float) -> float:
        """
        Solve Colebrook-White equation iteratively using mpmath (50 sig. figs).

        1/√f = -2·log₁₀(ε/D/3.7 + 2.51/(Re·√f))

        This is the reference-grade calculation used to validate Churchill.

        Precision is raised inside a ``workdps`` context rather than by assigning
        ``mpmath.mp.dps``. That attribute is process-global: setting it here left
        every other thread in a multi-threaded WSGI worker computing at 50 digits
        for the rest of the process, and it was never restored.
        """
        with mpmath.workdps(50):
            eD_mp = mpmath.mpf(eD)
            re_mp = mpmath.mpf(re)

            # Initial guess via Swamee-Jain
            if eD > 0:
                f_guess = 0.25 / (mpmath.log10(eD / 3.7 + 5.74 / re_mp ** 0.9)) ** 2
            else:
                f_guess = 0.316 / re_mp ** 0.25  # Blasius (smooth pipes)

            f = mpmath.mpf(f_guess)

            # Fixed-point iteration (converges in < 10 iterations)
            for _ in range(100):
                rhs = -2 * mpmath.log10(
                    eD_mp / 3.7 + mpmath.mpf('2.51') / (re_mp * mpmath.sqrt(f))
                )
                f_new = 1 / rhs ** 2
                if abs(f_new - f) < mpmath.mpf('1e-40'):
                    break
                f = f_new

            return float(f)

    # ------------------------------------------------------------------
    # Step 4 — Major Pressure Drop (Darcy-Weisbach)
    # ------------------------------------------------------------------

    def _pressure_drop_major(self, ff: float, velocity: float) -> float:
        """
        ΔP_major = f · (L/D) · (ρ·v²/2)

        Args:
            ff:       Darcy friction factor (dimensionless)
            velocity: Mean flow velocity [m/s]

        Returns:
            Pressure drop [Pa]
        """
        return fluids.dP_from_K(
            K=ff * (self.inp.length_m / self.inp.diameter_m),
            rho=self.inp.density_kg_m3,
            V=velocity,
        )

    # ------------------------------------------------------------------
    # Step 5 — Minor Losses (Fittings)
    # ------------------------------------------------------------------

    def _pressure_drop_minor(self, velocity: float) -> float:
        """
        Sum K·(ρ·v²/2) for all fittings.

        K values from fluids library (Crane TP-410 method).
        """
        if velocity == 0:
            return 0.0

        dynamic_pressure = 0.5 * self.inp.density_kg_m3 * velocity ** 2
        total_K = 0.0

        # 90° standard elbows: K ≈ 0.75 (typical; fluids has many variants)
        if self.inp.num_elbows_90 > 0:
            K_elbow = fluids.fittings.bend_rounded(
                Di=self.inp.diameter_m,
                angle=90.0,
                fd=0.02,           # approximate friction factor for K lookup
                bend_diameters=1.5,
            )
            total_K += self.inp.num_elbows_90 * K_elbow

        # Fully open gate valves: K ≈ 0.1
        if self.inp.num_gate_valves_open > 0:
            K_gate = fluids.fittings.K_gate_valve_Crane(
                D1=self.inp.diameter_m,
                D2=self.inp.diameter_m,
                angle=0.0,
                fd=0.02,
            )
            total_K += self.inp.num_gate_valves_open * K_gate

        # Swing check valves: K ≈ 2.0
        if self.inp.num_check_valves > 0:
            K_check = fluids.fittings.K_swing_check_valve_Crane(
                D=self.inp.diameter_m,
                fd=0.02,
            )
            total_K += self.inp.num_check_valves * K_check

        return float(total_K * dynamic_pressure)

    # ------------------------------------------------------------------
    # Step 6 — Velocity Profile
    # ------------------------------------------------------------------

    def _velocity_profile(
        self,
        v_mean: float,
        re: float,
        radius_m: float,
    ) -> tuple[list[float], list[float]]:
        """
        Compute radial velocity profile across the pipe cross-section.

        - Laminar: Exact parabolic profile (Hagen-Poiseuille)
          v(r) = v_max · (1 - (r/R)²),  v_max = 2 · v_mean

        - Turbulent: 1/7th power law approximation
          v(r) = v_max · (1 - r/R)^(1/7)
          (valid for Re ≈ 10⁴–10⁷; error < 5%)

        The laminar/turbulent split uses ``RE_LAMINAR_LIMIT``, the same
        threshold ``_friction_factor`` switches on. It used to branch on
        ``RE_TURBULENT_LIMIT`` instead, so for 2300 ≤ Re < 4000 a single
        response paired a turbulent (Churchill) friction factor with a fully
        parabolic laminar profile — the two charts on the page contradicted each
        other. The transition band is genuinely approximate either way, and
        ``_flow_regime`` already attaches a warning saying so.

        Returns:
            (normalised_radii, velocities)
            Both lists have ``PROFILE_POINTS`` elements.
            Radii are normalised: 0.0 = centre, 1.0 = wall.
        """
        r_norm = np.linspace(0.0, 1.0, self.PROFILE_POINTS)

        if v_mean == 0:
            return r_norm.tolist(), np.zeros_like(r_norm).tolist()

        if re < self.RE_LAMINAR_LIMIT:
            # Laminar: parabolic — v_max = 2·v_mean at centre
            v_max = 2.0 * v_mean
            v_profile = v_max * (1.0 - r_norm ** 2)
        else:
            # Turbulent: power-law, n ≈ 7
            n = 7.0
            # Correction factor so average integrates to v_mean
            # For power law: v_avg = v_max · 2n²/((n+1)(2n+1))
            correction = 2 * n ** 2 / ((n + 1) * (2 * n + 1))
            v_max = v_mean / correction
            v_profile = v_max * (1.0 - r_norm) ** (1.0 / n)
            # At the wall (r=1), velocity → 0 by no-slip condition
            v_profile[-1] = 0.0

        return r_norm.tolist(), v_profile.tolist()

    # ------------------------------------------------------------------
    # Step 7 — Pressure Drop Sweep (for Plotly chart)
    # ------------------------------------------------------------------

    def _pressure_drop_sweep(self) -> tuple[list[float], list[float]]:
        """
        Compute pressure drop for a range of flow rates from near-zero to
        3× the current operating flow rate.

        Returns ``SWEEP_POINTS`` (Q, ΔP) pairs for plotting.
        """
        q_max = max(self.inp.flow_rate_m3_s * 3.0, 1e-6)  # at least 1 µL/s
        q_values = np.linspace(1e-9, q_max, self.SWEEP_POINTS)

        area_m2 = math.pi * (self.inp.diameter_m / 2) ** 2
        dp_values = []

        for q in q_values:
            v = float(q) / area_m2
            re = self._reynolds_number(v)
            eD = self.inp.roughness_m / self.inp.diameter_m

            if re < self.RE_LAMINAR_LIMIT:
                ff = 64.0 / max(re, 1e-9)
            else:
                # Same correlation as _friction_factor, so the operating point
                # marker lands exactly on the plotted curve.
                ff = float(
                    fluids.friction.friction_factor(
                        Re=re, eD=eD, Method='Churchill_1977'
                    )
                )

            dp = fluids.dP_from_K(
                K=ff * (self.inp.length_m / self.inp.diameter_m),
                rho=self.inp.density_kg_m3,
                V=v,
            )
            dp_values.append(float(dp))

        return q_values.tolist(), dp_values

    # ------------------------------------------------------------------
    # Step 8 — Symbolic Hagen-Poiseuille (SymPy)
    # ------------------------------------------------------------------

    def _hagen_poiseuille_symbolic(self) -> str:
        """
        Return the exact Hagen-Poiseuille pressure drop equation as a
        LaTeX string using SymPy.

        ΔP = (128·μ·L·Q) / (π·D⁴)

        Substitutes the actual numerical values for display.
        """
        mu, L, Q_sym, D = sp.symbols('mu L Q D', positive=True)
        delta_p = (128 * mu * L * Q_sym) / (sp.pi * D ** 4)

        # Substitute numerical values
        delta_p_numerical = delta_p.subs({
            mu: self.inp.viscosity_pa_s,
            L:  self.inp.length_m,
            Q_sym: self.inp.flow_rate_m3_s,
            D:  self.inp.diameter_m,
        })

        # Return as LaTeX for MathJax rendering in the frontend
        return sp.latex(delta_p_numerical)
