"""apps/app_materials/urls.py"""
from django.urls import path
from . import views

app_name = 'materials'

urlpatterns = [
    path('', views.MaterialsPageView.as_view(), name='materials-index'),
    path('beam-deflection/', views.BeamDeflectionView.as_view(), name='beam-deflection'),
    path('beam-deflection/schema/', views.BeamDeflectionSchemaView.as_view(), name='beam-deflection-schema'),
]
