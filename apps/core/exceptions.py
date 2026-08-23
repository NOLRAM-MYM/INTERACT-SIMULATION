"""
apps/core/exceptions.py
========================
Domain-level exceptions shared by every scientific module.

Why this exists
---------------
Service layers raise two very different kinds of failure:

1. **Domain failures** — the input parsed and validated fine at the serializer
   level, but the computation itself is physically or mathematically invalid
   (unknown chemical element, formula that cannot be parsed, gear geometry with
   interference, solver that fails to converge). These are the *caller's*
   problem and must return HTTP 400 with an actionable message.

2. **Programming failures** — an ``AttributeError``, a bad index, a broken
   dependency. These are *our* problem, must be logged with a traceback, and
   must never leak internal detail to the client. They return HTTP 500 with a
   generic message.

Before this module, every view caught a bare ``Exception`` and returned
``str(exc)`` to the client, which conflated the two: a genuine bug was reported
to the user as if they had typed something wrong, and internal detail leaked
out. ``DomainError`` makes the distinction explicit and machine-checkable.

Usage in a service:

    from apps.core.exceptions import DomainError

    if formula_is_unparseable:
        raise DomainError(f"Cannot parse formula {formula!r}.", code="parse_error")
"""


class DomainError(Exception):
    """
    A physically or mathematically invalid request the caller can fix.

    Always maps to HTTP 400. The message is shown to the client verbatim, so it
    must be human-readable and must not contain internal paths or state.

    Args:
        message: Human-readable explanation of what is wrong with the input.
        code:    Machine-readable error code returned under ``"code"``.
        errors:  Optional field-level detail, e.g. ``{"formula": "..."}``.
    """

    #: Default machine-readable code when the caller does not pass one.
    default_code = "domain_error"

    def __init__(
        self,
        message: str,
        code: str | None = None,
        errors: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code
        self.errors = errors


class ComputationError(DomainError):
    """
    A solver ran but could not produce a valid result for these inputs.

    Distinct from ``DomainError`` only in its default code, so the frontend can
    tell "your input is malformed" apart from "your input is well-formed but
    unsolvable" (e.g. a stiff ODE that fails to converge).
    """

    default_code = "computation_error"
