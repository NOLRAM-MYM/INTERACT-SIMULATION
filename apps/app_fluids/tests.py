"""
apps/app_fluids/tests.py
=========================
Unit and integration tests for the Fluid Mechanics module.

Run: pytest apps/app_fluids/ -v
  or: python manage.py test apps.app_fluids
"""

import json
import math

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from .services import PipeFlowInput, PipeFlowService


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def water_pipe_input():
    """Standard water pipe scenario: 50mm diameter, 100m length, 120 L/min."""
    return PipeFlowInput(
        diameter_m     = 0.050,
        length_m       = 100.0,
        roughness_m    = 0.000046,  # 0.046 mm — commercial steel
        density_kg_m3  = 998.2,
        viscosity_pa_s = 0.001002,  # Water at 20°C
        flow_rate_m3_s = 120 / 60000,  # 120 L/min → 0.002 m³/s
    )


@pytest.fixture
def laminar_pipe_input():
    """Viscous oil in small pipe — guaranteed laminar (Re << 2300)."""
    return PipeFlowInput(
        diameter_m     = 0.010,    # 10mm
        length_m       = 5.0,
        roughness_m    = 0.0,      # Smooth
        density_kg_m3  = 888.0,   # Engine oil
        viscosity_pa_s = 0.1,     # 100 mPa·s
        flow_rate_m3_s = 1e-6,    # 1 mL/s — very slow
    )


@pytest.fixture
def api_client():
    return APIClient()


# ===========================================================================
# Service Tests — Reynolds Number
# ===========================================================================

class TestReynoldsNumber:
    def test_turbulent_water_pipe(self, water_pipe_input):
        """Standard water pipe should be turbulent (Re >> 4000)."""
        service = PipeFlowService(water_pipe_input)
        result  = service.compute()
        assert result.reynolds_number > 4000
        assert result.flow_regime == 'Turbulent'

    def test_laminar_flow(self, laminar_pipe_input):
        """Viscous oil at low flow rate should be laminar (Re < 2300)."""
        service = PipeFlowService(laminar_pipe_input)
        result  = service.compute()
        assert result.reynolds_number < 2300
        assert result.flow_regime == 'Laminar'

    def test_zero_flow_gives_zero_reynolds(self, water_pipe_input):
        water_pipe_input.flow_rate_m3_s = 0.0
        service = PipeFlowService(water_pipe_input)
        result  = service.compute()
        assert result.reynolds_number == 0.0
        assert result.velocity_m_s == 0.0


# ===========================================================================
# Service Tests — Friction Factor
# ===========================================================================

class TestFrictionFactor:
    def test_laminar_friction_factor_exact(self, laminar_pipe_input):

        """Laminar friction factor must be exactly 64/Re (Hagen-Poiseuille)."""
        service = PipeFlowService(laminar_pipe_input)
        result  = service.compute()
        
        # Calculate unrounded Reynolds number for exact comparison
        area = math.pi * (laminar_pipe_input.diameter_m / 2) ** 2
        velocity = laminar_pipe_input.flow_rate_m3_s / area
        re_unrounded = (laminar_pipe_input.density_kg_m3 * velocity * laminar_pipe_input.diameter_m) / laminar_pipe_input.viscosity_pa_s
        
        expected_ff = 64.0 / re_unrounded
        assert abs(result.friction_factor - expected_ff) < 1e-6

    def test_turbulent_friction_factor_range(self, water_pipe_input):
        """Turbulent friction factor for commercial steel should be in [0.01, 0.05]."""
        service = PipeFlowService(water_pipe_input)
        result  = service.compute()
        assert 0.01 < result.friction_factor < 0.05

    def test_smooth_pipe_lower_friction(self, water_pipe_input):
        """Smooth pipe (ε→0) must have lower friction factor than rough pipe."""
        rough_input = water_pipe_input

        smooth_input = PipeFlowInput(
            **{**water_pipe_input.__dict__, 'roughness_m': 0.0}
        )
        # rough
        r_rough = PipeFlowService(rough_input).compute()
        # smooth
        r_smooth = PipeFlowService(smooth_input).compute()
        assert r_smooth.friction_factor <= r_rough.friction_factor


# ===========================================================================
# Service Tests — Pressure Drop
# ===========================================================================

