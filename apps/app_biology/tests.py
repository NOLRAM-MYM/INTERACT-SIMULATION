"""apps/app_biology/tests.py"""
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient
from .services import DnaMolecularService, CellularBiologyService, InfectionSimulationService


class BiologyServiceTests(TestCase):
    def setUp(self):
        self.dna_service = DnaMolecularService()
        self.cell_service = CellularBiologyService()
        self.infection_service = InfectionSimulationService()

    def test_dna_transcription_and_translation(self):
        # ATG GGC TAA -> Met Gly STOP
        dna = 'ATGGGCTAA'
        res = self.dna_service.analyze_dna(dna)
        self.assertEqual(res['mrna_sequence'], 'AUGGGCUAA')
        self.assertEqual(res['amino_acid_count'], 2) # Met, Gly
        self.assertEqual(res['polypeptide_3letter'], 'Met-Gly-STOP')
        self.assertGreater(res['protein_mass_da'], 0)

    def test_invalid_dna_raises_error(self):
        with self.assertRaises(ValueError):
            self.dna_service.analyze_dna('XYZ123')

    def test_cellular_structures_data(self):
        self.assertGreater(len(self.cell_service.ANIMAL_CELL_ORGANELLES), 0)
        self.assertGreater(len(self.cell_service.PLANT_CELL_ORGANELLES), 0)
        self.assertIn('virus_bacteriophage', self.cell_service.MICROBES_DATABASE)

    def test_infection_simulation(self):
        res = self.infection_service.simulate_infection(
            scenario='virus_animal',
            initial_load=50,
            immune_defense_level=50,
            treatment='antiviral_protease',
            duration_steps=20
        )
        self.assertEqual(len(res['timeline']), 20)
        self.assertIn('outcome', res)


class BiologyAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_page_view(self):
        res = self.client.get('/biology/')
        self.assertEqual(res.status_code, 200)

    def test_dna_analyze_api(self):
        url = reverse('biology:dna_analyze')
        res = self.client.post(url, {'sequence': 'ATGGCCATTTAA'}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['status'], 'success')
        self.assertEqual(res.data['data']['dna_sequence'], 'ATGGCCATTTAA')

    def test_infection_simulate_api(self):
        url = reverse('biology:infection_simulate')
        res = self.client.post(url, {
            'scenario': 'virus_animal',
            'initial_load': 40,
            'immune_defense_level': 60,
            'treatment': 'none'
        }, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['status'], 'success')
        self.assertIn('timeline', res.data['data'])
