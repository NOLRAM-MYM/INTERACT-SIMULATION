"""
apps/core/tests.py
===================
Tests for the shared core layer: physical validators, unit conversion, error
classification, and serializer-driven form schemas.

``apps/core`` is imported by every scientific module but previously had no tests
of its own — it was only exercised indirectly through the fluids and materials
suites, so a regression here surfaced as a confusing failure in an unrelated
app (or not at all, for the branches no module happened to hit).

Run: pytest apps/core/ -v
"""

import pytest
from django.test import override_settings
from django.urls import reverse
from rest_framework import serializers
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.test import APIClient

from apps.core.exceptions import ComputationError, DomainError
from apps.core.responses import (
    computation_error_response,
    error_response,
    success_response,
)
from apps.core.schema import build_schema, describe_field
from apps.core.units import Q_, convert_temperature, to_si
from apps.core import validators as v


@pytest.fixture
def api_client():
    return APIClient()


# ===========================================================================
# Validators — physical constraints
# ===========================================================================

class TestTemperatureValidators:
    def test_celsius_above_absolute_zero_passes(self):
        assert v.validate_temperature_celsius(-273.15) == -273.15
        assert v.validate_temperature_celsius(20.0) == 20.0

    def test_celsius_below_absolute_zero_rejected(self):
        with pytest.raises(DRFValidationError):
            v.validate_temperature_celsius(-273.16)

    def test_kelvin_below_zero_rejected(self):
        with pytest.raises(DRFValidationError):
            v.validate_temperature_kelvin(-0.001)

    def test_kelvin_zero_allowed(self):
        assert v.validate_temperature_kelvin(0.0) == 0.0

    def test_error_message_names_the_field(self):
        with pytest.raises(DRFValidationError) as exc_info:
            v.validate_temperature_celsius(-500, field_name='inlet_temp')
        assert 'inlet_temp' in str(exc_info.value)


class TestStrictlyPositiveValidators:
    """Quantities where zero is as unphysical as a negative value."""

    @pytest.mark.parametrize('validator', [
        v.validate_positive_mass,
        v.validate_positive_density,
        v.validate_positive_diameter,
        v.validate_positive_length,
        v.validate_positive_viscosity,
        v.validate_positive_youngs_modulus,
        v.validate_positive_second_moment,
        v.validate_positive_load,
    ])
    def test_zero_rejected(self, validator):
        with pytest.raises(DRFValidationError):
            validator(0.0)

    @pytest.mark.parametrize('validator', [
        v.validate_positive_mass,
        v.validate_positive_density,
        v.validate_positive_diameter,
        v.validate_positive_length,
        v.validate_positive_viscosity,
        v.validate_positive_youngs_modulus,
        v.validate_positive_second_moment,
        v.validate_positive_load,
    ])
    def test_negative_rejected(self, validator):
        with pytest.raises(DRFValidationError):
            validator(-1.0)

    @pytest.mark.parametrize('validator', [
        v.validate_positive_mass,
        v.validate_positive_density,
        v.validate_positive_diameter,
        v.validate_positive_length,
        v.validate_positive_viscosity,
        v.validate_positive_youngs_modulus,
        v.validate_positive_second_moment,
        v.validate_positive_load,
    ])
    def test_positive_returned_unchanged(self, validator):
        assert validator(2.5) == 2.5


class TestNonNegativeValidators:
    """Quantities where zero is physically meaningful (a smooth pipe, no flow)."""

    @pytest.mark.parametrize('validator', [
        v.validate_non_negative_pressure,
        v.validate_roughness,
        v.validate_non_negative_flow_rate,
        v.validate_positive_concentration,
    ])
    def test_zero_allowed(self, validator):
        assert validator(0.0) == 0.0

    @pytest.mark.parametrize('validator', [
        v.validate_non_negative_pressure,
        v.validate_roughness,
        v.validate_non_negative_flow_rate,
        v.validate_positive_concentration,
    ])
    def test_negative_rejected(self, validator):
        with pytest.raises(DRFValidationError):
            validator(-0.1)


