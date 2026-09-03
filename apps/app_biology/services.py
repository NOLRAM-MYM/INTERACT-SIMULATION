"""
apps/app_biology/services.py
============================
Molecular & Cellular Biology calculation and simulation services.

Features:
- DNA / RNA Central Dogma (Transcription, Translation, Genetic Code Codon Table)
- Protein physicochemical analysis (Mass, Isoelectric Point, Hydrophobicity, Charge)
- Cellular organelles specification (Animal Cell vs Plant Cell)
- Microbial specifications (Bacteria Gram+/- structure, Virus / Bacteriophage T4)
- Pathogen-Host Cellular Infection kinetics simulation
"""

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# =============================================================================
# 1. GENETIC CODE & AMINO ACID DICTIONARY
# =============================================================================

CODON_TABLE = {
    # Phenylalanine / Leucine
    'UUU': ('Phe', 'F', 'Fenilalanina', 'Apolar', 165.19, 2.8),
    'UUC': ('Phe', 'F', 'Fenilalanina', 'Apolar', 165.19, 2.8),
    'UUA': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    'UUG': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    # Serine
    'UCU': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    'UCC': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    'UCA': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    'UCG': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    # Tyrosine / STOP
    'UAU': ('Tyr', 'Y', 'Tirosina', 'Polar Aromático', 181.19, -1.3),
    'UAC': ('Tyr', 'Y', 'Tirosina', 'Polar Aromático', 181.19, -1.3),
    'UAA': ('STOP', '*', 'Códon de Parada (Ochre)', 'Stop', 0.0, 0.0),
    'UAG': ('STOP', '*', 'Códon de Parada (Amber)', 'Stop', 0.0, 0.0),
    # Cysteine / Tryptophan / STOP
    'UGU': ('Cys', 'C', 'Cisteína', 'Polar Tiol', 121.16, 2.5),
    'UGC': ('Cys', 'C', 'Cisteína', 'Polar Tiol', 121.16, 2.5),
    'UGA': ('STOP', '*', 'Códon de Parada (Opal)', 'Stop', 0.0, 0.0),
    'UGG': ('Trp', 'W', 'Triptofano', 'Apolar Aromático', 204.23, -0.9),
    # Leucine
    'CUU': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    'CUC': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    'CUA': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    'CUG': ('Leu', 'L', 'Leucina', 'Apolar', 131.17, 3.8),
    # Proline
    'CCU': ('Pro', 'P', 'Prolina', 'Apolar Cíclico', 115.13, -1.6),
    'CCC': ('Pro', 'P', 'Prolina', 'Apolar Cíclico', 115.13, -1.6),
    'CCA': ('Pro', 'P', 'Prolina', 'Apolar Cíclico', 115.13, -1.6),
    'CCG': ('Pro', 'P', 'Prolina', 'Apolar Cíclico', 115.13, -1.6),
    # Histidine / Glutamine
    'CAU': ('His', 'H', 'Histidina', 'Básico (+)', 155.16, -3.2),
    'CAC': ('His', 'H', 'Histidina', 'Básico (+)', 155.16, -3.2),
    'CAA': ('Gln', 'Q', 'Glutamina', 'Polar Amida', 146.15, -3.5),
    'CAG': ('Gln', 'Q', 'Glutamina', 'Polar Amida', 146.15, -3.5),
    # Arginine
    'CGU': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    'CGC': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    'CGA': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    'CGG': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    # Isoleucine / Methionine (Start)
    'AUU': ('Ile', 'I', 'Isoleucina', 'Apolar', 131.17, 4.5),
    'AUC': ('Ile', 'I', 'Isoleucina', 'Apolar', 131.17, 4.5),
    'AUA': ('Ile', 'I', 'Isoleucina', 'Apolar', 131.17, 4.5),
    'AUG': ('Met', 'M', 'Metionina (Início)', 'Apolar Início', 149.21, 1.9),
    # Threonine
    'ACU': ('Thr', 'T', 'Treonina', 'Polar Hidroxila', 119.12, -0.7),
    'ACC': ('Thr', 'T', 'Treonina', 'Polar Hidroxila', 119.12, -0.7),
    'ACA': ('Thr', 'T', 'Treonina', 'Polar Hidroxila', 119.12, -0.7),
    'ACG': ('Thr', 'T', 'Treonina', 'Polar Hidroxila', 119.12, -0.7),
    # Asparagine / Lysine
    'AAU': ('Asn', 'N', 'Asparagina', 'Polar Amida', 132.12, -3.5),
    'AAC': ('Asn', 'N', 'Asparagina', 'Polar Amida', 132.12, -3.5),
    'AAA': ('Lys', 'K', 'Lisina', 'Básico (+)', 146.19, -3.9),
    'AAG': ('Lys', 'K', 'Lisina', 'Básico (+)', 146.19, -3.9),
    # Serine / Arginine
    'AGU': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    'AGC': ('Ser', 'S', 'Serina', 'Polar Neutro', 105.09, -0.8),
    'AGA': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    'AGG': ('Arg', 'R', 'Arginina', 'Básico (+)', 174.20, -4.5),
    # Valine
    'GUU': ('Val', 'V', 'Valina', 'Apolar', 117.15, 4.2),
    'GUC': ('Val', 'V', 'Valina', 'Apolar', 117.15, 4.2),
    'GUA': ('Val', 'V', 'Valina', 'Apolar', 117.15, 4.2),
    'GUG': ('Val', 'V', 'Valina', 'Apolar', 117.15, 4.2),
    # Alanine
    'GCU': ('Ala', 'A', 'Alanina', 'Apolar', 89.09, 1.8),
    'GCC': ('Ala', 'A', 'Alanina', 'Apolar', 89.09, 1.8),
    'GCA': ('Ala', 'A', 'Alanina', 'Apolar', 89.09, 1.8),
    'GCG': ('Ala', 'A', 'Alanina', 'Apolar', 89.09, 1.8),
    # Aspartate / Glutamate
    'GAU': ('Asp', 'D', 'Ácido Aspártico', 'Ácido (-)', 133.10, -3.5),
    'GAC': ('Asp', 'D', 'Ácido Aspártico', 'Ácido (-)', 133.10, -3.5),
    'GAA': ('Glu', 'E', 'Ácido Glutâmico', 'Ácido (-)', 147.13, -3.5),
    'GAG': ('Glu', 'E', 'Ácido Glutâmico', 'Ácido (-)', 147.13, -3.5),
    # Glycine
    'GGU': ('Gly', 'G', 'Glicina', 'Apolar Pequeno', 75.07, -0.4),
    'GGC': ('Gly', 'G', 'Glicina', 'Apolar Pequeno', 75.07, -0.4),
    'GGA': ('Gly', 'G', 'Glicina', 'Apolar Pequeno', 75.07, -0.4),
    'GGG': ('Gly', 'G', 'Glicina', 'Apolar Pequeno', 75.07, -0.4),
}


