"""apps/app_biology/urls.py"""
from django.urls import path
from .views import (
    BiologyPageView,
    DnaAnalyzeView,
    DnaPresetsView,
    CellularStructuresView,
    InfectionSimulateView,
)

app_name = 'biology'

urlpatterns = [
    # Page view
    path('', BiologyPageView.as_view(), name='index'),

    # REST APIs
    path('dna/analyze/', DnaAnalyzeView.as_view(), name='dna_analyze'),
    path('dna/presets/', DnaPresetsView.as_view(), name='dna_presets'),
    path('cells/structures/', CellularStructuresView.as_view(), name='cell_structures'),
    path('infection/simulate/', InfectionSimulateView.as_view(), name='infection_simulate'),
]
