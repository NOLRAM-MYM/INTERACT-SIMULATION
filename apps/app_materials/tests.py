"""
apps/app_materials/tests.py
=============================
Tests for the Materials & FEA beam deflection module.
"""

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from .services import BeamDeflectionService


@pytest.fixture
def api_client():
    return APIClient()


class TestBeamDeflectionService:
    def test_point_centre_matches_closed_form(self):
        svc = BeamDeflectionService(
            length_m=5.0, youngs_modulus_gpa=200.0,
            second_moment_m4=8.33e-6, load_kn=50.0, load_type='point_centre',
        )
        result = svc.compute()
        EI = 200e9 * 8.33e-6
        expected_mm = (50000 * 5.0 ** 3 / (48 * EI)) * 1000
        assert result['max_deflection_mm'] == pytest.approx(expected_mm, rel=1e-6)
        assert result['load_type'] == 'point_centre'

    def test_uniform_matches_closed_form(self):
        svc = BeamDeflectionService(
            length_m=4.0, youngs_modulus_gpa=70.0,
            second_moment_m4=2.0e-5, load_kn=20.0, load_type='uniform',
        )
        result = svc.compute()
        EI = 70e9 * 2.0e-5
        q = 20000 / 4.0
        expected_mm = (5 * q * 4.0 ** 4 / (384 * EI)) * 1000
        assert result['max_deflection_mm'] == pytest.approx(expected_mm, rel=1e-6)

    def test_cantilever_point_matches_closed_form(self):
        svc = BeamDeflectionService(
            length_m=5.0, youngs_modulus_gpa=200.0,
            second_moment_m4=8.33e-6, load_kn=50.0, load_type='cantilever_point',
        )
        result = svc.compute()
        EI = 200e9 * 8.33e-6
        expected_mm = (50000 * 5.0 ** 3 / (3 * EI)) * 1000
        assert result['max_deflection_mm'] == pytest.approx(expected_mm, rel=1e-6)

    def test_cantilever_uniform_matches_closed_form(self):
        svc = BeamDeflectionService(
            length_m=4.0, youngs_modulus_gpa=70.0,
            second_moment_m4=2.0e-5, load_kn=20.0, load_type='cantilever_uniform',
        )
        result = svc.compute()
        EI = 70e9 * 2.0e-5
        q = 20000 / 4.0
        expected_mm = (q * 4.0 ** 4 / (8 * EI)) * 1000
        assert result['max_deflection_mm'] == pytest.approx(expected_mm, rel=1e-6)

    def test_cantilever_point_deflects_more_than_simply_supported(self):
        """A cantilever with a free end always deflects more than a simply
        supported beam under the same magnitude point load (PL^3/3EI > PL^3/48EI)."""
        common = dict(length_m=5.0, youngs_modulus_gpa=200.0,
                      second_moment_m4=8.33e-6, load_kn=50.0)
        simply_supported = BeamDeflectionService(**common, load_type='point_centre').compute()
        cantilever = BeamDeflectionService(**common, load_type='cantilever_point').compute()
        assert cantilever['max_deflection_mm'] > simply_supported['max_deflection_mm']

    def test_unsupported_load_type_raises(self):
        svc = BeamDeflectionService(
            length_m=5.0, youngs_modulus_gpa=200.0,
            second_moment_m4=8.33e-6, load_kn=50.0, load_type='not_a_real_type',
        )
        with pytest.raises(ValueError):
            svc.compute()