# =============================================================================
# 2. DNA & MOLECULAR GENETICS SERVICE
# =============================================================================

class DnaMolecularService:
    """Central dogma of molecular biology engine: DNA -> mRNA -> Protein."""

    PRESETS = {
        'insulin': {
            'title': 'Fragmento da Insulina Humana (Cadeia A)',
            'dna': 'ATGGGCATTGTGGAACAATGCTGTACCAGCATCTGCTCCCTCTACCAGCTGGAGAACTACTGCAACTAG',
            'desc': 'Hormônio peptídico essencial no metabolismo da glicose produzido pelas células beta pancreáticas.'
        },
        'gfp_chromophore': {
            'title': 'Motivo Fluoróforo da GFP (Proteína Verde Fluorescente)',
            'dna': 'ATGAGCAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATGTTAATGGGCACAAATTTTCTGTCAGTGGAGAGGGTGAAGGTGATGCAACATACGGAAAACTTACCCTTAAATTTATTTGCACTACTGGAAAACTACCTGTTCCATGGCCAACACTTGTCACTACTTTCACTTATGGTGTTCAATGCTTTTCAAGATACCCAGATCATATGAAACGGCATGACTTTTTCAAGAGTGCCATGCCCGAAGGTTATGTACAGGAAAGAACTATATTTTTCAAAGATGACGGGAACTACAAGACACGTGCTGAAGTCAAGTTTGAAGGTGATACCCTTGTTAATAGAATCGAGTTAAAAGGTATTGATTTTAAAGAAGATGGAAACATTCTTGGACACAAATTGGAATACAACTATAACTCACACAATGTATACATCATGGCAGACAAACAAAAGAATGGAATCAAAGTTAACTTCAAAATTAGACACAACATTGAAGATGGAAGCGTTCAACTAGCAGACCATTATCAACAAAATACTCCAATTGGCGATGGCCCTGTCCTTTTACCAGACAACCATTACCTGTCCACACAATCTGCCCTTTCGAAAGATCCCAACGAAAAGAGAGACCACATGGTCCTTCTTGAGTTTGTAACAGCTGCTGGGATTACACATGGCATGGATGAACTATACAAATAG',
            'desc': 'Proteína bioluminescente da água-viva Aequorea victoria usada mundialmente como marcador celular.'
        },
        'sars_spike_rbm': {
            'title': 'Motivo de Ligação ao Receptor (RBM) - Spike SARS-CoV-2',
            'dna': 'ATGAATTACAACTATTTGTACAGATTGTTTAGGAAGTCTAATCTCAAACCTTTTGAGAGAGATATTTCAACTGAAATCTATCAGGCCGGTAGCACACCTTGTAATGGTGTTAAAGGTTTTAATTGTTACTTTCCTTTACAATCATATGGTTTCCAACCCACTAATGGTGTTGGTTACCAACCATACAGAGTAGTAGTACTTTCTTTTGAACTTCTACATGCACCAGCAACTGTTTGTGGACCTAAAAAGTCTACTAATTTGGTTAAAAACAAATGTGTCAATTTCAACTTCAATGGTTTAACAGGCACAGGTGTTCTTACTGAGTCTAACAAAAAGTTTCTGCCTTTCCAACAATTTGGCAGAGACATTGCTGACACTACTGATGCTGTCCGTGATCCACAGACACTTGAGATTCTTGACATTACACCATGTTCTTTTGGTGGTGTCAGTGTTATAACACCAGGAACAAATACTTCTAACCAGGTTGCTGTTCTTTATCAGGATGTTAACTGCACAGAAGTCCCTGTTGCTATTCATGCAGATCAACTTACTCCTACTTGGCGTGTTTATTCTACAGGTTCTAATGTTTTTCAAACACGTGCAGGCTGTTTAATAGGGGCTGAACATGTCAACAACTCATATGAGTGTGACATACCCATTGGTGCAGGTATATGCGCTAGTTATCAGACTCAGACTAATTCTCCTCGGCGGGCACGTAGTGTAGCTAGTCAATCCATCATTGCCTACACTATGTCACTTGGTGCAGAAAATTCAGTTGCTTACTCTAATAACTCTATTGCCATACCCACAAATTTTACTATTAGTGTTACCACAGAAATTCTACCAGTGTCTATGACCAAGACATCAGTAGATTGTACAATGTACATTTGTGGTGATTCAACTGAATGCAGCAATCTTTTGTTGCAATATGGCAGTTTTTGTACACAATTAAACCGTGCTTTAACTGGAATAGCTGTTGAACAAGACAAAAACACCCAAGAAGTTTTTGCACAAGTCAAACAAATTTACAAAACACCACCAATTAAAGATTTTGGTGGTTTTAATTTTTCACAAATATTACCAGATCCATCAAAACCAAGCAAGAGGTCATTTATTGAAGATCTACTTTTCAACAAAGTGACACTTGCAGATGCTGGCTTCATCAAACAATATGGTGATTGCCTTGGTGATATTGCTGCTAGAGACCTCATTTGTGCACAAAAGTTTAACGGCCTTACTGTTTTGCCACCTTTGCTCACAGATGAAATGATTGCTCAATACACTTCTGCACTGTTAGCGGGTACAATCACTTCTGGTTGGACCTTTGGTGCAGGTGCTGCATTACAAATACCATTTGCTATGCAAATGGCTTATAGGTTTAATGGTATTGGAGTTACACAGAATGTTCTCTATGAGAACCAAAAATTGATTGCCAACCAATTTAATAGTGCTATTGGCAAAATTCAAGACTCACTTTCTTCCACAGCAAGTGCACTTGGAAAACTTCAAGATGTGGTCAACCAAAATGCACAAGCTTTAAACACGCTTGTTAAACAACTTAGCTCCAATTTTGGTGCAATTTCAAGTGTTTTAAATGATATCCTTTCACGTCTTGACAAAGTTGAGGCTGAAGTGCAAATTGATAGGTTGATCACAGGCAGACTTCAAAGTTTGCAGACATATGTGACTCAACAATTAATTAGAGCTGCAGAAATCAGAGCTTCTGCTAATCTTGCTGCTACTAAAATGTCAGAGTGTGTACTTGGACAATCAAAAAGAGTTGATTTTTGTGGAAAGGGCTATCATCTTATGTCCTTCCCTCAGTCAGCACCTCATGGTGTAGTCTTCTTGCATGTGACTTATGTCCCTGCACAAGAAAAGAACTTCACAACTGCTCCTGCCATTTGTCATGATGGAAAAGCACACTTTCCTCGTGAAGGTGTCTTTGTTTCAAATGGCACACACTGGTTTGTAACACAAAGGAATTTTTATGAACCACAAATCATTACTACAGACAACACATTTGTGTCTGGTAACTGTGATGTTGTAATAGGAATTGTCAACAACACAGTTTATGATCCTTTGCAACCTGAATTAGACTCATTCAAGGAGGAGTTAGATAAATATTTTAAGAATCATACATCACCAGATGTTGATTTAGGTGACATCTCTGGCATTAATGCTTCAGTTGTAAACATTCAAAAAGAAATTGACCGCCTCAATGAGGTTGCCAAGAATTTAAATGAATCTCTCATCGATCTCCAAGAACTTGGAAAGTATGAGCAGTATATAAAATGGCCATGGTACATTTGGCTAGGTTTTATAGCTGGCTTGATTGCCATAGTAATGGTGACAATTATGCTTTGCTGTATGACCAGTTGCTGTAGTTGTCTCAAGGGCTGTTGTTCTTGTGGATCCTGCTGCAAATTTGATGAAGACGACTCTGAGCCAGTGCTCAAAGGAGTCAAATTACATTACACATAA',
            'desc': 'Domínio de ancoragem que interage diretamente com o receptor celular humano ACE2 para permitir infecção.'
        },
        'hemoglobin_beta': {
            'title': 'Fragmento da Hemoglobina Beta (HbA)',
            'dna': 'ATGGTGCACCTGACTCCTGAGGAGAAGTCTGCCGTTACTGCCCTGTGGGGCAAGGTGAACGTGGATGAAGTTGGTGGTGAGGCCCTGGGCAGGCTGCTGGTGGTCTACCCTTGGACCCAGAGGTTCTTTGAGTCCTTTGGGGATCTGTCCACTCCTGATGCTGTTATGGGCAACCCTAAGGTGAAGGCTCATGGCAAGAAAGTGCTCGGTGCCTTTAGTGATGGCCTGGCTCACCTGGACAACCTCAAGGGCACCTTTGCCACACTGAGTGAGCTGCACTGTGACAAGCTGCACGTGGATCCTGAGAACTTCAGGCTCCTGGGCAACGTGCTGGTCTGTGTGCTGGCCCATCACTTTGGCAAAGAATTCACCCCACCAGTGCAGGCTGCCTATCAGAAAGTGGTGGCTGGTGTGGCTAATGCCCTGGCCCACAAGTATCACTAA',
            'desc': 'Cadeia beta da hemoglobina humana responsável pelo transporte de oxigênio nos eritrócitos.'
        }
    }

    def analyze_dna(self, dna_sequence: str) -> Dict[str, Any]:
        """Transcribe and translate DNA sequence, computing protein physicochemical properties."""
        dna_clean = re.sub(r'[^ATCGatcg]', '', dna_sequence).upper()
        if not dna_clean:
            raise ValueError('Sequência de DNA inválida. Utilize apenas as bases A, T, C, G.')

        # 1. Complementary DNA Strand (3' -> 5')
        dna_comp_map = {'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C'}
        dna_complement = ''.join(dna_comp_map[base] for base in dna_clean)

        # 2. Transcription: DNA -> mRNA (Uracil replaces Thymine)
        # Template strand transcription (A->U, T->A, C->G, G->C)
        mrna = dna_clean.replace('T', 'U')

        # 3. Translation: Triplet codons to amino acids
        codons = []
        amino_acids = []
        polypeptide_3letter = []
        polypeptide_1letter = []
        full_names = []
        total_mass = 0.0
        hydrophobicity_sum = 0.0
        charge_at_ph74 = 0.0

        for i in range(0, len(mrna) - (len(mrna) % 3), 3):
            triplet = mrna[i:i+3]
            data = CODON_TABLE.get(triplet, ('Unknown', '?', 'Desconhecido', 'Neutro', 110.0, 0.0))
            code3, code1, name, polar_type, mass, hydro = data

            codons.append({
                'codon': triplet,
                'dna_triplet': dna_clean[i:i+3],
                'amino_acid': name,
                'code3': code3,
                'code1': code1,
                'type': polar_type,
                'mass': mass,
                'hydrophobicity': hydro
            })

            if code3 != 'STOP':
                amino_acids.append(name)
                polypeptide_3letter.append(code3)
                polypeptide_1letter.append(code1)
                total_mass += mass
                hydrophobicity_sum += hydro

                if 'Básico' in polar_type or code3 in ['Lys', 'Arg', 'His']:
                    charge_at_ph74 += 1.0
                elif 'Ácido' in polar_type or code3 in ['Asp', 'Glu']:
                    charge_at_ph74 -= 1.0
            else:
                polypeptide_3letter.append('STOP')
                polypeptide_1letter.append('*')
                break

        # Subtract water molecules removed during peptide bond formation: H2O = 18.015 Da per bond
        num_bonds = max(0, len([c for c in codons if c['code3'] != 'STOP']) - 1)
        protein_molecular_weight = max(0.0, total_mass - (num_bonds * 18.015))
        avg_hydrophobicity = (hydrophobicity_sum / len(amino_acids)) if amino_acids else 0.0

        # Base composition
        gc_content = ((dna_clean.count('G') + dna_clean.count('C')) / len(dna_clean)) * 100.0
        at_content = 100.0 - gc_content

        # Estimate melting temperature Tm (°C) of DNA duplex
        # Marmur formula approximation
        tm_celsius = 64.9 + 41.0 * (dna_clean.count('G') + dna_clean.count('C') - 16.4) / len(dna_clean) if len(dna_clean) > 20 else (dna_clean.count('A') + dna_clean.count('T')) * 2 + (dna_clean.count('G') + dna_clean.count('C')) * 4

        return {
            'dna_sequence': dna_clean,
            'dna_length': len(dna_clean),
            'dna_complement': dna_complement,
            'mrna_sequence': mrna,
            'gc_content_pct': round(gc_content, 2),
            'at_content_pct': round(at_content, 2),
            'melting_temp_celsius': round(tm_celsius, 1),
            'codons': codons,
            'amino_acid_count': len(amino_acids),
            'polypeptide_3letter': '-'.join(polypeptide_3letter),
            'polypeptide_1letter': ''.join(polypeptide_1letter),
            'protein_mass_da': round(protein_molecular_weight, 2),
            'protein_mass_kda': round(protein_molecular_weight / 1000.0, 3),
            'avg_hydrophobicity': round(avg_hydrophobicity, 2),
            'net_charge_ph74': round(charge_at_ph74, 1)
        }


