#!/usr/bin/env python3
"""TransportX CAD engine.

The Host owns revisions, locking and final commit. This process only reads a
structured request, writes temporary artifacts below the job directory, and
prints one JSON result to stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import time
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
from pyproj import CRS, Transformer
from shapely import make_valid
from shapely.geometry import mapping, shape

CAD_PROTOCOL = "tau-cad"
CAD_VERSION = "1.0"
CAD_ENGINE_PROTOCOL = "tau-cad-engine"
CAD_ENGINE_VERSION = "1.0"
CAD_DRAWING_PROTOCOL = "tau-cad-drawing"
CAD_DRAWING_VERSION = "1.0"

MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_ENTITY_COUNT = 20_000
MAX_OPERATIONS = 200
MAX_MATCHED = 5_000
MAX_HANDLES = 500
MAX_POINTS = 10_000
MAX_TEXT = 500

FILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
HANDLE_RE = re.compile(r"^[0-9A-F]{1,16}$")
LAYER_RE = re.compile(r'^[^<>/\\":;?*|,=\x00-\x1f]{1,255}$')
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
EPSG_RE = re.compile(r"^EPSG:[0-9]{4,6}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")

CLOSED_LAYERS = {
    "LANDUSE-300",
    "MARKING-AREA",
    "MARKING-HATCH",
    "PAVEMENT",
    "TRANSIT-PLATFORM",
    "WORKZONE",
}
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
SUPPORTED_ENTITY_TYPES = {
    "LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT",
    "POINT", "INSERT", "HATCH",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def diag(code: str, severity: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"code": code, "severity": severity, "message": message, **extra}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_posix(path: Path, workspace: Path) -> str:
    return path.resolve().relative_to(workspace.resolve()).as_posix()


def is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([str(path.resolve()), str(root.resolve())]) == str(root.resolve())
    except ValueError:
        return False


def workspace_path(workspace: Path, relative: Any, extensions: set[str] | None = None, must_exist: bool = True) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ValueError("A non-empty session-relative path is required.")
    if relative.startswith("/") or "\\" in relative or re.match(r"^[A-Za-z]:", relative):
        raise ValueError("Path must be a safe relative POSIX path.")
    if any(part in ("", ".", "..") for part in relative.split("/")):
        raise ValueError("Path must not contain empty, '.' or '..' segments.")
    path = (workspace / relative).resolve()
    if not is_within(path, workspace):
        raise ValueError("Path escapes the session workspace.")
    if extensions and path.suffix.lower() not in extensions:
        raise ValueError(f"Path must end with {', '.join(sorted(extensions))}.")
    if must_exist:
        if not path.is_file():
            raise ValueError("Input file does not exist.")
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError(f"Input file exceeds {MAX_INPUT_BYTES} bytes.")
    return path


def safe_job_dir(workspace: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError("jobDir is required.")
    job_dir = Path(value).resolve()
    if not is_within(job_dir, workspace):
        raise ValueError("jobDir must be inside the session workspace.")
    job_dir.mkdir(parents=True, exist_ok=True)
    return job_dir


def add_layer(doc: Any, name: str) -> None:
    if name not in doc.layers:
        doc.layers.add(name, color=LAYER_COLORS.get(name, 7))


def units_code(doc: Any) -> int:
    try:
        return int(doc.header.get("$INSUNITS", 0) or 0)
    except (TypeError, ValueError):
        return 0


def units_name(code: int) -> str | None:
    return {6: "m", 4: "mm"}.get(code)


def units_from_request(value: Any) -> str | None:
    return value if value in ("m", "mm") else None


def text_style(doc: Any) -> str:
    if "CJK" not in doc.styles:
        doc.styles.add("CJK", font="Microsoft YaHei")
    return "CJK"


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


def rotate_scale_coords(value: Any, rotation_deg: float, scale: float) -> Any:
    if isinstance(value, list) and value and isinstance(value[0], (int, float)):
        x, y = float(value[0]), float(value[1])
        angle = math.radians(rotation_deg)
        return [scale * (math.cos(angle) * x - math.sin(angle) * y), scale * (math.sin(angle) * x + math.cos(angle) * y)]
    if isinstance(value, list):
        return [rotate_scale_coords(item, rotation_deg, scale) for item in value]
    return value


def rotate_scale_geometry(geometry: dict[str, Any], rotation_deg: float, scale: float) -> dict[str, Any]:
    if geometry.get("type") == "GeometryCollection":
        return {
            **geometry,
            "geometries": [rotate_scale_geometry(item, rotation_deg, scale) for item in geometry.get("geometries", [])],
        }
    return {**geometry, "coordinates": rotate_scale_coords(geometry.get("coordinates"), rotation_deg, scale)}


def geometry_parts(geometry: dict[str, Any]) -> Iterable[tuple[str, Any]]:
    kind = geometry.get("type")
    if kind == "GeometryCollection":
        for item in geometry.get("geometries", []):
            yield from geometry_parts(item)
        return
    if kind and kind.startswith("Multi"):
        for coordinates in geometry.get("coordinates", []):
            yield kind[5:], coordinates
        return
    yield str(kind), geometry.get("coordinates")


def normalize_geometry(geometry: dict[str, Any], repair_invalid: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    warnings: list[dict[str, Any]] = []
    try:
        parsed = shape(geometry)
    except Exception:
        return geometry, warnings
    if parsed.is_valid:
        return geometry, warnings
    if not repair_invalid:
        raise ValueError("Invalid GeoJSON geometry; set repairInvalid=true to repair it.")
    repaired = make_valid(parsed)
    if repaired.is_empty:
        raise ValueError("Geometry is empty after repair.")
    warnings.append(diag("cad.geometry_repaired", "warning", "Invalid geometry was repaired with shapely.make_valid."))
    return mapping(repaired), warnings


def add_geometry(
    doc: Any,
    msp: Any,
    geometry: dict[str, Any],
    layer: str,
    properties: dict[str, Any],
    fill_layers: set[str],
    label_field: str | None,
    label_layer: str,
) -> int:
    count = 0
    style = text_style(doc)
    label = properties.get(label_field) if label_field else None
    for kind, coordinates in geometry_parts(geometry):
        if kind == "Point":
            x, y = coordinates
            msp.add_point((x, y), dxfattribs={"layer": layer})
            if label:
                msp.add_text(str(label)[:MAX_TEXT], height=2.5, dxfattribs={"layer": label_layer, "style": style}).set_placement((x + 1.0, y + 1.0))
            count += 1
        elif kind == "LineString":
            if len(coordinates) < 2:
                raise ValueError("LineString requires at least two points.")
            msp.add_lwpolyline(coordinates, close=False, dxfattribs={"layer": layer})
            if label:
                x, y = coordinates[0]
                msp.add_text(str(label)[:MAX_TEXT], height=2.5, dxfattribs={"layer": label_layer, "style": style}).set_placement((x + 1.0, y + 1.0))
            count += 1
        elif kind == "Polygon":
            if not coordinates:
                raise ValueError("Polygon has no rings.")
            ring = coordinates[0]
            if len(ring) < 4:
                raise ValueError("Polygon outer ring requires at least four points.")
            msp.add_lwpolyline(ring, close=True, dxfattribs={"layer": layer})
            if layer in fill_layers:
                hatch = msp.add_hatch(color=LAYER_COLORS.get(layer, 7), dxfattribs={"layer": layer})
                hatch.paths.add_polyline_path(ring, is_closed=True)
            if label:
                x, y = ring[0]
                msp.add_text(str(label)[:MAX_TEXT], height=2.5, dxfattribs={"layer": label_layer, "style": style}).set_placement((x + 1.0, y + 1.0))
            count += 1
        else:
            raise ValueError(f"Unsupported geometry type: {kind}")
    return count


def target_transformer(target: dict[str, Any]) -> tuple[Transformer, dict[str, Any]]:
    if target.get("kind") == "epsg":
        code = target.get("code")
        if not isinstance(code, str) or not EPSG_RE.match(code):
            raise ValueError("target.code must look like EPSG:32651.")
        crs = CRS.from_user_input(code)
        if abs(crs.axis_info[0].unit_conversion_factor - 1.0) > 1e-9:
            raise ValueError("target EPSG must use metres; feet or degrees are not supported.")
        return Transformer.from_crs("EPSG:4326", code, always_xy=True), {"kind": "epsg", "code": code}
    if target.get("kind") == "local":
        origin = target.get("origin")
        if not isinstance(origin, list) or len(origin) != 2 or not all(isinstance(item, (int, float)) for item in origin):
            raise ValueError("local target requires origin [lng, lat].")
        lng, lat = float(origin[0]), float(origin[1])
        rotation = float(target.get("rotationDeg", 0))
        scale = float(target.get("scale", 1))
        if not math.isfinite(rotation) or not math.isfinite(scale) or scale <= 0:
            raise ValueError("local target requires finite rotationDeg and scale > 0.")
        proj = f"+proj=aeqd +lat_0={lat} +lon_0={lng} +units=m +datum=WGS84"
        return Transformer.from_crs("EPSG:4326", proj, always_xy=True), {
            "kind": "local",
            "origin": [lng, lat],
            "rotationDeg": rotation,
            "scale": scale,
        }
    raise ValueError('target.kind must be "epsg" or "local".')


def build_geojson_document(
    workspace: Path,
    request: dict[str, Any],
) -> tuple[Any, int, list[dict[str, Any]], list[dict[str, Any]]]:
    source = workspace_path(workspace, request.get("sourcePath"), {".geojson", ".json"})
    data = json.loads(source.read_text(encoding="utf-8"))
    features = data.get("features")
    if data.get("type") != "FeatureCollection" or not isinstance(features, list) or not features:
        raise ValueError("GeoJSON must be a non-empty FeatureCollection.")
    if len(features) > MAX_ENTITY_COUNT:
        raise ValueError("GeoJSON has too many features.")
    target = request.get("target")
    if not isinstance(target, dict):
        raise ValueError("target is required.")
    transformer, normalized_target = target_transformer(target)
    rotation = float(normalized_target.get("rotationDeg", 0)) if normalized_target["kind"] == "local" else 0.0
    scale = float(normalized_target.get("scale", 1)) if normalized_target["kind"] == "local" else 1.0
    layer_map = request.get("layerMap")
    if not isinstance(layer_map, dict) or not layer_map:
        raise ValueError("layerMap is required.")
    layer_key = request.get("layerKey") or "kind"
    label_field = request.get("labelField")
    label_layer = request.get("labelLayer") or "LABEL"
    fill_layers = set(request.get("fillLayers") or [])
    warnings: list[dict[str, Any]] = []
    if request.get("template") not in (None, "none"):
        warnings.append(diag("cad.template_unavailable", "warning", "Template is not bundled in this engine build; drawing uses a blank R2013 document."))

    doc = ezdxf.new("R2013", setup=True)
    doc.header["$INSUNITS"] = 6
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    doc.header["$LUPREC"] = 3
    for layer in set(layer_map.values()) | {label_layer, "LABEL"}:
        add_layer(doc, str(layer))
    msp = doc.modelspace()
    entity_count = 0
    for feature in features:
        geometry = feature.get("geometry")
        if not geometry:
            continue
        properties = feature.get("properties") or {}
        layer = layer_map.get(str(properties.get(layer_key) or ""), "UNASSIGNED")
        if not isinstance(layer, str) or not LAYER_RE.match(layer):
            raise ValueError(f"Invalid layer name from layerMap: {layer!r}.")
        add_layer(doc, layer)
        geometry, geometry_warnings = normalize_geometry(geometry, bool(request.get("repairInvalid")))
        warnings.extend(geometry_warnings)
        transformed = transform_geometry(geometry, transformer)
        if rotation or scale != 1:
            transformed = rotate_scale_geometry(transformed, rotation, scale)
        entity_count += add_geometry(doc, msp, transformed, layer, properties, fill_layers, label_field, label_layer)
    if entity_count == 0 or len(msp) == 0:
        raise ValueError("No DXF entities were generated.")
    return doc, entity_count, warnings, [{"kind": "geojson", "path": relative_posix(source, workspace), "sha256": sha256_file(source)}]


def resolve_manifest(workspace: Path, file_id: str) -> dict[str, Any] | None:
    path = workspace / ".tau" / "cad-drawings" / file_id / "manifest.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("protocol") != CAD_DRAWING_PROTOCOL or data.get("version") != CAD_DRAWING_VERSION:
        return None
    return data


def resolve_drawing_path(workspace: Path, file_id: str, revision: int | None = None) -> tuple[Path, int]:
    manifest = resolve_manifest(workspace, file_id)
    if manifest:
        revisions = manifest.get("revisions")
        if isinstance(revisions, list):
            if revision is None:
                revision = int(manifest.get("currentRevision"))
            for item in revisions:
                if isinstance(item, dict) and item.get("revision") == revision:
                    path = workspace_path(workspace, item.get("path"), {".dxf"})
                    return path, int(revision)
    directory = workspace / "cad" / file_id
    candidates = []
    if directory.is_dir():
        for path in directory.glob("r*.dxf"):
            match = re.match(r"r(\d+)\.dxf$", path.name)
            if match:
                candidates.append((int(match.group(1)), path))
    if not candidates:
        raise ValueError(f"CAD drawing not found: {file_id}.")
    candidates.sort()
    if revision is None:
        revision = candidates[-1][0]
    for number, path in candidates:
        if number == revision:
            return workspace_path(workspace, relative_posix(path, workspace), {".dxf"}), number
    raise ValueError(f"CAD revision not found: {file_id} r{revision}.")


def resolve_input(workspace: Path, request: dict[str, Any]) -> tuple[Path, int | None]:
    if request.get("path") is not None:
        return workspace_path(workspace, request.get("path"), {".dxf"}), request.get("revision")
    file_id = request.get("fileId")
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise ValueError("fileId or path is required.")
    return resolve_drawing_path(workspace, file_id, request.get("revision"))


def entity_bbox(entity: Any) -> tuple[float, float, float, float] | None:
    try:
        box = bbox.extents([entity])
    except Exception:
        return None
    if not box.has_data:
        return None
    return float(box.extmin.x), float(box.extmin.y), float(box.extmax.x), float(box.extmax.y)


def selector_matches(entity: Any, selector: dict[str, Any] | None) -> bool:
    if not selector:
        return True
    kind = selector.get("kind")
    layer = selector.get("layer")
    entity_type = selector.get("entityType")
    if layer is not None and entity.dxf.layer != layer:
        return False
    if entity_type is not None and entity.dxftype() != entity_type:
        return False
    if kind == "handle":
        return str(entity.dxf.handle).upper() == str(selector.get("handle", "")).upper()
    if kind == "bounds":
        box = entity_bbox(entity)
        if box is None:
            return False
        min_x, min_y = selector.get("min", [0, 0])
        max_x, max_y = selector.get("max", [0, 0])
        return not (box[2] < min_x or box[0] > max_x or box[3] < min_y or box[1] > max_y)
    return True


def select_entities(msp: Any, selector: dict[str, Any] | None) -> list[Any]:
    selected = [entity for entity in list(msp) if selector_matches(entity, selector)]
    if len(selected) > MAX_MATCHED:
        raise ValueError(f"Selector matched {len(selected)} entities; limit is {MAX_MATCHED}.")
    return selected


def apply_operations(doc: Any, operations: list[dict[str, Any]]) -> dict[str, Any]:
    msp = doc.modelspace()
    matched_count = 0
    handles: list[str] = []
    would_create = 0
    would_modify = 0
    would_delete = 0
    for operation in operations:
        op = operation.get("op")
        if op in ("move", "copy", "delete", "setLayer"):
            selected = select_entities(msp, operation.get("selector"))
            matched_count += len(selected)
            handles.extend(str(entity.dxf.handle) for entity in selected if len(handles) < MAX_HANDLES)
            if op == "move":
                for entity in selected:
                    entity.translate(float(operation["dx"]), float(operation["dy"]), 0)
                would_modify += len(selected)
            elif op == "copy":
                count = int(operation.get("count", 1))
                for entity in selected:
                    for _ in range(count):
                        copied = entity.copy()
                        copied.translate(float(operation["dx"]), float(operation["dy"]), 0)
                        msp.add_entity(copied)
                        would_create += 1
            elif op == "delete":
                for entity in selected:
                    msp.delete_entity(entity)
                would_delete += len(selected)
            else:
                layer = operation.get("layer")
                if not isinstance(layer, str) or not LAYER_RE.match(layer):
                    raise ValueError("setLayer requires a valid layer name.")
                add_layer(doc, layer)
                for entity in selected:
                    entity.dxf.layer = layer
                would_modify += len(selected)
        elif op == "drawPolyline":
            layer = operation["layer"]
            add_layer(doc, layer)
            msp.add_lwpolyline(operation["points"], close=bool(operation.get("closed")), dxfattribs={"layer": layer})
            would_create += 1
        elif op == "drawText":
            layer = operation["layer"]
            add_layer(doc, layer)
            msp.add_text(
                operation["text"],
                height=float(operation["height"]),
                dxfattribs={"layer": layer, "style": text_style(doc)},
            ).set_placement(tuple(operation["position"]))
            would_create += 1
        elif op == "drawHatch":
            layer = operation["layer"]
            add_layer(doc, layer)
            hatch = msp.add_hatch(color=LAYER_COLORS.get(layer, 7), dxfattribs={"layer": layer})
            hatch.paths.add_polyline_path(operation["boundary"], is_closed=True)
            would_create += 1
        elif op == "insertBlock":
            layer = operation["layer"]
            add_layer(doc, layer)
            msp.add_blockref(operation["name"], tuple(operation["position"]), dxfattribs={"layer": layer})
            would_create += 1
        else:
            raise ValueError(f"Unsupported operation: {op}")
    return {
        "operationCount": len(operations),
        "matchedCount": matched_count,
        "sampleHandles": handles,
        "wouldCreate": would_create,
        "wouldModify": would_modify,
        "wouldDelete": would_delete,
    }


def check(
    checks: list[dict[str, Any]],
    diagnostics: list[dict[str, Any]],
    check_id: str,
    status: str,
    message: str,
    count: int | None = None,
    code: str | None = None,
) -> None:
    entry: dict[str, Any] = {"id": check_id, "status": status, "message": message}
    if count is not None:
        entry["count"] = count
    checks.append(entry)
    if status in ("warning", "fail") and code:
        diagnostics.append(diag(code, "error" if status == "fail" else "warning", message, **({"count": count} if count is not None else {})))


def verify_dxf(path: Path, policy: str = "traffic-v1") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    try:
        doc, auditor = recover.readfile(str(path))
    except Exception as error:  # noqa: BLE001
        check(checks, diagnostics, "reopen", "fail", f"Cannot reopen DXF: {error}", code="cad.reopen")
        return checks, diagnostics

    if auditor.has_errors:
        check(checks, diagnostics, "audit", "fail", f"DXF audit errors: {auditor.errors}", code="cad.audit")
    else:
        check(checks, diagnostics, "audit", "pass", "DXF audit passed.")

    code = units_code(doc)
    if code in (4, 6):
        check(checks, diagnostics, "units", "pass", f"$INSUNITS={code}.")
    else:
        check(checks, diagnostics, "units", "warning", f"$INSUNITS={code}; expected 4 (mm) or 6 (m).", code="cad.units")

    msp = doc.modelspace()
    entities = list(msp)
    if not entities and not list(doc.paperspace()):
        check(checks, diagnostics, "empty", "fail", "Modelspace and paperspace are empty.", code="cad.empty")
    else:
        check(checks, diagnostics, "empty", "pass", f"{len(entities)} modelspace entities.")

    layer0 = sum(1 for entity in entities if entity.dxf.layer == "0")
    if layer0:
        check(checks, diagnostics, "layer0", "warning", f"{layer0} entities are on layer 0.", count=layer0, code="cad.layer0")
    else:
        check(checks, diagnostics, "layer0", "pass", "No modelspace entities on layer 0.")

    closed_count = 0
    open_count = 0
    degenerate = 0
    unsupported = 0
    text_warning = 0
    signatures: dict[Any, int] = {}
    for entity in entities:
        kind = entity.dxftype()
        layer = entity.dxf.layer
        if kind == "LWPOLYLINE":
            points = [(float(x), float(y)) for x, y in entity.get_points("xy")]
            if len(points) < 2 or any(math.dist(points[index], points[index + 1]) < 1e-9 for index in range(len(points) - 1)):
                degenerate += 1
            if layer in CLOSED_LAYERS:
                if entity.closed:
                    closed_count += 1
                else:
                    check(checks, diagnostics, "closed", "fail", f"Boundary layer {layer} contains an open LWPOLYLINE.", code="cad.open_boundary", count=1)
            elif not entity.closed:
                open_count += 1
            signatures[("LWPOLYLINE", layer, tuple((round(x, 6), round(y, 6)) for x, y in points), bool(entity.closed))] = signatures.get(("LWPOLYLINE", layer, tuple((round(x, 6), round(y, 6)) for x, y in points), bool(entity.closed)), 0) + 1
        elif kind == "LINE":
            if math.dist((float(entity.dxf.start.x), float(entity.dxf.start.y)), (float(entity.dxf.end.x), float(entity.dxf.end.y))) < 1e-9:
                degenerate += 1
            start, end = entity.dxf.start, entity.dxf.end
            signatures[("LINE", layer, tuple(sorted([(round(float(start.x), 6), round(float(start.y), 6)), (round(float(end.x), 6), round(float(end.y), 6))])))] = signatures.get(("LINE", layer, tuple(sorted([(round(float(start.x), 6), round(float(start.y), 6)), (round(float(end.x), 6), round(float(end.y), 6))]))), 0) + 1
        elif kind == "POINT":
            location = entity.dxf.location
            signatures[("POINT", layer, (round(float(location.x), 6), round(float(location.y), 6)))] = signatures.get(("POINT", layer, (round(float(location.x), 6), round(float(location.y), 6))), 0) + 1
        elif kind == "HATCH":
            if layer in CLOSED_LAYERS:
                closed_count += 1
            continue
        elif kind in ("ACIS", "3DSOLID", "PROXY"):
            unsupported += 1
        elif kind in ("TEXT", "MTEXT"):
            height = getattr(entity.dxf, "height", None) or getattr(entity.dxf, "char_height", None)
            if height is not None and (float(height) < 1.5 or float(height) > 10):
                text_warning += 1
        elif layer in CLOSED_LAYERS:
            check(checks, diagnostics, "closed", "fail", f"Boundary layer {layer} contains {kind}.", code="cad.boundary_type", count=1)

    if closed_count:
        check(checks, diagnostics, "closed", "pass", f"{closed_count} closed boundary entities.")
    if open_count:
        status = "fail" if policy == "strict" else "warning"
        check(checks, diagnostics, "open", status, f"{open_count} open polylines outside boundary layers.", count=open_count, code="cad.open_contour")
    else:
        check(checks, diagnostics, "open", "pass", "No open polylines outside boundary layers.")

    if degenerate:
        check(checks, diagnostics, "degenerate", "fail", f"{degenerate} degenerate entities.", count=degenerate, code="cad.degenerate")
    else:
        check(checks, diagnostics, "degenerate", "pass", "No degenerate entities.")

    duplicates = sum(count - 1 for count in signatures.values() if count > 1)
    if duplicates:
        status = "fail" if policy == "strict" else "warning"
        check(checks, diagnostics, "duplicate", status, f"{duplicates} duplicate geometries.", count=duplicates, code="cad.duplicate")
    else:
        check(checks, diagnostics, "duplicate", "pass", "No duplicate geometries.")

    if unsupported:
        check(checks, diagnostics, "unsupported", "warning", f"{unsupported} unsupported ACIS/3DSOLID/PROXY entities.", count=unsupported, code="cad.unsupported_entity")
    else:
        check(checks, diagnostics, "unsupported", "pass", "No unsupported ACIS/3DSOLID/PROXY entities.")

    if text_warning:
        check(checks, diagnostics, "text", "warning", f"{text_warning} text entities have a suspicious height.", count=text_warning, code="cad.text_height")

    try:
        xrefs = list(doc.xrefs)
    except Exception:
        xrefs = []
    if xrefs:
        check(checks, diagnostics, "xref", "warning", f"{len(xrefs)} external references are present.", count=len(xrefs), code="cad.xref")
    else:
        check(checks, diagnostics, "xref", "pass", "No external references.")

    box = bbox.extents(msp)
    if not box.has_data:
        check(checks, diagnostics, "extents", "fail", "Drawing has no extents.", code="cad.extents")
    else:
        width = float(box.extmax.x - box.extmin.x)
        height = float(box.extmax.y - box.extmin.y)
        if width <= 0 or height <= 0:
            check(checks, diagnostics, "extents", "fail", "Drawing extents are zero.", code="cad.extents")
        elif width > 1e7 or height > 1e7:
            check(checks, diagnostics, "extents", "warning", "Drawing extents exceed 1e7.", code="cad.extents")
        else:
            check(checks, diagnostics, "extents", "pass", f"Extents {width:.2f} x {height:.2f}.")

    return checks, diagnostics


def document_summary(doc: Any) -> dict[str, Any]:
    msp = doc.modelspace()
    entities = list(msp)
    box = bbox.extents(msp)
    extents = None
    if box.has_data:
        extents = {
            "min": [float(box.extmin.x), float(box.extmin.y)],
            "max": [float(box.extmax.x), float(box.extmax.y)],
        }
    return {
        "units": units_name(units_code(doc)),
        "extents": extents,
        "layerCount": len({entity.dxf.layer for entity in entities}),
        "entityCount": len(entities),
        "blockCount": len(list(doc.blocks)),
        "sha256": None,
    }


def render_dxf(doc: Any, png: Path, pdf: Path) -> dict[str, Any]:
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


def save_document(doc: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    doc.saveas(str(temporary))
    os.replace(temporary, path)


def split_diagnostics(diagnostics: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    warnings = [item for item in diagnostics if item.get("severity") != "error"]
    errors = [item for item in diagnostics if item.get("severity") == "error"]
    return warnings, errors


def draw_result(
    workspace: Path,
    job_dir: Path,
    request: dict[str, Any],
    doc: Any,
    revision: int,
    file_id: str,
    title: str,
    plan: dict[str, Any],
    source_refs: list[dict[str, Any]] | None,
    dry_run: bool,
) -> dict[str, Any]:
    out_dir = job_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    temp_dxf = out_dir / f"r{revision}.dxf"
    save_document(doc, temp_dxf)
    checks, diagnostics = verify_dxf(temp_dxf, "traffic-v1")
    warnings, errors = split_diagnostics(diagnostics)
    summary = document_summary(doc)
    summary["sha256"] = sha256_file(temp_dxf)
    final_dxf = f"cad/{file_id}/r{revision}.dxf"
    result: dict[str, Any] = {
        "protocol": CAD_PROTOCOL,
        "version": CAD_VERSION,
        "ok": not errors,
        "dryRun": dry_run,
        "plan": plan,
        "checks": checks,
        "warnings": warnings,
        "diagnostics": diagnostics,
        **({"sourceRefs": source_refs} if source_refs else {}),
    }
    if dry_run:
        temp_dxf.unlink(missing_ok=True)
        return result

    png = out_dir / f"r{revision}.png"
    pdf = out_dir / f"r{revision}.pdf"
    try:
        preview = render_dxf(doc, png, pdf)
        result["preview"] = {
            "png": f"cad/{file_id}/r{revision}.png",
            "pdf": f"cad/{file_id}/r{revision}.pdf",
            **preview,
        }
    except Exception as error:  # noqa: BLE001
        warnings.append(diag("cad.render", "warning", str(error)))
        result["warnings"] = warnings

    result["drawing"] = {
        "fileId": file_id,
        "revision": revision,
        "path": final_dxf,
        "sha256": summary["sha256"],
        "bytes": temp_dxf.stat().st_size,
        "units": summary["units"] or "m",
        "extents": summary["extents"],
        "layerCount": summary["layerCount"],
        "entityCount": summary["entityCount"],
    }
    return result


def fail_draw(dry_run: bool, code: str, message: str) -> dict[str, Any]:
    return {
        "protocol": CAD_PROTOCOL,
        "version": CAD_VERSION,
        "ok": False,
        "dryRun": dry_run,
        "warnings": [],
        "diagnostics": [diag(code, "error", message)],
    }


def draw(workspace: Path, job_dir: Path, request: dict[str, Any]) -> dict[str, Any]:
    kind = request.get("kind")
    dry_run = bool(request.get("dryRun", False))
    if kind not in ("from-geojson", "edit", "import"):
        return fail_draw(dry_run, "cad.invalid_request", "draw request kind must be from-geojson, edit or import.")
    try:
        source_refs: list[dict[str, Any]] = []
        if kind == "from-geojson":
            file_id = request.get("fileId") or generated_file_id(request, request.get("sourcePath"))
            if not FILE_ID_RE.match(file_id):
                raise ValueError("Invalid fileId.")
            title = request.get("title") or file_id
            doc, _count, warnings, source_refs = build_geojson_document(workspace, request)
            plan = {"operationCount": 0, "matchedCount": 0, "sampleHandles": [], "wouldCreate": len(doc.modelspace()), "wouldModify": 0, "wouldDelete": 0}
            result = draw_result(workspace, job_dir, request, doc, 1, file_id, title, plan, source_refs, dry_run)
            result["warnings"] = warnings + result["warnings"]
            return result

        if kind == "import":
            file_id = request.get("fileId") or generated_file_id(request, request.get("sourcePath"))
            if not FILE_ID_RE.match(file_id):
                raise ValueError("Invalid fileId.")
            title = request.get("title") or file_id
            source = workspace_path(workspace, request.get("sourcePath"), {".dxf"})
            doc, auditor = recover.readfile(str(source))
            if auditor.has_errors:
                raise ValueError(f"Source DXF audit failed: {auditor.errors}")
            header_code = units_code(doc)
            requested_units = units_from_request(request.get("units"))
            if header_code == 0 and requested_units is None:
                raise ValueError("Source DXF has $INSUNITS=0; pass units explicitly.")
            if requested_units and header_code not in (0, 4, 6):
                raise ValueError("Source DXF has an unsupported $INSUNITS value.")
            if requested_units and header_code in (4, 6) and units_name(header_code) != requested_units:
                raise ValueError("Requested units do not match the source DXF header.")
            if header_code == 0 and requested_units:
                doc.header["$INSUNITS"] = 6 if requested_units == "m" else 4
            source_refs = [{"kind": "dxf", "path": relative_posix(source, workspace), "sha256": sha256_file(source)}]
            plan = {"operationCount": 0, "matchedCount": 0, "sampleHandles": [], "wouldCreate": 0, "wouldModify": 0, "wouldDelete": 0}
            return draw_result(workspace, job_dir, request, doc, 0, file_id, title, plan, source_refs, dry_run)

        file_id = request.get("fileId")
        if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
            raise ValueError("edit requires a valid fileId.")
        manifest = resolve_manifest(workspace, file_id)
        source, current_revision = resolve_drawing_path(workspace, file_id, None)
        base_revision = int(request.get("baseRevision", -1))
        if base_revision != current_revision:
            raise ValueError(f"Revision mismatch: current r{current_revision}, request r{base_revision}.")
        if manifest and int(manifest.get("currentRevision", -1)) != base_revision:
            raise ValueError("Revision mismatch against manifest.")
        doc, auditor = recover.readfile(str(source))
        if auditor.has_errors:
            raise ValueError(f"Source DXF audit failed: {auditor.errors}")
        header_units = units_name(units_code(doc))
        requested_units = units_from_request(request.get("units"))
        if header_units is None:
            if requested_units is None:
                raise ValueError("Source DXF has $INSUNITS=0; pass units explicitly.")
            doc.header["$INSUNITS"] = 6 if requested_units == "m" else 4
            header_units = requested_units
        elif requested_units and requested_units != header_units:
            raise ValueError("Requested units do not match the drawing header.")
        plan = apply_operations(doc, request.get("operations", []))
        return draw_result(workspace, job_dir, request, doc, base_revision + 1, file_id, request.get("title") or file_id, plan, None, dry_run)
    except Exception as error:  # noqa: BLE001
        return fail_draw(dry_run, "cad.invalid_request", str(error))


def generated_file_id(request: dict[str, Any], source_path: Any) -> str:
    title = request.get("title") or Path(str(source_path or "drawing")).stem
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", str(title)).strip("-")[:40] or "drawing"
    digest = hashlib.sha1(f"{source_path}:{time.time_ns()}".encode()).hexdigest()[:6]
    return f"cad_{slug}_{digest}"


def inspect_entities(workspace: Path, request: dict[str, Any]) -> dict[str, Any]:
    path, _revision = resolve_input(workspace, request)
    doc, auditor = recover.readfile(str(path))
    warnings: list[dict[str, Any]] = []
    if auditor.has_errors:
        warnings.append(diag("cad.audit", "warning", f"DXF audit errors: {auditor.errors}"))
    include = set(request.get("include") or ["summary"])
    msp = doc.modelspace()
    entities = list(msp)
    summary = document_summary(doc)
    summary["sha256"] = sha256_file(path)
    if summary["units"] is None:
        warnings.append(diag("cad.units", "warning", f"Unsupported $INSUNITS={units_code(doc)}."))
    result: dict[str, Any] = {
        "protocol": CAD_PROTOCOL,
        "version": CAD_VERSION,
        "summary": summary,
        "warnings": warnings,
    }
    selector = request.get("selector")
    filtered = [entity for entity in entities if selector_matches(entity, selector)] if selector else entities
    if "layers" in include:
        counts: dict[str, int] = {}
        for entity in entities:
            counts[entity.dxf.layer] = counts.get(entity.dxf.layer, 0) + 1
        result["layers"] = [
            {
                "name": layer.dxf.name,
                "entityCount": counts.get(layer.dxf.name, 0),
                "color": int(getattr(layer.dxf, "color", 7) or 7),
                "linetype": str(getattr(layer.dxf, "linetype", "CONTINUOUS") or "CONTINUOUS"),
            }
            for layer in doc.layers
        ]
    if "entities" in include:
        limit = min(int(request.get("limit", 500)), MAX_HANDLES)
        try:
            offset = int(request.get("cursor") or 0)
        except (TypeError, ValueError):
            offset = 0
        page = filtered[offset:offset + limit]
        records = []
        for entity in page:
            kind = entity.dxftype()
            if kind not in SUPPORTED_ENTITY_TYPES:
                warnings.append(diag("cad.unsupported_entity", "warning", f"Skipped unsupported entity type {kind}.", entityHandle=str(entity.dxf.handle)))
                continue
            record: dict[str, Any] = {
                "handle": str(entity.dxf.handle),
                "type": kind,
                "layer": entity.dxf.layer,
            }
            box = entity_bbox(entity)
            if box:
                record["bounds"] = {"min": [box[0], box[1]], "max": [box[2], box[3]]}
            if kind == "TEXT":
                record["text"] = str(entity.dxf.text)[:MAX_TEXT]
            elif kind == "MTEXT":
                record["text"] = str(entity.plain_text())[:MAX_TEXT]
            records.append(record)
        result["entities"] = records
        if offset + limit < len(filtered):
            result["nextCursor"] = str(offset + limit)
    if "blocks" in include:
        blocks = []
        for block in doc.blocks:
            if block.name.startswith("*"):
                continue
            blocks.append({"name": block.name, "entityCount": len(list(block))})
        result["blocks"] = blocks
    if "textStyles" in include:
        result["textStyles"] = [
            {"name": style.dxf.name, "font": str(getattr(style.dxf, "font", "txt") or "txt")}
            for style in doc.styles
        ]
    return result


def fail_inspect(code: str, message: str) -> dict[str, Any]:
    return {
        "protocol": CAD_PROTOCOL,
        "version": CAD_VERSION,
        "summary": {"units": None, "extents": None, "layerCount": 0, "entityCount": 0, "blockCount": 0},
        "warnings": [diag(code, "error", message)],
    }


def verify(workspace: Path, request: dict[str, Any]) -> dict[str, Any]:
    try:
        path, _revision = resolve_input(workspace, request)
        checks, diagnostics = verify_dxf(path, request.get("policy", "traffic-v1"))
        return {
            "protocol": CAD_PROTOCOL,
            "version": CAD_VERSION,
            "ok": not any(check_item["status"] == "fail" for check_item in checks),
            "checks": checks,
            "diagnostics": diagnostics,
        }
    except Exception as error:  # noqa: BLE001
        return {
            "protocol": CAD_PROTOCOL,
            "version": CAD_VERSION,
            "ok": False,
            "checks": [{"id": "reopen", "status": "fail", "message": str(error)}],
            "diagnostics": [diag("cad.reopen", "error", str(error))],
        }


def health() -> dict[str, Any]:
    try:
        import importlib.metadata as metadata
        return {
            "ok": True,
            "python": platform.python_version(),
            "ezdxf": metadata.version("ezdxf"),
            "pyproj": metadata.version("pyproj"),
            "matplotlib": metadata.version("matplotlib"),
        }
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "reason": str(error), "python": platform.python_version()}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--request")
    args = parser.parse_args()
    if args.health:
        emit(health())
        return 0
    if not args.request:
        emit({"protocol": CAD_ENGINE_PROTOCOL, "version": CAD_ENGINE_VERSION, "ok": False, "error": "Missing --request."})
        return 2
    try:
        envelope = json.loads(Path(args.request).read_text(encoding="utf-8"))
        if not isinstance(envelope, dict):
            raise ValueError("Request envelope must be an object.")
        if envelope.get("protocol") != CAD_ENGINE_PROTOCOL or envelope.get("version") != CAD_ENGINE_VERSION:
            raise ValueError("Unsupported engine protocol/version.")
        workspace = Path(envelope.get("workspaceRoot")).resolve()
        job_dir = safe_job_dir(workspace, envelope.get("jobDir"))
        action = envelope.get("action")
        request = envelope.get("request")
        if not isinstance(request, dict):
            raise ValueError("request must be an object.")
        if action == "draw":
            emit(draw(workspace, job_dir, request))
        elif action == "inspect":
            try:
                emit(inspect_entities(workspace, request))
            except Exception as error:  # noqa: BLE001
                emit(fail_inspect("cad.invalid_request", str(error)))
        elif action == "verify":
            emit(verify(workspace, request))
        else:
            raise ValueError(f"Unsupported action: {action}")
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"protocol": CAD_ENGINE_PROTOCOL, "version": CAD_ENGINE_VERSION, "ok": False, "error": str(error)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
