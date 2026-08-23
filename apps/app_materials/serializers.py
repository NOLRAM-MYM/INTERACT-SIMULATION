"""
apps/app_materials/serializers.py
===================================
DRF serializer for the beam deflection API endpoint.

Responsibility:
    1. Deserialize raw user JSON → validated Python types
    2. Apply physical constraint validators (from apps.core.validators)
    3. Hand off validated kwargs to BeamDeflectionService
"""

from rest_framework import serializers

from apps.core.validators import (
    validate_positive_length,
    validate_positive_load,
    validate_positive_second_moment,
    validate_positive_youngs_modulus,
)


class BeamDeflectionInputSerializer(serializers.Serializer):
    """Validates and normalises user inputs for the beam deflection calculation."""

    schema_title = "Beam Deflection"
    schema_description = (
        "Euler-Bernoulli deflection of a simply-supported or cantilever beam "
        "under a point or uniformly distributed load."
    )
    schema_field_meta = {
        'length_m':           {'label': "Beam Span (L)",              'step': 0.01},
        'youngs_modulus_gpa': {'label': "Young's Modulus (E)",        'step': 1.0},
        'second_moment_m4':   {'label': "Second Moment of Area (I)",  'step': 1e-9},
        'load_kn':            {'label': "Applied Load (total)",       'step': 0.1},
        'load_type':          {'label': "Load Case", 'unit': None},
    }

    length_m = serializers.FloatField(
        min_value=0.1,
        max_value=100.0,
        help_text="Beam span [m]",
    )
    youngs_modulus_gpa = serializers.FloatField(
        min_value=0.001,
        max_value=1000.0,
        help_text="Young's modulus [GPa]",
    )
    second_moment_m4 = serializers.FloatField(
        min_value=1e-12,
        max_value=10.0,
        help_text="Second moment of area (I) [m⁴]",
    )
    load_kn = serializers.FloatField(
        min_value=0.001,
        max_value=100_000.0,
        help_text=(
            "Applied load [kN]. For the point-load cases this is the force "
            "itself; for the uniform cases it is the TOTAL load distributed "
            "over the span (intensity q = load / length)."
        ),
    )
    load_type = serializers.ChoiceField(
        choices=['point_centre', 'uniform', 'cantilever_point', 'cantilever_uniform'],
        default='point_centre',
        help_text=(
            "'point_centre'/'uniform': simply-supported beam with a central "
            "point load / uniformly distributed load. "
            "'cantilever_point'/'cantilever_uniform': fixed at x=0, free at "
            "x=L, with a point load at the free end / uniformly distributed load."
        ),
    )

    # ---------------------------------------------------------------
    # Field-level validation (physical constraints)
    # ---------------------------------------------------------------

    def validate_length_m(self, value: float) -> float:
        validate_positive_length(value, 'length_m')
        return value

    def validate_youngs_modulus_gpa(self, value: float) -> float:
        validate_positive_youngs_modulus(value, 'youngs_modulus_gpa')
        return value

    def validate_second_moment_m4(self, value: float) -> float:
        validate_positive_second_moment(value, 'second_moment_m4')
        return value

    def validate_load_kn(self, value: float) -> float:
        validate_positive_load(value, 'load_kn')
        return value

    # ---------------------------------------------------------------
    # Build BeamDeflectionService kwargs
    # ---------------------------------------------------------------

    def to_service_kwargs(self) -> dict:
        """Convert validated data to BeamDeflectionService constructor kwargs."""
        d = self.validated_data
        return dict(
            length_m=d['length_m'],
            youngs_modulus_gpa=d['youngs_modulus_gpa'],
            second_moment_m4=d['second_moment_m4'],
            load_kn=d['load_kn'],
            load_type=d['load_type'],
        )
