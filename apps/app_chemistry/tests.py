"""
apps/app_chemistry/tests.py
===========================
Tests for the Chemistry Periodic Table & Reaction Simulator.
"""

import pytest
from django.urls import reverse
from rest_framework.test import APIClient
from .services import ElementPropertyService, ChemistrySimulationService, FormulaParserService


@pytest.fixture
def api_client():
    return APIClient()


class TestElementPropertyService:
    def test_get_element_by_symbol(self):
        service = ElementPropertyService()
        el = service.get_element("Fe")
        assert el.symbol == "Fe"
        assert el.name == "Iron"
        assert el.atomic_number == 26
        assert el.atomic_mass > 55.0

    def test_get_element_by_number(self):
        service = ElementPropertyService()
        el = service.get_element(6)
        assert el.symbol == "C"
        assert el.name == "Carbon"
        assert el.atomic_number == 6

    def test_hydrogen_ionisation_energy_is_in_electronvolts(self):
        """
        13.598 eV is the textbook first ionisation energy of hydrogen. Pinning
        it here catches a unit slip in either backend — the mendeleev path used
        to apply a kJ/mol conversion to a value already in eV, reporting 0.141.
        """
        el = ElementPropertyService().get_element("H")
        assert el.ionisation_energy_ev == pytest.approx(13.598, abs=0.01)

    def test_electron_configuration_is_a_string(self):
        """
        This field is typed `str` and reaches the client through
        dataclasses.asdict + JSONRenderer, which rejects non-string dict keys.
        """
        el = ElementPropertyService().get_element("Fe")
        assert isinstance(el.electron_configuration, str)
        assert el.electron_configuration


class _FakeMendeleevElement:
    """Minimal stand-in shaped like the attributes the service reads."""

    symbol = "H"
    name = "Hydrogen"
    atomic_number = 1
    atomic_weight = 1.008
    period = 1
    group_id = 1
    # mendeleev reports these in eV, keyed by ionisation stage.
    ionenergies = {1: 13.598434599702}
    covalent_radius_pyykko = 32.0
    melting_point = 13.99
    boiling_point = 20.271
    density = 8.988e-05
    oxistates = [-1, 1]

    class _EC:
        # The real type is an OrderedDict keyed by (n, subshell) tuples — the
        # shape that used to be assigned straight to a `str` field.
        conf = {(1, 's'): 1}

    ec = _EC()

    def electronegativity(self, scale='pauling'):
        return 2.20


class TestMendeleevBackend:
    """
    mendeleev is optional (requirements-advanced.txt) and absent from the test
    environment, so this whole branch of ElementPropertyService ran untested —
    which is how a ~96x unit error and a guaranteed 500 both survived in it.
    Injecting a fake module exercises it without adding the dependency.
    """

    @pytest.fixture
    def fake_mendeleev(self, monkeypatch):
        import sys
        import types

        module = types.ModuleType('mendeleev')
        module.element = lambda identifier: _FakeMendeleevElement()
        monkeypatch.setitem(sys.modules, 'mendeleev', module)
        return module

    def test_ionisation_energy_is_not_rescaled(self, fake_mendeleev):
        el = ElementPropertyService().get_element("H")
        assert el.ionisation_energy_ev == pytest.approx(13.598, abs=0.01)

    def test_electron_configuration_is_flattened_to_a_string(self, fake_mendeleev):
        el = ElementPropertyService().get_element("H")
        assert el.electron_configuration == "1s1"

    def test_result_is_json_serialisable(self, fake_mendeleev):
        """dataclasses.asdict -> json.dumps is exactly what the view does."""
        import dataclasses
        import json

        el = ElementPropertyService().get_element("H")
        json.dumps(dataclasses.asdict(el))  # must not raise

    def test_backend_failure_falls_back_instead_of_500ing(self, monkeypatch):
        """
        mendeleev raises SQLAlchemy's NoResultFound for an unknown element,
        which is not a ValueError, so it escaped the view's 404 branch and
        surfaced as a 500. Any backend failure now degrades to the local table.
        """
        import sys
        import types

        class Boom(Exception):
            pass

        def explode(identifier):
            raise Boom("no such element")

        module = types.ModuleType('mendeleev')
        module.element = explode
        monkeypatch.setitem(sys.modules, 'mendeleev', module)

        el = ElementPropertyService().get_element("Fe")
        assert el.symbol == "Fe"
        assert el.atomic_number == 26