class TestAtomicNumberValidator:
    @pytest.mark.parametrize('z', [1, 26, 118])
    def test_valid_range_accepted(self, z):
        assert v.validate_atomic_number(z) == z

    @pytest.mark.parametrize('z', [0, -1, 119, 500])
    def test_out_of_range_rejected(self, z):
        with pytest.raises(DRFValidationError):
            v.validate_atomic_number(z)


# ===========================================================================
# Units — Pint conversion helpers
# ===========================================================================

class TestUnitConversion:
    def test_millimetres_to_metres(self):
        assert to_si(50.0, 'mm', 'm') == pytest.approx(0.05)

    def test_bar_to_pascal(self):
        assert to_si(1.0, 'bar', 'Pa') == pytest.approx(100_000.0)

    def test_litres_per_minute_to_cubic_metres_per_second(self):
        assert to_si(120.0, 'L/min', 'm^3/s') == pytest.approx(0.002)

    def test_returns_plain_float_not_quantity(self):
        result = to_si(1.0, 'm', 'mm')
        assert type(result) is float

    def test_incompatible_units_raise(self):
        import pint
        with pytest.raises(pint.DimensionalityError):
            to_si(1.0, 'm', 'kg')

    def test_celsius_to_kelvin_applies_offset(self):
        # The offset is the whole point — a naive scale factor gives 0.0 here.
        assert convert_temperature(100.0, 'degC', 'kelvin') == pytest.approx(373.15)
        assert convert_temperature(0.0, 'degC', 'kelvin') == pytest.approx(273.15)

    def test_fahrenheit_to_celsius(self):
        assert convert_temperature(212.0, 'degF', 'degC') == pytest.approx(100.0)

    def test_shared_registry_allows_arithmetic(self):
        # Mixing registries raises DimensionalityError; this guards the singleton.
        assert (Q_(1.0, 'm') + Q_(100.0, 'cm')).to('m').magnitude == pytest.approx(2.0)


# ===========================================================================
# Response envelope + error classification
# ===========================================================================

class TestResponseEnvelope:
    def test_success_envelope(self):
        response = success_response({'value': 42})
        assert response.status_code == 200
        assert response.data == {'status': 'success', 'data': {'value': 42}}

    def test_error_envelope_omits_empty_errors(self):
        response = error_response("Nope", code="bad")
        assert response.data == {'status': 'error', 'code': 'bad', 'message': 'Nope'}

    def test_error_envelope_includes_field_errors(self):
        response = error_response("Nope", code="bad", errors={'field': ['detail']})
        assert response.data['errors'] == {'field': ['detail']}


