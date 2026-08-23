"""apps/app_materials/views.py"""
import logging

from django.views.generic import TemplateView
from rest_framework import status
from rest_framework.views import APIView

from apps.core.responses import (
    computation_error_response,
    error_response,
    success_response,
)
from apps.core.schema import SerializerSchemaView

from .serializers import BeamDeflectionInputSerializer

logger = logging.getLogger(__name__)


class MaterialsPageView(TemplateView):
    template_name = 'app_materials/index.html'


class BeamDeflectionView(APIView):
    """POST /api/materials/beam-deflection/ — Euler-Bernoulli beam analysis."""

    def post(self, request, *args, **kwargs):
        from .services import BeamDeflectionService

        serializer = BeamDeflectionInputSerializer(data=request.data)
        if not serializer.is_valid():
            return error_response(
                message="Invalid beam parameters.",
                code="validation_error",
                errors=serializer.errors,
                http_status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            service = BeamDeflectionService(**serializer.to_service_kwargs())
            result = service.compute()
        except Exception as exc:
            return computation_error_response(
                exc,
                view_name="BeamDeflectionView",
                view_logger=logger,
            )

        return success_response(result)


class BeamDeflectionSchemaView(SerializerSchemaView):
    """GET /api/materials/beam-deflection/schema/ — form schema for the beam solver."""
    serializer_class = BeamDeflectionInputSerializer
