"""
Dictionary-based translation suggestions.

ftl_consts/*.txt holds a curated phrase library of generic form-field vocabulary as
FreeMarker-style `<#assign name="value" />` lines, one file per language. This module
parses them into a forward lookup: given a term in one language, return its DE/FR/IT/EN
values so the builder can fill the other three.

A fixed-library lookup, not machine translation — unknown terms return None.
"""

import re
from pathlib import Path

_LANGS = ('de', 'fr', 'it', 'en')
_FTL_CONSTS_DIR = Path(__file__).resolve().parent / "ftl_consts"

# Only plain string assignments. Skip aliases (`<#assign a=b/>`) and concatenations
# (`<#assign a="x "+b/>`) — those carry no standalone translatable literal.
_ASSIGN_INLINE = re.compile(r'<#assign\s+(\w+)\s*=\s*"([^"]*)"\s*/>')
_ASSIGN_BLOCK = re.compile(r'<#assign\s+(\w+)\s*>([^<]*)</#assign>')


def _norm(text: str) -> str:
    """Normalize for matching: trim + casefold (so 'Company name'/'Company Name'/' company name ' all match)."""
    return (text or '').strip().casefold()


def _parse_lang(lang: str) -> dict:
    """Parse ftl_consts/{lang}.txt into {constant_name: value} for plain-string assignments."""
    path = _FTL_CONSTS_DIR / f"{lang}.txt"
    out = {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for raw in f:
                line = raw.strip()
                match = _ASSIGN_INLINE.match(line) or _ASSIGN_BLOCK.match(line)
                if match:
                    name, value = match.group(1), match.group(2)
                    out.setdefault(name, value)  # first (canonical) definition wins
    except OSError:
        pass
    return out


def _build():
    """Returns (by_name, index): {name: {lang: value}} and {lang: {normalized_value: name}}."""
    by_name = {}
    index = {lang: {} for lang in _LANGS}
    for lang in _LANGS:
        for name, value in _parse_lang(lang).items():
            by_name.setdefault(name, {})[lang] = value
            index[lang].setdefault(_norm(value), name)  # first match wins for an ambiguous value
    return by_name, index


_BY_NAME, _INDEX = _build()


def lookup(text: str, src_lang: str):
    """Find a library entry matching `text` in `src_lang`.

    Returns {'name': constant_name, 'translations': {'DE','FR','IT','EN'}} on a hit, else None.
    Languages missing from the library entry are returned as empty strings.
    """
    lang = (src_lang or 'de').lower()
    if lang not in _INDEX:
        return None
    name = _INDEX[lang].get(_norm(text))
    if not name:
        return None
    values = _BY_NAME.get(name, {})
    return {
        'name': name,
        'translations': {
            'DE': values.get('de', ''),
            'FR': values.get('fr', ''),
            'IT': values.get('it', ''),
            'EN': values.get('en', ''),
        },
    }