class TestComputationErrorClassification:
    """
    The distinction this suite protects: caller-fixable failures must return 400
    with a useful message; our own bugs must return 500 without leaking internals.
    """

    def test_domain_error_is_client_error(self):
        exc = DomainError("Formula 'Xx2' has no such element.", code="parse_error")
        response = computation_error_response(exc, view_name="T")
        assert response.status_code == 400
        assert response.data['code'] == 'parse_error'
        assert response.data['message'] == "Formula 'Xx2' has no such element."

    def test_domain_error_carries_field_errors(self):
        exc = DomainError("bad", errors={'formula': 'unparseable'})
        response = computation_error_response(exc, view_name="T")
        assert response.data['errors'] == {'formula': 'unparseable'}

    def test_computation_error_has_its_own_code(self):
        response = computation_error_response(ComputationError("no convergence"), view_name="T")
        assert response.status_code == 400
        assert response.data['code'] == 'computation_error'

    def test_value_error_is_client_error(self):
        # Services across every module raise ValueError for unsupported input.
        response = computation_error_response(ValueError("Reaction 'zzz' not found."), view_name="T")
        assert response.status_code == 400
        assert response.data['message'] == "Reaction 'zzz' not found."

    def test_drf_validation_error_forwards_field_detail(self):
        exc = DRFValidationError({'density': ['Density must be strictly positive.']})
        response = computation_error_response(exc, view_name="T")
        assert response.status_code == 400
        assert response.data['code'] == 'validation_error'
        assert 'density' in response.data['errors']

    @override_settings(DEBUG=False)
    def test_unexpected_error_is_server_error_and_does_not_leak(self):
        secret = "connection to 10.0.0.7 failed: password=hunter2"
        response = computation_error_response(AttributeError(secret), view_name="T")
        assert response.status_code == 500
        assert response.data['code'] == 'server_error'
        assert secret not in str(response.data)
        # error_response omits the key entirely rather than sending errors: null
        assert 'errors' not in response.data

    @override_settings(DEBUG=True)
    def test_unexpected_error_includes_detail_in_debug(self):
        response = computation_error_response(AttributeError("boom"), view_name="T")
        assert response.status_code == 500
        assert 'boom' in response.data['errors']['detail']

    def test_custom_code_used_for_client_errors_only(self):
        client = computation_error_response(ValueError("x"), view_name="T", code="parse_error")
        server = computation_error_response(RuntimeError("x"), view_name="T", code="parse_error")
        assert client.data['code'] == 'parse_error'
        assert server.data['code'] == 'server_error'


# ===========================================================================
# Schema generation
# ===========================================================================

class SampleSerializer(serializers.Serializer):
    """Fixture serializer exercising every branch of the schema builder."""

    schema_title = "Sample Form"
    schema_description = "Exercises the schema builder."
    schema_field_meta = {
        'diameter_mm': {'label': "Inner Diameter", 'step': 0.1},
        'ratio': {'label': "Ratio", 'unit': None},
    }
    schema_extra = {'presets': [{'name': 'default'}]}

    diameter_mm = serializers.FloatField(min_value=0.1, max_value=500.0, help_text="Bore.")
    length_m = serializers.FloatField(default=2.0, min_value=0.0)
    count = serializers.IntegerField(default=3, min_value=0, max_value=10)
    ratio = serializers.FloatField(default=0.3)
    mode = serializers.ChoiceField(choices=['fast', 'slow'], default='fast')
    label = serializers.CharField(max_length=20, required=False)
    computed = serializers.FloatField(read_only=True)


class TestBuildSchema:
    @pytest.fixture
    def schema(self):
        return build_schema(SampleSerializer)

    @pytest.fixture
    def fields(self, schema):
        return {f['name']: f for f in schema['fields']}

    def test_title_and_description_from_serializer(self, schema):
        assert schema['title'] == "Sample Form"
        assert schema['description'] == "Exercises the schema builder."

    def test_schema_extra_is_merged(self, schema):
        assert schema['presets'] == [{'name': 'default'}]

    def test_read_only_field_excluded(self, fields):
        # A form cannot fill in a read-only output field.
        assert 'computed' not in fields

    def test_constraints_read_from_field_not_metadata(self, fields):
        assert fields['diameter_mm']['min'] == 0.1
        assert fields['diameter_mm']['max'] == 500.0
        assert fields['count']['min'] == 0
        assert fields['count']['max'] == 10

    def test_types_are_mapped(self, fields):
        assert fields['diameter_mm']['type'] == 'float'
        assert fields['count']['type'] == 'integer'
        assert fields['mode']['type'] == 'choice'
        assert fields['label']['type'] == 'string'

    def test_defaults_resolved(self, fields):
        assert fields['length_m']['default'] == 2.0
        assert fields['mode']['default'] == 'fast'

    def test_missing_default_is_none_not_sentinel(self, fields):
        # DRF's `empty` sentinel is not JSON-serialisable.
        assert fields['diameter_mm']['default'] is None
        assert fields['diameter_mm']['required'] is True

    def test_metadata_supplies_label(self, fields):
        assert fields['diameter_mm']['label'] == "Inner Diameter"

    def test_label_falls_back_to_humanised_name_without_unit_suffix(self, fields):
        assert fields['length_m']['label'] == "Length"

    def test_unit_inferred_from_suffix(self, fields):
        assert fields['diameter_mm']['unit'] == 'mm'
        assert fields['length_m']['unit'] == 'm'

    def test_metadata_can_clear_an_inferred_unit(self, fields):
        assert fields['ratio']['unit'] is None

    def test_step_only_present_when_declared(self, fields):
        assert fields['diameter_mm']['step'] == 0.1
        assert 'step' not in fields['count']

    def test_choices_exposed(self, fields):
        assert fields['mode']['choices'] == [
            {'value': 'fast', 'label': 'fast'},
            {'value': 'slow', 'label': 'slow'},
        ]

    def test_help_text_from_field(self, fields):
        assert fields['diameter_mm']['help'] == "Bore."

    def test_char_field_length_bound(self, fields):
        assert fields['label']['max_length'] == 20


