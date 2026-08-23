"""
apps/core/schema.py
====================
Build a frontend form schema by introspecting a DRF serializer.

Why this exists
---------------
``PipeFlowSchemaView`` used to carry a ~120-line hand-written dict repeating
every field's ``min``, ``max``, ``default`` and ``type`` — values that already
existed on ``PipeFlowInputSerializer``. Two sources of truth for the same
constraint drift apart silently: tighten ``min_value`` on the serializer and the
form still offers the old range, so the user gets a 400 from a control the form
told them was legal.

Here the serializer is the single source of truth for *constraints*, and each
serializer declares only its *presentation* metadata (human label, unit, UI
step) — the part introspection genuinely cannot infer.

Declaring metadata on a serializer::

    class PipeFlowInputSerializer(serializers.Serializer):
        schema_title = "Pipe Flow Analysis"
        schema_description = "Darcy-Weisbach analysis for incompressible flow."
        schema_field_meta = {
            'diameter_mm': {'label': "Inner Diameter", 'step': 0.1,
                            'help': "Internal pipe diameter."},
        }
        schema_extra = {'preset_fluids': [...]}

Everything else — type, default, min, max, required, choices — is read off the
field itself. A field with no metadata entry still produces a usable form entry:
the label falls back to DRF's humanised field name with the unit suffix removed,
and the unit is inferred from that suffix.
"""

from typing import Any

from rest_framework import serializers
from rest_framework.views import APIView

from apps.core.responses import success_response

# ---------------------------------------------------------------------------
# Field type mapping
# ---------------------------------------------------------------------------

#: Checked in order — the first isinstance match wins, so subclasses that carry
#: extra meaning (ChoiceField) must be listed before their bases.
_TYPE_CHECKS: list[tuple[type, str]] = [
    (serializers.BooleanField, 'boolean'),
    (serializers.ChoiceField, 'choice'),
    (serializers.IntegerField, 'integer'),
    (serializers.FloatField, 'float'),
    (serializers.DecimalField, 'float'),
    (serializers.ListField, 'list'),
    (serializers.CharField, 'string'),
]

# ---------------------------------------------------------------------------
# Unit inference
# ---------------------------------------------------------------------------

#: Field-name suffix → display unit. Longest suffixes first: ``_m_s`` must be
#: tested before ``_s`` and ``_m``, or "velocity_m_s" resolves to metres.
_UNIT_SUFFIXES: list[tuple[str, str]] = [
    ('_kg_m3', 'kg/m³'),
    ('_mpa_s', 'mPa·s'),
    ('_m3_s', 'm³/s'),
    ('_pa_s', 'Pa·s'),
    ('_m_s2', 'm/s²'),
    ('_m_s', 'm/s'),
    ('_gpa', 'GPa'),
    ('_rpm', 'RPM'),
    ('_lpm', 'L/min'),
    ('_deg', '°'),
    ('_bar', 'bar'),
    ('_mm', 'mm'),
    ('_um', 'µm'),
    ('_kg', 'kg'),
    ('_mg', 'mg'),
    ('_uc', 'µC'),
    ('_pa', 'Pa'),
    ('_m4', 'm⁴'),
    ('_m2', 'm²'),
    ('_kn', 'kN'),
    ('_m', 'm'),
    ('_n', 'N'),
    ('_k', 'K'),
]


def _field_type(field: serializers.Field) -> str:
    """Map a DRF field instance to a frontend-facing type string."""
    for field_class, type_name in _TYPE_CHECKS:
        if isinstance(field, field_class):
            return type_name
    return 'string'


def _infer_unit(field_name: str) -> tuple[str | None, str]:
    """
    Split a field name into (unit, base name) using its suffix.

    Returns:
        ``(unit, base_name)`` — unit is ``None`` when no suffix matches, and
        base_name is the field name with the unit suffix stripped.

    Example:
        >>> _infer_unit('diameter_mm')
        ('mm', 'diameter')
        >>> _infer_unit('mode')
        (None, 'mode')
    """
    for suffix, unit in _UNIT_SUFFIXES:
        if field_name.endswith(suffix) and len(field_name) > len(suffix):
            return unit, field_name[: -len(suffix)]
    return None, field_name


