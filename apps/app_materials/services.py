"""
apps/app_materials/services.py
================================
Structural & Finite Element Analysis (FEA) service layer.

Libraries:
    - numpy:   Deflection curve arrays

The header used to also list sfepy, scipy and pint; none of them are imported
here. The beam cases below are closed-form Euler-Bernoulli solutions, which need
no FEA engine and no sparse solver, and every value arrives already in SI from
the serializer, so there are no Quantities either.

Planned modules (scaffold):
    - BeamDeflectionService:   Euler-Bernoulli beam bending analysis
    - TrussAnalysisService:    2D/3D truss FEA (would need sfepy)
    - PlateStressService:      Thin plate theory + SfePy solver
"""

import logging
import numpy as np

logger = logging.getLogger(__name__)


class BeamDeflectionService:
    """
    Euler-Bernoulli beam deflection under point/distributed load.

    Governing equation: EI · d⁴w/dx⁴ = q(x)
    where E = Young's modulus, I = second moment of area, w = deflection.

    Supported ``load_type`` values (all simplified analytical solutions for
    uniform beams; SfePy would be used for complex geometries/loading):
        - 'point_centre':     simply-supported, point load at mid-span.
        - 'uniform':           simply-supported, uniformly distributed load.
        - 'cantilever_point':  fixed at x=0, point load at the free end (x=L).
        - 'cantilever_uniform':fixed at x=0, uniformly distributed load.
    """

    def __init__(
        self,
        length_m: float,
        youngs_modulus_gpa: float,
        second_moment_m4: float,
        load_kn: float,
        load_type: str = 'point_centre',
        extreme_fibre_m: float | None = None,
        yield_strength_mpa: float | None = None,
    ):
        self.L  = length_m
        self.E  = youngs_modulus_gpa * 1e9   # GPa → Pa
        self.I  = second_moment_m4
        self.P  = load_kn * 1000             # kN → N
        self.load_type = load_type
        # Distance from the neutral axis to the outermost fibre (h/2 for a
        # rectangle). Without it the stress cannot be computed, only the shape.
        self.c = extreme_fibre_m
        self.sigma_y = yield_strength_mpa * 1e6 if yield_strength_mpa else None

    def compute(self) -> dict:
        """
        Compute maximum deflection and deflection curve.

        Returns:
            dict with the deflection curve plus the bending-moment and shear
            diagrams (sagging moment positive), support reactions, and — when
            the extreme-fibre distance is known — bending stress and the
            safety factor against yield.
        """
        # Odd count so x = L/2 is a sample: the point load and the UDL peak sit there.
        n_points = 101
        x = np.linspace(0, self.L, n_points)
        EI = self.E * self.I

        if self.load_type == 'point_centre':
            # δ_max = PL³/(48EI) at centre (simply supported)
            delta_max = self.P * self.L ** 3 / (48 * EI)
            # Deflection curve: w(x) = Px/(48EI) * (3L² - 4x²) for x ≤ L/2
            w = np.where(
                x <= self.L / 2,
                self.P * x / (48 * EI) * (3 * self.L ** 2 - 4 * x ** 2),
                self.P * (self.L - x) / (48 * EI) * (3 * self.L ** 2 - 4 * (self.L - x) ** 2),
            )
            # Reactions P/2; M = P·x/2 rising to PL/4 under the load.
            M = np.where(x <= self.L / 2, self.P * x / 2, self.P * (self.L - x) / 2)
            V = np.where(x < self.L / 2, self.P / 2, -self.P / 2)
            reactions = {'left_n': self.P / 2, 'right_n': self.P / 2, 'fixed_moment_nm': 0.0}
        elif self.load_type == 'uniform':
            # Uniform distributed load: δ_max = 5qL⁴/(384EI)
            #
            # NOTE: for the two distributed cases `load_kn` is the TOTAL load
            # spread over the span, not an intensity — q is recovered by
            # dividing by L. For the point cases it is the force itself. Same
            # field, two meanings; the serializer's help text says so.
            q = self.P / self.L   # N/m
            delta_max = 5 * q * self.L ** 4 / (384 * EI)
            # w(x) = qx/(24EI) * (L³ - 2Lx² + x³)
            w = q * x / (24 * EI) * (self.L ** 3 - 2 * self.L * x ** 2 + x ** 3)
            # M = qx(L − x)/2, peak qL²/8 at mid-span; V = q(L/2 − x).
            M = q * x * (self.L - x) / 2
            V = q * (self.L / 2 - x)
            reactions = {'left_n': q * self.L / 2, 'right_n': q * self.L / 2, 'fixed_moment_nm': 0.0}
        elif self.load_type == 'cantilever_point':
            # Fixed at x=0, point load P at the free end (x=L).
            # δ_max = PL³/(3EI) at the free end.
            # w(x) = Px²(3L - x)/(6EI)
            delta_max = self.P * self.L ** 3 / (3 * EI)
            w = self.P * x ** 2 * (3 * self.L - x) / (6 * EI)
            # Hogging: M = −P(L − x), −PL at the wall; V = P throughout.
            M = -self.P * (self.L - x)
            V = np.full_like(x, self.P)
            reactions = {'left_n': self.P, 'right_n': 0.0, 'fixed_moment_nm': self.P * self.L}
        elif self.load_type == 'cantilever_uniform':
            # Fixed at x=0, uniformly distributed load q over the span.
            # δ_max = qL⁴/(8EI) at the free end.
            # w(x) = qx²(x² - 4Lx + 6L²)/(24EI)
            q = self.P / self.L   # N/m
            delta_max = q * self.L ** 4 / (8 * EI)
            w = q * x ** 2 * (x ** 2 - 4 * self.L * x + 6 * self.L ** 2) / (24 * EI)
            # Hogging: M = −q(L − x)²/2, −qL²/2 at the wall; V = q(L − x).
            M = -q * (self.L - x) ** 2 / 2
            V = q * (self.L - x)
            reactions = {'left_n': q * self.L, 'right_n': 0.0, 'fixed_moment_nm': q * self.L ** 2 / 2}
        else:
            raise ValueError(f"Unsupported load_type: {self.load_type!r}")

        max_moment = float(np.max(np.abs(M)))
        max_shear = float(np.max(np.abs(V)))

        # Serviceability: span/deflection ratio against the usual L/250 limit
        # for beams (L/180 for cantilevers, which are judged on their tip).
        limit_ratio = 180 if self.load_type.startswith('cantilever') else 250
        span_ratio = self.L / delta_max if delta_max > 0 else None

        result = {
            'x_positions_m': x.tolist(),
            'deflection_m': w.tolist(),
            'moment_nm': M.tolist(),
            'shear_n': V.tolist(),
            'max_deflection_mm': float(delta_max * 1000),
            'max_moment_nm': max_moment,
            'max_shear_n': max_shear,
            'reactions': reactions,
            'span_deflection_ratio': span_ratio,
            'deflection_limit_ratio': limit_ratio,
            'deflection_ok': span_ratio is None or span_ratio >= limit_ratio,
            'EI_nm2': float(EI),
            'load_type': self.load_type,
            'stress_mpa': None,
            'max_stress_mpa': None,
            'safety_factor': None,
        }

        if self.c:
            # Navier: σ = M·c / I at the outermost fibre.
            result['stress_mpa'] = (M * self.c / self.I / 1e6).tolist()
            sigma_max = max_moment * self.c / self.I
            result['max_stress_mpa'] = sigma_max / 1e6
            if self.sigma_y and sigma_max > 0:
                result['safety_factor'] = self.sigma_y / sigma_max

        return result
