"""Resolve fonts from the available runtime, without operating-system guesses."""
from functools import lru_cache


@lru_cache(maxsize=1)
def cjk_font() -> str | None:
    from matplotlib import font_manager
    from matplotlib.ft2font import FT2Font

    for font in font_manager.fontManager.ttflist:
        try:
            if ord("中") in FT2Font(font.fname).get_charmap():
                return font.name
        except (OSError, RuntimeError):
            continue
    return None


def font_warning(doc) -> str | None:
    for entity in doc.modelspace():
        if entity.dxftype() not in ("TEXT", "MTEXT"):
            continue
        text = entity.dxf.text if entity.dxftype() == "TEXT" else entity.plain_text()
        if any("\u3400" <= char <= "\u9fff" for char in text) and cjk_font() is None:
            return "No available CJK font was found for Python rendering."
    return None