# =============================================================================
# 3. CELLULAR ORGANELLES & MORPHOLOGY SERVICE
# =============================================================================

class CellularBiologyService:
    """Detailed biological organelle databases and comparative morphology."""

    ANIMAL_CELL_ORGANELLES = [
        {
            'id': 'nucleus',
            'name': 'Núcleo Celular & Nucléolo',
            'icon': '🧬',
            'color': '#8b5cf6',
            'function': 'Contém o genoma (cromatina) em eucariotos, delimitado pela carioteca com poros nucleares. O nucléolo sintetiza o rRNA dos ribossomos.',
            'energy_atp': 'Consumo elevado de ATP para transcrição e transporte nuclear',
            'pathology': 'Laminopatias, progeria e instabilidade genômica no câncer'
        },
        {
            'id': 'mitochondria',
            'name': 'Mitocôndrias',
            'icon': '⚡',
            'color': '#f59e0b',
            'function': 'Usinas de energia celular. Realizam o ciclo de Krebs e a fosforilação oxidativa na membrana interna (cristas), gerando até 32 ATP por glicose.',
            'energy_atp': 'Produz 90% do ATP celular via ATP-Sintase',
            'pathology': 'Doenças mitocondriais, síndrome de MELAS e estresse oxidativo'
        },
        {
            'id': 'plasma_membrane',
            'name': 'Membrana Plasmática',
            'icon': '🛡️',
            'color': '#3b82f6',
            'function': 'Bicamada fosfolipídica fluida com colesterol e proteínas integrais/periféricas. Controla permeabilidade seletiva, canais iônicos e receptores hormonais/virais (ex: ACE2, CD4).',
            'energy_atp': 'Consome ATP via bombas iônicas (Bomba de Na+/K+ ATPase)',
            'pathology': 'Fibrose cística (defeito no canal CFTR) e alvo de entrada de vírus'
        },
        {
            'id': 'endoplasmic_reticulum',
            'name': 'Retículo Endoplasmático (RER & REL)',
            'icon': '🕸️',
            'color': '#10b981',
            'function': 'RER (com ribossomos) sintetiza proteínas de secreção e membrana; REL sintetiza lipídios, esteroides e faz detoxificação de xenobióticos.',
            'energy_atp': 'Consome ATP e GTP para translocação e enovelamento de chaperonas (BiP)',
            'pathology': 'Estresse de retículo (ER stress) e resposta a proteínas mal dobradas (UPR)'
        },
        {
            'id': 'golgi_apparatus',
            'name': 'Complexo de Golgi',
            'icon': '📦',
            'color': '#ec4899',
            'function': 'Dictiossomos que recebem vesículas do retículo, promovem glicosilação, empacotamento, sulfatação e endereçamento de enzimas para lisossomos ou secreção.',
            'energy_atp': 'Consome ATP em transporte vesicular mediado por COP-I, COP-II e clatrina',
            'pathology': 'Doença de inclusão celular (mucolipidose II)'
        },
        {
            'id': 'lysosomes',
            'name': 'Lisossomos',
            'icon': '💥',
            'color': '#ef4444',
            'function': 'Vesículas ácidas (pH ~ 4.8) contendo mais de 50 hidrolases ácidas. Realizam autofagia, digestão intracelular e destruição de bactérias fagocitadas.',
            'energy_atp': 'Bomba de prótons V-ATPase consome ATP para acidificar o lúmen',
            'pathology': 'Doenças de depósito lisossômico (Doença de Tay-Sachs, Gaucher)'
        },
        {
            'id': 'centrioles',
            'name': 'Centríolos & Centrossomo',
            'icon': '⭐',
            'color': '#06b6d4',
            'function': 'Estruturas de 9 trincas de microtúbulos de tubulina que organizam o fuso mitótico durante a divisão celular (mitose/meiose) e formam cílios e flagelos.',
            'energy_atp': 'Consome GTP e ATP para polimerização e motores moleculares (cinesina/dineína)',
            'pathology': 'Aneuploidia tumoral por amplificação de centrossomos'
        }
    ]

    PLANT_CELL_ORGANELLES = [
        {
            'id': 'cell_wall',
            'name': 'Parede Celular Vegetal',
            'icon': '🧱',
            'color': '#22c55e',
            'function': 'Armadura rígida de microfibrilas de celulose, hemicelulose e pectina. Resiste à pressão de turgor osmótico e serve como primeira barreira física contra patógenos.',
            'energy_atp': 'Sintetizada por complexos de celulose sintase na membrana',
            'pathology': 'Degradação por enzimas fúngicas e bacterianas (pectinases, celulases)'
        },
        {
            'id': 'chloroplast',
            'name': 'Cloroplastos & Tilacoides',
            'icon': '🍃',
            'color': '#16a34a',
            'function': 'Plastídios de dupla membrana onde ocorre a fotossíntese. O estroma realiza o Ciclo de Calvin e os tilacoides abrigam os fotossistemas I e II gerando ATP e NADPH via luz solar.',
            'energy_atp': 'Gera ATP fotossintético e sintetiza carboidratos',
            'pathology': 'Clorose e inibição fotossintética por fitovírus do mosaico'
        },
        {
            'id': 'central_vacuole',
            'name': 'Grande Vacúolo Central & Tonoplasto',
            'icon': '💧',
            'color': '#06b6d4',
            'function': 'Pode ocupar até 90% do volume da célula vegetal. Mantém a pressão de turgor que sustenta a planta, armazena íons, metabólitos secundários e pigmentos (antocianinas).',
            'energy_atp': 'Bomba V-ATPase e pirofosfatase no tonoplasto consomem energia para transporte ativo',
            'pathology': 'Murchamento por estresse hídrico osmótico ou plasmólise'
        },
        {
            'id': 'plasmodesmata',
            'name': 'Plasmodesmos',
            'icon': '🌉',
            'color': '#a855f7',
            'function': 'Canais citoplasmáticos contínuos que perfuram as paredes celulares, permitindo transporte simplástico de água, açúcares e sinalizadores hormonais entre células vizinhas.',
            'energy_atp': 'Regulado por deposição de calose e proteínas motoras',
            'pathology': 'Principal via de disseminação sistêmica de vírus vegetais na planta'
        },
        {
            'id': 'nucleus_plant',
            'name': 'Núcleo Vegetal',
            'icon': '🧬',
            'color': '#8b5cf6',
            'function': 'Coordena a expressão gênica, desenvolvimento e resposta a fitohormônios (auxina, citocinina, ácido abscísico e etileno).',
            'energy_atp': 'Alto consumo de ATP na replicação e transcrição',
            'pathology': 'Inativação gênica por proteínas supressoras de silenciamento viral'
        },
        {
            'id': 'mitochondria_plant',
            'name': 'Mitocôndrias Vegetais',
            'icon': '⚡',
            'color': '#f59e0b',
            'function': 'Oxidação respiratória celular essencial no escuro e em tecidos não fotossintéticos (raízes), cooperando com os cloroplastos no metabolismo de fotorespiração.',
            'energy_atp': 'Gera ATP celular na respiração aeróbia',
            'pathology': 'Disfunção respiratória por toxinas fúngicas'
        }
    ]

    MICROBES_DATABASE = {
        'bacteria_gram_neg': {
            'name': 'Bactéria Gram-Negativa (ex: E. coli / Pseudomonas)',
            'type': 'Procarioto Gram-Negativo',
            'envelope': 'Membrana externa rica em Lipopolissacarídeo (LPS / Endotoxina) + Fina camada de peptideoglicano (2-7 nm) + Membrana interna.',
            'genome': 'Cromossomo circular único no nucleoide (sem carioteca) + Plasmídeos circulares com genes de resistência.',
            'ribosome': 'Ribossomos 70S (subunidades 50S e 30S), alvo de antibióticos como tetraciclina e aminoglicosídeos.',
            'motility': 'Flagelos peritríquios giratórios acionados por força próton-motriz + Fímbrias/Pili para conjugação e adesão.',
            'virulence': 'Secreção tipo III (T3SS), endotoxinas LPS e biofilme protetor.'
        },
        'bacteria_gram_pos': {
            'name': 'Bactéria Gram-Positiva (ex: Staphylococcus / Bacillus)',
            'type': 'Procarioto Gram-Positivo',
            'envelope': 'Espessa parede de peptideoglicano (20-80 nm) com ácidos teicoicos e lipoteicoicos, retendo o corante cristal violeta.',
            'genome': 'Cromossomo circular + Plasmídeos.',
            'ribosome': 'Ribossomos 70S.',
            'motility': 'Geralmente imóveis ou com flagelos polares.',
            'virulence': 'Exotoxinas potentes, coagulase e cápsula polissacarídica antifagocítica.'
        },
        'virus_enveloped': {
            'name': 'Vírus Envelopado (ex: SARS-CoV-2 / Influenza / HIV)',
            'type': 'Vírus com Envelope Lipídico',
            'structure': 'Genoma (RNA ou DNA) envolto por capsídeo proteico icosaédrico ou helicoidal + Envelope lipídico derivado da membrana da célula hospedeira.',
            'spikes': 'Glicoproteínas de superfície (Spike S, Hemaglutinina HA, gp120) que reconhecem receptores específicos na célula hospedeira.',
            'replication': 'Fusão de membrana ou endocitose mediada por receptor -> Desnudamento -> Tradução e replicação por polimerase viral -> Montagem e brotamento.'
        },
        'virus_bacteriophage': {
            'name': 'Bacteriófago T4 (Fago Lítico de Bactéria)',
            'type': 'Vírus Complexo de Procarioto',
            'structure': 'Cabeça icosaédrica (cápside com genoma de DNA dupla fita) + Colar + Bainha contrátil helicoidal + Placa basal com espículas + 6 Fibras caudais flexíveis.',
            'infection_mechanism': 'Fibras caudais ancoram no LPS bacteriano -> Bainha contrátil se contrai injetando o DNA como uma seringa hipodérmica -> Ciclo lítico destrói o genoma bacteriano e lisa a célula.'
        }
    }


