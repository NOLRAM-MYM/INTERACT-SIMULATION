"""apps/app_chemistry/views.py"""
import dataclasses
import logging

from django.views.generic import TemplateView
from rest_framework.views import APIView
from rest_framework import serializers, status
from rest_framework.exceptions import ValidationError as DRFValidationError
from apps.core.responses import (
    computation_error_response,
    success_response,
    error_response,
)
from apps.core.schema import SerializerSchemaView
from apps.core.validators import validate_atomic_number

logger = logging.getLogger(__name__)


class ChemistryPageView(TemplateView):
    template_name = 'app_chemistry/index.html'


class PeriodicTableListView(APIView):
    """GET /api/chemistry/elements/ — Complete periodic table dataset."""

    def get(self, request, *args, **kwargs):
        from .fallback_db import load_elements_data
        elements = load_elements_data()
        res = []
        for el in elements:
            res.append({
                "symbol": el.get("symbol"),
                "name": el.get("name"),
                "number": el.get("number"),
                "period": el.get("period"),
                "group": el.get("group"),
                "category": el.get("category"),
                "mass": el.get("atomic_mass") or el.get("mass") or 0.0
            })
        return success_response(res)



class ElementPropertyView(APIView):
    """GET /api/chemistry/element/<symbol_or_z>/ — Element properties."""

    def get(self, request, identifier, *args, **kwargs):
        from .services import ElementPropertyService

        # A numeric path segment is an atomic number and must be in range;
        # anything else is treated as a symbol.
        #
        # validate_atomic_number raises DRF's ValidationError, which is NOT a
        # ValueError — so wrapping it in `except ValueError` (the guard for
        # int() failing on a symbol) let an out-of-range Z escape this view
        # entirely and get rendered by the global exception handler in a
        # different envelope shape. Split the two concerns.
        try:
            z = int(identifier)
        except ValueError:
            lookup = str(identifier).capitalize()
        else:
            try:
                validate_atomic_number(z)
            except DRFValidationError as exc:
                return error_response(
                    message=str(exc.detail['atomic_number'][0]),
                    code="element_not_found",
                    http_status=status.HTTP_404_NOT_FOUND,
                )
            lookup = z

        try:
            service = ElementPropertyService()
            data = service.get_element(lookup)
        except ValueError:
            # The element genuinely is not in the dataset — that is a 404, not
            # a malformed request and not a server fault.
            return error_response(
                message=f"Element '{identifier}' not found.",
                code="element_not_found",
                http_status=status.HTTP_404_NOT_FOUND,
            )
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="ElementPropertyView",
                view_logger=logger,
            )
        return success_response(dataclasses.asdict(data))


class ChemistrySimulateSerializer(serializers.Serializer):
    """Validates chemical bonding or reaction simulation requests."""

    schema_title = "Bonding & Reaction Simulator"
    schema_description = (
        "Simulates covalent/ionic bonding for a chemical formula, or runs a "
        "known reaction by id."
    )
    schema_field_meta = {
        'mode':        {'label': "Simulation Mode", 'unit': None},
        'formula':     {'label': "Chemical Formula", 'unit': None,
                        'help': "Required when mode is 'bond' (e.g. H2O, C6H12O6)."},
        'reaction_id': {'label': "Reaction", 'unit': None,
                        'help': "Required when mode is 'reaction'."},
    }

    mode = serializers.ChoiceField(choices=['bond', 'reaction'])
    formula = serializers.CharField(required=False, allow_blank=True, default='')
    reaction_id = serializers.CharField(required=False, allow_blank=True, default='')

    def validate(self, data):
        mode = data.get('mode')
        if mode == 'bond' and not data.get('formula'):
            raise serializers.ValidationError({"formula": "Formula is required when mode is 'bond'."})
        if mode == 'reaction' and not data.get('reaction_id'):
            raise serializers.ValidationError({"reaction_id": "reaction_id is required when mode is 'reaction'."})
        return data


class ChemistrySimulateView(APIView):
    """
    POST /api/chemistry/simulate/
    Simulates atomic bonds or compound reactions.
    """

    def post(self, request, *args, **kwargs):
        serializer = ChemistrySimulateSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid simulation parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        mode = data['mode']
        try:
            from .services import ChemistrySimulationService
            if mode == 'bond':
                result = ChemistrySimulationService.run_bond(data['formula'])
            else:
                result = ChemistrySimulationService.run_reaction(data['reaction_id'])
            return success_response(result)
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="ChemistrySimulateView",
                code="simulation_error",
                view_logger=logger,
            )


class ChemistrySimulateSchemaView(SerializerSchemaView):
    """GET /api/chemistry/simulate/schema/ — form schema for the simulator."""
    serializer_class = ChemistrySimulateSerializer


class StoichiometryInputSerializer(serializers.Serializer):
    """Validates an arbitrary chemical formula for the stoichiometry endpoint."""

    schema_title = "Stoichiometry"
    schema_description = (
        "Computes molar mass and per-element mass composition for an arbitrary "
        "chemical formula using real atomic masses."
    )
    schema_field_meta = {
        'formula': {'label': "Chemical Formula", 'unit': None,
                    'help': "e.g. C6H12O6, Fe2(SO4)3"},
    }

    formula = serializers.CharField(max_length=100, allow_blank=False)


class StoichiometryView(APIView):
    """
    POST /api/chemistry/stoichiometry/
    Computes molar mass and per-element mass composition for an arbitrary
    chemical formula (e.g. 'C6H12O6', 'Fe2(SO4)3'), using real atomic masses.
    """

    def post(self, request, *args, **kwargs):
        serializer = StoichiometryInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid formula.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            from .services import FormulaParserService
            result = FormulaParserService.compute_molar_mass(serializer.validated_data['formula'])
            return success_response(result)
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="StoichiometryView",
                code="parse_error",
                view_logger=logger,
            )


class StoichiometrySchemaView(SerializerSchemaView):
    """GET /api/chemistry/stoichiometry/schema/ — form schema for molar mass."""
    serializer_class = StoichiometryInputSerializer

