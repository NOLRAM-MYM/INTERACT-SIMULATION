"""
apps/core/templatetags/vite.py
===============================
Template tags that connect Django templates to the Vite build output.

Why this exists
---------------
``vite.config.js`` declared four Rollup entry points and ``settings.base``
pointed ``STATICFILES_DIRS`` at ``frontend/dist`` — but no template ever
referenced a bundle, so the entire frontend build was dead code. Templates
loaded hand-maintained copies of Three.js and Plotly from
``apps/core/static/core/vendor/`` instead, duplicating libraries that
``package.json`` already declared as dependencies.

These tags close that gap: a template asks for a *source* entry name and gets
the correct hashed production file (or a dev-server URL during development).

Usage::

    {% load vite %}
    {% vite_hmr_client %}                   {# no-op unless the dev server is on #}
    {% vite_asset 'pages/fluids.js' %}

The entry name is the key Vite writes into its manifest, which is the path of
the entry file relative to ``vite.config.js``'s ``root`` (``frontend/src``) —
e.g. ``main.js``, ``pages/fluids.js``.

Development
-----------
Set ``VITE_DEV_SERVER_URL=http://localhost:5173`` in the environment and run
``npm run dev`` alongside ``manage.py runserver``. The tags then point at the
dev server and hot reload works. With the variable unset, the tags always read
the built manifest, so a plain ``runserver`` needs ``npm run build`` first.
"""

import json
import logging
from pathlib import Path

from django import template
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.templatetags.static import static
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

logger = logging.getLogger(__name__)

register = template.Library()

#: Parsed manifest, cached between requests. Never populated while DEBUG is on,
#: so a rebuild is picked up without restarting the server.
_manifest_cache: dict | None = None


class ViteManifestError(ImproperlyConfigured):
    """The Vite manifest is missing, unreadable, or lacks a requested entry."""


def _dev_server_url() -> str:
    """Return the configured dev server origin, or '' when not in dev mode."""
    return (getattr(settings, 'VITE_DEV_SERVER_URL', '') or '').rstrip('/')


def _manifest_path() -> Path:
    return Path(
        getattr(settings, 'VITE_MANIFEST_PATH', None)
        or Path(settings.BASE_DIR) / 'frontend' / 'dist' / '.vite' / 'manifest.json'
    )


def load_manifest() -> dict:
    """
    Read and cache ``frontend/dist/.vite/manifest.json``.

    Raises:
        ViteManifestError: if the manifest is absent or not valid JSON.
    """
    global _manifest_cache

    if _manifest_cache is not None and not settings.DEBUG:
        return _manifest_cache

    path = _manifest_path()
    try:
        manifest = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError as exc:
        raise ViteManifestError(
            f"Vite manifest not found at {path}. Run `npm run build` "
            "(or set VITE_DEV_SERVER_URL and run `npm run dev`)."
        ) from exc
    except json.JSONDecodeError as exc:
        raise ViteManifestError(f"Vite manifest at {path} is not valid JSON: {exc}") from exc

    if not settings.DEBUG:
        _manifest_cache = manifest
    return manifest


def clear_manifest_cache() -> None:
    """Drop the cached manifest. Used by tests."""
    global _manifest_cache
    _manifest_cache = None


def _collect_imports(manifest: dict, key: str, seen: set[str]) -> list[str]:
    """
    Walk an entry's transitive imports, returning chunk file paths.

    The browser discovers these on its own once the entry executes, but
    preloading them removes a request waterfall — it matters here because the
    plotly chunk is several megabytes.
    """
    files: list[str] = []
    for import_key in manifest.get(key, {}).get('imports', []):
        if import_key in seen:
            continue
        seen.add(import_key)
        entry = manifest.get(import_key, {})
        if entry.get('file'):
            files.append(entry['file'])
        files.extend(_collect_imports(manifest, import_key, seen))
    return files


@register.simple_tag
def vite_asset(entry: str) -> str:
    """
    Emit the tags needed to load a Vite entry point.

    In production this is the entry's stylesheets, ``modulepreload`` hints for
    its chunks, and the hashed module script. In dev-server mode it is a single
    module script pointed at Vite.

    Args:
        entry: Manifest key, e.g. ``'pages/fluids.js'``.
    """
    dev_url = _dev_server_url()
    if dev_url:
        return format_html(
            '<script type="module" src="{}/{}"></script>', dev_url, entry
        )

    try:
        manifest = load_manifest()
    except ViteManifestError as exc:
        if settings.DEBUG:
            logger.warning("vite_asset(%r): %s", entry, exc)
            return format_html('<!-- vite: {} -->', str(exc))
        # A missing bundle in production is a broken deploy, not a page to
        # render half-working. Fail loudly.
        raise

    if entry not in manifest:
        available = ', '.join(k for k in manifest if not k.startswith('_'))
        message = (
            f"Vite entry {entry!r} is not in the manifest. "
            f"Add it to rollupOptions.input in vite.config.js. Available: {available}"
        )
        if settings.DEBUG:
            logger.warning("%s", message)
            return format_html('<!-- vite: {} -->', message)
        raise ViteManifestError(message)

    record = manifest[entry]

    css_tags = format_html_join(
        '\n',
        '<link rel="stylesheet" href="{}">',
        ((static(href),) for href in record.get('css', [])),
    )
    preload_tags = format_html_join(
        '\n',
        '<link rel="modulepreload" href="{}">',
        ((static(href),) for href in _collect_imports(manifest, entry, set())),
    )
    script_tag = format_html(
        '<script type="module" src="{}"></script>', static(record['file'])
    )

    return mark_safe('\n'.join(filter(None, [css_tags, preload_tags, script_tag])))


@register.simple_tag
def vite_hmr_client() -> str:
    """
    Emit Vite's HMR client when the dev server is configured, otherwise nothing.

    Safe to leave in ``base.html`` permanently — it renders an empty string in
    production.
    """
    dev_url = _dev_server_url()
    if not dev_url:
        return ''
    return format_html('<script type="module" src="{}/@vite/client"></script>', dev_url)
