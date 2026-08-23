"""
apps/app_chemistry/fallback_db.py
==================================
Local database fallback for the Chemistry Periodic Table Element properties,
active when the `mendeleev` library is not installed (e.g. on Python 3.14).
"""

import os
import json
import logging

from .services import ElementData

logger = logging.getLogger(__name__)

# Covalent Radii in picometers (pm) based on Pekka Pyykkö and Michiko Atsumi (2009)
COVALENT_RADII = {
    1: 31, 2: 28, 3: 128, 4: 96, 5: 85, 6: 76, 7: 71, 8: 66, 9: 57, 10: 58,
    11: 166, 12: 141, 13: 121, 14: 111, 15: 107, 16: 105, 17: 102, 18: 106,
    19: 203, 20: 176, 21: 170, 22: 160, 23: 153, 24: 139, 25: 139, 26: 132,
    27: 126, 28: 124, 29: 132, 30: 122, 31: 122, 32: 120, 33: 121, 34: 116,
    35: 114, 36: 112, 37: 248, 38: 211, 39: 180, 40: 160, 41: 164, 42: 154,
    43: 147, 44: 146, 45: 142, 46: 139, 47: 145, 48: 144, 49: 142, 50: 139,
    51: 139, 52: 138, 53: 139, 54: 140, 55: 244, 56: 215, 57: 207, 58: 204,
    59: 203, 60: 201, 61: 199, 62: 198, 63: 198, 64: 196, 65: 194, 66: 192,
    67: 192, 68: 189, 69: 190, 70: 187, 71: 187, 72: 159, 73: 146, 74: 137,
    75: 131, 76: 129, 77: 122, 78: 123, 79: 124, 80: 133, 81: 145, 82: 146,
    83: 148, 84: 140, 85: 150, 86: 150, 87: 260, 88: 221, 89: 215, 90: 206,
    91: 200, 92: 196, 93: 190, 94: 187, 95: 180, 96: 169
}

# Common oxidation states
OXIDATION_STATES = {
    1: [1, -1], 2: [], 3: [1], 4: [2], 5: [3], 6: [-4, 4], 7: [-3, 3, 5],
    8: [-2], 9: [-1], 10: [], 11: [1], 12: [2], 13: [3], 14: [-4, 4],
    15: [-3, 3, 5], 16: [-2, 2, 4, 6], 17: [-1, 1, 3, 5, 7], 18: [],
    19: [1], 20: [2], 21: [3], 22: [4], 23: [5], 24: [2, 3, 6],
    25: [2, 3, 4, 7], 26: [2, 3, 6], 27: [2, 3], 28: [2, 3],
    29: [1, 2], 30: [2], 31: [3], 32: [-4, 4], 33: [-3, 3, 5],
    34: [-2, 4, 6], 35: [-1, 1, 3, 5], 36: [0, 2], 37: [1], 38: [2],
    39: [3], 40: [4], 41: [5], 42: [4, 6], 43: [4, 7], 44: [3, 4],
    45: [3], 46: [2, 4], 47: [1], 48: [2], 49: [3], 50: [2, 4],
    51: [3, 5], 52: [-2, 4, 6], 53: [-1, 1, 5, 7], 54: [0, 2, 4, 6, 8],
    55: [1], 56: [2], 57: [3], 58: [3, 4], 59: [3], 60: [3],
    61: [3], 62: [3], 63: [2, 3], 64: [3], 65: [3, 4], 66: [3],
    67: [3], 68: [3], 69: [3], 70: [2, 3], 71: [3], 72: [4],
    73: [5], 74: [4, 6], 75: [4, 7], 76: [4, 8], 77: [3, 4],
    78: [2, 4], 79: [1, 3], 80: [1, 2], 81: [1, 3], 82: [2, 4],
    83: [3, 5], 84: [2, 4], 85: [-1, 1, 3, 5], 86: [0], 87: [1],
    88: [2], 89: [3], 90: [4], 91: [5], 92: [3, 4, 5, 6], 93: [3, 4, 5, 6],
    94: [3, 4, 5, 6], 95: [3, 4, 5, 6], 96: [3], 97: [3, 4], 98: [3],
    99: [3], 100: [3], 101: [2, 3], 102: [2, 3], 103: [3], 104: [4],
    105: [5], 106: [6], 107: [7], 108: [8], 109: [9]
}

# Hardcoded minimal fallback data for basic elements in case periodic_table.json cannot be read
MINIMAL_FALLBACKS = {
    "H": {
        "symbol": "H", "name": "Hydrogen", "atomic_number": 1, "atomic_mass": 1.008,
        "period": 1, "group": 1, "electron_configuration": "1s1", "electronegativity": 2.2,
        "atomic_radius_pm": 31, "ionisation_energy_ev": 13.598, "melting_point_k": 13.99,
        "boiling_point_k": 20.271, "density_g_cm3": 0.00008988, "oxidation_states": [1, -1]
    },
    "HE": {
        "symbol": "He", "name": "Helium", "atomic_number": 2, "atomic_mass": 4.0026,
        "period": 1, "group": 18, "electron_configuration": "1s2", "electronegativity": None,
        "atomic_radius_pm": 28, "ionisation_energy_ev": 24.587, "melting_point_k": 0.95,
        "boiling_point_k": 4.222, "density_g_cm3": 0.0001786, "oxidation_states": []
    },
    "C": {
        "symbol": "C", "name": "Carbon", "atomic_number": 6, "atomic_mass": 12.011,
        "period": 2, "group": 14, "electron_configuration": "1s2 2s2 2p2", "electronegativity": 2.55,
        "atomic_radius_pm": 76, "ionisation_energy_ev": 11.260, "melting_point_k": 3823,
        "boiling_point_k": 4300, "density_g_cm3": 2.267, "oxidation_states": [-4, 4]
    },
    "O": {
        "symbol": "O", "name": "Oxygen", "atomic_number": 8, "atomic_mass": 15.999,
        "period": 2, "group": 16, "electron_configuration": "1s2 2s2 2p4", "electronegativity": 3.44,
        "atomic_radius_pm": 66, "ionisation_energy_ev": 13.618, "melting_point_k": 54.36,
        "boiling_point_k": 90.188, "density_g_cm3": 0.001429, "oxidation_states": [-2]
    },
    "FE": {
        "symbol": "Fe", "name": "Iron", "atomic_number": 26, "atomic_mass": 55.845,
        "period": 4, "group": 8, "electron_configuration": "[Ar] 3d6 4s2", "electronegativity": 1.83,
        "atomic_radius_pm": 132, "ionisation_energy_ev": 7.902, "melting_point_k": 1811,
        "boiling_point_k": 3134, "density_g_cm3": 7.874, "oxidation_states": [2, 3, 6]
    }
}


