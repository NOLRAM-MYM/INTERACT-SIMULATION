"""
apps/app_tribology/tests.py
===========================
Unit and integration tests for the Tribology and Gears module.
"""

import math

from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase

from .services import TribologyService


class TribologyNumericalTests(TestCase):
    """Verifies gear design calculations and EHL lubrication status logic."""

    def test_gear_geometry(self):
        """Checks pitch diameters, gear ratio, and center distance calculations."""
        service = TribologyService(
            module_mm=3.0,
            pinion_teeth=20,
            gear_teeth=40,
            pinion_rpm=1000.0,
            viscosity_pa_s=0.05,
            roughness_um=0.4,
            load_n=1000.0,
        )
        geom = service.compute_geometry()
        self.assertEqual(geom["pitch_diameter_pinion_mm"], 60.0)
        self.assertEqual(geom["pitch_diameter_gear_mm"], 120.0)
        self.assertEqual(geom["center_distance_mm"], 90.0)
        self.assertEqual(geom["gear_ratio"], 2.0)

    def test_ehl_regime_effects(self):
        """Verifies that faster rotational speed yields thicker oil film thickness."""
        service_slow = TribologyService(
            module_mm=3.0,
            pinion_teeth=20,
            gear_teeth=40,
            pinion_rpm=100.0,
            viscosity_pa_s=0.04,
            roughness_um=0.5,
            load_n=5000.0,
        )
        res_slow = service_slow.compute_ehl()

        service_fast = TribologyService(
            module_mm=3.0,
            pinion_teeth=20,
            gear_teeth=40,
            pinion_rpm=3000.0,
            viscosity_pa_s=0.04,
            roughness_um=0.5,
            load_n=5000.0,
        )
        res_fast = service_fast.compute_ehl()

        # Thicker oil film at higher speeds
        self.assertGreater(res_fast["h_min_um"], res_slow["h_min_um"])
        self.assertGreater(res_fast["lambda_parameter"], res_slow["lambda_parameter"])

    def test_entrainment_velocity_is_projected_onto_the_line_of_action(self):
        """
        At the pitch point the teeth roll without sliding, so the entrainment
        velocity is the pitch-circle speed projected onto the line of action:
        u = omega1 * r1 * sin(phi), the same sin(phi) already applied to the
        curvature radii.

        This used to return the unprojected pitch speed, overstating u by
        1/sin(phi) = 2.92 at the standard 20 deg pressure angle.
        """
        rpm, d1_mm, phi_deg = 1500.0, 60.0, 20.0
        service = TribologyService(
            module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=rpm,
            viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
        )
        res = service.compute_ehl()

        omega1 = 2.0 * math.pi * rpm / 60.0
        expected_u = omega1 * (d1_mm / 2000.0) * math.sin(math.radians(phi_deg))
        self.assertAlmostEqual(res["entrainment_velocity_m_s"], expected_u, places=9)

        # The unprojected pitch speed is still reported, and is strictly larger.
        self.assertAlmostEqual(
            res["pitch_line_velocity_m_s"], omega1 * (d1_mm / 2000.0), places=9
        )
        self.assertAlmostEqual(
            res["pitch_line_velocity_m_s"] / res["entrainment_velocity_m_s"],
            1.0 / math.sin(math.radians(phi_deg)),
            places=9,
        )

    def test_film_thickness_follows_dowson_higginson_from_the_projected_speed(self):
        """
        h_min/R' = 2.65 * U^0.7 * G^0.54 * W^-0.13, recomputed here from the
        dimensionless groups the service reports. Pins the magnitude, not just
        the trend: the sin(phi) bug inflated h_min by 2.92^0.7 = 2.1x, which is
        enough to move a gear pair from 'boundary' into 'mixed'.
        """
        service = TribologyService(
            module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=1500.0,
            viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
        )
        res = service.compute_ehl()

        expected_ratio = (
            2.65
            * res["u_dimensionless"] ** 0.7
            * res["g_dimensionless"] ** 0.54
            * res["w_dimensionless"] ** -0.13
        )
        expected_h_um = expected_ratio * res["equivalent_radius_m"] * 1e6
        self.assertAlmostEqual(res["h_min_um"], expected_h_um, places=9)

        # Lambda = h_min / composite roughness, so this pair is in boundary
        # lubrication. Under the old (inflated) speed it reported mixed.
        self.assertAlmostEqual(
            res["lambda_parameter"], res["h_min_um"] / 0.5, places=9
        )
        self.assertEqual(res["regime_code"], "boundary")

    def test_normal_load_is_derived_from_the_tangential_input(self):
        """
        `load_n` is the tangential force at the pitch circle; the tooth normal
        force along the line of action is F_t / cos(phi). The schema label used
        to say "Normal Load", which made users enter an already-normal force
        that then got inflated a second time.
        """
        service = TribologyService(
            module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=1500.0,
            viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
        )
        res = service.compute_ehl()
        self.assertAlmostEqual(
            res["normal_load_n"], 2000.0 / math.cos(math.radians(20.0)), places=9
        )

    def test_sweep_brackets_the_operating_speed(self):
        """
        The chart marks the operating point on the swept curve, so the sweep has
        to contain it. A fixed 100-5000 RPM window did not, for any of the
        speeds up to 20000 RPM the serializer accepts.
        """
        for rpm in (50.0, 1500.0, 12000.0, 20000.0):
            service = TribologyService(
                module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=rpm,
                viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
            )
            rpms = service.compute()["sweep"]["rpms"]
            self.assertLessEqual(min(rpms), rpm, f"{rpm} RPM is left of the sweep")
            self.assertGreaterEqual(max(rpms), rpm, f"{rpm} RPM is right of the sweep")

    def test_equal_materials_matches_legacy_single_material_result(self):
        """Explicit E1=E2=210GPa/nu=0.3 must reproduce the same result as
        omitting the gear material entirely (the pre-existing single-material
        behavior), since the legacy formula computed E/(1-nu^2) either way."""
        common = dict(
            module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=1500.0,
            viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
        )
        legacy = TribologyService(**common).compute_ehl()
        explicit_equal = TribologyService(
            **common, youngs_modulus_gpa=210.0, poissons_ratio=0.3,
            gear_youngs_modulus_gpa=210.0, gear_poissons_ratio=0.3,
        ).compute_ehl()
        self.assertAlmostEqual(legacy["h_min_um"], explicit_equal["h_min_um"], places=9)

    def test_dissimilar_materials_changes_film_thickness(self):
        """A steel pinion against a bronze gear (lower E) must yield a
        different film thickness than a steel-steel pair, since the
        Dowson-Higginson formula depends on the reduced elastic modulus E'."""
        common = dict(
            module_mm=3.0, pinion_teeth=20, gear_teeth=40, pinion_rpm=1500.0,
            viscosity_pa_s=0.04, roughness_um=0.5, load_n=2000.0,
        )
        steel_steel = TribologyService(
            **common, youngs_modulus_gpa=210.0, poissons_ratio=0.3,
            gear_youngs_modulus_gpa=210.0, gear_poissons_ratio=0.3,
        ).compute_ehl()
        steel_bronze = TribologyService(
            **common, youngs_modulus_gpa=210.0, poissons_ratio=0.3,
            gear_youngs_modulus_gpa=115.0, gear_poissons_ratio=0.34,
        ).compute_ehl()
        self.assertNotAlmostEqual(steel_steel["h_min_um"], steel_bronze["h_min_um"], places=6)


