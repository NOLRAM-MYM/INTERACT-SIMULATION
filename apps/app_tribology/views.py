"""
apps/app_tribology/views.py
===========================
Views and API controllers for the Tribology module.
"""

import logging

from django.views.generic import TemplateView
from rest_framework.views import APIView
from rest_framework import serializers, status
from apps.core.responses import (
    computation_error_response,
    success_response,
    error_response,
)
from apps.core.schema import SerializerSchemaView
from .services import TribologyService

logger = logging.getLogger(__name__)


class TribologyPageView(TemplateView):
    """Serves the main Tribology and Gears simulation page."""
    template_name = 'app_tribology/index.html'


class TribologyInputSerializer(serializers.Serializer):
    """Validates physical input parameters for gear and EHL calculation."""

    schema_title = "Gear Geometry & EHL Lubrication"
    schema_description = (
        "Spur gear geometry (AGMA/ISO) plus elastohydrodynamic minimum film "
        "thickness and the resulting Lambda lubrication regime."
    )
    schema_field_meta = {
        'module_mm':      {'label': "Gear Module (m)",       'step': 0.1},
        'pinion_teeth':   {'label': "Pinion Teeth (z₁)",     'step': 1, 'unit': "count"},
        'gear_teeth':     {'label': "Gear Teeth (z₂)",       'step': 1, 'unit': "count"},
        'pinion_rpm':     {'label': "Pinion Speed",          'step': 10.0},
        'viscosity_pa_s': {'label': "Lubricant Viscosity",   'step': 0.001},
        'roughness_um':   {'label': "Composite Roughness",   'step': 0.01},
        # Labelled "Normal Load" before, but the service stores it as F_t and
        # divides by cos(phi) to *derive* the normal load — so a user entering
        # the true tooth-normal force had it inflated by 1/cos(20 deg). The
        # tangential force at the pitch circle is also what a gear datasheet
        # quotes (T / r), so name the field for what the maths actually uses.
        'load_n':         {'label': "Tangential Load (Fₜ)",  'step': 1.0},
        'pressure_angle_deg': {'label': "Pressure Angle (φ)",  'step': 0.5},
        'face_width_mm':      {'label': "Face Width (b)",      'step': 1.0},
        'pinion_youngs_modulus_gpa': {'label': "Pinion Young's Modulus", 'step': 1.0},
        'pinion_poissons_ratio':     {'label': "Pinion Poisson's Ratio", 'step': 0.01, 'unit': None},
        'gear_youngs_modulus_gpa':   {'label': "Gear Young's Modulus",   'step': 1.0},
        'gear_poissons_ratio':       {'label': "Gear Poisson's Ratio",   'step': 0.01, 'unit': None},
    }

    module_mm = serializers.FloatField(default=3.0, min_value=0.1, max_value=50.0)
    pinion_teeth = serializers.IntegerField(default=20, min_value=5, max_value=500)
    gear_teeth = serializers.IntegerField(default=40, min_value=5, max_value=500)
    pinion_rpm = serializers.FloatField(default=1500.0, min_value=0.0, max_value=20000.0)
    viscosity_pa_s = serializers.FloatField(default=0.04, min_value=0.001, max_value=100.0)
    roughness_um = serializers.FloatField(default=0.5, min_value=0.01, max_value=50.0)
    load_n = serializers.FloatField(default=2000.0, min_value=1.0, max_value=1000000.0)

    # Gear geometry that the service has always used but never received: both
    # were constructor defaults with no serializer field and no value passed by
    # the view, so every result silently assumed a 20 deg pressure angle and a
    # 20 mm face width. Face width feeds the dimensionless load W directly
    # (w_param = F/(E'*R'*b)), so it changes h_min for real.
    pressure_angle_deg = serializers.FloatField(default=20.0, min_value=10.0, max_value=35.0)
    face_width_mm = serializers.FloatField(default=20.0, min_value=1.0, max_value=1000.0)

    # Pinion/gear material properties — default to steel-on-steel (210 GPa,
    # ν=0.3) for backward compatibility with callers that don't specify a
    # material pair.
    pinion_youngs_modulus_gpa = serializers.FloatField(default=210.0, min_value=1.0, max_value=1000.0)
    pinion_poissons_ratio = serializers.FloatField(default=0.3, min_value=0.0, max_value=0.5)
    gear_youngs_modulus_gpa = serializers.FloatField(default=210.0, min_value=1.0, max_value=1000.0)
    gear_poissons_ratio = serializers.FloatField(default=0.3, min_value=0.0, max_value=0.5)


class TribologyCalculateView(APIView):
    """
    POST /api/tribology/calculate/
    Processes spur gear parameters and returns EHL lubrication status and speed sweeps.
    """

    def post(self, request, *args, **kwargs):
        serializer = TribologyInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid input parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        try:
            service = TribologyService(
                module_mm=data['module_mm'],
                pinion_teeth=data['pinion_teeth'],
                gear_teeth=data['gear_teeth'],
                pinion_rpm=data['pinion_rpm'],
                viscosity_pa_s=data['viscosity_pa_s'],
                roughness_um=data['roughness_um'],
                load_n=data['load_n'],
                pressure_angle_deg=data['pressure_angle_deg'],
                face_width_mm=data['face_width_mm'],
                youngs_modulus_gpa=data['pinion_youngs_modulus_gpa'],
                poissons_ratio=data['pinion_poissons_ratio'],
                gear_youngs_modulus_gpa=data['gear_youngs_modulus_gpa'],
                gear_poissons_ratio=data['gear_poissons_ratio'],
            )
            result = service.compute()
            return success_response(result)
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="TribologyCalculateView",
                view_logger=logger,
            )


class TribologySchemaView(SerializerSchemaView):
    """GET /api/tribology/schema/ — form schema for the gear/EHL solver."""
    serializer_class = TribologyInputSerializer