class TestPressureDrop:
    def test_pressure_drop_positive_for_positive_flow(self, water_pipe_input):
        """Non-zero flow must produce a positive pressure drop."""
        result = PipeFlowService(water_pipe_input).compute()
        assert result.pressure_drop_total_pa > 0

    def test_zero_flow_zero_pressure_drop(self, water_pipe_input):
        water_pipe_input.flow_rate_m3_s = 0.0
        result = PipeFlowService(water_pipe_input).compute()
        assert result.pressure_drop_total_pa == 0.0

    def test_pressure_drop_scales_with_length(self, water_pipe_input):
        """Doubling pipe length must approximately double major pressure drop."""
        result_base  = PipeFlowService(water_pipe_input).compute()

        long_input = PipeFlowInput(**{**water_pipe_input.__dict__, 'length_m': 200.0})
        result_long = PipeFlowService(long_input).compute()

        ratio = result_long.pressure_drop_major_pa / result_base.pressure_drop_major_pa
        assert abs(ratio - 2.0) < 0.01  # Within 1%

    def test_laminar_hagen_poiseuille_consistency(self, laminar_pipe_input):
        """
        For laminar flow, ΔP from service must match Hagen-Poiseuille exactly:
        ΔP = 128·μ·L·Q / (π·D⁴)
        """
        inp = laminar_pipe_input
        expected_dp = (
            128 * inp.viscosity_pa_s * inp.length_m * inp.flow_rate_m3_s
            / (math.pi * inp.diameter_m ** 4)
        )
        result = PipeFlowService(inp).compute()
        relative_error = abs(result.pressure_drop_major_pa - expected_dp) / expected_dp
        assert relative_error < 0.005  # within 0.5%


# ===========================================================================
# Service Tests — Velocity Profile
# ===========================================================================

class TestVelocityProfile:
    def test_laminar_profile_centre_is_max(self, laminar_pipe_input):
        """Laminar (parabolic) profile: velocity at centre > velocity at wall."""
        result = PipeFlowService(laminar_pipe_input).compute()
        assert result.velocity_profile[0] > result.velocity_profile[-1]

    def test_wall_velocity_near_zero(self, water_pipe_input):
        """No-slip condition: wall velocity must be ~0 (or very small)."""
        result = PipeFlowService(water_pipe_input).compute()
        assert result.velocity_profile[-1] < result.velocity_profile[0] * 0.01

    def test_profile_length_matches_schema(self, water_pipe_input):
        """Profile arrays must have PROFILE_POINTS elements."""
        result = PipeFlowService(water_pipe_input).compute()
        assert len(result.radial_positions) == PipeFlowService.PROFILE_POINTS
        assert len(result.velocity_profile)  == PipeFlowService.PROFILE_POINTS


class TestRegimeConsistency:
    """
    The friction factor and the velocity profile must agree about whether the
    flow is laminar. They used to branch on different thresholds — friction on
    RE_LAMINAR_LIMIT (2300), profile on RE_TURBULENT_LIMIT (4000) — so between
    those two values one response carried a turbulent Churchill friction factor
    next to a fully parabolic laminar profile, and the page drew two charts that
    contradicted each other.

    The profile shape is the discriminator: parabolic puts the centreline at
    exactly 2x the mean, the 1/7 power law at about 1.22x.
    """

    @staticmethod
    def _transition_input():
        """Water in a 50 mm pipe, sized to land inside 2300 <= Re < 4000."""
        return PipeFlowInput(
            diameter_m     = 0.050,
            length_m       = 10.0,
            roughness_m    = 0.000045,
            density_kg_m3  = 998.2,
            viscosity_pa_s = 0.001002,
            flow_rate_m3_s = 7.1 / 60000,
        )

    def test_scenario_really_is_in_the_transition_band(self):
        result = PipeFlowService(self._transition_input()).compute()
        assert PipeFlowService.RE_LAMINAR_LIMIT <= result.reynolds_number
        assert result.reynolds_number < PipeFlowService.RE_TURBULENT_LIMIT
        assert result.flow_regime == 'Transition'

    def test_transition_profile_is_not_laminar_parabolic(self):
        result = PipeFlowService(self._transition_input()).compute()
        centreline_ratio = result.velocity_profile[0] / result.velocity_m_s
        assert centreline_ratio == pytest.approx(1.2245, abs=1e-3), (
            "transition-zone profile fell back to the laminar parabola while "
            "the friction factor used the turbulent correlation"
        )

    def test_transition_friction_factor_uses_the_turbulent_correlation(self):
        result = PipeFlowService(self._transition_input()).compute()
        assert result.friction_method.startswith('Churchill')
        # 64/Re is the laminar value; the turbulent correlation is well above it
        # at this Reynolds number, so a mismatch here is unambiguous.
        assert result.friction_factor > 64.0 / result.reynolds_number

    def test_laminar_side_of_the_threshold_stays_parabolic(self, laminar_pipe_input):
        result = PipeFlowService(laminar_pipe_input).compute()
        assert result.reynolds_number < PipeFlowService.RE_LAMINAR_LIMIT
        centreline_ratio = result.velocity_profile[0] / result.velocity_m_s
        assert centreline_ratio == pytest.approx(2.0, abs=1e-2)


