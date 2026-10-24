from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
from ezdxf import bbox
from ezdxf import recover
from shapely.geometry import Polygon
from cad_fonts import font_warning
from cad_io import diag, units_code, MAX_ENTITY_COUNT


def check(
    checks: list[dict[str, Any]],
    diagnostics: list[dict[str, Any]],
    check_id: str,
    status: str,
    message: str,
    count: int | None = None,
    code: str | None = None,
    handles: list[str] | None = None,
) -> None:
    entry: dict[str, Any] = {"id": check_id, "status": status, "message": message}
    if count is not None:
        entry["count"] = count
    checks.append(entry)
    if status in ("warning", "fail") and code:
        diagnostics.append(diag(code, "error" if status == "fail" else "warning", message, **({"count": count} if count is not None else {}), **({"details": {"entityHandles": handles[:100], "truncated": len(handles) > 100}} if handles else {})))


def verify_dxf(path: Path, policy: str = "basic") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    closed_layers = set(json.loads(Path(__file__).with_name("traffic-policy.json").read_text())["closedLayers"]) if policy == "traffic-v1" else set()
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
    signatures: dict[Any, list[str]] = {}
    invalid_boundaries: list[str] = []
    curved_boundaries = 0
    for entity in entities:
        kind = entity.dxftype()
        layer = entity.dxf.layer
        if kind == "LWPOLYLINE":
            points = [(float(x), float(y)) for x, y in entity.get_points("xy")]
            if len(points) < 2 or any(math.dist(points[index], points[index + 1]) < 1e-9 for index in range(len(points) - 1)):
                degenerate += 1
            if entity.closed:
                if any(abs(p[0]) > 1e-12 for p in entity.get_points("b")):
                    curved_boundaries += 1
                elif len(points) < 3 or not Polygon(points).is_valid:
                    invalid_boundaries.append(str(entity.dxf.handle))
            if layer in closed_layers:
                if entity.closed:
                    closed_count += 1
                else:
                    check(checks, diagnostics, "closed", "fail", f"Boundary layer {layer} contains an open LWPOLYLINE.", code="cad.open_boundary", count=1)
            elif not entity.closed:
                open_count += 1
            signatures.setdefault(("LWPOLYLINE", layer, tuple((round(x, 6), round(y, 6)) for x, y in points), bool(entity.closed)), []).append(str(entity.dxf.handle))
        elif kind == "LINE":
            if math.dist((float(entity.dxf.start.x), float(entity.dxf.start.y)), (float(entity.dxf.end.x), float(entity.dxf.end.y))) < 1e-9:
                degenerate += 1
            start, end = entity.dxf.start, entity.dxf.end
            signatures.setdefault(("LINE", layer, tuple(sorted([(round(float(start.x), 6), round(float(start.y), 6)), (round(float(end.x), 6), round(float(end.y), 6))]))), []).append(str(entity.dxf.handle))
        elif kind == "POINT":
            location = entity.dxf.location
            signatures.setdefault(("POINT", layer, (round(float(location.x), 6), round(float(location.y), 6))), []).append(str(entity.dxf.handle))
        elif kind == "HATCH":
            if layer in closed_layers:
                closed_count += 1
            continue
        elif kind in ("ACIS", "3DSOLID", "PROXY"):
            unsupported += 1
        elif kind in ("TEXT", "MTEXT"):
            height = getattr(entity.dxf, "height", None) or getattr(entity.dxf, "char_height", None)
            if height is not None and (float(height) < 1.5 or float(height) > 10):
                text_warning += 1
        elif layer in closed_layers:
            check(checks, diagnostics, "closed", "fail", f"Boundary layer {layer} contains {kind}.", code="cad.boundary_type", count=1)

    if closed_count:
        check(checks, diagnostics, "closed", "pass", f"{closed_count} closed boundary entities.")
    if open_count:
        status = "warning"
        check(checks, diagnostics, "open", status, f"{open_count} open polylines outside boundary layers.", count=open_count, code="cad.open_contour")
    else:
        check(checks, diagnostics, "open", "pass", "No open polylines outside boundary layers.")

    if degenerate:
        check(checks, diagnostics, "degenerate", "fail", f"{degenerate} degenerate entities.", count=degenerate, code="cad.degenerate")
    else:
        check(checks, diagnostics, "degenerate", "pass", "No degenerate entities.")

    duplicates = sum(len(handles) - 1 for handles in signatures.values() if len(handles) > 1)
    duplicate_handles = [handle for group in signatures.values() if len(group) > 1 for handle in group]
    if duplicates:
        status = "fail" if policy == "strict" else "warning"
        check(checks, diagnostics, "duplicate", status, f"{duplicates} duplicate geometries.", count=duplicates, code="cad.duplicate", handles=duplicate_handles)
    else:
        check(checks, diagnostics, "duplicate", "pass", "No duplicate geometries.")

    if unsupported:
        check(checks, diagnostics, "unsupported", "warning", f"{unsupported} unsupported ACIS/3DSOLID/PROXY entities.", count=unsupported, code="cad.unsupported_entity")
    else:
        check(checks, diagnostics, "unsupported", "pass", "No unsupported ACIS/3DSOLID/PROXY entities.")

    if text_warning:
        check(checks, diagnostics, "text", "warning", f"{text_warning} text entities have a suspicious height.", count=text_warning, code="cad.text_height")

    check(checks, diagnostics, "boundary_validity", "fail" if invalid_boundaries else "pass",
          f"{len(invalid_boundaries)} invalid straight closed polyline boundaries." if invalid_boundaries else "Straight closed polyline boundaries are valid.",
          count=len(invalid_boundaries), code="cad.invalid_boundary", handles=invalid_boundaries)
    if curved_boundaries:
        check(checks, diagnostics, "boundary_curves", "warning", "Curved polyline topology was not checked.", count=curved_boundaries, code="cad.topology_not_checked")
    xrefs = [block.name for block in doc.blocks if block.block.is_xref]
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
        if width <= 0 and height <= 0:
            check(checks, diagnostics, "extents", "fail", "Drawing extents are zero.", code="cad.extents")
        elif width > 1e7 or height > 1e7:
            check(checks, diagnostics, "extents", "warning", "Drawing extents exceed 1e7.", code="cad.extents")
        else:
            check(checks, diagnostics, "extents", "pass", f"Extents {width:.2f} x {height:.2f}.")

    missing_font = font_warning(doc)
    if missing_font:
        check(checks, diagnostics, "font", "warning", missing_font, code="cad.font")
    return checks, diagnostics


def validate_commit(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Only storage integrity is mandatory; domain checks remain explicit."""
    doc, auditor = recover.readfile(str(path))
    checks: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    check(checks, diagnostics, "audit", "fail" if auditor.has_errors else "pass",
          "DXF audit failed." if auditor.has_errors else "DXF audit passed.", code="cad.audit")
    if len(doc.modelspace()) > MAX_ENTITY_COUNT:
        check(checks, diagnostics, "size", "fail", "Entity count exceeds the CAD limit.", code="cad.too_large")
    missing_font = font_warning(doc)
    if missing_font:
        check(checks, diagnostics, "font", "warning", missing_font, code="cad.font")
    return checks, diagnostics
