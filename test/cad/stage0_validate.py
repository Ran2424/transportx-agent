from __future__ import annotations

import argparse
import json
import math
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import ezdxf
from ezdxf import bbox, recover
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.config import ColorPolicy, Configuration
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pyproj import Transformer

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
DEFAULT_OUT = HERE / "out"
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

CLOSED_LAYERS = {
    "LANDUSE-300",
    "MARKING-AREA",
    "MARKING-HATCH",
    "PAVEMENT",
    "TRANSIT-PLATFORM",
    "WORKZONE",
}

BASE_LAYER_MAP = {
    "roads": "ROAD-CENTERLINE",
    "buffers": "LANDUSE-300",
    "crosswalk": "MARKING-AREA",
    "stopline": "MARKING",
    "island": "PAVEMENT",
    "signals": "SIGNAL",
    "solid": "MARKING-SOLID",
    "dashed": "MARKING-DASHED",
    "hatch": "MARKING-HATCH",
    "markings": "MARKING",
    "stops": "TRANSIT-STOP",
    "platform": "TRANSIT-PLATFORM",
    "workzone": "WORKZONE",
    "detour": "DETOUR",
}

SCENARIOS = [
    {
        "id": "01_centerline_buffer",
        "title": "中心线 + 3 m 缓冲",
        "kind": "geojson",
        "fixture": "01_centerline_buffer.geojson",
        "fill_layers": {"LANDUSE-300"},
    },
    {
        "id": "02_intersection",
        "title": "路口渠化",
        "kind": "geojson",
        "fixture": "02_intersection.geojson",
        "fill_layers": {"PAVEMENT"},
    },
    {
        "id": "03_crosswalk_stopline",
        "title": "人行横道 + 停止线",
        "kind": "geojson",
        "fixture": "03_crosswalk_stopline.geojson",
        "fill_layers": set(),
    },
    {
        "id": "04_signals",
        "title": "信号灯点位 + 标注",
        "kind": "geojson",
        "fixture": "04_signals.geojson",
        "fill_layers": set(),
    },
    {
        "id": "05_markings",
        "title": "实线 / 虚线 / 导流线",
        "kind": "geojson",
        "fixture": "05_markings.geojson",
        "fill_layers": {"MARKING-HATCH"},
    },
    {
        "id": "06_transit_stop",
        "title": "公交站点 + 站台",
        "kind": "geojson",
        "fixture": "06_transit_stop.geojson",
        "fill_layers": {"TRANSIT-PLATFORM"},
    },
    {
        "id": "07_workzone_detour",
        "title": "施工围挡 + 绕行",
        "kind": "geojson",
        "fixture": "07_workzone_detour.geojson",
        "fill_layers": set(),
    },
    {
        "id": "08_layer_edit",
        "title": "多图层批量改层",
        "kind": "edit",
        "fixture": "08_layer_edit.geojson",
        "fill_layers": set(),
    },
    {
        "id": "09_existing_r2013",
        "title": "已有 DXF 移动实体",
        "kind": "existing",
        "fixture": "09_existing_r2013.dxf",
        "fill_layers": set(),
    },
    {
        "id": "10_units_missing",
        "title": "单位缺失的 DXF",
        "kind": "units-missing",
        "fixture": "10_units_missing.dxf",
        "expected": "units-missing",
        "fill_layers": set(),
    },
]


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


def diagnostic(code: str, severity: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "severity": severity, "message": message, **extra}


def entity_signature(entity: Any) -> Any:
    kind = entity.dxftype()
    layer = entity.dxf.layer
    if kind == "LWPOLYLINE":
        points = tuple((round(float(x), 6), round(float(y), 6)) for x, y in entity.get_points("xy"))
        return (kind, layer, points, bool(entity.closed))
    if kind == "LINE":
        start = entity.dxf.start
        end = entity.dxf.end
        points = tuple(sorted([
            (round(float(start.x), 6), round(float(start.y), 6)),
            (round(float(end.x), 6), round(float(end.y), 6)),
        ]))
        return (kind, layer, points)
    if kind == "POINT":
        location = entity.dxf.location
        return (kind, layer, (round(float(location.x), 6), round(float(location.y), 6)))
    return None