class TribologyAPITests(APITestCase):
    """Verifies that POST calculation endpoints validate parameters and handle errors."""

    def setUp(self):
        self.calc_url = reverse("tribology:tribology-calculate")

    def test_calculation_endpoint_success(self):
        """Checks successful API request returns correct JSON geometry and EHL structures."""
        payload = {
            "module_mm": 2.5,
            "pinion_teeth": 24,
            "gear_teeth": 48,
            "pinion_rpm": 1200.0,
            "viscosity_pa_s": 0.08,
            "roughness_um": 0.35,
            "load_n": 1500.0,
        }
        response = self.client.post(self.calc_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        
        data = response.data["data"]
        self.assertIn("geometry", data)
        self.assertIn("ehl", data)
        self.assertIn("sweep", data)
        
        # Verify geometry values
        self.assertEqual(data["geometry"]["pitch_diameter_pinion_mm"], 60.0)
        self.assertEqual(data["geometry"]["center_distance_mm"], 90.0)

    def test_calculation_endpoint_validation_error(self):
        """Checks negative/invalid inputs are rejected with 400 Bad Request."""
        payload = {
            "module_mm": -1.0,  # Negative modules are invalid
            "pinion_teeth": 15,
            "gear_teeth": 30,
            "pinion_rpm": 1500.0,
            "viscosity_pa_s": 0.04,
            "roughness_um": 0.4,
            "load_n": 2000.0,
        }
        response = self.client.post(self.calc_url, payload, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data["status"], "error")