class TestUnitSuffixInference:
    """Longest-suffix-first matching — 'velocity_m_s' must not resolve to metres."""

    @pytest.mark.parametrize('name,expected_unit,expected_label', [
        ('velocity_m_s', 'm/s', "Velocity"),
        ('density_kg_m3', 'kg/m³', "Density"),
        ('viscosity_mpa_s', 'mPa·s', "Viscosity"),
        ('viscosity_pa_s', 'Pa·s', "Viscosity"),
        ('flow_rate_lpm', 'L/min', "Flow rate"),
        ('second_moment_m4', 'm⁴', "Second moment"),
        ('angle_deg', '°', "Angle"),
        ('roughness_um', 'µm', "Roughness"),
        ('load_n', 'N', "Load"),
        ('mode', None, "Mode"),
    ])
    def test_suffix_resolution(self, name, expected_unit, expected_label):
        entry = describe_field(name, serializers.FloatField(required=False))
        assert entry['unit'] == expected_unit
        assert entry['label'] == expected_label


# ===========================================================================
# Schema endpoints — every module exposes one, and it matches the serializer
# ===========================================================================

SCHEMA_ENDPOINTS = [
    'fluids:pipe-flow-schema',
    'materials:beam-deflection-schema',
    'physics:projectile-schema',
    'physics:magnetism-schema',
    'tribology:tribology-schema',
    'chemistry:chemistry-simulate-schema',
    'chemistry:stoichiometry-schema',
]


@pytest.mark.django_db
class TestSchemaEndpoints:
    @pytest.mark.parametrize('route', SCHEMA_ENDPOINTS)
    def test_endpoint_returns_usable_schema(self, api_client, route):
        response = api_client.get(reverse(route))
        assert response.status_code == 200
        payload = response.json()['data']
        assert payload['title']
        assert payload['fields'], f"{route} returned no fields"
        for field in payload['fields']:
            assert field['name']
            assert field['label']
            assert field['type']

    def test_fluids_schema_matches_serializer_bounds(self, api_client):
        """
        The anti-drift test. The old hand-written schema advertised
        roughness_mm max=10.0 while the serializer accepted up to 100.0, so the
        form silently blocked values the API would have taken.
        """
        from apps.app_fluids.serializers import PipeFlowInputSerializer

        response = api_client.get(reverse('fluids:pipe-flow-schema'))
        fields = {f['name']: f for f in response.json()['data']['fields']}
        declared = PipeFlowInputSerializer().fields

        for name, field in declared.items():
            if field.read_only:
                continue
            assert name in fields, f"{name} missing from schema"
            if getattr(field, 'min_value', None) is not None:
                assert fields[name]['min'] == field.min_value
            if getattr(field, 'max_value', None) is not None:
                assert fields[name]['max'] == field.max_value

    def test_fluids_schema_keeps_preset_fluids(self, api_client):
        response = api_client.get(reverse('fluids:pipe-flow-schema'))
        presets = response.json()['data']['preset_fluids']
        assert any(p['name'].startswith('Water') for p in presets)


