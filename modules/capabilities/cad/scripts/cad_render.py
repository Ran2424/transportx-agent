from __future__ import annotations

from pathlib import Path
from typing import Any
import ezdxf


def render_dxf(doc: Any, png: Path, pdf: Path, options: dict[str, Any] | None = None) -> dict[str, Any]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.config import ColorPolicy, Configuration
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    options = options or {}
    width, height, dpi = int(options.get("width", 1800)), int(options.get("height", 1200)), 150
    if not (256 <= width <= 4096 and 256 <= height <= 4096):
        raise ValueError("Preview dimensions must be 256..4096 pixels.")
    selected = options.get("layers")
    if selected:
        unknown = set(selected) - {layer.dxf.name for layer in doc.layers}
        if unknown:
            raise ValueError(f"Unknown preview layers: {sorted(unknown)}")
        for layer in doc.layers:
            layer.on() if layer.dxf.name in selected else layer.off()
    fig = plt.figure(figsize=(width / dpi, height / dpi))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    Frontend(
        RenderContext(doc),
        MatplotlibBackend(ax, adjust_figure=False),
        config=Configuration(color_policy=ColorPolicy.COLOR_SWAP_BW),
    ).draw_layout(doc.modelspace(), finalize=True)
    bounds = options.get("bounds")
    if bounds:
        ax.set_xlim(*[bounds[key][0] for key in ("min", "max")])
        ax.set_ylim(*[bounds[key][1] for key in ("min", "max")])
        ax.set_aspect("equal", adjustable="box")
    fig.savefig(str(png), dpi=dpi, facecolor="white")
    fig.savefig(str(pdf), facecolor="white")
    plt.close(fig)
    return {"width": width, "height": height, "dpi": dpi}
