"""
apps/core/responses.py
=======================
Standardised JSON response helpers and a custom DRF exception handler.

All API responses follow this envelope structure:

    Success:
    {
        "status": "success",
        "data": { ... }
    }

    Error:
    {
        "status": "error",
        "code": "validation_error",
        "message": "Human-readable summary",
        "errors": { "field": ["detail", ...] }
    }
"""

import logging
from typing import Any

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

from apps.core.exceptions import DomainError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Response Builders
# ---------------------------------------------------------------------------

def success_response(data: Any, http_status: int = status.HTTP_200_OK) -> Response:
    """
    Return a standardised success Response.

    Args:
        data:        Serializable payload to nest under ``"data"``.
        http_status: HTTP status code (default 200).

    Returns:
        DRF ``Response`` with ``{"status": "success", "data": ...}``.
    """
    return Response(
        {"status": "success", "data": data},
        status=http_status,
    )


def error_response(
    message: str,
    code: str = "error",
    errors: dict | None = None,
    http_status: int = status.HTTP_400_BAD_REQUEST,
) -> Response:
    """
    Return a standardised error Response.

    Args:
        message:     Human-readable error summary.
        code:        Machine-readable error code (e.g. ``"validation_error"``).
        errors:      Optional field-level error details.
        http_status: HTTP status code (default 400).

    Returns:
        DRF ``Response`` with structured error envelope.
    """
    payload: dict = {
        "status": "error",
        "code": code,
        "message": message,
    }
    if errors:
        payload["errors"] = errors
    return Response(payload, status=http_status)


# ---------------------------------------------------------------------------
# Service-Layer Failure Classification
# ---------------------------------------------------------------------------

def computation_error_response(
    exc: Exception,
    *,
    view_name: str,
    code: str = "calculation_error",
    message: str | None = None,
    view_logger: logging.Logger | None = None,
) -> Response:
    """
    Turn a service-layer exception into the right HTTP response.

    Classification:
        - ``DomainError``  → 400, message shown verbatim (author wrote it for the user)
        - ``ValidationError`` (DRF) → 400, field detail forwarded
        - ``ValueError``   → 400, message shown verbatim (idiomatic "bad argument")
        - anything else    → 500, generic message, traceback logged server-side

    The 500 branch never returns ``str(exc)`` to the client unless ``DEBUG`` is
    on. In production that string could contain file paths, SQL fragments, or
    library internals; a caller cannot act on it either way.

    Args:
        exc:         The exception raised by the service layer.
        view_name:   Name used in the server-side log line (e.g. ``"PipeFlowCalculateView"``).
        code:        Machine-readable code for the 400 branch.
        message:     Override for the 400 branch message. Defaults to ``str(exc)``.
        view_logger: Logger to use. Defaults to this module's logger.

    Returns:
        DRF ``Response`` with the standard error envelope.
    """
    log = view_logger or logger

    if isinstance(exc, DomainError):
        return error_response(
            message=message or exc.message,
            code=exc.code,
            errors=exc.errors,
            http_status=status.HTTP_400_BAD_REQUEST,
        )

    if isinstance(exc, ValidationError):
        # A core validator fired inside the service layer rather than the
        # serializer. Still the caller's problem — forward the field detail.
        detail = exc.detail if isinstance(exc.detail, dict) else {"non_field_errors": exc.detail}
        return error_response(
            message=_extract_message(detail),
            code="validation_error",
            errors=detail,
            http_status=status.HTTP_400_BAD_REQUEST,
        )

    if isinstance(exc, ValueError):
        return error_response(
            message=message or str(exc),
            code=code,
            http_status=status.HTTP_400_BAD_REQUEST,
        )

    # Unexpected — this is a bug on our side, not bad input.
    log.exception("%s failed with an unhandled exception", view_name, exc_info=exc)
    return error_response(
        message="Computation failed due to an internal error. Please try again.",
        code="server_error",
        errors={"detail": f"{type(exc).__name__}: {exc}"} if settings.DEBUG else None,
        http_status=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )


# ---------------------------------------------------------------------------
# Custom DRF Exception Handler
# ---------------------------------------------------------------------------

def custom_exception_handler(exc: Exception, context: dict) -> Response | None:
    """
    Wrap DRF's default exception handler output in our standard envelope.

    Configured in ``settings/base.py`` under ``REST_FRAMEWORK['EXCEPTION_HANDLER']``.
    """
    # Let DRF handle the exception first
    response = drf_exception_handler(exc, context)

    if response is not None:
        # Log server errors with full traceback
        if response.status_code >= 500:
            logger.exception(
                "Unhandled API exception in %s",
                context.get('view', 'unknown view'),
                exc_info=exc,
            )

        # Re-shape the response into our envelope
        original_data = response.data

        # Determine human-readable message
        if isinstance(original_data, dict):
            # DRF ValidationError: {"field": ["error"]}
            message = _extract_message(original_data)
            errors = original_data
        elif isinstance(original_data, list):
            message = str(original_data[0]) if original_data else "An error occurred."
            errors = {"non_field_errors": original_data}
        else:
            message = str(original_data)
            errors = None

        # Omit `errors` when there is nothing to put in it, matching
        # error_response() above. Emitting `"errors": null` here meant a 404 or
        # 405 raised by DRF came back in a different shape from an error raised
        # by a view, so clients had to handle both.
        payload = {
            "status": "error",
            "code": _status_to_code(response.status_code),
            "message": message,
        }
        if errors:
            payload["errors"] = errors
        response.data = payload

    return response


# ---------------------------------------------------------------------------
# Internal Helpers
# ---------------------------------------------------------------------------

def _extract_message(data: dict) -> str:
    """Extract first human-readable message from a DRF validation error dict."""
    for key, value in data.items():
        if isinstance(value, list) and value:
            return f"{key}: {value[0]}"
        if isinstance(value, str):
            return f"{key}: {value}"
    return "Validation failed."


def _status_to_code(http_status: int) -> str:
    """Map HTTP status code to a machine-readable error code string."""
    codes = {
        400: "validation_error",
        401: "authentication_required",
        403: "permission_denied",
        404: "not_found",
        405: "method_not_allowed",
        429: "throttled",
        500: "server_error",
    }
    return codes.get(http_status, "error")
