"""
What a Fachdatenbezeichner may contain.

It travels downstream into generated identifiers and quoted strings, so anything beyond
letters, digits and _ breaks one of them. Umlauts stay allowed: real PSPH sheets use
them, and the identifier folding downstream drops them.
"""

from __future__ import annotations

import re

_FIELD_NAME = re.compile(r'(?:[^\W\d_]|[0-9_])+')

ALLOWED_DESCRIPTION = 'letters, digits and _'


def is_valid_field_name(name: str | None) -> bool:
    """Blank counts as valid: the builder then derives a name itself."""
    name = (name or '').strip()
    return not name or bool(_FIELD_NAME.fullmatch(name))


def _names_in(payload: dict):
    for section in payload.get('sections') or []:
        yield section.get('sourceRef')
        yield section.get('aggregateFachdatenbezeichner')
        for comp in section.get('components') or []:
            yield comp.get('fieldName')
            split = comp.get('splitConfig') or {}
            for side in (split.get('a'), split.get('b')):
                if side:
                    yield side.get('fieldName')
            for option in comp.get('options') or []:
                yield option.get('fieldName')


def invalid_field_names(payload: dict) -> list[str]:
    seen: dict[str, None] = {}
    for name in _names_in(payload):
        if not is_valid_field_name(name):
            seen.setdefault(name.strip(), None)
    return list(seen)


class InvalidFieldNames(ValueError):
    def __init__(self, names: list[str]):
        self.names = names
        quoted = ', '.join(f'"{n}"' for n in names)
        super().__init__(
            f'Fachdatenbezeichner may only contain {ALLOWED_DESCRIPTION}. '
            f'Rename before generating: {quoted}')


def reject_invalid_field_names(payload: dict) -> None:
    names = invalid_field_names(payload)
    if names:
        raise InvalidFieldNames(names)