def validate_dxf(path: Path, closed_layers: set[str]) -> dict[str, Any]:
    diagnostics: list[dict[str, Any]] = []
    try:
        doc, auditor = recover.readfile(str(path))
    except Exception as error:  # noqa: BLE001 - report the actual parser failure
        return {
            "status": "fail",
            "units": None,
            "entityCount": 0,
            "layerCount": 0,
            "layers": [],
            "extents": None,
            "diagnostics": [diagnostic("cad.reopen", "error", str(error))],
        }

    if auditor.has_errors:
        diagnostics.append(diagnostic("cad.audit", "error", f"DXF audit errors: {auditor.errors}"))

    units = int(doc.header.get("$INSUNITS", 0) or 0)
    if units not in (4, 6):
        diagnostics.append(diagnostic("cad.units", "warning", f"$INSUNITS is {units}; expected 4 (mm) or 6 (m)"))

    msp = doc.modelspace()
    entities = list(msp)
    if not entities and not list(doc.paperspace()):
        diagnostics.append(diagnostic("cad.empty", "error", "Modelspace and paperspace are empty"))

    layers = sorted({entity.dxf.layer for entity in entities})
    if "0" in layers:
        diagnostics.append(diagnostic("cad.layer0", "warning", "Generated geometry is on layer 0"))

    signatures: dict[Any, int] = {}
    for entity in entities:
        kind = entity.dxftype()
        layer = entity.dxf.layer
        if kind == "LWPOLYLINE":
            points = [(float(x), float(y)) for x, y in entity.get_points("xy")]
            if len(points) < 2:
                diagnostics.append(diagnostic("cad.degenerate", "error", "LWPOLYLINE has fewer than two points", layer=layer))
            if any(math.dist(points[index], points[index + 1]) < 1e-9 for index in range(len(points) - 1)):
                diagnostics.append(diagnostic("cad.degenerate", "error", "LWPOLYLINE has a zero-length segment", layer=layer))
            if layer in closed_layers and not entity.closed:
                diagnostics.append(diagnostic("cad.open_boundary", "error", "Boundary layer contains an open LWPOLYLINE", layer=layer))
        elif kind == "LINE":
            if math.dist(
                (float(entity.dxf.start.x), float(entity.dxf.start.y)),
                (float(entity.dxf.end.x), float(entity.dxf.end.y)),
            ) < 1e-9:
                diagnostics.append(diagnostic("cad.degenerate", "error", "LINE has zero length", layer=layer))
        elif kind == "HATCH":
            if layer in closed_layers:
                continue
        elif layer in closed_layers:
            diagnostics.append(diagnostic("cad.boundary_type", "error", f"Boundary layer contains {kind}", layer=layer))

        signature = entity_signature(entity)
        if signature is not None:
            signatures[signature] = signatures.get(signature, 0) + 1

    duplicates = sum(count - 1 for count in signatures.values() if count > 1)
    if duplicates:
        diagnostics.append(diagnostic("cad.duplicate", "warning", f"{duplicates} duplicate geometries"))

    extents = None
    box = bbox.extents(msp)
    if not box.has_data:
        diagnostics.append(diagnostic("cad.extents", "error", "Drawing has no extents"))
    else:
        width = float(box.extmax.x - box.extmin.x)
        height = float(box.extmax.y - box.extmin.y)
        extents = {
            "min": [float(box.extmin.x), float(box.extmin.y)],
            "max": [float(box.extmax.x), float(box.extmax.y)],
            "width": width,
            "height": height,
        }
        if width <= 0 or height <= 0:
            diagnostics.append(diagnostic("cad.extents", "error", "Drawing extents are zero"))
        if width > 1e7 or height > 1e7:
            diagnostics.append(diagnostic("cad.extents", "warning", "Drawing extents exceed 1e7"))

    status = "pass"
    if any(item["severity"] == "error" for item in diagnostics):
        status = "fail"
    elif diagnostics:
        status = "pass-with-warning"

    return {
        "status": status,
        "units": units,
        "entityCount": len(entities),
        "layerCount": len(layers),
        "layers": layers,
        "extents": extents,
        "diagnostics": diagnostics,
    }


