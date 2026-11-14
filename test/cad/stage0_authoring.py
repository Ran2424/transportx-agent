from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

import ezdxf
from ezdxf import recover
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.config import ColorPolicy, Configuration
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pyproj import Transformer

TARGET_CRS = "EPSG:32651"

LAYER_COLORS = {
    "ROAD-CENTERLINE": 7,
    "ROAD-EDGE": 8,
    "LANDUSE-300": 5,
    "MARKING": 1,
    "MARKING-AREA": 1,
    "MARKING-SOLID": 1,
    "MARKING-DASHED": 2,
    "MARKING-HATCH": 4,
    "MARKING-REVIEW": 2,
    "PAVEMENT": 8,
    "SIGNAL": 3,
    "LABEL": 7,
    "TRANSIT-STOP": 3,
    "TRANSIT-PLATFORM": 4,
    "WORKZONE": 6,
    "DETOUR": 2,
    "UNASSIGNED": 8,
}

def add_layer(doc: Any, name: str) -> None:
    if name not in doc.layers:
        doc.layers.add(name, color=LAYER_COLORS.get(name, 7))


def transform_coords(value: Any, transformer: Transformer) -> Any:
    if isinstance(value, list) and value and isinstance(value[0], (int, float)):
        return list(transformer.transform(float(value[0]), float(value[1])))
    if isinstance(value, list):
        return [transform_coords(item, transformer) for item in value]
    return value


def transform_geometry(geometry: dict[str, Any], transformer: Transformer) -> dict[str, Any]:
    if geometry.get("type") == "GeometryCollection":
        return {
            **geometry,
            "geometries": [transform_geometry(item, transformer) for item in geometry.get("geometries", [])],
        }
    return {**geometry, "coordinates": transform_coords(geometry.get("coordinates"), transformer)}


def geometry_parts(geometry: dict[str, Any]) -> Iterable[tuple[str, Any]]:
    kind = geometry.get("type")
    if kind == "GeometryCollection":
        for item in geometry.get("geometries", []):
            yield from geometry_parts(item)
        return
    if kind and kind.startswith("Multi"):
        base = kind[5:]
        for coordinates in geometry.get("coordinates", []):
            yield base, coordinates
        return
    yield str(kind), geometry.get("coordinates")


def add_geometry(
    doc: Any,
    msp: Any,
    geometry: dict[str, Any],
    layer: str,
    properties: dict[str, Any],
    fill_layers: set[str],
    text_style: str,
) -> int:
    count = 0
    name = properties.get("name")
    for kind, coordinates in geometry_parts(geometry):
        if kind == "Point":
            x, y = coordinates
            msp.add_point((x, y), dxfattribs={"layer": layer})
            if name:
                msp.add_text(
                    str(name),
                    height=2.5,
                    dxfattribs={"layer": "LABEL", "style": text_style},
                ).set_placement((x + 1.0, y + 1.0))
            count += 1
        elif kind == "LineString":
            if len(coordinates) < 2:
                raise ValueError("LineString requires at least two points")
            msp.add_lwpolyline(coordinates, close=False, dxfattribs={"layer": layer})
            if name:
                x, y = coordinates[0]
                msp.add_text(
                    str(name),
                    height=2.5,
                    dxfattribs={"layer": "LABEL", "style": text_style},
                ).set_placement((x + 1.0, y + 1.0))
            count += 1
        elif kind == "Polygon":
            if not coordinates:
                raise ValueError("Polygon has no rings")
            ring = coordinates[0]
            if len(ring) < 4:
                raise ValueError("Polygon outer ring requires at least four points")
            msp.add_lwpolyline(ring, close=True, dxfattribs={"layer": layer})
            if layer in fill_layers:
                hatch = msp.add_hatch(color=LAYER_COLORS.get(layer, 7), dxfattribs={"layer": layer})
                hatch.paths.add_polyline_path(ring, is_closed=True)
            if name:
                x, y = ring[0]
                msp.add_text(
                    str(name),
                    height=2.5,
                    dxfattribs={"layer": "LABEL", "style": text_style},
                ).set_placement((x + 1.0, y + 1.0))
            count += 1
        else:
            raise ValueError(f"Unsupported geometry type: {kind}")
    return count


def build_geojson(fixture: Path, layer_map: dict[str, str], fill_layers: set[str], output: Path) -> Any:
    data = json.loads(fixture.read_text(encoding="utf-8"))
    features = data.get("features")
    if data.get("type") != "FeatureCollection" or not isinstance(features, list) or not features:
        raise ValueError("GeoJSON must be a non-empty FeatureCollection")

    transformer = Transformer.from_crs("EPSG:4326", TARGET_CRS, always_xy=True)
    doc = ezdxf.new("R2013", setup=True)
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    doc.header["$LUPREC"] = 3

    for layer in sorted(set(layer_map.values()) | {"LABEL"}):
        add_layer(doc, layer)

    text_style = "Standard"
    if "CJK" not in doc.styles:
        doc.styles.add("CJK", font="Microsoft YaHei")
        text_style = "CJK"

    msp = doc.modelspace()
    for feature in features:
        geometry = feature.get("geometry")
        if not geometry:
            continue
        properties = feature.get("properties") or {}
        layer = layer_map.get(str(properties.get("kind") or ""), "UNASSIGNED")
        add_layer(doc, layer)
        add_geometry(
            doc,
            msp,
            transform_geometry(geometry, transformer),
            layer,
            properties,
            fill_layers,
            text_style,
        )

    if len(msp) == 0:
        raise ValueError("No DXF entities were generated")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    doc.saveas(str(temporary))
    reopened, auditor = recover.readfile(str(temporary))
    if auditor.has_errors:
        raise ValueError(f"DXF audit failed: {auditor.errors}")
    os.replace(temporary, output)
    return reopened


def render_dxf(doc: Any, png: Path, pdf: Path) -> None:
    fig = plt.figure(figsize=(12, 8))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    Frontend(
        RenderContext(doc),
        MatplotlibBackend(ax),
        config=Configuration(color_policy=ColorPolicy.COLOR_SWAP_BW),
    ).draw_layout(doc.modelspace(), finalize=True)
    fig.savefig(png, dpi=150, facecolor="white")
    fig.savefig(pdf, facecolor="white")
    plt.close(fig)