class TestChemistrySimulationService:
    def test_simulate_bond_water(self):
        res = ChemistrySimulationService.run_bond("H2O")
        assert res["formula"] == "H2O"
        assert res["name"] == "Água"
        assert res["mass"] == 18.015
        assert res["bond_type"] == "Covalente Polar"
        assert len(res["atoms"]) == 3

    def test_simulate_bond_nacl(self):
        res = ChemistrySimulationService.run_bond("NaCl")
        assert res["formula"] == "NaCl"
        assert res["name"] == "Cloreto de Sódio (Sal de Cozinha)"
        assert res["bond_type"] == "Iônica"
        assert len(res["atoms"]) == 2

    def test_simulate_reaction_sodium_water(self):
        res = ChemistrySimulationService.run_reaction("sodium_water")
        assert res["id"] == "sodium_water"
        assert "NaOH" in res["product_name"]
        assert "H2" in res["byproduct_name"]
        assert res["product_mass"] == 39.997
        assert res["byproduct_mass"] == 2.016


class TestFormulaParserService:
    def test_parse_simple_formula(self):
        counts = FormulaParserService.parse_formula("H2O")
        assert counts == {"H": 2, "O": 1}

    def test_parse_formula_with_parentheses(self):
        counts = FormulaParserService.parse_formula("Fe2(SO4)3")
        assert counts == {"Fe": 2, "S": 3, "O": 12}

    def test_molar_mass_glucose_matches_known_value(self):
        result = FormulaParserService.compute_molar_mass("C6H12O6")
        assert result["molar_mass_g_mol"] == pytest.approx(180.156, rel=1e-3)

    def test_molar_mass_nacl_matches_legacy_static_value(self):
        """Cross-check the dynamic parser against the static value already
        hardcoded in ChemistrySimulationService.COMPOUNDS['NaCl']['mass']."""
        result = FormulaParserService.compute_molar_mass("NaCl")
        legacy = ChemistrySimulationService.COMPOUNDS["NaCl"]["mass"]
        assert result["molar_mass_g_mol"] == pytest.approx(legacy, rel=1e-2)

    def test_mass_percent_sums_to_100(self):
        result = FormulaParserService.compute_molar_mass("CH4")
        total_pct = sum(c["mass_percent"] for c in result["composition"])
        assert total_pct == pytest.approx(100.0, rel=1e-6)

    def test_unknown_element_raises(self):
        with pytest.raises(ValueError):
            FormulaParserService.compute_molar_mass("Xx2O")

    def test_empty_formula_raises(self):
        with pytest.raises(ValueError):
            FormulaParserService.parse_formula("")


class TestChemistryAPI:
    def test_get_elements_list(self, api_client):
        url = reverse("chemistry:periodic-table-list")
        response = api_client.get(url)
        assert response.status_code == 200
        assert response.data["status"] == "success"
        symbols = [el["symbol"] for el in response.data["data"]]
        assert "Fe" in symbols
        assert "H" in symbols
        assert "O" in symbols

    def test_get_element_detail(self, api_client):
        url = reverse("chemistry:element-property", kwargs={"identifier": "Fe"})
        response = api_client.get(url)
        assert response.status_code == 200
        assert response.data["status"] == "success"
        assert response.data["data"]["symbol"] == "Fe"

    def test_simulate_bond_api_success(self, api_client):
        url = reverse("chemistry:chemistry-simulate")
        payload = {"mode": "bond", "formula": "H2O"}
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 200
        assert response.data["status"] == "success"
        assert response.data["data"]["formula"] == "H2O"

    def test_simulate_reaction_api_success(self, api_client):
        url = reverse("chemistry:chemistry-simulate")
        payload = {"mode": "reaction", "reaction_id": "sodium_water"}
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 200
        assert response.data["status"] == "success"
        assert response.data["data"]["id"] == "sodium_water"

    def test_simulate_api_validation_error(self, api_client):
        url = reverse("chemistry:chemistry-simulate")
        payload = {"mode": "bond"}
        response = api_client.post(url, payload, format="json")
        assert response.status_code == 400
        assert response.data["status"] == "error"
        assert "formula" in response.data["errors"]

    def test_stoichiometry_api_success(self, api_client):
        url = reverse("chemistry:stoichiometry")
        response = api_client.post(url, {"formula": "C6H12O6"}, format="json")
        assert response.status_code == 200
        assert response.data["status"] == "success"
        assert response.data["data"]["molar_mass_g_mol"] == pytest.approx(180.156, rel=1e-3)

    def test_stoichiometry_api_invalid_formula_returns_400(self, api_client):
        url = reverse("chemistry:stoichiometry")
        response = api_client.post(url, {"formula": "Xx2O"}, format="json")
        assert response.status_code == 400
        assert response.data["status"] == "error"