def run_scenario(scenario: dict[str, Any], out_root: Path) -> dict[str, Any]:
    fixture = FIXTURES / scenario["fixture"]
    out_dir = out_root / scenario["id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    layer_map = {**BASE_LAYER_MAP, **scenario.get("layer_map", {})}
    fill_layers = set(scenario.get("fill_layers", set()))
    revision = 1
    operations: list[str] = []

    if scenario["kind"] == "geojson":
        doc = build_geojson(fixture, layer_map, fill_layers, out_dir / "r1.dxf")
    elif scenario["kind"] == "edit":
        doc = build_geojson(fixture, layer_map, fill_layers, out_dir / "r1.dxf")
        revision = 2
        source = out_dir / "r1.dxf"
        doc, auditor = recover.readfile(str(source))
        if auditor.has_errors:
            raise ValueError(f"Source audit failed: {auditor.errors}")
        add_layer(doc, "MARKING-REVIEW")
        changed_layers = 0
        moved_signals = 0
        for entity in doc.modelspace():
            if entity.dxf.layer == "MARKING":
                entity.dxf.layer = "MARKING-REVIEW"
                changed_layers += 1
            elif entity.dxf.layer == "SIGNAL":
                entity.translate(2.0, 0.0, 0.0)
                moved_signals += 1
        operations = [f"setLayer MARKING -> MARKING-REVIEW ({changed_layers})", f"move SIGNAL dx=2 ({moved_signals})"]
        target = out_dir / "r2.dxf"
        temporary = target.with_suffix(".dxf.tmp")
        doc.saveas(str(temporary))
        os.replace(temporary, target)
        doc, _ = recover.readfile(str(target))
    elif scenario["kind"] == "existing":
        revision = 2
        source = out_dir / "r1.dxf"
        shutil.copyfile(fixture, source)
        doc, auditor = recover.readfile(str(source))
        if auditor.has_errors:
            raise ValueError(f"Source audit failed: {auditor.errors}")
        moved = 0
        for entity in doc.modelspace():
            if entity.dxf.layer == "SIGNAL":
                entity.translate(2.0, 0.0, 0.0)
                moved += 1
        operations = [f"move SIGNAL dx=2 ({moved})"]
        target = out_dir / "r2.dxf"
        temporary = target.with_suffix(".dxf.tmp")
        doc.saveas(str(temporary))
        os.replace(temporary, target)
        doc, _ = recover.readfile(str(target))
    elif scenario["kind"] == "units-missing":
        source = out_dir / "r1.dxf"
        shutil.copyfile(fixture, source)
        doc, auditor = recover.readfile(str(source))
        if auditor.has_errors:
            raise ValueError(f"Source audit failed: {auditor.errors}")
    else:
        raise ValueError(f"Unknown scenario kind: {scenario['kind']}")

    dxf = out_dir / f"r{revision}.dxf"
    validation = validate_dxf(dxf, CLOSED_LAYERS)
    png = out_dir / f"r{revision}.png"
    pdf = out_dir / f"r{revision}.pdf"
    try:
        render_dxf(doc, png, pdf)
        validation["preview"] = {
            "png": str(png.relative_to(HERE.parent.parent)),
            "pdf": str(pdf.relative_to(HERE.parent.parent)),
            "pngBytes": png.stat().st_size,
            "pdfBytes": pdf.stat().st_size,
        }
    except Exception as error:  # noqa: BLE001 - preview failure must be visible
        validation["diagnostics"].append(diagnostic("cad.render", "warning", str(error)))
        validation["preview"] = None
        if validation["status"] == "pass":
            validation["status"] = "pass-with-warning"

    result = {
        "id": scenario["id"],
        "title": scenario["title"],
        "kind": scenario["kind"],
        "fixture": scenario["fixture"],
        "revision": revision,
        "dxf": str(dxf.relative_to(HERE.parent.parent)),
        "operations": operations,
        **validation,
    }

    if scenario.get("expected") == "units-missing":
        units_missing = result["units"] == 0
        has_units_warning = any(item["code"] == "cad.units" for item in result["diagnostics"])
        if units_missing and has_units_warning and result["status"] != "fail":
            result["status"] = "expected-warning"
        else:
            result["status"] = "fail"
            result["diagnostics"].append(diagnostic(
                "cad.stage0_expectation",
                "error",
                "Expected $INSUNITS=0 plus a cad.units warning",
            ))

    return result


def run_negative_controls(out_root: Path) -> list[dict[str, Any]]:
    """Prove the validator rejects known-bad drawings instead of rubber-stamping them."""
    probe_root = out_root / "_negative_controls"
    probe_root.mkdir(parents=True, exist_ok=True)

    def build_probe(name: str, build: Any) -> Path:
        doc = ezdxf.new("R2013", setup=False)
        doc.header["$INSUNITS"] = 6
        doc.header["$MEASUREMENT"] = 1
        build(doc)
        path = probe_root / f"{name}.dxf"
        doc.saveas(str(path))
        return path

    def open_boundary(doc: Any) -> None:
        add_layer(doc, "WORKZONE")
        doc.modelspace().add_lwpolyline(
            [(0, 0), (10, 0), (10, 10)],
            close=False,
            dxfattribs={"layer": "WORKZONE"},
        )

    def zero_length(doc: Any) -> None:
        add_layer(doc, "ROAD-CENTERLINE")
        doc.modelspace().add_line((0, 0), (0, 0), dxfattribs={"layer": "ROAD-CENTERLINE"})

    def duplicate_geometry(doc: Any) -> None:
        add_layer(doc, "ROAD-CENTERLINE")
        for _ in range(2):
            doc.modelspace().add_line((0, 0), (10, 10), dxfattribs={"layer": "ROAD-CENTERLINE"})

    probes = [
        ("open_boundary", "fail", "cad.open_boundary", open_boundary),
        ("zero_length", "fail", "cad.degenerate", zero_length),
        ("duplicate_geometry", "pass-with-warning", "cad.duplicate", duplicate_geometry),
    ]
    results = []
    for name, expected_status, expected_code, build in probes:
        path = build_probe(name, build)
        validation = validate_dxf(path, CLOSED_LAYERS)
        codes = {item["code"] for item in validation["diagnostics"]}
        detected = validation["status"] == expected_status and expected_code in codes
        results.append({
            "id": name,
            "expectedStatus": expected_status,
            "expectedCode": expected_code,
            "detected": detected,
            "status": validation["status"],
            "diagnostics": validation["diagnostics"],
            "dxf": str(path.relative_to(HERE.parent.parent)),
        })
    return results


def write_summary(results: list[dict[str, Any]], negative_controls: list[dict[str, Any]], out_root: Path) -> None:
    out_root.mkdir(parents=True, exist_ok=True)
    summary = {
        "protocol": "tau-cad-stage0",
        "version": "1.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "targetCrs": TARGET_CRS,
        "scenarios": results,
        "negativeControls": negative_controls,
    }
    (out_root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# CAD Stage 0 validation",
        "",
        f"- target CRS: `{TARGET_CRS}`",
        f"- generated: `{summary['generatedAt']}`",
        "",
        "| # | Scenario | Status | Units | Entities | Layers | Warnings | Errors |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for result in results:
        warnings = sum(1 for item in result["diagnostics"] if item["severity"] == "warning")
        errors = sum(1 for item in result["diagnostics"] if item["severity"] == "error")
        lines.append(
            f"| {result['id']} | {result['title']} | {result['status']} | "
            f"{result['units']} | {result['entityCount']} | {result['layerCount']} | {warnings} | {errors} |"
        )
    lines.extend([
        "",
        "## Negative controls",
        "",
        "| Probe | Expected | Actual | Detected |",
        "|---|---|---|---|",
    ])
    for probe in negative_controls:
        lines.append(
            f"| {probe['id']} | {probe['expectedStatus']} / {probe['expectedCode']} | "
            f"{probe['status']} | {'yes' if probe['detected'] else 'NO'} |"
        )
    (out_root / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage 0 CAD fixture validation")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out_root = args.out.resolve()

    results: list[dict[str, Any]] = []
    for scenario in SCENARIOS:
        try:
            results.append(run_scenario(scenario, out_root))
        except Exception as error:  # noqa: BLE001 - keep going so one failure doesn't hide the rest
            results.append({
                "id": scenario["id"],
                "title": scenario["title"],
                "kind": scenario["kind"],
                "fixture": scenario["fixture"],
                "status": "fail",
                "units": None,
                "entityCount": 0,
                "layerCount": 0,
                "layers": [],
                "extents": None,
                "preview": None,
                "diagnostics": [diagnostic("cad.stage0_exception", "error", str(error))],
            })

    negative_controls = run_negative_controls(out_root)
    write_summary(results, negative_controls, out_root)
    print(f"{'ID':<24} {'STATUS':<18} {'UNITS':>5} {'ENT':>5} {'LAY':>4}  TITLE")
    for result in results:
        print(
            f"{result['id']:<24} {result['status']:<18} "
            f"{str(result['units']):>5} {result['entityCount']:>5} {result['layerCount']:>4}  {result['title']}"
        )
    print("\nnegative controls:")
    for probe in negative_controls:
        print(f"  {probe['id']:<24} detected={probe['detected']} status={probe['status']}")
    print(f"\nsummary: {out_root / 'summary.md'}")
    return 0 if all(result["status"] != "fail" for result in results) and all(
        probe["detected"] for probe in negative_controls
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
