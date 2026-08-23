"""
apps/app_fluids/serializers.py
================================
DRF serializers for pipe flow API endpoints.

Responsibility:
    1. Deserialize raw user JSON → validated Python types
    2. Apply physical constraint validators (from apps.core.validators)
    3. Convert user units → SI units before handing off to PipeFlowService
    4. Serialize PipeFlowResult → JSON-ready dict

Design:
    - Accepts user-friendly inputs with explicit unit fields
      (e.g., diameter_mm, flow_rate_lpm) to avoid ambiguity
    - All internal calculations happen in SI; unit conversion is explicit
"""

from dataclasses import asdict

from rest_framework import serializers

from apps.core.units import to_si
from apps.core.validators import (
    validate_non_negative_flow_rate,
    validate_positive_density,
    validate_positive_diameter,
    validate_positive_length,
    validate_positive_viscosity,
    validate_roughness,
)
from .services import PipeFlowInput


class PipeFlowInputSerializer(serializers.Serializer):
    """
    Validates and normalises user inputs for the pipe flow calculation.

    Accepted units (explicit — no guessing):
        diameter  → mm   (converted to m)
        length    → m    (stored as-is)
        roughness → mm   (converted to m)
        density   → kg/m³
        viscosity → mPa·s (milli-pascal·second, converted to Pa·s)
        flow_rate → L/min (converted to m³/s)
    """

    # ---------------------------------------------------------------
    # Form schema metadata (consumed by apps.core.schema.build_schema)
    # ---------------------------------------------------------------
    # Only presentation lives here. Type, default, min and max are read off
    # the fields below, so there is exactly one place to change a constraint.

    schema_title = "Pipe Flow Analysis"
    schema_description = (
        "Darcy-Weisbach analysis for incompressible Newtonian pipe flow. "
        "Computes Reynolds number, friction factor, pressure drop, "
        "and velocity profile."
    )
    schema_field_meta = {
        'diameter_mm':          {'label': "Inner Diameter",        'step': 0.1},
        'length_m':             {'label': "Pipe Length",           'step': 0.1},
        'roughness_mm':         {'label': "Wall Roughness (ε)",    'step': 0.001},
        'density_kg_m3':        {'label': "Fluid Density",         'step': 0.1},
        'viscosity_mpa_s':      {'label': "Dynamic Viscosity (μ)", 'step': 0.001},
        'flow_rate_lpm':        {'label': "Flow Rate",             'step': 0.1},
        'num_elbows_90':        {'label': "90° Elbows",            'step': 1, 'unit': "count"},
        'num_gate_valves_open': {'label': "Gate Valves (open)",    'step': 1, 'unit': "count"},
        'num_check_valves':     {'label': "Check Valves",          'step': 1, 'unit': "count"},
    }
    schema_extra = {
        "preset_fluids": [
            {"name": "Water (20°C)",     "density": 998.2,   "viscosity": 1.002},
            {"name": "Water (60°C)",     "density": 983.2,   "viscosity": 0.467},
            {"name": "Engine Oil",       "density": 888.0,   "viscosity": 100.0},
            {"name": "Air (20°C, 1atm)", "density": 1.204,   "viscosity": 0.0181},
            {"name": "Mercury (20°C)",   "density": 13546.0, "viscosity": 1.526},
            {"name": "Ethanol (20°C)",   "density": 789.0,   "viscosity": 1.2},
        ],
    }

    # --- Pipe geometry ---
    diameter_mm = serializers.FloatField(
        min_value=0.1,
        max_value=10_000.0,
        help_text="Inner pipe diameter [mm]",
    )
    length_m = serializers.FloatField(
        min_value=0.001,
        max_value=100_000.0,
        help_text="Pipe length [m]",
    )
    roughness_mm = serializers.FloatField(
        default=0.046,   # Commercial steel (typical default)
        min_value=0.0,
        max_value=100.0,
        help_text="Absolute wall roughness [mm]. Default: 0.046 mm (commercial steel)",
    )

    # --- Fluid properties ---
    density_kg_m3 = serializers.FloatField(
        default=1000.0,  # Water at ~20°C
        min_value=0.001,
        max_value=100_000.0,
        help_text="Fluid density [kg/m³]. Default: 1000 kg/m³ (water)",
    )
    viscosity_mpa_s = serializers.FloatField(
        default=1.002,   # Water at 20°C
        min_value=1e-6,
        max_value=100_000.0,
        help_text="Dynamic viscosity [mPa·s]. Default: 1.002 mPa·s (water at 20°C)",
    )

    # --- Operating conditions ---
    flow_rate_lpm = serializers.FloatField(
        min_value=0.0,
        max_value=1_000_000.0,
        help_text="Volumetric flow rate [L/min]",
    )

    # --- Minor losses (optional fittings) ---
    num_elbows_90 = serializers.IntegerField(
        default=0, min_value=0, max_value=100,
        help_text="Number of 90° elbows",
    )
    num_gate_valves_open = serializers.IntegerField(
        default=0, min_value=0, max_value=100,
        help_text="Number of fully-open gate valves",
    )
    num_check_valves = serializers.IntegerField(
        default=0, min_value=0, max_value=100,
        help_text="Number of swing check valves",
    )

    # ---------------------------------------------------------------
    # Field-level validation (physical constraints)
    # ---------------------------------------------------------------

    def validate_diameter_mm(self, value: float) -> float:
        validate_positive_diameter(value / 1000, 'diameter_mm')
        return value

    def validate_length_m(self, value: float) -> float:
        validate_positive_length(value, 'length_m')
        return value

    def validate_roughness_mm(self, value: float) -> float:
        validate_roughness(value / 1000, 'roughness_mm')
        return value

    def validate_density_kg_m3(self, value: float) -> float:
        validate_positive_density(value, 'density_kg_m3')
        return value

    def validate_viscosity_mpa_s(self, value: float) -> float:
        validate_positive_viscosity(value / 1000, 'viscosity_mpa_s')
        return value

    def validate_flow_rate_lpm(self, value: float) -> float:
        validate_non_negative_flow_rate(value, 'flow_rate_lpm')
        return value

    # ---------------------------------------------------------------
    # Cross-field validation
    # ---------------------------------------------------------------

    def validate(self, attrs: dict) -> dict:
        """
        Check that roughness < diameter (otherwise pipe is physically blocked).
        """
        roughness_m = attrs['roughness_mm'] / 1000
        diameter_m  = attrs['diameter_mm'] / 1000
        if roughness_m >= diameter_m / 2:
            raise serializers.ValidationError(
                "Roughness must be less than the pipe radius. "
                f"Got roughness={roughness_m*1000:.3f} mm, radius={diameter_m/2*1000:.3f} mm."
            )
        return attrs

    # ---------------------------------------------------------------
    # Build SI-unit PipeFlowInput
    # ---------------------------------------------------------------

    def to_pipe_flow_input(self) -> PipeFlowInput:
        """
        Convert validated data to SI-unit PipeFlowInput dataclass.
        Call this after ``is_valid(raise_exception=True)``.
        """
        d = self.validated_data
        return PipeFlowInput(
            diameter_m          = d['diameter_mm'] / 1000,
            length_m            = d['length_m'],
            roughness_m         = d['roughness_mm'] / 1000,
            density_kg_m3       = d['density_kg_m3'],
            viscosity_pa_s      = d['viscosity_mpa_s'] / 1000,
            flow_rate_m3_s      = to_si(d['flow_rate_lpm'], 'L/min', 'm^3/s'),
            num_elbows_90       = d['num_elbows_90'],
            num_gate_valves_open= d['num_gate_valves_open'],
            num_check_valves    = d['num_check_valves'],
        )


