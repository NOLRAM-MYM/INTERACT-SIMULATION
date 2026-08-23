"""
apps/app_chemistry/services.py
================================
Atomic & Molecular property service using pymatgen, ASE, and mendeleev.

Libraries:
    - mendeleev:  Precise periodic table data (ionisation energies, radii, etc.)
    - pymatgen:   Crystal structure analysis, composition parsing
    - ase:        Atomic simulation, bond lengths, molecular geometry

Modules:
    - ElementPropertyService:   Fetch all properties of a periodic table element
    - MoleculeGeometryService:  Build atomic positions for simple molecules
"""

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ElementData:
    """Structured data for a single periodic table element."""
    symbol: str
    name: str
    atomic_number: int
    atomic_mass: float           # u (unified atomic mass units)
    period: int
    group: int | None
    electron_configuration: str
    electronegativity: float | None   # Pauling scale
    atomic_radius_pm: float | None    # Covalent radius in pm
    ionisation_energy_ev: float | None  # First ionisation energy in eV
    melting_point_k: float | None
    boiling_point_k: float | None
    density_g_cm3: float | None
    oxidation_states: list[int] = field(default_factory=list)


class ElementPropertyService:
    """
    Retrieve complete properties for a chemical element by symbol or atomic number.

    Uses mendeleev for precise, IUPAC-approved data with a local JSON fallback if unavailable.
    """

    def get_element(self, identifier: str | int) -> ElementData:
        """
        Fetch element data.

        Args:
            identifier: Element symbol (e.g., 'Fe') or atomic number (e.g., 26).

        Returns:
            ElementData dataclass with all available properties.
        """
        try:
            from mendeleev import element as mendeleev_element
        except ImportError:
            # mendeleev lives in requirements-advanced.txt and is optional.
            from .fallback_db import get_element_fallback
            return get_element_fallback(identifier)

        try:
            el = mendeleev_element(identifier)

            # mendeleev stores ionisation energies in eV (NIST ASD), not kJ/mol.
            # This used to apply a kJ/mol -> eV factor of 0.010364 on top,
            # reporting hydrogen at 0.141 eV instead of 13.598 — a ~96x error,
            # and one the project's own fallback table contradicted.
            ie_ev = None
            if el.ionenergies and 1 in el.ionenergies:
                ie_ev = float(el.ionenergies[1])

            electronegativity_raw = el.electronegativity('pauling')
            radius_raw = el.covalent_radius_pyykko

            return ElementData(
                symbol                = el.symbol,
                name                  = el.name,
                atomic_number         = el.atomic_number,
                atomic_mass           = float(el.atomic_weight) if el.atomic_weight else 0.0,
                period                = el.period,
                group                 = el.group_id,
                electron_configuration= self._format_electron_configuration(el),
                electronegativity     = float(electronegativity_raw) if electronegativity_raw is not None else None,
                atomic_radius_pm      = float(radius_raw) if radius_raw is not None else None,
                ionisation_energy_ev  = ie_ev,
                melting_point_k       = float(el.melting_point) if el.melting_point else None,
                boiling_point_k       = float(el.boiling_point) if el.boiling_point else None,
                density_g_cm3         = float(el.density) if el.density else None,
                oxidation_states      = list(el.oxistates) if el.oxistates else [],
            )
        except Exception as exc:
            # mendeleev signals "no such element" with SQLAlchemy's NoResultFound,
            # which is not a ValueError — so the view's 404 branch never caught
            # it and an unknown symbol came back as a 500. Anything else here is
            # a genuine fault in the optional backend; the bundled JSON table
            # covers the same elements, so fall back rather than fail the request.
            logger.warning(
                "mendeleev lookup failed for %r (%s: %s); using local table.",
                identifier, type(exc).__name__, exc,
            )
            from .fallback_db import get_element_fallback
            return get_element_fallback(identifier)

    @staticmethod
    def _format_electron_configuration(el) -> str:
        """
        Render mendeleev's electron configuration as a string.

        ``Element.ec.conf`` is an OrderedDict keyed by ``(n, subshell)`` tuples.
        Assigning it straight to this dataclass's ``str`` field meant
        ``dataclasses.asdict`` handed DRF's JSONRenderer a dict with tuple keys,
        which raises ``TypeError: keys must be str, int, float, bool or None``
        — a 500 on every element detail request once mendeleev is installed.
        """
        ec = getattr(el, 'ec', None)
        conf = getattr(ec, 'conf', None)

        if isinstance(conf, dict):
            return ' '.join(
                f"{shell[0]}{shell[1]}{count}" for shell, count in conf.items()
            )
        if conf is not None:
            return str(conf)
        return str(getattr(el, 'econf', ''))


