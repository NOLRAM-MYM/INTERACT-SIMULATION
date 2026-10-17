"""
apps/app_physics/tests.py
==========================
Unit and integration tests for the Physics module.
"""

import pytest
from django.urls import reverse
from rest_framework.test import APIClient
from .services import ProjectileMotionService


@pytest.fixture
def standard_projectile_service():
    """Baseball at 45 degrees launched at 45 m/s."""
    return ProjectileMotionService(
        velocity_m_s=45.0,
        angle_deg=45.0,
        mass_kg=0.145,
        diameter_m=0.074,
        drag_coefficient=0.30
    )


@pytest.fixture
def api_client():
    return APIClient()


# ===========================================================================
# Service Tests
# ===========================================================================

class TestProjectileMotionService:
    def test_drag_reduces_range(self, standard_projectile_service):
        """Verify that atmospheric drag reduces the projectile range compared to vacuum."""
        result = standard_projectile_service.compute()
        stats = result['stats']
        
        assert stats['range_drag_m'] < stats['range_vacuum_m']
        assert stats['height_drag_m'] < stats['height_vacuum_m']
        assert stats['time_drag_s'] < stats['time_vacuum_s']

    def test_increasing_drag_coefficient(self):
        """Verify that higher drag coefficient further degrades the range."""
        service_low_drag = ProjectileMotionService(
            velocity_m_s=50.0, angle_deg=45.0, mass_kg=1.0, diameter_m=0.1, drag_coefficient=0.1
        )
        service_high_drag = ProjectileMotionService(
            velocity_m_s=50.0, angle_deg=45.0, mass_kg=1.0, diameter_m=0.1, drag_coefficient=1.0
        )
        
        res_low = service_low_drag.compute()
        res_high = service_high_drag.compute()
        
        assert res_high['stats']['range_drag_m'] < res_low['stats']['range_drag_m']
        assert res_high['stats']['height_drag_m'] < res_low['stats']['height_drag_m']


# ===========================================================================
# API Integration Tests
# ===========================================================================

class TestProjectileMotionAPI:
    def test_calculate_endpoint_success(self, api_client):
        """Test API successfully computes trajectory for valid payload."""
        url = reverse('physics:projectile-calculate')
        payload = {
            "velocity_m_s": 45.0,
            "angle_deg": 45.0,
            "mass_kg": 0.145,
            "diameter_m": 0.074,
            "drag_coefficient": 0.30
        }
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 200
        
        data = response.data
        assert data['status'] == 'success'
        assert 'x_vacuum' in data['data']
        assert 'x_drag' in data['data']
        assert 'stats' in data['data']
        assert data['data']['stats']['range_drag_m'] > 0

    def test_calculate_endpoint_invalid_angle(self, api_client):
        """Test API rejects out-of-bound launch angle."""
        url = reverse('physics:projectile-calculate')
        payload = {
            "velocity_m_s": 45.0,
            "angle_deg": 95.0,  # invalid angle (> 89.9)
            "mass_kg": 0.145,
            "diameter_m": 0.074,
            "drag_coefficient": 0.30
        }
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 400
        assert response.data['status'] == 'error'
        assert 'angle_deg' in response.data['errors']

    def test_calculate_endpoint_negative_mass(self, api_client):
        """Test API rejects negative mass."""
        url = reverse('physics:projectile-calculate')
        payload = {
            "velocity_m_s": 45.0,
            "angle_deg": 45.0,
            "mass_kg": -1.0,  # invalid negative mass
            "diameter_m": 0.074,
            "drag_coefficient": 0.30
        }
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 400
        assert response.data['status'] == 'error'
        assert 'mass_kg' in response.data['errors']


# ===========================================================================
# Magnetism and Motors Service & API Tests
# ===========================================================================

