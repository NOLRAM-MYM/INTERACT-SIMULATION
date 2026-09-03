"""apps/app_biology/views.py"""
import logging
from django.views.generic import TemplateView
from rest_framework.views import APIView
from rest_framework import serializers, status
from apps.core.responses import (
    computation_error_response,
    success_response,
    error_response,
)
from .services import (
    DnaMolecularService,
    CellularBiologyService,
    InfectionSimulationService,
)

logger = logging.getLogger(__name__)


class BiologyPageView(TemplateView):
    """Render the main Biology Simulation HTML template."""
    template_name = 'app_biology/index.html'


class DnaAnalyzeView(APIView):
    """POST /api/biology/dna/analyze/ — Transcribes and translates DNA sequence."""

    def post(self, request, *args, **kwargs):
        seq = request.data.get('sequence', '')
        if not seq:
            return error_response(
                message='A sequência de DNA é obrigatória.',
                code='missing_sequence',
                http_status=status.HTTP_400_BAD_REQUEST
            )

        try:
            service = DnaMolecularService()
            result = service.analyze_dna(seq)
            return success_response(result)
        except ValueError as e:
            return error_response(
                message=str(e),
                code='invalid_dna_sequence',
                http_status=status.HTTP_400_BAD_REQUEST
            )
        except Exception as e:
            logger.exception("Error analyzing DNA: %s", e)
            return computation_error_response(e, view_name="DnaAnalyzeView", message="Erro ao processar a sequência de DNA.")


class DnaPresetsView(APIView):
    """GET /api/biology/dna/presets/ — Return preconfigured biological DNA sequences."""

    def get(self, request, *args, **kwargs):
        service = DnaMolecularService()
        return success_response(service.PRESETS)


class CellularStructuresView(APIView):
    """GET /api/biology/cells/structures/ — Organelles and morphology data."""

    def get(self, request, *args, **kwargs):
        service = CellularBiologyService()
        return success_response({
            'animal_cell': service.ANIMAL_CELL_ORGANELLES,
            'plant_cell': service.PLANT_CELL_ORGANELLES,
            'microbes': service.MICROBES_DATABASE,
        })


class InfectionSimulateView(APIView):
    """POST /api/biology/infection/simulate/ — Runs pathogen-host cellular infection simulation."""

    def post(self, request, *args, **kwargs):
        scenario = request.data.get('scenario', 'virus_animal')
        initial_load = int(request.data.get('initial_load', 50))
        immune_level = int(request.data.get('immune_defense_level', 40))
        treatment = request.data.get('treatment', 'none')
        steps = int(request.data.get('duration_steps', 30))

        try:
            service = InfectionSimulationService()
            result = service.simulate_infection(
                scenario=scenario,
                initial_load=initial_load,
                immune_defense_level=immune_level,
                treatment=treatment,
                duration_steps=steps
            )
            return success_response(result)
        except Exception as e:
            logger.exception("Error simulating infection: %s", e)
            return computation_error_response(e, view_name="InfectionSimulateView", message="Erro ao simular dinâmica de infecção celular.")
