from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
from typing import Iterable
import ezdxf
from pyproj import CRS
from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import mapping
from shapely.geometry import shape
from cad_io import diag, sha256_file, relative_posix, workspace_path, add_layer, text_style, MAX_ENTITY_COUNT, MAX_TEXT, LAYER_RE, EPSG_RE
from cad_checks import check


def transform_coords(value: Any, transformer: Transformer) -> Any:
    if isinstance(value, list) and value and isinstance(value[0], (int, float)):
        result = list(transformer.transform(float(value[0]), float(value[1]), errcheck=True))
        if not all(math.isfinite(v) and abs(v) <= 1e8 for v in result):
            raise ValueError('Transformed coordinates exceed the supported finite range.')
        return result
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
    label = properties.get(label_field) if label_field else None
    style = text_style(doc) if label else "Standard"
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
                hatch = msp.add_hatch(color=7, dxfattribs={"layer": layer})
                hatch.paths.add_polyline_path(ring, is_closed=True)
            if label:
                x, y = ring[0]
                msp.add_text(str(label)[:MAX_TEXT], height=2.5, dxfattribs={"layer": label_layer, "style": style}).set_placement((x + 1.0, y + 1.0))
            count += 1
        else:
            raise ValueError(f"Unsupported geometry type: {kind}")
    return count


def target_transformer(target: dict[str, Any], source_crs: CRS) -> tuple[Transformer, dict[str, Any]]:
    if target.get("kind") == "epsg":
        code = target.get("code")
        if not isinstance(code, str) or not EPSG_RE.match(code):
            raise ValueError("target.code must look like EPSG:32651.")
        crs = CRS.from_user_input(code)
        if not crs.is_projected or any(abs(axis.unit_conversion_factor - 1.0) > 1e-9 for axis in crs.axis_info[:2]):
            raise ValueError("target EPSG must use metres; feet or degrees are not supported.")
        return Transformer.from_crs(source_crs, code, always_xy=True), {"kind": "epsg", "code": code}
    if target.get("kind") == "local":
        origin = target.get("origin")
        if not isinstance(origin, list) or len(origin) != 2 or not all(isinstance(item, (int, float)) for item in origin):
            raise ValueError("local target requires origin [lng, lat].")
        lng, lat = float(origin[0]), float(origin[1])
        rotation = float(target.get("rotationDeg", 0))
        scale = float(target.get("scale", 1))
        if not (-180 <= lng <= 180 and -90 <= lat <= 90) or not math.isfinite(rotation) or not math.isfinite(scale) or scale <= 0:
            raise ValueError("local target requires finite rotationDeg and scale > 0.")
        proj = f"+proj=aeqd +lat_0={lat} +lon_0={lng} +units=m +datum=WGS84"
        return Transformer.from_crs(source_crs, proj, always_xy=True), {
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
    if not isinstance(request.get('sourceCrs'), str) or not request['sourceCrs'].strip():
        raise ValueError('from-geojson requires explicit sourceCrs.')
    source_crs = CRS.from_user_input(request['sourceCrs'])
    embedded_crs = data.get('crs', {}).get('properties', {}).get('name') if isinstance(data.get('crs'), dict) else None
    if embedded_crs and not source_crs.equals(CRS.from_user_input(embedded_crs), ignore_axis_order=True):
        raise ValueError('GeoJSON CRS differs from declared sourceCrs.')
    transformer, normalized_target = target_transformer(target, source_crs)
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
        if source_crs.is_geographic:
            bounds = shape(geometry).bounds
            if bounds and not (-180 <= bounds[0] <= bounds[2] <= 180 and -90 <= bounds[1] <= bounds[3] <= 90):
                raise ValueError('Geographic input must use longitude/latitude degrees; check sourceCrs.')
        transformed = transform_geometry(geometry, transformer)
        if rotation or scale != 1:
            transformed = rotate_scale_geometry(transformed, rotation, scale)
        entity_count += add_geometry(doc, msp, transformed, layer, properties, fill_layers, label_field, label_layer)
    if entity_count == 0 or len(msp) == 0:
        raise ValueError("No DXF entities were generated.")
    return doc, entity_count, warnings, [{"kind": "geojson", "path": relative_posix(source, workspace), "sha256": sha256_file(source)}]