_ELEMENTS_CACHE = None

def load_elements_data():
    """
    Loads elements data from periodic_table.json, caching the result in memory.
    """
    global _ELEMENTS_CACHE
    if _ELEMENTS_CACHE is not None:
        return _ELEMENTS_CACHE
        
    json_path = os.path.join(os.path.dirname(__file__), "periodic_table.json")
    if not os.path.exists(json_path):
        logger.error(
            "Periodic table dataset missing at %s — the elements endpoint will "
            "return an empty table.", json_path,
        )
        _ELEMENTS_CACHE = []
        return _ELEMENTS_CACHE

    # A corrupt or unreadable file still degrades to an empty table rather than
    # a 500, but it must not do so silently: the endpoint answers 200 with zero
    # elements, which looks like a working periodic table with nothing in it.
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        _ELEMENTS_CACHE = data.get("elements", [])
    except (OSError, json.JSONDecodeError) as exc:
        logger.error(
            "Could not read periodic table dataset at %s (%s: %s) — the "
            "elements endpoint will return an empty table.",
            json_path, type(exc).__name__, exc,
        )
        _ELEMENTS_CACHE = []
    return _ELEMENTS_CACHE


def load_element_from_json(identifier: str | int) -> ElementData | None:
    """
    Tries to find and return the ElementData from cached periodic_table.json.
    """
    elements = load_elements_data()
    if not elements:
        return None
        
    try:
        
        # Search by symbol or atomic number
        match_el = None
        if isinstance(identifier, int):
            for el in elements:
                if el.get("number") == identifier:
                    match_el = el
                    break
        else:
            ident_upper = str(identifier).upper()
            for el in elements:
                if el.get("symbol", "").upper() == ident_upper or el.get("name", "").upper() == ident_upper:
                    match_el = el
                    break
                    
        if match_el:
            z = match_el.get("number")
            
            # Map first ionization energy from eV (Bowserinator values are kJ/mol or eV depending on database,
            # but usually they are listed in kJ/mol. Wait, for H it's 1312 kJ/mol which is 13.598 eV).
            # If values are > 100, they are in kJ/mol. We convert to eV.
            # 1 kJ/mol = 0.010364 eV/atom.
            ie_val = None
            ion_energies = match_el.get("ionization_energies", [])
            if ion_energies:
                first_ie = float(ion_energies[0])
                if first_ie > 100:
                    ie_val = first_ie * 0.010364
                else:
                    ie_val = first_ie
                    
            # Density handling (g/L for gases, g/cm3 for others).
            # Convert gas density from g/L to g/cm3 by dividing by 1000.
            density = match_el.get("density")
            if density is not None:
                density = float(density)
                if match_el.get("phase") == "Gas":
                    density = density / 1000.0

            return ElementData(
                symbol                 = match_el.get("symbol"),
                name                   = match_el.get("name"),
                atomic_number          = z,
                atomic_mass            = float(match_el.get("atomic_mass") or 0.0),
                period                 = match_el.get("period"),
                group                  = match_el.get("group"),
                electron_configuration = match_el.get("electron_configuration_semantic") or match_el.get("electron_configuration") or "",
                electronegativity      = match_el.get("electronegativity_pauling"),
                atomic_radius_pm       = COVALENT_RADII.get(z),
                ionisation_energy_ev   = ie_val,
                melting_point_k        = match_el.get("melt"),
                boiling_point_k        = match_el.get("boil"),
                density_g_cm3          = density,
                oxidation_states       = OXIDATION_STATES.get(z, []),
            )
            
    except (KeyError, TypeError, ValueError) as exc:
        # A malformed record for one element should not take out the whole
        # lookup, but swallowing it silently made a data problem look like
        # "element not found". Returning None hands control to the minimal
        # hardcoded table in get_element_fallback().
        logger.warning(
            "Malformed periodic table record for %r (%s: %s); falling back to "
            "the minimal built-in table.", identifier, type(exc).__name__, exc,
        )
    return None


def get_element_fallback(identifier: str | int) -> ElementData:
    """
    Gets element from local json or minimal hardcoded dictionary fallback.
    """
    # 1. Try JSON
    el_data = load_element_from_json(identifier)
    if el_data:
        return el_data
        
    # 2. Try minimal fallbacks
    key = str(identifier).upper()
    # Check if number matches
    if isinstance(identifier, int):
        for k, v in MINIMAL_FALLBACKS.items():
            if v["atomic_number"] == identifier:
                key = k
                break
                
    if key in MINIMAL_FALLBACKS:
        val = MINIMAL_FALLBACKS[key]
        return ElementData(**val)
        
    raise ValueError(f"Element '{identifier}' not found in local fallback database.")
