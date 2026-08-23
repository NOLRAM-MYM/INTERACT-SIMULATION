"""
apps/app_physics/views.py
==========================
Views for the Physics module.
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
from .services import ProjectileMotionService

logger = logging.getLogger(__name__)


class PhysicsPageView(TemplateView):
    """Serves the main Physics simulation HTML page."""
    template_name = 'app_physics/index.html'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['active_tab'] = 'projectile'
        return context


class ProjectileInputSerializer(serializers.Serializer):
    """Validates parameters for the projectile motion simulation."""

    schema_title = "Projectile Motion"
    schema_description = (
        "Numerical integration of a sphere launched under gravity with "
        "quadratic air drag."
    )
    schema_field_meta = {
        'velocity_m_s':     {'label': "Launch Speed",      'step': 0.1},
        'angle_deg':        {'label': "Launch Angle",      'step': 0.1},
        'mass_kg':          {'label': "Projectile Mass",   'step': 0.001},
        'diameter_m':       {'label': "Projectile Diameter", 'step': 0.001},
        'drag_coefficient': {'label': "Drag Coefficient (Cd)", 'step': 0.01, 'unit': None},
    }

    velocity_m_s = serializers.FloatField(default=20.0, min_value=0.1, max_value=1000.0)
    angle_deg = serializers.FloatField(default=45.0, min_value=0.1, max_value=89.9)
    mass_kg = serializers.FloatField(default=1.0, min_value=0.001, max_value=10000.0)
    diameter_m = serializers.FloatField(default=0.1, min_value=0.001, max_value=10.0)
    drag_coefficient = serializers.FloatField(default=0.47, min_value=0.0, max_value=5.0)


class ProjectileCalculateView(APIView):
    """
    POST /api/physics/projectile/calculate/
    Runs the numerical integration solver for projectile trajectories.
    """

    def post(self, request, *args, **kwargs):
        serializer = ProjectileInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid input parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        try:
            service = ProjectileMotionService(
                velocity_m_s=data['velocity_m_s'],
                angle_deg=data['angle_deg'],
                mass_kg=data['mass_kg'],
                diameter_m=data['diameter_m'],
                drag_coefficient=data['drag_coefficient']
            )
            result = service.compute()
            return success_response(result)
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="ProjectileCalculateView",
                view_logger=logger,
            )


class ProjectileSchemaView(SerializerSchemaView):
    """GET /api/physics/projectile/schema/ — form schema for the projectile solver."""
    serializer_class = ProjectileInputSerializer


class MagnetismPageView(TemplateView):
    """Serves the Magnetism & Motors simulation HTML page."""
    template_name = 'app_physics/index.html'

    def get_context_data(self, **kwargs):
        context = super().get_context_data(**kwargs)
        context['active_tab'] = 'magnetism'
        return context


class MagnetismInputSerializer(serializers.Serializer):
    """Validates parameters for the magnetism & motors simulations."""

    schema_title = "Magnetism & Motors"
    schema_description = (
        "Charged particle in a magnetic field (Lorentz), force between magnetic "
        "poles, and DC motor transient response."
    )
    schema_field_meta = {
        'mode': {'label': "Simulation Mode", 'unit': None},
        # Lorentz
        'q_uc': {'label': "Charge (q)"},
        'm_mg': {'label': "Particle Mass"},
        'vx':   {'label': "Velocity x", 'unit': "m/s"},
        'vy':   {'label': "Velocity y", 'unit': "m/s"},
        'vz':   {'label': "Velocity z", 'unit': "m/s"},
        'Bx':   {'label': "Field Bx", 'unit': "T"},
        'By':   {'label': "Field By", 'unit': "T"},
        'Bz':   {'label': "Field Bz", 'unit': "T"},
        # Poles
        'qm1': {'label': "Pole Strength 1", 'unit': "A·m"},
        'qm2': {'label': "Pole Strength 2", 'unit': "A·m"},
        'r':   {'label': "Pole Separation", 'unit': "m"},
        # Motor
        'V':  {'label': "Supply Voltage",     'unit': "V"},
        'R':  {'label': "Winding Resistance", 'unit': "Ω"},
        'L':  {'label': "Winding Inductance", 'unit': "H"},
        'J':  {'label': "Rotor Inertia",      'unit': "kg·m²"},
        'b':  {'label': "Viscous Friction",   'unit': "N·m·s"},
        'Kt': {'label': "Torque Constant",    'unit': "N·m/A"},
        'Ke': {'label': "Back-EMF Constant",  'unit': "V·s/rad"},
        'tl': {'label': "Load Torque",        'unit': "N·m"},
        'poles_count':     {'label': "Pole Count",       'unit': None, 'step': 1},
        'magnet_material': {'label': "Magnet Material",  'unit': None},
        'pole_span_deg':   {'label': "Pole Span",        'step': 1.0},
    }

    mode = serializers.ChoiceField(choices=['lorentz', 'poles', 'motor'])

    # Lorentz fields
    q_uc = serializers.FloatField(required=False, default=10.0)
    m_mg = serializers.FloatField(required=False, default=1.0)
    vx = serializers.FloatField(required=False, default=10.0)
    vy = serializers.FloatField(required=False, default=10.0)
    vz = serializers.FloatField(required=False, default=0.0)
    Bx = serializers.FloatField(required=False, default=0.0)
    By = serializers.FloatField(required=False, default=0.0)
    Bz = serializers.FloatField(required=False, default=1.0)

    # Pole fields
    qm1 = serializers.FloatField(required=False, default=100.0)
    qm2 = serializers.FloatField(required=False, default=-100.0)
    r = serializers.FloatField(required=False, default=0.2)

    # Motor fields
    V = serializers.FloatField(required=False, default=24.0)
    R = serializers.FloatField(required=False, default=2.0)
    L = serializers.FloatField(required=False, default=0.05)
    J = serializers.FloatField(required=False, default=0.02)
    b = serializers.FloatField(required=False, default=0.005)
    Kt = serializers.FloatField(required=False, default=0.5)
    Ke = serializers.FloatField(required=False, default=0.5)
    tl = serializers.FloatField(required=False, default=0.5)
    poles_count = serializers.IntegerField(required=False, default=2, min_value=2, max_value=12)
    magnet_material = serializers.ChoiceField(
        choices=['ndfeb_n52', 'ndfeb_n42', 'smco', 'alnico5', 'ferrite'],
        required=False,
        default='ndfeb_n52'
    )
    pole_span_deg = serializers.FloatField(required=False, default=120.0, min_value=30.0, max_value=170.0)

    def validate(self, data):
        mode = data.get('mode')
        if mode == 'lorentz':
            if data.get('m_mg', 0) <= 0:
                raise serializers.ValidationError({"m_mg": "Mass must be positive and non-zero."})
        elif mode == 'poles':
            if data.get('r', 0) <= 0:
                raise serializers.ValidationError({"r": "Distance must be positive and non-zero."})
        elif mode == 'motor':
            for field in ['R', 'L', 'J', 'b', 'Kt', 'Ke']:
                if data.get(field, 0) <= 0:
                    raise serializers.ValidationError({field: f"{field} must be positive and non-zero."})
        return data


class MagnetismCalculateView(APIView):
    """
    POST /api/physics/magnetism/calculate/
    Runs calculation pipelines for Lorentz force, Pole force, and DC Motors.
    """

    def post(self, request, *args, **kwargs):
        serializer = MagnetismInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid input parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        mode = data['mode']
        try:
            from .services import MagnetismService
            if mode == 'lorentz':
                result = MagnetismService.compute_lorentz(
                    q_uc=data['q_uc'],
                    m_mg=data['m_mg'],
                    v0=[data['vx'], data['vy'], data['vz']],
                    B=[data['Bx'], data['By'], data['Bz']]
                )
            elif mode == 'poles':
                result = MagnetismService.compute_poles(
                    qm1=data['qm1'],
                    qm2=data['qm2'],
                    r=data['r']
                )
            elif mode == 'motor':
                result = MagnetismService.compute_motor(
                    V=data['V'],
                    R=data['R'],
                    L=data['L'],
                    J=data['J'],
                    b=data['b'],
                    Kt=data['Kt'],
                    Ke=data['Ke'],
                    tl=data['tl'],
                    poles_count=data.get('poles_count', 2),
                    magnet_material=data.get('magnet_material', 'ndfeb_n52'),
                    pole_span_deg=data.get('pole_span_deg', 120.0)
                )
            else:
                # Unreachable while the serializer's ChoiceField and this chain
                # list the same modes. Without it, adding a choice in one place
                # and forgetting the other leaves `result` unbound and the
                # NameError surfaces as an opaque 500.
                raise ValueError(f"Unsupported magnetism mode: {mode!r}")
            return success_response(result)
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="MagnetismCalculateView",
                view_logger=logger,
            )


class MagnetismSchemaView(SerializerSchemaView):
    """GET /api/physics/magnetism/schema/ — form schema for Lorentz / poles / motor."""
    serializer_class = MagnetismInputSerializer

