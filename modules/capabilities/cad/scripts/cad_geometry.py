"""Bounded 2D geometry observations; no file writes or drawing mutations."""
from __future__ import annotations

from typing import Any


def xy(value: Any) -> list[float]:
    return [float(value[0]), float(value[1])]


def entity_geometry(entity: Any, budget: int) -> tuple[dict[str, Any] | None, int, bool]:
    kind = entity.dxftype()
    dxf = entity.dxf
    if kind == "LINE":
        return {"kind": "line", "start": xy(dxf.start), "end": xy(dxf.end)}, 0, False
    if kind in ("LWPOLYLINE", "POLYLINE"):
        if kind == "LWPOLYLINE":
            count = len(entity)
        else:
            count = len(entity.vertices)
        if count > budget:
            return None, 0, True
        points = [xy(p) for p in entity.get_points("xy")] if kind == "LWPOLYLINE" else [xy(v.dxf.location) for v in entity.vertices]
        bulges = [float(p[0]) for p in entity.get_points("b")] if kind == "LWPOLYLINE" else [float(v.dxf.get("bulge", 0)) for v in entity.vertices]
        if not points:
            return None, 0, False
        return {"kind": "polyline", "points": points, "closed": bool(entity.is_closed), "bulges": bulges}, count, False
    if kind in ("CIRCLE", "ARC"):
        result = {"kind": kind.lower(), "center": xy(dxf.center), "radius": float(dxf.radius)}
        if kind == "ARC":
            result.update(startAngle=float(dxf.start_angle), endAngle=float(dxf.end_angle))
        return result, 0, False
    if kind in ("TEXT", "MTEXT"):
        rotation = float(entity.get_rotation()) if kind == "MTEXT" else float(dxf.get("rotation", 0))
        height = float(dxf.char_height) if kind == "MTEXT" else float(dxf.height)
        return {"kind": "text", "position": xy(dxf.insert), "height": height, "rotationDeg": rotation}, 0, False
    if kind == "POINT":
        return {"kind": "point", "position": xy(dxf.location)}, 0, False
    if kind == "INSERT":
        return {"kind": "insert", "name": str(dxf.name), "position": xy(dxf.insert), "rotationDeg": float(dxf.rotation), "scale": [float(dxf.xscale), float(dxf.yscale), float(dxf.zscale)]}, 0, False
    return None, 0, False
