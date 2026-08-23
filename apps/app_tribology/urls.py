"""
apps/app_tribology/urls.py
==========================
Routing for the Tribology module.
"""

from django.urls import path
from . import views

app_name = 'tribology'

urlpatterns = [
    # Dashboard Page
    path('', views.TribologyPageView.as_view(), name='tribology-index'),

    # Calculation API Endpoint
    path('calculate/', views.TribologyCalculateView.as_view(), name='tribology-calculate'),
    path('schema/', views.TribologySchemaView.as_view(), name='tribology-schema'),
]