def _humanise(name: str) -> str:
    """Turn ``pinion_teeth`` into ``Pinion teeth``."""
    return name.replace('_', ' ').strip().capitalize()


def _resolve_default(field: serializers.Field) -> Any:
    """
    Read a field's default, normalising DRF's sentinel and callables.

    DRF uses the ``empty`` sentinel for "no default"; a default may also be a
    zero-argument callable. Neither is JSON-serialisable, so both are resolved
    here.
    """
    default = field.default
    if default is serializers.empty:
        return None
    if callable(default):
        try:
            return default()
        except TypeError:
            # Context-dependent default (e.g. CurrentUserDefault) — not
            # meaningful in a static schema.
            return None
    return default


def describe_field(field_name: str, field: serializers.Field, meta: dict | None = None) -> dict:
    """
    Describe a single serializer field as a frontend form entry.

    Constraints come from the field; ``meta`` supplies presentation-only keys
    (``label``, ``unit``, ``step``, ``help``) and always wins where present.
    """
    meta = meta or {}
    inferred_unit, base_name = _infer_unit(field_name)

    entry: dict[str, Any] = {
        "name": field_name,
        "label": meta.get('label') or _humanise(base_name),
        "unit": meta.get('unit', inferred_unit),
        "type": _field_type(field),
        "required": field.required,
        "default": _resolve_default(field),
    }

    # Numeric bounds live on the field itself — never duplicated in meta.
    min_value = getattr(field, 'min_value', None)
    max_value = getattr(field, 'max_value', None)
    if min_value is not None:
        entry["min"] = min_value
    if max_value is not None:
        entry["max"] = max_value

    # Length bounds for text fields.
    min_length = getattr(field, 'min_length', None)
    max_length = getattr(field, 'max_length', None)
    if min_length is not None:
        entry["min_length"] = min_length
    if max_length is not None:
        entry["max_length"] = max_length

    if isinstance(field, serializers.ChoiceField):
        entry["choices"] = [
            {"value": value, "label": str(display)}
            for value, display in field.choices.items()
        ]

    if 'step' in meta:
        entry["step"] = meta['step']

    help_text = meta.get('help') or field.help_text
    if help_text:
        entry["help"] = str(help_text)

    return entry


def build_schema(serializer_class: type[serializers.Serializer]) -> dict:
    """
    Build the complete form schema for a serializer class.

    Read-only fields are skipped — the schema describes an *input* form, and a
    read-only field cannot be filled in.

    Args:
        serializer_class: The DRF serializer describing the endpoint's input.

    Returns:
        ``{"title", "description", "fields": [...], **schema_extra}``
    """
    field_meta = getattr(serializer_class, 'schema_field_meta', {}) or {}

    fields = [
        describe_field(name, field, field_meta.get(name))
        for name, field in serializer_class().fields.items()
        if not field.read_only
    ]

    schema: dict[str, Any] = {
        "title": getattr(serializer_class, 'schema_title', None) or serializer_class.__name__,
        "description": (
            getattr(serializer_class, 'schema_description', None)
            or (serializer_class.__doc__ or "").strip()
        ),
        "fields": fields,
    }
    schema.update(getattr(serializer_class, 'schema_extra', {}) or {})
    return schema


# ---------------------------------------------------------------------------
# Reusable schema endpoint
# ---------------------------------------------------------------------------

class SerializerSchemaView(APIView):
    """
    Generic ``GET .../schema/`` endpoint driven by a serializer.

    Every module exposes one so the frontend can build its form without
    hard-coding field names, ranges, or units:

        class PipeFlowSchemaView(SerializerSchemaView):
            serializer_class = PipeFlowInputSerializer
    """

    #: Serializer describing the endpoint's input. Required.
    serializer_class: type[serializers.Serializer] | None = None

    def get(self, request, *args, **kwargs):
        if self.serializer_class is None:
            raise NotImplementedError(
                f"{type(self).__name__} must set `serializer_class`."
            )
        return success_response(build_schema(self.serializer_class))
