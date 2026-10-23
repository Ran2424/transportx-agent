from __future__ import annotations

from pathlib import Path
from typing import Any
import ezdxf


def render_dxf(doc: Any, png: Path, pdf: Path) -> dict[str, Any]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.config import ColorPolicy, Configuration
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    width, height, dpi = 1800, 1200, 150
    fig = plt.figure(figsize=(width / dpi, height / dpi))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    Frontend(
        RenderContext(doc),
        MatplotlibBackend(ax),
        config=Configuration(color_policy=ColorPolicy.COLOR_SWAP_BW),
    ).draw_layout(doc.modelspace(), finalize=True)
    fig.savefig(str(png), dpi=dpi, facecolor="white")
    fig.savefig(str(pdf), facecolor="white")
    plt.close(fig)
    return {"width": width, "height": height, "dpi": dpi}