# =============================================================================
# 4. PATHOGEN-HOST INFECTION KINETICS SIMULATION SERVICE
# =============================================================================

class InfectionSimulationService:
    """Mathematical and kinetic simulation of cellular infection dynamics."""

    def simulate_infection(
        self,
        scenario: str = 'virus_animal',
        initial_load: int = 50,
        immune_defense_level: int = 40,
        treatment: str = 'none',
        duration_steps: int = 30
    ) -> Dict[str, Any]:
        """
        Simulate multi-step infection kinetics over time.

        Args:
            scenario: 'virus_animal', 'bacteriophage_bacteria', or 'pathogen_plant'
            initial_load: Initial pathogen count (10 - 200)
            immune_defense_level: Cellular immunity / defense efficacy (0 - 100%)
            treatment: 'none', 'antiviral_protease', 'antibiotic_penicillin', 'plant_phytoalexin'
            duration_steps: Number of simulation timeframes

        Returns:
            Dictionary containing step-by-step telemetry, cell viability, pathogen count, and phase narrative.
        """
        timeline = []
        pathogen_count = float(initial_load)
        host_cell_health = 100.0  # % viability
        cellular_atp = 100.0       # % metabolic energy
        viral_protein_synthesis = 0.0
        immune_antibody_level = float(immune_defense_level)

        # Treatment modifiers
        treatment_kill_rate = 0.0
        if treatment == 'antiviral_protease' and scenario == 'virus_animal':
            treatment_kill_rate = 0.35
        elif treatment == 'antibiotic_penicillin' and scenario == 'bacteriophage_bacteria':
            treatment_kill_rate = 0.45
        elif treatment == 'plant_phytoalexin' and scenario == 'pathogen_plant':
            treatment_kill_rate = 0.30

        infection_stage = 'Adsorção e Reconhecimento'
        lysis_occurred = False

        for t in range(duration_steps):
            # Phase Determination
            if t < 5:
                infection_stage = '1. Adsorção & Ancoragem em Receptores'
                pathogen_growth_factor = 1.02
                cell_damage_rate = 0.3
            elif t < 12:
                infection_stage = '2. Penetração & Desnudamento Genômico'
                pathogen_growth_factor = 1.08
                cell_damage_rate = 1.2
                viral_protein_synthesis += 4.5
            elif t < 22:
                infection_stage = '3. Replicação & Sequestro Ribossomal'
                pathogen_growth_factor = 1.22
                cell_damage_rate = 3.5
                viral_protein_synthesis += 9.0
            else:
                infection_stage = '4. Maturação, Brotamento & Lise Celular'
                pathogen_growth_factor = 1.35
                cell_damage_rate = 6.0
                viral_protein_synthesis += 15.0

            # Immune Response Kinetics
            immune_clearance = (immune_antibody_level / 100.0) * 0.15 * pathogen_count
            drug_clearance = treatment_kill_rate * pathogen_count
            net_pathogen_change = (pathogen_count * (pathogen_growth_factor - 1.0)) - immune_clearance - drug_clearance

            pathogen_count = max(0.0, pathogen_count + net_pathogen_change)

            # Health Impact
            health_drain = (pathogen_count / 100.0) * cell_damage_rate
            host_cell_health = max(0.0, host_cell_health - health_drain)

            # ATP Consumption by Pathogen replication vs host depletion
            atp_drain = (pathogen_count / 80.0) * 1.8
            cellular_atp = max(0.0, cellular_atp - atp_drain)

            if host_cell_health <= 5.0 and not lysis_occurred:
                lysis_occurred = True
                infection_stage = '5. RUPTURA / LISE CELULAR COMPLETA'

            # Adaptive immunity rise
            immune_antibody_level = min(100.0, immune_antibody_level + 1.2)

            timeline.append({
                'step': t + 1,
                'time_hours': round((t + 1) * 0.8, 1),
                'stage': infection_stage,
                'pathogen_count': int(pathogen_count),
                'host_cell_health': round(host_cell_health, 1),
                'cellular_atp': round(cellular_atp, 1),
                'viral_protein_pct': round(min(100.0, viral_protein_synthesis), 1),
                'immune_level': round(immune_antibody_level, 1),
                'status': 'Lise Celular' if host_cell_health < 10 else ('Infectado' if pathogen_count > 50 else 'Controlado')
            })

        # Summary Metrics
        max_pathogen = max(entry['pathogen_count'] for entry in timeline)
        final_health = timeline[-1]['host_cell_health']
        cleared = timeline[-1]['pathogen_count'] < 5

        outcome = 'Célula Sobreviveu (Infecção Neutralizada)' if final_health > 30 else 'Célula Destruída por Lise/Apoptose'

        return {
            'scenario': scenario,
            'initial_load': initial_load,
            'immune_defense_level': immune_defense_level,
            'treatment': treatment,
            'duration_steps': duration_steps,
            'max_pathogen_count': max_pathogen,
            'final_cell_health': final_health,
            'final_atp': timeline[-1]['cellular_atp'],
            'is_cleared': cleared,
            'outcome': outcome,
            'timeline': timeline
        }