class TestFrictionCorrelationIsExplicit:
    def test_churchill_is_requested_by_name(self, water_pipe_input):
        """
        friction_factor() defaults to Clamond, so omitting Method returned a
        Clamond value under the 'Churchill (1977)' label this service reports
        to the UI. Compare against the library called explicitly both ways.
        """
        import fluids

        result = PipeFlowService(water_pipe_input).compute()
        eD = water_pipe_input.roughness_m / water_pipe_input.diameter_m
        churchill = fluids.friction.friction_factor(
            Re=result.reynolds_number, eD=eD, Method='Churchill_1977'
        )
        clamond = fluids.friction.friction_factor(Re=result.reynolds_number, eD=eD)

        # The service rounds to 8 decimals, so match loosely enough to survive
        # that but tightly enough to tell the two correlations apart — they
        # differ by ~0.7% here, four orders of magnitude above this tolerance.
        assert result.friction_factor == pytest.approx(churchill, rel=1e-6)
        assert result.friction_factor != pytest.approx(clamond, rel=1e-4)
        assert 'Churchill' in result.friction_method

    def test_sweep_uses_the_same_correlation_as_the_operating_point(self, water_pipe_input):
        """
        The chart draws the sweep and marks the operating point on it. If the
        two use different correlations the marker sits off the curve.
        """
        import numpy as np

        result = PipeFlowService(water_pipe_input).compute()
        q = np.array(result.sweep_flow_rates_m3_s)
        dp = np.array(result.sweep_pressure_drops_pa)
        interpolated = float(np.interp(water_pipe_input.flow_rate_m3_s, q, dp))
        assert interpolated == pytest.approx(
            result.pressure_drop_total_bar * 1e5, rel=0.02
        )


# ===========================================================================
# API Integration Tests
# ===========================================================================

@pytest.mark.django_db
class TestPipeFlowAPI:
    BASE_URL = '/api/fluids/pipe-flow/calculate/'
    VALID_PAYLOAD = {
        "diameter_mm": 50.0,
        "length_m": 100.0,
        "roughness_mm": 0.046,
        "density_kg_m3": 998.2,
        "viscosity_mpa_s": 1.002,
        "flow_rate_lpm": 120.0,
        "num_elbows_90": 2,
        "num_gate_valves_open": 0,
        "num_check_valves": 0,
    }

    def test_valid_request_returns_200(self, api_client):
        response = api_client.post(self.BASE_URL, self.VALID_PAYLOAD, format='json')
        assert response.status_code == 200
        data = response.json()
        assert data['status'] == 'success'
        assert 'reynolds_number' in data['data']

    def test_negative_flow_rate_rejected(self, api_client):
        payload = {**self.VALID_PAYLOAD, 'flow_rate_lpm': -10.0}
        response = api_client.post(self.BASE_URL, payload, format='json')
        assert response.status_code == 400
        assert response.json()['status'] == 'error'

    def test_sub_absolute_zero_temperature_not_applicable(self, api_client):
        """Pipe flow inputs don't have temperature — ensure unknown fields are ignored."""
        payload = {**self.VALID_PAYLOAD, 'temperature_c': -500.0}
        response = api_client.post(self.BASE_URL, payload, format='json')
        # Extra fields are ignored; should still succeed
        assert response.status_code == 200

    def test_zero_diameter_rejected(self, api_client):
        payload = {**self.VALID_PAYLOAD, 'diameter_mm': 0.0}
        response = api_client.post(self.BASE_URL, payload, format='json')
        assert response.status_code == 400

    def test_roughness_exceeds_radius_rejected(self, api_client):
        """Roughness ≥ pipe radius must be rejected (physically blocked pipe)."""
        payload = {**self.VALID_PAYLOAD, 'diameter_mm': 10.0, 'roughness_mm': 6.0}
        response = api_client.post(self.BASE_URL, payload, format='json')
        assert response.status_code == 400

    def test_schema_endpoint(self, api_client):
        response = api_client.get('/api/fluids/pipe-flow/schema/')
        assert response.status_code == 200
        data = response.json()
        assert data['status'] == 'success'
        assert 'fields' in data['data']
        assert len(data['data']['fields']) > 0
