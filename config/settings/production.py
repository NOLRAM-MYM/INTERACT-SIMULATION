"""
config/settings/production.py
==============================
Production environment settings — DEBUG off, security headers on.

Deploy order matters
--------------------
``npm run build`` MUST run before ``collectstatic``. The Vite manifest names
every bundle with a content hash, and ``apps/core/templatetags/vite.py`` resolves
those names through Django's ``static()``. Under the manifest storage configured
below, ``static()`` raises ``ValueError: Missing staticfiles manifest entry`` for
any file that was not present when ``collectstatic`` ran — and ``vite_asset``
deliberately re-raises with DEBUG off, so a build that lands after collectstatic
turns every page into a 500 rather than a degraded render.

    npm run build && python manage.py collectstatic --noinput
"""
from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401, F403

# Pinned, not read from the environment: a stray DEBUG=True in a production
# environment would leak tracebacks and settings to every visitor.
DEBUG = False

# ---------------------------------------------------------------------------
# Secrets — fail fast, never fall back
# ---------------------------------------------------------------------------
# base.py gives SECRET_KEY a development default so `runserver` works out of the
# box. That default must never reach production: without this override, a
# missing SECRET_KEY env var would boot silently with a key that is public in
# the repository, making every session cookie and password-reset token forgeable.
# Calling env() with no default raises ImproperlyConfigured at import time.
SECRET_KEY = env('SECRET_KEY')  # noqa: F405

if not ALLOWED_HOSTS or '*' in ALLOWED_HOSTS:  # noqa: F405
    raise ImproperlyConfigured(
        "ALLOWED_HOSTS must list explicit hostnames in production. "
        "Set the ALLOWED_HOSTS environment variable."
    )

# Security hardening
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = 'DENY'
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

# SECURE_SSL_REDIRECT above decides "is this request already HTTPS?" from
# request.is_secure(). Behind a TLS-terminating proxy the connection to Django
# is plain HTTP, so is_secure() is always False and the redirect loops forever.
# The proxy signals the original scheme in a header; trust it.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

# CSRF_COOKIE_SECURE alone is not enough once the site is served through a
# proxy or on a non-default port: Django matches the Origin header against this
# list before accepting any unsafe method. Derived from ALLOWED_HOSTS so the two
# cannot drift, and overridable for the odd case (extra port, sibling domain).
CSRF_TRUSTED_ORIGINS = env.list(  # noqa: F405
    'CSRF_TRUSTED_ORIGINS',
    default=[f'https://{host}' for host in ALLOWED_HOSTS],  # noqa: F405
)

# ---------------------------------------------------------------------------
# Static files — WhiteNoise
# ---------------------------------------------------------------------------
# WhiteNoise must sit directly *after* SecurityMiddleware, not at a fixed index:
# CorsMiddleware occupies slot 0, so the previous hardcoded `insert(1, ...)` put
# WhiteNoise *ahead* of SecurityMiddleware and static responses escaped the HSTS
# and SSL-redirect headers it adds. Compute the position instead.
_security_middleware = 'django.middleware.security.SecurityMiddleware'
MIDDLEWARE.insert(  # noqa: F405
    MIDDLEWARE.index(_security_middleware) + 1,  # noqa: F405
    'whitenoise.middleware.WhiteNoiseMiddleware',
)

# STATICFILES_STORAGE was removed in Django 5.1 (this project runs 5.2), so the
# old assignment was silently ignored and production served static files
# uncompressed and unhashed through the plain StaticFilesStorage. STORAGES is
# the replacement, and it must carry the "default" entry too — declaring the
# dict replaces Django's default wholesale rather than merging into it.
STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
    },
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
    },
}

# ---------------------------------------------------------------------------
# Cache — shared, so the API throttle is actually enforced
# ---------------------------------------------------------------------------
# base.py's LocMemCache is per-process: with several Gunicorn workers, each one
# keeps its own counter and the 60/min anonymous limit effectively multiplies by
# the worker count. Redis gives every worker the same counter.
CACHES = {
    'default': {
        'BACKEND': 'django.core.cache.backends.redis.RedisCache',
        'LOCATION': env('REDIS_URL', default='redis://localhost:6379/0'),  # noqa: F405
    }
}