class ChemistrySimulationService:
    """
    Simulates chemical bonding and reactions.
    Provides molecular masses, oxidation states, and bond types for compounds and reactions.
    """

    COMPOUNDS = {
        "H2O": {
            "formula": "H2O",
            "name": "Água",
            "mass": 18.015,
            "oxidation_states": {"H": "+1", "O": "-2"},
            "electrovalency": "H (+1), O (-2)",
            "bond_type": "Covalente Polar",
            "strong_bonds": "Ligações Covalentes Polares Simples (Sigma O-H)",
            "weak_bonds": "Ligações de Hidrogênio (intermolecular), Forças de London",
            "atoms": [
                {"element": "O", "x": 0.0, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "H", "x": 0.76, "y": 0.59, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.76, "y": 0.59, "z": 0.0, "color": "#ffffff", "radius": 0.15}
            ]
        },
        "NaCl": {
            "formula": "NaCl",
            "name": "Cloreto de Sódio (Sal de Cozinha)",
            "mass": 58.440,
            "oxidation_states": {"Na": "+1", "Cl": "-1"},
            "electrovalency": "Na (+1), Cl (-1)",
            "bond_type": "Iônica",
            "strong_bonds": "Ligação Iônica (Atração Eletrostática Forte)",
            "weak_bonds": "Forças de Van der Waals (de dispersão de London na rede cristalina)",
            "atoms": [
                {"element": "Na", "x": -0.6, "y": 0.0, "z": 0.0, "color": "#a78bfa", "radius": 0.28},
                {"element": "Cl", "x": 0.6, "y": 0.0, "z": 0.0, "color": "#10b981", "radius": 0.28}
            ]
        },
        "CO2": {
            "formula": "CO2",
            "name": "Dióxido de Carbono (Gás Carbônico)",
            "mass": 44.009,
            "oxidation_states": {"C": "+4", "O": "-2"},
            "electrovalency": "C (+4), O (-2)",
            "bond_type": "Covalente Apolar (Molécula Linear)",
            "strong_bonds": "Ligações Covalentes Polares Duplas (2x C=O, consistindo em 1 Sigma e 1 Pi cada)",
            "weak_bonds": "Forças de Dispersão de London (intermolecular fraca)",
            "atoms": [
                {"element": "C", "x": 0.0, "y": 0.0, "z": 0.0, "color": "#4b5563", "radius": 0.23},
                {"element": "O", "x": -1.16, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "O", "x": 1.16, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23}
            ]
        },
        "NH3": {
            "formula": "NH3",
            "name": "Amônia",
            "mass": 17.031,
            "oxidation_states": {"N": "-3", "H": "+1"},
            "electrovalency": "N (-3), H (+1)",
            "bond_type": "Covalente Polar (Piramidal Trigonal)",
            "strong_bonds": "Ligações Covalentes Polares Simples (3x N-H)",
            "weak_bonds": "Ligações de Hidrogênio (Ponte de Hidrogênio) intensas",
            "atoms": [
                {"element": "N", "x": 0.0, "y": 0.12, "z": 0.0, "color": "#3b82f6", "radius": 0.23},
                {"element": "H", "x": 0.94, "y": -0.38, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.38, "z": 0.81, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.38, "z": -0.81, "color": "#ffffff", "radius": 0.15}
            ]
        },
        "CH4": {
            "formula": "CH4",
            "name": "Metano (Gás Natural)",
            "mass": 16.040,
            "oxidation_states": {"C": "-4", "H": "+1"},
            "electrovalency": "C (-4), H (+1)",
            "bond_type": "Covalente Apolar (Geometria Tetraédrica)",
            "strong_bonds": "Ligações Covalentes Simples Apolar (4x C-H)",
            "weak_bonds": "Forças de Dispersão de London discretas",
            "atoms": [
                {"element": "C", "x": 0.0, "y": 0.0, "z": 0.0, "color": "#4b5563", "radius": 0.23},
                {"element": "H", "x": 0.0, "y": 1.0, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": 0.94, "y": -0.33, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.33, "z": 0.82, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.33, "z": -0.82, "color": "#ffffff", "radius": 0.15}
            ]
        },
        "HCl": {
            "formula": "HCl",
            "name": "Ácido Clorídrico / Cloreto de Hidrogênio",
            "mass": 36.460,
            "oxidation_states": {"H": "+1", "Cl": "-1"},
            "electrovalency": "H (+1), Cl (-1)",
            "bond_type": "Covalente Polar (Dipolo Forte)",
            "strong_bonds": "Ligação Covalente Polar Simples (H-Cl)",
            "weak_bonds": "Força Dipolo-Dipolo permanente e Forças de London",
            "atoms": [
                {"element": "H", "x": -0.64, "y": 0.0, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "Cl", "x": 0.64, "y": 0.0, "z": 0.0, "color": "#10b981", "radius": 0.28}
            ]
        },
        "Fe2O3": {
            "formula": "Fe2O3",
            "name": "Óxido de Ferro(III) (Hematita/Ferrugem)",
            "mass": 159.69,
            "oxidation_states": {"Fe": "+3", "O": "-2"},
            "electrovalency": "Fe (+3), O (-2)",
            "bond_type": "Iônica",
            "strong_bonds": "Ligações Iônicas de Rede Cristalina entre Cátions de Fe3+ e Ânions de O2-",
            "weak_bonds": "Forças eletrostáticas de coesão cristalina",
            "atoms": [
                {"element": "Fe", "x": -0.8, "y": 0.5, "z": 0.0, "color": "#f59e0b", "radius": 0.28},
                {"element": "Fe", "x": 0.8, "y": -0.5, "z": 0.0, "color": "#f59e0b", "radius": 0.28},
                {"element": "O", "x": 0.0, "y": 0.8, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "O", "x": -0.8, "y": -0.5, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "O", "x": 0.8, "y": 0.5, "z": 0.0, "color": "#ef4444", "radius": 0.23}
            ]
        },
        "LiF": {
            "formula": "LiF",
            "name": "Fluoreto de Lítio",
            "mass": 25.939,
            "oxidation_states": {"Li": "+1", "F": "-1"},
            "electrovalency": "Li (+1), F (-1)",
            "bond_type": "Iônica (Altamente Polar)",
            "strong_bonds": "Ligação Iônica Forte (Diferença de eletronegatividade muito alta ~3.0)",
            "weak_bonds": "Atrações eletrostáticas da rede iônica",
            "atoms": [
                {"element": "Li", "x": -0.5, "y": 0.0, "z": 0.0, "color": "#ec4899", "radius": 0.22},
                {"element": "F", "x": 0.5, "y": 0.0, "z": 0.0, "color": "#14b8a6", "radius": 0.22}
            ]
        },
        "MgO": {
            "formula": "MgO",
            "name": "Óxido de Magnésio (Magnésia)",
            "mass": 40.304,
            "oxidation_states": {"Mg": "+2", "O": "-2"},
            "electrovalency": "Mg (+2), O (-2)",
            "bond_type": "Iônica (Divalente)",
            "strong_bonds": "Ligação Iônica Forte por transferência de 2 elétrons",
            "weak_bonds": "Coesão cristalina eletrostática tridimensional",
            "atoms": [
                {"element": "Mg", "x": -0.55, "y": 0.0, "z": 0.0, "color": "#047857", "radius": 0.26},
                {"element": "O", "x": 0.55, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23}
            ]
        }
    }

    REACTIONS = {
        "sodium_water": {
            "id": "sodium_water",
            "title": "Sódio Metálico em Água",
            "equation": "2Na + 2H2O -> 2NaOH + H2",
            "reactants": "2Na (Sódio) + 2H2O (Água)",
            "product_name": "NaOH (Hidróxido de Sódio)",
            "product_formula": "NaOH",
            "product_mass": 39.997,
            "product_electrovalency": "Na (+1), O (-2), H (+1)",
            "product_strong": "Iônica entre Na+ e OH-, Covalente Polar dentro do ânion OH-",
            "product_weak": "Forças íon-dipolo em solução, Forças de London",
            "byproduct_name": "H2 (Gás Hidrogênio)",
            "byproduct_formula": "H2",
            "byproduct_mass": 2.016,
            "byproduct_electrovalency": "H (0)",
            "byproduct_strong": "Covalente Apolar Simples (H-H)",
            "byproduct_weak": "Forças de Dispersão de London intermolecular muito fracas",
            "description": "Reação exotérmica violenta. O sódio oxida rapidamente, liberando hidrogênio gasoso inflamável e deixando a solução fortemente alcalina (básica) devido à formação de hidróxido de sódio.",
            "product_atoms": [
                {"element": "Na", "x": -0.6, "y": 0.0, "z": 0.0, "color": "#a78bfa", "radius": 0.28},
                {"element": "O", "x": 0.4, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "H", "x": 1.0, "y": 0.4, "z": 0.0, "color": "#ffffff", "radius": 0.15}
            ]
        },
        "haber_bosch": {
            "id": "haber_bosch",
            "title": "Síntese de Amônia (Haber-Bosch)",
            "equation": "N2 + 3H2 -> 2NH3",
            "reactants": "N2 (Nitrogênio) + 3H2 (Hidrogênio)",
            "product_name": "NH3 (Amônia)",
            "product_formula": "NH3",
            "product_mass": 17.031,
            "product_electrovalency": "N (-3), H (+1)",
            "product_strong": "Ligações Covalentes Polares Simples (3x N-H)",
            "product_weak": "Ligações de Hidrogênio (Pontes) e Forças de London",
            "byproduct_name": "Nenhum",
            "byproduct_formula": "-",
            "byproduct_mass": 0.0,
            "byproduct_electrovalency": "-",
            "byproduct_strong": "-",
            "byproduct_weak": "-",
            "description": "Reação industrial crucial para produção de fertilizantes agrícolas. Ocorre sob alta pressão, temperatura moderada e na presença de catalisadores de ferro.",
            "product_atoms": [
                {"element": "N", "x": 0.0, "y": 0.12, "z": 0.0, "color": "#3b82f6", "radius": 0.23},
                {"element": "H", "x": 0.94, "y": -0.38, "z": 0.0, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.38, "z": 0.81, "color": "#ffffff", "radius": 0.15},
                {"element": "H", "x": -0.47, "y": -0.38, "z": -0.81, "color": "#ffffff", "radius": 0.15}
            ]
        },
        "combustion_methane": {
            "id": "combustion_methane",
            "title": "Combustão Completa do Metano",
            "equation": "CH4 + 2O2 -> CO2 + 2H2O",
            "reactants": "CH4 (Metano) + 2O2 (Gás Oxigênio)",
            "product_name": "CO2 (Dióxido de Carbono)",
            "product_formula": "CO2",
            "product_mass": 44.009,
            "product_electrovalency": "C (+4), O (-2)",
            "product_strong": "Covalente Polar Dupla (C=O)",
            "product_weak": "Forças de Dispersão de London",
            "byproduct_name": "H2O (Água - Vapor)",
            "byproduct_formula": "H2O",
            "byproduct_mass": 18.015,
            "byproduct_electrovalency": "H (+1), O (-2)",
            "byproduct_strong": "Covalente Polar Simples (O-H)",
            "byproduct_weak": "Ligações de Hidrogênio (Pontes de Hidrogênio)",
            "description": "Queima clássica de hidrocarboneto simples. Libera energia na forma de calor e luz, produzindo dióxido de carbono e vapor de água.",
            "product_atoms": [
                {"element": "C", "x": 0.0, "y": 0.0, "z": 0.0, "color": "#4b5563", "radius": 0.23},
                {"element": "O", "x": -1.16, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23},
                {"element": "O", "x": 1.16, "y": 0.0, "z": 0.0, "color": "#ef4444", "radius": 0.23}
            ]
        },
        "neutralization": {
            "id": "neutralization",
            "title": "Neutralização Ácido-Base (HCl + NaOH)",
            "equation": "HCl + NaOH -> NaCl + H2O",
            "reactants": "HCl (Ácido Clorídrico) + NaOH (Hidróxido de Sódio)",
            "product_name": "NaCl (Cloreto de Sódio)",
            "product_formula": "NaCl",
            "product_mass": 58.440,
            "product_electrovalency": "Na (+1), Cl (-1)",
            "product_strong": "Iônica entre Na+ e Cl-",
            "product_weak": "Forças iônicas cristalinas, Forças de London",
            "byproduct_name": "H2O (Água Líquida)",
            "byproduct_formula": "H2O",
            "byproduct_mass": 18.015,
            "byproduct_electrovalency": "H (+1), O (-2)",
            "byproduct_strong": "Covalente Polar Simples (O-H)",
            "byproduct_weak": "Ligações de Hidrogênio permanentes",
            "description": "Reação clássica de neutralização de Arrhenius. Os íons H+ e OH- formam água neutra, e o sódio e o cloro formam sal dissolvido.",
            "product_atoms": [
                {"element": "Na", "x": -0.6, "y": 0.0, "z": 0.0, "color": "#a78bfa", "radius": 0.28},
                {"element": "Cl", "x": 0.6, "y": 0.0, "z": 0.0, "color": "#10b981", "radius": 0.28}
            ]
        }
    }

    @classmethod
    def run_bond(cls, formula: str):
        lookup = formula.strip().replace(" ", "")
        match = cls.COMPOUNDS.get(lookup)
        if not match:
            for key, val in cls.COMPOUNDS.items():
                if key.lower() == lookup.lower():
                    match = val
                    break
        if not match:
            raise ValueError(f"Composto '{formula}' não é suportado pelo banco de dados dinâmico de ligações.")
        return match

    @classmethod
    def run_reaction(cls, reaction_id: str):
        match = cls.REACTIONS.get(reaction_id)
        if not match:
            raise ValueError(f"Reação '{reaction_id}' não suportada ou não encontrada.")
        return match


class FormulaParserService:
    """
    Parses an arbitrary chemical formula (e.g. 'C6H12O6', 'Fe2(SO4)3') into
    element counts, and computes molar mass / mass composition from real
    atomic masses via ElementPropertyService — unlike ChemistrySimulationService
    (which only looks up a fixed set of pre-defined compounds), this works for
    any valid formula.

    Supports nested parentheses with multiplier subscripts (e.g. 'Fe2(SO4)3').
    Does NOT balance chemical equations — that requires solving a linear system
    over the reaction's stoichiometric matrix, a materially different (and
    substantially more complex) problem left out of scope here.
    """

    _TOKEN_RE = re.compile(r'([A-Z][a-z]?)(\d*)|(\()|(\))(\d*)')

    @classmethod
    def parse_formula(cls, formula: str) -> dict:
        """Returns {element_symbol: count}, expanding parenthesised groups."""
        formula = formula.strip()
        if not formula:
            raise ValueError("Formula cannot be empty.")

        # Stack of dicts: each frame accumulates counts for its parenthesis
        # depth; closing a frame multiplies it into the parent by the
        # trailing subscript and merges it in.
        stack = [{}]
        pos = 0
        for m in cls._TOKEN_RE.finditer(formula):
            if m.start() != pos:
                raise ValueError(f"Could not parse formula '{formula}' near position {pos}.")
            pos = m.end()

            element, count, open_paren, close_paren, close_count = m.groups()
            if element:
                n = int(count) if count else 1
                stack[-1][element] = stack[-1].get(element, 0) + n
            elif open_paren:
                stack.append({})
            elif close_paren:
                if len(stack) < 2:
                    raise ValueError(f"Unbalanced parentheses in formula '{formula}'.")
                group = stack.pop()
                multiplier = int(close_count) if close_count else 1
                for el, n in group.items():
                    stack[-1][el] = stack[-1].get(el, 0) + n * multiplier

        if pos != len(formula):
            raise ValueError(f"Could not parse formula '{formula}' near position {pos}.")
        if len(stack) != 1:
            raise ValueError(f"Unbalanced parentheses in formula '{formula}'.")

        counts = stack[0]
        if not counts:
            raise ValueError(f"No valid elements found in formula '{formula}'.")
        return counts

    @classmethod
    def compute_molar_mass(cls, formula: str) -> dict:
        """Returns molar mass [g/mol] and per-element mass composition."""
        counts = cls.parse_formula(formula)
        service = ElementPropertyService()

        composition = []
        total_mass = 0.0
        for symbol, count in counts.items():
            try:
                el = service.get_element(symbol)
            except Exception as exc:
                raise ValueError(f"Unknown element symbol '{symbol}' in formula '{formula}': {exc}")
            mass_contribution = el.atomic_mass * count
            total_mass += mass_contribution
            composition.append({
                "element": symbol,
                "count": count,
                "atomic_mass": el.atomic_mass,
                "mass_contribution": mass_contribution,
            })

        for c in composition:
            c["mass_percent"] = (c["mass_contribution"] / total_mass * 100) if total_mass > 0 else 0.0

        return {
            "formula": formula,
            "molar_mass_g_mol": total_mass,
            "composition": composition,
        }

