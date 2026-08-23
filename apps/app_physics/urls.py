"""apps/app_physics/urls.py"""
from django.urls import path
from . import views

app_name = 'physics'

urlpatterns = [
    path('', views.PhysicsPageView.as_view(), name='physics-index'),
    path('projectile/calculate/', views.ProjectileCalculateView.as_view(), name='projectile-calculate'),
    path('projectile/schema/', views.ProjectileSchemaView.as_view(), name='projectile-schema'),
    path('magnetism/', views.MagnetismPageView.as_view(), name='magnetism-index'),
    path('magnetism/calculate/', views.MagnetismCalculateView.as_view(), name='magnetism-calculate'),
    path('magnetism/schema/', views.MagnetismSchemaView.as_view(), name='magnetism-schema'),
]
