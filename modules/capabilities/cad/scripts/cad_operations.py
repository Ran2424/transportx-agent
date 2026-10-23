from __future__ import annotations

from typing import Any
from ezdxf import bbox
from cad_io import add_layer, text_style, MAX_MATCHED, MAX_HANDLES, LAYER_RE


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
            hatch = msp.add_hatch(color=7, dxfattribs={"layer": layer})
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
