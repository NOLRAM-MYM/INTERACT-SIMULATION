"""
config/urls.py
===============
Root URL configuration for the Scientific Dashboard project.
"""
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static

urlpatterns = [
    # Django Admin
    path('admin/', admin.site.urls),

    # Dashboard root
    path('', include('apps.core.urls')),

    # --- Scientific Module APIs ---
    path('api/fluids/', include('apps.app_fluids.urls', namespace='fluids')),
    path('api/materials/', include('apps.app_materials.urls', namespace='materials')),
    path('api/chemistry/', include('apps.app_chemistry.urls', namespace='chemistry')),
    path('api/physics/', include('apps.app_physics.urls', namespace='physics')),
    path('api/tribology/', include('apps.app_tribology.urls', namespace='tribology')),
    path('api/biology/', include('apps.app_biology.urls', namespace='biology')),
    path('biology/', include('apps.app_biology.urls', namespace='biology-page')),
]

# Serve media files in development
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

    # Django Debug Toolbar
    try:
        import debug_toolbar
        urlpatterns += [path('__debug__/', include(debug_toolbar.urls))]
    except ImportError:
        pass
