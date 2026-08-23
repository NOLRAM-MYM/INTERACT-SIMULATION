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
    ):
        self.L  = length_m
        self.E  = youngs_modulus_gpa * 1e9   # GPa → Pa
        self.I  = second_moment_m4
        self.P  = load_kn * 1000             # kN → N
        self.load_type = load_type

    def compute(self) -> dict:
        """
        Compute maximum deflection and deflection curve.

        Returns:
            dict with x_positions, deflection_profile, max_deflection_mm
        """
        n_points = 100
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
        elif self.load_type == 'cantilever_point':
            # Fixed at x=0, point load P at the free end (x=L).
            # δ_max = PL³/(3EI) at the free end.
            # w(x) = Px²(3L - x)/(6EI)
            delta_max = self.P * self.L ** 3 / (3 * EI)
            w = self.P * x ** 2 * (3 * self.L - x) / (6 * EI)
        elif self.load_type == 'cantilever_uniform':
            # Fixed at x=0, uniformly distributed load q over the span.
            # δ_max = qL⁴/(8EI) at the free end.
            # w(x) = qx²(x² - 4Lx + 6L²)/(24EI)
            q = self.P / self.L   # N/m
            delta_max = q * self.L ** 4 / (8 * EI)
            w = q * x ** 2 * (x ** 2 - 4 * self.L * x + 6 * self.L ** 2) / (24 * EI)
        else:
            raise ValueError(f"Unsupported load_type: {self.load_type!r}")

        return {
            'x_positions_m': x.tolist(),
            'deflection_m': w.tolist(),
            'max_deflection_mm': float(delta_max * 1000),
            'EI_nm2': float(EI),
            'load_type': self.load_type,
        }