# ===========================================================================
# Error handling end-to-end through a real endpoint
# ===========================================================================

@pytest.mark.django_db
class TestErrorHandlingIntegration:
    def test_unparseable_formula_returns_400_not_500(self, api_client):
        response = api_client.post(
            reverse('chemistry:stoichiometry'),
            {'formula': '((H2O'},
            format='json',
        )
        assert response.status_code == 400
        assert response.json()['code'] == 'parse_error'

    def test_unknown_element_returns_404(self, api_client):
        response = api_client.get(
            reverse('chemistry:element-property', kwargs={'identifier': 'Zz'})
        )
        assert response.status_code == 404
        assert response.json()['code'] == 'element_not_found'

    def test_unsupported_reaction_returns_400(self, api_client):
        response = api_client.post(
            reverse('chemistry:chemistry-simulate'),
            {'mode': 'reaction', 'reaction_id': 'not-a-real-reaction'},
            format='json',
        )
        assert response.status_code == 400
        assert response.json()['status'] == 'error'


# ===========================================================================
# Vite integration
# ===========================================================================

MANIFEST_FIXTURE = {
    "_utils-abc.js": {"file": "js/utils-abc.js", "name": "utils"},
    "_plotly-def.js": {"file": "js/plotly-def.js", "name": "plotly"},
    "main.js": {
        "file": "js/main-xyz.js",
        "isEntry": True,
        "imports": ["_utils-abc.js"],
        "css": ["assets/dashboard-123.css"],
    },
    "pages/fluids.js": {
        "file": "js/fluids-qqq.js",
        "isEntry": True,
        "imports": ["_utils-abc.js", "_plotly-def.js"],
        "css": ["assets/dashboard-123.css"],
    },
}


@pytest.fixture
def manifest_file(tmp_path):
    """Write a manifest fixture and point settings at it."""
    import json as _json

    path = tmp_path / '.vite' / 'manifest.json'
    path.parent.mkdir(parents=True)
    path.write_text(_json.dumps(MANIFEST_FIXTURE), encoding='utf-8')
    return path


@pytest.fixture(autouse=True)
def _reset_vite_cache():
    from apps.core.templatetags.vite import clear_manifest_cache
    clear_manifest_cache()
    yield
    clear_manifest_cache()