class PipeFlowResultSerializer(serializers.Serializer):
    """
    Serializes PipeFlowResult to a JSON-compatible dict.

    This is a read-only serializer — it's only used for output documentation
    and response shaping. The actual serialization calls ``dataclasses.asdict``.
    """
    velocity_m_s             = serializers.FloatField(read_only=True)
    reynolds_number          = serializers.FloatField(read_only=True)
    flow_regime              = serializers.CharField(read_only=True)
    friction_factor          = serializers.FloatField(read_only=True)
    friction_method          = serializers.CharField(read_only=True)
    pressure_drop_major_pa   = serializers.FloatField(read_only=True)
    pressure_drop_minor_pa   = serializers.FloatField(read_only=True)
    pressure_drop_total_pa   = serializers.FloatField(read_only=True)
    pressure_drop_total_bar  = serializers.FloatField(read_only=True)
    # read_only on every field, not just the scalars. build_schema() skips
    # read-only fields, so the six below — which were writable purely by
    # oversight — would be emitted as if they were form *inputs* if this class
    # were ever pointed at a schema view.
    radial_positions         = serializers.ListField(child=serializers.FloatField(), read_only=True)
    velocity_profile         = serializers.ListField(child=serializers.FloatField(), read_only=True)
    sweep_flow_rates_m3_s    = serializers.ListField(child=serializers.FloatField(), read_only=True)
    sweep_pressure_drops_pa  = serializers.ListField(child=serializers.FloatField(), read_only=True)
    hagen_poiseuille_exact   = serializers.CharField(allow_null=True, read_only=True)
    warnings                 = serializers.ListField(child=serializers.CharField(), read_only=True)