class TestMagnetismService:
    def test_compute_lorentz_charge(self):
        """Verify Lorentz trajectory calculations for positive/negative charge."""
        from .services import MagnetismService
        res_pos = MagnetismService.compute_lorentz(q_uc=10.0, m_mg=1.0, v0=[10.0, 10.0, 0.0], B=[0.0, 0.0, 1.0])
        res_neg = MagnetismService.compute_lorentz(q_uc=-10.0, m_mg=1.0, v0=[10.0, 10.0, 0.0], B=[0.0, 0.0, 1.0])

        assert len(res_pos['x']) > 0
        assert res_pos['stats']['larmor_radius_m'] > 0
        assert res_pos['stats']['cyclotron_frequency_hz'] > 0
        # Opposite charges must produce opposite force components
        assert res_pos['Fx'][0] == -res_neg['Fx'][0]
        assert res_pos['Fy'][0] == -res_neg['Fy'][0]

    def test_compute_poles_force(self):
        """Verify Coulomb magnetism poles force decays with 1/r^2."""
        from .services import MagnetismService
        res_close = MagnetismService.compute_poles(qm1=100.0, qm2=-100.0, r=0.1)
        res_far = MagnetismService.compute_poles(qm1=100.0, qm2=-100.0, r=0.2)

        # Force magnitude at 0.1m must be 4x higher than at 0.2m (quadratic decay)
        assert abs(res_close['stats']['force_n']) > abs(res_far['stats']['force_n'])
        assert pytest.approx(abs(res_close['stats']['force_n']), rel=1e-3) == 4.0 * abs(res_far['stats']['force_n'])
        assert res_close['stats']['type'] == 'Attraction'

        res_repulsive = MagnetismService.compute_poles(qm1=100.0, qm2=100.0, r=0.1)
        assert res_repulsive['stats']['type'] == 'Repulsion'

    def test_compute_motor_dynamics(self):
        """Verify DC Motor transient response simulation converges."""
        from .services import MagnetismService
        res = MagnetismService.compute_motor(
            V=24.0, R=2.0, L=0.05, J=0.02, b=0.005, Kt=0.5, Ke=0.5, tl=0.5
        )

        assert len(res['t']) > 0
        assert res['stats']['steady_state_speed_rpm'] > 0
        assert res['stats']['starting_current_a'] > 0
        assert res['stats']['max_efficiency_pct'] > 0
        assert res['stats']['settling_time_s'] < 1.5


class TestMagnetismAPI:
    def test_page_view_status_code(self, api_client):
        """Verify that the Magnetism & Motors dashboard template renders successfully."""
        url = reverse('physics:magnetism-index')
        response = api_client.get(url)
        assert response.status_code == 200

    def test_calculate_lorentz_api_success(self, api_client):
        """Verify Lorentz API succeeds with correct payload."""
        url = reverse('physics:magnetism-calculate')
        payload = {
            "mode": "lorentz",
            "q_uc": 10.0,
            "m_mg": 1.0,
            "vx": 10.0,
            "vy": 10.0,
            "vz": 0.0,
            "Bx": 0.0,
            "By": 0.0,
            "Bz": 1.0
        }
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 200
        assert response.data['status'] == 'success'
        assert 'x' in response.data['data']
        assert 'stats' in response.data['data']

    def test_calculate_motor_api_validation_error(self, api_client):
        """Verify API rejects invalid negative parameter inputs for DC motor."""
        url = reverse('physics:magnetism-calculate')
        payload = {
            "mode": "motor",
            "V": 24.0,
            "R": -1.0,  # Invalid negative resistance
            "L": 0.05,
            "J": 0.02,
            "b": 0.005,
            "Kt": 0.5,
            "Ke": 0.5,
            "tl": 0.5
        }
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 400
        assert response.data['status'] == 'error'
        assert 'R' in response.data['errors']



# ===========================================================================
# Values pinned by independent paths (closed forms), not just trends
# ===========================================================================

class TestProjectileClosedForms:
    def test_zero_drag_matches_vacuum_from_height(self):
        """With Cd = 0 the integrated flight must equal the analytic one."""
        res = ProjectileMotionService(
            velocity_m_s=30.0, angle_deg=35.0, mass_kg=1.0, diameter_m=0.1,
            drag_coefficient=0.0, launch_height_m=12.0,
        ).compute()['stats']
        assert res['range_drag_m'] == pytest.approx(res['range_vacuum_m'], rel=1e-6)
        assert res['height_drag_m'] == pytest.approx(res['height_vacuum_m'], rel=1e-3)
        assert res['time_drag_s'] == pytest.approx(res['time_vacuum_s'], rel=1e-6)

    def test_horizontal_throw_from_cliff(self):
        """Level launch from h: t = √(2h/g), range = v·t."""
        g, h, v = 9.80665, 20.0, 15.0
        res = ProjectileMotionService(
            velocity_m_s=v, angle_deg=0.0, mass_kg=1.0, diameter_m=0.1,
            drag_coefficient=0.0, launch_height_m=h,
        ).compute()['stats']
        t = (2 * h / g) ** 0.5
        assert res['time_vacuum_s'] == pytest.approx(t, rel=1e-9)
        assert res['range_drag_m'] == pytest.approx(v * t, rel=1e-6)

    def test_moon_without_air(self):
        """g = 1.62, ρ = 0: range = v²·sin(2θ)/g and no drag energy lost."""
        res = ProjectileMotionService(
            velocity_m_s=20.0, angle_deg=45.0, mass_kg=1.0, diameter_m=0.1,
            drag_coefficient=0.47, gravity_m_s2=1.62, air_density_kg_m3=0.0,
        ).compute()['stats']
        assert res['range_drag_m'] == pytest.approx(20.0 ** 2 / 1.62, rel=1e-6)
        assert res['terminal_velocity_m_s'] is None
        assert res['drag_energy_loss_j'] == pytest.approx(0.0, abs=1e-6)

    def test_long_drop_reaches_terminal_velocity(self):
        """Falling far enough, the impact speed is v_t = √(2mg / ρCdA)."""
        res = ProjectileMotionService(
            velocity_m_s=0.1, angle_deg=-89.9, mass_kg=0.145, diameter_m=0.074,
            drag_coefficient=0.30, launch_height_m=3000.0,
        ).compute()['stats']
        assert res['final_velocity_drag_m_s'] == pytest.approx(res['terminal_velocity_m_s'], rel=1e-3)
        # The drag flight outlasts the vacuum one here — no 100 s cap any more.
        assert res['time_drag_s'] > res['time_vacuum_s']

    def test_api_accepts_level_throw_only_from_height(self, api_client):
        url = reverse('physics:projectile-calculate')
        base = {"velocity_m_s": 10, "mass_kg": 1, "diameter_m": 0.1, "drag_coefficient": 0.47, "angle_deg": 0}
        assert api_client.post(url, {**base, "launch_height_m": 5}, format='json').status_code == 200
        response = api_client.post(url, base, format='json')
        assert response.status_code == 400
        assert 'angle_deg' in response.data['errors']