class TestViteAsset:
    """
    The tag that finally connects vite.config.js's entry points to the
    templates. Before it, STATICFILES_DIRS pointed at frontend/dist and nothing
    ever referenced a file inside it.
    """

    def _render(self, entry='main.js'):
        from apps.core.templatetags.vite import vite_asset
        return vite_asset(entry)

    def test_production_emits_hashed_script(self, manifest_file):
        with override_settings(VITE_MANIFEST_PATH=manifest_file, VITE_DEV_SERVER_URL='', DEBUG=False):
            html = self._render('main.js')
        assert 'js/main-xyz.js' in html
        assert 'type="module"' in html

    def test_production_emits_stylesheet(self, manifest_file):
        with override_settings(VITE_MANIFEST_PATH=manifest_file, VITE_DEV_SERVER_URL='', DEBUG=False):
            html = self._render('main.js')
        assert 'rel="stylesheet"' in html
        assert 'assets/dashboard-123.css' in html

    def test_production_preloads_transitive_chunks(self, manifest_file):
        with override_settings(VITE_MANIFEST_PATH=manifest_file, VITE_DEV_SERVER_URL='', DEBUG=False):
            html = self._render('pages/fluids.js')
        # plotly is multi-megabyte — preloading removes a request waterfall.
        assert 'modulepreload' in html
        assert 'js/plotly-def.js' in html
        assert 'js/utils-abc.js' in html

    def test_dev_server_bypasses_manifest(self):
        with override_settings(VITE_DEV_SERVER_URL='http://localhost:5173', DEBUG=True):
            html = self._render('pages/fluids.js')
        assert html == '<script type="module" src="http://localhost:5173/pages/fluids.js"></script>'

    def test_hmr_client_only_in_dev(self):
        from apps.core.templatetags.vite import vite_hmr_client

        with override_settings(VITE_DEV_SERVER_URL='http://localhost:5173'):
            assert '@vite/client' in vite_hmr_client()
        with override_settings(VITE_DEV_SERVER_URL=''):
            assert vite_hmr_client() == ''

    def test_unknown_entry_raises_in_production(self, manifest_file):
        from apps.core.templatetags.vite import ViteManifestError

        with override_settings(VITE_MANIFEST_PATH=manifest_file, VITE_DEV_SERVER_URL='', DEBUG=False):
            with pytest.raises(ViteManifestError):
                self._render('pages/nope.js')

    def test_unknown_entry_degrades_to_comment_in_debug(self, manifest_file):
        with override_settings(VITE_MANIFEST_PATH=manifest_file, VITE_DEV_SERVER_URL='', DEBUG=True):
            html = self._render('pages/nope.js')
        assert html.startswith('<!-- vite:')

    def test_missing_manifest_raises_in_production(self, tmp_path):
        from apps.core.templatetags.vite import ViteManifestError

        missing = tmp_path / 'nope' / 'manifest.json'
        with override_settings(VITE_MANIFEST_PATH=missing, VITE_DEV_SERVER_URL='', DEBUG=False):
            with pytest.raises(ViteManifestError):
                self._render('main.js')

    def test_missing_manifest_degrades_in_debug(self, tmp_path):
        missing = tmp_path / 'nope' / 'manifest.json'
        with override_settings(VITE_MANIFEST_PATH=missing, VITE_DEV_SERVER_URL='', DEBUG=True):
            html = self._render('main.js')
        assert 'npm run build' in html


@pytest.mark.django_db
class TestPagesLoadTheBundle:
    """
    End-to-end: every page extends base.html, so every page must now ship the
    Vite bundle. This is the regression guard against the bundle silently
    becoming dead code again.
    """

    PAGE_ROUTES = [
        'dashboard-index',
        'fluids:pipe-flow-page',
        'materials:materials-index',
        'chemistry:chemistry-index',
        'physics:physics-index',
        'tribology:tribology-index',
    ]

    @pytest.mark.parametrize('route', PAGE_ROUTES)
    def test_page_renders_and_includes_bundle(self, client, route):
        response = client.get(reverse(route))
        assert response.status_code == 200
        html = response.content.decode()
        assert 'type="module"' in html, f"{route} does not load the Vite bundle"

    def test_base_no_longer_defines_toast_inline(self, client):
        """showToast/showLoading now come from the bundle, not a second copy."""
        html = client.get(reverse('dashboard-index')).content.decode()
        assert 'window.showToast = function' not in html
        assert 'window.showLoading = function' not in html


# Every simulator page: (url name, Vite chunk prefix, an i18n key it owns)
MIGRATED_PAGES = [
    ('fluids:pipe-flow-page',     'fluids',    'fluids-presets-title'),
    ('materials:materials-index', 'materials', 'materials-title'),
    ('tribology:tribology-index', 'tribology', 'tribology-title'),
    ('chemistry:chemistry-index', 'chemistry', 'chem-title-explorer'),
    ('physics:physics-index',     'physics',   'physics-proj-title'),
]

# Controller objects that used to be declared inline in the templates.
INLINE_CONTROLLER_SYMBOLS = [
    'const FormManager', 'const UIUpdater', 'const API =',
    'const ThreeBeam', 'const ThreeGears', 'const ThreeAtom', 'const ThreePipe',
    'const DashboardManager', 'const MoleculeBuilder', 'const GlobalPhysicsManager',
    'const PlotlyChart', 'const PlotlyCharts', 'const ProjectileForm', 'const MagnetismForm',
]

# Pages that legitimately still load the vendored plotly build. Chemistry is
# absent on purpose: it contains zero Plotly calls.
PAGES_USING_PLOTLY = {'fluids', 'materials', 'tribology', 'physics'}