class TestBeamDeflectionAPI:
    def test_valid_payload_returns_200(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": 5.0, "youngs_modulus_gpa": 200.0,
            "second_moment_m4": 8.33e-6, "load_kn": 50.0,
            "load_type": "point_centre",
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 200
        assert response.data["status"] == "success"
        assert response.data["data"]["max_deflection_mm"] > 0

    def test_cantilever_payload_returns_200(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": 3.0, "youngs_modulus_gpa": 200.0,
            "second_moment_m4": 5.0e-6, "load_kn": 10.0,
            "load_type": "cantilever_uniform",
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 200
        assert response.data["data"]["load_type"] == "cantilever_uniform"

    def test_negative_length_returns_400(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": -5.0, "youngs_modulus_gpa": 200.0,
            "second_moment_m4": 8.33e-6, "load_kn": 50.0,
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 400
        assert response.data["status"] == "error"
        assert "length_m" in response.data["errors"]

    def test_zero_second_moment_returns_400_not_500(self, api_client):
        """Regression test: I=0 must not cause a raw 500 (ZeroDivisionError in EI)."""
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": 5.0, "youngs_modulus_gpa": 200.0,
            "second_moment_m4": 0.0, "load_kn": 50.0,
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 400

    def test_negative_youngs_modulus_returns_400(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": 5.0, "youngs_modulus_gpa": -200.0,
            "second_moment_m4": 8.33e-6, "load_kn": 50.0,
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 400

    def test_invalid_load_type_returns_400(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {
            "length_m": 5.0, "youngs_modulus_gpa": 200.0,
            "second_moment_m4": 8.33e-6, "load_kn": 50.0,
            "load_type": "not_a_real_type",
        }
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 400


# ===========================================================================
# Moment, shear and stress — pinned by closed forms and by the deflection
# curve itself (M = −EI·w″), an independent path through the other formulas.
# ===========================================================================

import numpy as np  # noqa: E402

from .services import BeamDeflectionService as _Beam  # noqa: E402

_CASES = {
    # load_type: (peak |M| as a function of total load P [N] and span L)
    'point_centre':       lambda P, L: P * L / 4,
    'uniform':            lambda P, L: (P / L) * L ** 2 / 8,
    'cantilever_point':   lambda P, L: P * L,
    'cantilever_uniform': lambda P, L: (P / L) * L ** 2 / 2,
}


class TestBeamInternalForces:
    @pytest.mark.parametrize('load_type', list(_CASES))
    def test_peak_moment_matches_closed_form(self, load_type):
        res = _Beam(length_m=4.0, youngs_modulus_gpa=200, second_moment_m4=1e-5,
                    load_kn=10.0, load_type=load_type).compute()
        assert res['max_moment_nm'] == pytest.approx(_CASES[load_type](10_000.0, 4.0), rel=1e-3)

    @pytest.mark.parametrize('load_type', list(_CASES))
    def test_reactions_balance_the_load(self, load_type):
        r = _Beam(length_m=4.0, youngs_modulus_gpa=200, second_moment_m4=1e-5,
                  load_kn=10.0, load_type=load_type).compute()['reactions']
        assert r['left_n'] + r['right_n'] == pytest.approx(10_000.0)

    @pytest.mark.parametrize('load_type', list(_CASES))
    def test_moment_is_curvature_of_deflection(self, load_type):
        """w is downward, so sagging (M > 0) means w″ < 0: M = −EI·w″."""
        res = _Beam(length_m=4.0, youngs_modulus_gpa=200, second_moment_m4=1e-5,
                    load_kn=10.0, load_type=load_type).compute()
        x = np.array(res['x_positions_m'])
        w = np.array(res['deflection_m'])
        M = np.array(res['moment_nm'])
        curvature_moment = -res['EI_nm2'] * np.gradient(np.gradient(w, x), x)
        # Skip the ends (one-sided differences) and the kink under a point load.
        mask = np.ones_like(x, dtype=bool)
        mask[:3] = mask[-3:] = False
        if load_type == 'point_centre':
            mask &= np.abs(x - 2.0) > 0.15
        scale = np.max(np.abs(M))
        assert np.max(np.abs(curvature_moment[mask] - M[mask])) < 2e-3 * scale

    def test_rectangular_stress_and_safety_factor(self):
        """σ = M·c/I = 6M/(b·h²) for a b×h rectangle; SF = σy/σ."""
        b, h = 0.15, 0.30
        res = _Beam(length_m=5.0, youngs_modulus_gpa=200, second_moment_m4=b * h ** 3 / 12,
                    load_kn=50.0, load_type='point_centre',
                    extreme_fibre_m=h / 2, yield_strength_mpa=250).compute()
        sigma = 6 * (50_000 * 5.0 / 4) / (b * h ** 2) / 1e6
        assert res['max_stress_mpa'] == pytest.approx(sigma, rel=1e-9)
        assert res['safety_factor'] == pytest.approx(250 / sigma, rel=1e-9)

    def test_without_fibre_distance_there_is_no_stress(self):
        res = _Beam(length_m=5.0, youngs_modulus_gpa=200, second_moment_m4=1e-5,
                    load_kn=5.0).compute()
        assert res['max_stress_mpa'] is None and res['safety_factor'] is None

    def test_serviceability_limit(self):
        stiff = _Beam(length_m=5.0, youngs_modulus_gpa=200, second_moment_m4=1e-3, load_kn=5.0).compute()
        floppy = _Beam(length_m=5.0, youngs_modulus_gpa=200, second_moment_m4=1e-7, load_kn=5.0).compute()
        assert stiff['deflection_ok'] and not floppy['deflection_ok']
        assert floppy['span_deflection_ratio'] == pytest.approx(5.0 / (floppy['max_deflection_mm'] / 1000))

    def test_api_accepts_optional_stress_inputs(self, api_client):
        url = reverse('materials:beam-deflection')
        payload = {'length_m': 5, 'youngs_modulus_gpa': 200, 'second_moment_m4': 3.375e-4,
                   'load_kn': 50, 'load_type': 'uniform', 'extreme_fibre_m': 0.15, 'yield_strength_mpa': 250}
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 200
        assert response.data['data']['safety_factor'] > 1
        payload.update(extreme_fibre_m=None, yield_strength_mpa=None)
        assert api_client.post(url, payload, format='json').status_code == 200