class TestMagnetismClosedForms:
    def test_fast_orbit_stays_on_larmor_circle(self):
        """q/m = 1000 C/kg at 1 T (T ≈ 6 ms) used to break the fixed 5 ms step."""
        from .services import MagnetismService
        res = MagnetismService.compute_lorentz(q_uc=1000.0, m_mg=1.0, v0=[10.0, 0.0, 0.0], B=[0.0, 0.0, 1.0])
        r = res['stats']['larmor_radius_m']
        assert r == pytest.approx(0.01)
        # Positive charge, v = +x, B = +z: F = q v×B points −y, so the centre is (0, −r).
        dist = [((x ** 2 + (y + r) ** 2) ** 0.5) for x, y in zip(res['x'], res['y'])]
        assert max(abs(d - r) for d in dist) < 1e-4 * r

    def test_motor_steady_state_matches_algebra(self):
        from .services import MagnetismService
        res = MagnetismService.compute_motor(V=24.0, R=2.0, L=0.05, J=0.02, b=0.005, Kt=0.5, Ke=0.5, tl=0.5)
        s = res['stats']
        kt = s['kt_eff']
        omega = (kt * 24.0 - 2.0 * 0.5) / (2.0 * 0.005 + kt * kt)
        assert s['steady_state_speed_rad_s'] == pytest.approx(omega, rel=1e-12)
        assert res['speed_rad_s'][-1] == pytest.approx(omega, rel=5e-3)
        # Kt = Ke closes the energy balance: P_elec = P_cu + P_fric + P_shaft.
        assert s['p_elec_w'] == pytest.approx(s['p_cu_w'] + s['p_fric_w'] + s['p_mech_w'], abs=0.03)
        assert not s['stalled'] and res['warnings'] == []

    def test_overloaded_motor_stalls_instead_of_reversing(self):
        """The 'Motor Bloqueado' preset used to spin backwards at ~860 RPM."""
        from .services import MagnetismService
        res = MagnetismService.compute_motor(V=12.0, R=3.0, L=0.05, J=0.05, b=0.005, Kt=0.4, Ke=0.4, tl=5.0)
        s = res['stats']
        assert s['stalled'] is True
        assert s['steady_state_speed_rpm'] == 0.0
        assert min(res['speed_rad_s']) == 0.0
        assert res['I'][-1] == pytest.approx(12.0 / 3.0, rel=1e-3)
        assert s['efficiency_steady_pct'] == 0.0
        assert res['warnings']

    def test_stiff_motor_stays_finite(self):
        """L/R = 0.5 ms next to J·R/(Kt·Ke) ≈ 2 s: fixed-step RK4 diverged here."""
        from .services import MagnetismService
        res = MagnetismService.compute_motor(V=36.0, R=1.5, L=0.001, J=0.4, b=0.01, Kt=0.7, Ke=0.7, tl=0.8)
        assert all(abs(v) < 1e6 for v in res['I'] + res['speed_rad_s'])
        assert res['stats']['t_end_s'] > 1.5  # horizon follows the slow mechanical constant
        assert res['speed_rad_s'][-1] == pytest.approx(res['stats']['steady_state_speed_rad_s'], rel=5e-3)

    def test_motor_api_rejects_negative_load(self, api_client):
        url = reverse('physics:magnetism-calculate')
        payload = {"mode": "motor", "V": 24, "R": 2, "L": 0.05, "J": 0.02, "b": 0.005, "Kt": 0.5, "Ke": 0.5, "tl": -1}
        response = api_client.post(url, payload, format='json')
        assert response.status_code == 400
        assert 'tl' in response.data['errors']