@pytest.mark.django_db
class TestPagesAreMigrated:
    """
    All five simulator pages moved their controller out of the template and
    into a Vite page bundle. These assertions pin the migration: without them,
    re-adding an inline controller or a vendored library tag passes silently.
    """

    @pytest.mark.parametrize('route,chunk,_key', MIGRATED_PAGES)
    def test_loads_its_page_bundle(self, client, route, chunk, _key):
        html = client.get(reverse(route)).content.decode()
        assert f'js/{chunk}-' in html, f"{route} does not load its page bundle"

    @pytest.mark.parametrize('route,_chunk,_key', MIGRATED_PAGES)
    def test_still_loads_vendored_three(self, client, route, _chunk, _key):
        """
        The vendored three/OrbitControls build must keep loading. It is NOT
        interchangeable with the `three` package in package.json: the vendored
        file is ~r13x (2021) while npm resolves 0.166.1, a jump that includes
        r155's redefinition of light intensity units. The controllers were
        written against the vendored build and read THREE off the global.
        """
        html = client.get(reverse(route)).content.decode()
        assert 'vendor/three.min.js' in html, f"{route} lost the vendored three build"
        assert 'vendor/OrbitControls.js' in html, f"{route} lost OrbitControls"

    @pytest.mark.parametrize('route,chunk,_key', MIGRATED_PAGES)
    def test_plotly_loaded_only_where_used(self, client, route, chunk, _key):
        """Chemistry makes zero Plotly calls, so it must not ship the 3.5 MB build."""
        html = client.get(reverse(route)).content.decode()
        loads_plotly = 'vendor/plotly.min.js' in html
        assert loads_plotly == (chunk in PAGES_USING_PLOTLY), (
            f"{route}: expected plotly loaded={chunk in PAGES_USING_PLOTLY}, got {loads_plotly}"
        )


# ---------------------------------------------------------------------------
# Production settings
# ---------------------------------------------------------------------------

@pytest.fixture
def production_settings(monkeypatch):
    """
    Import ``config.settings.production`` in isolation and return its namespace.

    The whole suite runs on the development settings, so nothing ever imported
    the production module — which is how it came to reference a package that was
    not in requirements.txt (every request died with ModuleNotFoundError) and a
    setting Django 5.1 had removed (static files silently served unhashed and
    uncompressed), while ``manage.py check`` stayed green. Importing the module
    by hand is enough to catch both, and needs no separate settings run.
    """
    import importlib

    monkeypatch.setenv('SECRET_KEY', 'x' * 50)
    monkeypatch.setenv('ALLOWED_HOSTS', 'dashboard.example.com')
    return importlib.import_module('config.settings.production')


