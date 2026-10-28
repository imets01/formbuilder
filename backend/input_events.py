"""
A field's extra JavaScript events, written the way they appear in HTML:

    onchange="vLicenceCheck(this);" onblur="trimField(this)"

A bare handler with no event name (how forms and sheets held it before events were
generic) means onchange.
"""

from __future__ import annotations

import re

_ATTRIBUTE = re.compile(
    r"""\b(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?)(?=\s+on[a-z]+\s*=|\s*$))""",
    re.IGNORECASE | re.DOTALL)


def parse_events(text: str | None) -> list[tuple[str, str]]:
    """[(event, handler)] in the order written; empty handlers are dropped."""
    text = (text or "").strip()
    if not text:
        return []
    found = [(m.group(1).lower(), next(g for g in m.groups()[1:] if g is not None).strip())
             for m in _ATTRIBUTE.finditer(text)]
    if not found:
        return [("onchange", text)]
    return [(event, handler) for event, handler in found if handler]


def format_events(text: str | None) -> str:
    """The canonical spelling: each event as name="handler", space-separated."""
    return " ".join(_attribute(event, handler) for event, handler in parse_events(text))


def _attribute(event: str, handler: str) -> str:
    if '"' not in handler:
        return f'{event}="{handler}"'
    if "'" not in handler:
        return f"{event}='{handler}'"
    # Both quotes: the browser decodes &quot; back to " before running the handler.
    return f'{event}="{handler.replace(chr(34), "&quot;")}"'
