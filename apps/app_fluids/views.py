"""
apps/app_fluids/views.py
=========================
REST API views for the Fluid Mechanics module.

Endpoints:
    POST /api/fluids/pipe-flow/calculate/
        → Compute full pipe flow analysis. Returns JSON with Reynolds number,
          friction factor, pressure drop, velocity profile, and sweep data.

    GET  /api/fluids/pipe-flow/schema/
        → Returns the input schema (field names, units, defaults, constraints)
          so the frontend can auto-generate the form without hard-coding field
          names. Derived from PipeFlowInputSerializer — see apps.core.schema.

    GET  /api/fluids/
        → Returns the pipe flow HTML template (full page view).
"""

import dataclasses
import logging

from django.views.generic import TemplateView
from rest_framework.views import APIView
from rest_framework import status

from apps.core.responses import (
    computation_error_response,
    error_response,
    success_response,
)
from apps.core.schema import SerializerSchemaView
from .serializers import PipeFlowInputSerializer
from .services import PipeFlowService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Template View (HTML Page)
# ---------------------------------------------------------------------------

class PipeFlowPageView(TemplateView):
    """Render the full Pipe Flow dashboard page."""
    template_name = 'app_fluids/pipe_flow.html'


# ---------------------------------------------------------------------------
# API View — Pipe Flow Calculation
# ---------------------------------------------------------------------------

class PipeFlowCalculateView(APIView):
    """
    POST /api/fluids/pipe-flow/calculate/

    Accepts pipe and fluid parameters as JSON, runs PipeFlowService,
    and returns the complete analysis as a structured JSON response.

    Request body (JSON):
        {
            "diameter_mm": 50.0,        // Inner diameter [mm]
            "length_m": 100.0,          // Pipe length [m]
            "roughness_mm": 0.046,      // Wall roughness [mm] (default: 0.046)
            "density_kg_m3": 1000.0,    // Fluid density [kg/m³] (default: 1000)
            "viscosity_mpa_s": 1.002,   // Dynamic viscosity [mPa·s] (default: 1.002)
            "flow_rate_lpm": 120.0,     // Volumetric flow rate [L/min]
            "num_elbows_90": 2,         // Optional: fitting count
            "num_gate_valves_open": 1,
            "num_check_valves": 0
        }

    Response (JSON):
        {
            "status": "success",
            "data": {
                "velocity_m_s": 1.02,
                "reynolds_number": 51000.0,
                "flow_regime": "Turbulent",
                "friction_factor": 0.0208,
                "pressure_drop_total_bar": 0.234,
                ... (full PipeFlowResult fields)
            }
        }
    """

    def post(self, request, *args, **kwargs):
        logger.info("PipeFlowCalculateView.post() — %s", request.data)

        # 1. Validate and deserialize input
        serializer = PipeFlowInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid input parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        # 2. Build SI-unit input dataclass
        pipe_input = serializer.to_pipe_flow_input()

        # 3. Run computation
        try:
            service = PipeFlowService(pipe_input)
            result  = service.compute()
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="PipeFlowCalculateView",
                view_logger=logger,
            )

        # 4. Serialize result (dataclass → dict)
        result_dict = dataclasses.asdict(result)

        return success_response(result_dict, http_status=status.HTTP_200_OK)


# ---------------------------------------------------------------------------
# API View — Input Schema (for form auto-generation)
# ---------------------------------------------------------------------------

class PipeFlowSchemaView(SerializerSchemaView):
    """
    GET /api/fluids/pipe-flow/schema/

    Field constraints (type, default, min, max) are read off
    ``PipeFlowInputSerializer`` rather than restated here, so tightening a
    bound on the serializer updates the form automatically. Labels, units and
    UI step sizes live in that serializer's ``schema_field_meta``.
    """
    serializer_class = PipeFlowInputSerializer
