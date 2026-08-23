"""apps/app_chemistry/urls.py"""
from django.urls import path
from . import views

app_name = 'chemistry'

urlpatterns = [
    path('', views.ChemistryPageView.as_view(), name='chemistry-index'),
    path('elements/', views.PeriodicTableListView.as_view(), name='periodic-table-list'),
    path('element/<str:identifier>/', views.ElementPropertyView.as_view(), name='element-property'),
    path('simulate/', views.ChemistrySimulateView.as_view(), name='chemistry-simulate'),
    path('simulate/schema/', views.ChemistrySimulateSchemaView.as_view(), name='chemistry-simulate-schema'),
    path('stoichiometry/', views.StoichiometryView.as_view(), name='stoichiometry'),
    path('stoichiometry/schema/', views.StoichiometrySchemaView.as_view(), name='stoichiometry-schema'),
]