class TestProductionSettings:
    """Guards the deploy path that no other test exercises."""

    def test_whitenoise_is_installed(self):
        """
        production.py names WhiteNoise in MIDDLEWARE and STORAGES. Django builds
        the middleware chain lazily on the first request, not during `check`, so
        a missing package surfaces as a 500 in production rather than at deploy.
        """
        import whitenoise.middleware  # noqa: F401
        import whitenoise.storage  # noqa: F401

    def test_static_storage_uses_whitenoise(self, production_settings):
        """
        STATICFILES_STORAGE was removed in Django 5.1; assigning it is a silent
        no-op. The replacement is the STORAGES dict, and only it actually
        activates compression and hashed filenames.
        """
        backend = production_settings.STORAGES['staticfiles']['BACKEND']
        assert backend == 'whitenoise.storage.CompressedManifestStaticFilesStorage'
        assert not hasattr(production_settings, 'STATICFILES_STORAGE'), (
            "STATICFILES_STORAGE does nothing on Django 5.1+; use STORAGES"
        )

    def test_storages_keeps_the_default_entry(self, production_settings):
        """Declaring STORAGES replaces Django's default wholesale, not merges."""
        assert 'default' in production_settings.STORAGES

    def test_whitenoise_sits_directly_after_security_middleware(self, production_settings):
        """
        WhiteNoise's documented position is immediately after SecurityMiddleware.
        A hardcoded index put it *ahead* — CorsMiddleware holds slot 0 — so
        static responses escaped the HSTS and SSL-redirect headers.
        """
        mw = production_settings.MIDDLEWARE
        security = mw.index('django.middleware.security.SecurityMiddleware')
        assert mw[security + 1] == 'whitenoise.middleware.WhiteNoiseMiddleware'

    def test_ssl_redirect_trusts_the_proxy_header(self, production_settings):
        """
        SECURE_SSL_REDIRECT reads request.is_secure(). Behind a TLS-terminating
        proxy the hop to Django is plain HTTP, so without this header the
        redirect loops forever.
        """
        assert production_settings.SECURE_SSL_REDIRECT is True
        assert production_settings.SECURE_PROXY_SSL_HEADER == (
            'HTTP_X_FORWARDED_PROTO', 'https',
        )

    def test_csrf_trusted_origins_covers_allowed_hosts(self, production_settings):
        """
        Django matches Origin against this list before accepting any unsafe
        method, so an entry missing here rejects legitimate POSTs. Deriving it
        from ALLOWED_HOSTS is what keeps the two from drifting apart.
        """
        assert production_settings.CSRF_TRUSTED_ORIGINS == [
            f'https://{host}' for host in production_settings.ALLOWED_HOSTS
        ]

    def test_debug_is_pinned_off(self, production_settings):
        """Pinned in the module, never read from the environment."""
        assert production_settings.DEBUG is False

    def test_cache_is_shared_across_workers(self, production_settings):
        """
        The 60/min anonymous throttle counts through the cache. A per-process
        LocMemCache multiplies the effective limit by the worker count.
        """
        backend = production_settings.CACHES['default']['BACKEND']
        assert 'locmem' not in backend.lower()


class TestBaseSettings:
    def test_debug_is_read_from_the_environment(self):
        """
        base.py declared a DEBUG cast but never assigned DEBUG, so setting it in
        .env did nothing and any settings module importing only base fell
        through to Django's default.
        """
        from config.settings import base

        assert hasattr(base, 'DEBUG')

    def test_bundle_does_not_duplicate_vendored_libraries(self, client):
        """
        The Vite bundle must contain application code only. If a module ever
        re-adds `import * as THREE from 'three'`, the page would run two
        different Three.js builds at once.
        """
        from pathlib import Path

        for module in Path('frontend/src').rglob('*.js'):
            source = module.read_text(encoding='utf-8')
            assert "from 'three'" not in source, f"{module} imports three from npm"
            assert "'plotly.js-dist'" not in source, f"{module} imports plotly from npm"

    @pytest.mark.parametrize('route,_chunk,_key', MIGRATED_PAGES)
    def test_controller_no_longer_inline(self, client, route, _chunk, _key):
        html = client.get(reverse(route)).content.decode()
        for symbol in INLINE_CONTROLLER_SYMBOLS:
            assert symbol not in html, f"{route} still declares {symbol} inline"

    @pytest.mark.parametrize('route,_chunk,key', MIGRATED_PAGES)
    def test_translations_stay_inline(self, client, route, _chunk, key):
        """
        The i18n block must remain inline: it has to register its
        DOMContentLoaded listener before base.html's translatePage listener,
        which a deferred module cannot do.
        """
        html = client.get(reverse(route)).content.decode()
        assert key in html, f"{route} lost its inline i18n dictionary"
        assert 'window.TRANSLATIONS' in html

    @pytest.mark.parametrize('route,_chunk,_key', MIGRATED_PAGES)
    def test_page_module_is_deferred(self, client, route, _chunk, _key):
        """
        The page bundle must load as a module (therefore deferred), so it runs
        after the vendored classic <script> tags have installed THREE/Plotly.
        """
        html = client.get(reverse(route)).content.decode()
        assert 'type="module"' in html
