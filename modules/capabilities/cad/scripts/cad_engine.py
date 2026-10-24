#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import time
from pathlib import Path
from typing import Any
import ezdxf
from ezdxf import recover
from cad_io import diag, sha256_file, relative_posix, workspace_path, safe_job_dir, units_code, units_name, units_from_request, resolve_manifest, resolve_drawing_path, resolve_input, document_summary, save_document, split_diagnostics, CAD_PROTOCOL, CAD_VERSION, CAD_ENGINE_PROTOCOL, CAD_ENGINE_VERSION, MAX_HANDLES, MAX_TEXT, FILE_ID_RE, SUPPORTED_ENTITY_TYPES
from cad_projection import build_geojson_document
from cad_geometry import entity_geometry
from cad_operations import entity_bbox, selector_matches, apply_operations
from cad_checks import verify_dxf, validate_commit
from cad_render import render_dxf


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
    checks, diagnostics = validate_commit(temp_dxf)
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

    if request.get("exportPreview", False):
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
    if kind not in ("from-geojson", "edit", "import", "commit-candidate"):
        return fail_draw(dry_run, "cad.invalid_request", "draw request kind must be from-geojson, edit, import or commit-candidate.")
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
            return draw_result(workspace, job_dir, request, doc, 1, file_id, title, plan, source_refs, dry_run)

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
        if request.get('expectedSha256') != sha256_file(source):
            raise ValueError('Exact base DXF expectedSha256 is required and must match.')
        if kind == "commit-candidate":
            base_doc = ezdxf.readfile(str(source))
            source = workspace_path(workspace, request.get("sourcePath"), {".dxf"})
            doc, auditor = recover.readfile(str(source))
            if auditor.has_errors:
                raise ValueError(f"Candidate DXF audit failed: {auditor.errors}")
            if units_code(doc) != units_code(base_doc) or units_code(doc) not in (4, 6):
                raise ValueError("Candidate units must match the current drawing; convert geometry explicitly before submission.")
            source_refs = [{"kind": "dxf", "path": relative_posix(source, workspace), "sha256": sha256_file(source)}]
            plan = {"operationCount": 1, "matchedCount": 0, "sampleHandles": [], "wouldCreate": len(doc.modelspace()), "wouldModify": 0, "wouldDelete": len(base_doc.modelspace())}
            return draw_result(workspace, job_dir, request, doc, base_revision + 1, file_id, file_id, plan, source_refs, dry_run)

        doc, auditor = recover.readfile(str(source))
        if auditor.has_errors:
            raise ValueError(f"Source DXF audit failed: {auditor.errors}")
        if units_code(doc) not in (0, 4, 6):
            raise ValueError("Drawing units are unsupported; explicit unit conversion is required before editing.")
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
    if "selectionHandles" in request:
        handles = set(request["selectionHandles"])
        filtered = [entity for entity in filtered if str(entity.dxf.handle) in handles]
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
    if "entities" in include or "geometry" in include:
        limit = min(int(request.get("limit", 500)), MAX_HANDLES)
        try:
            offset = int(request.get("cursor") or 0)
        except (TypeError, ValueError):
            offset = 0
        page = filtered[offset:offset + limit]
        records = []
        point_budget = 10_000
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
            if "geometry" in include:
                geometry, used, truncated = entity_geometry(entity, point_budget)
                point_budget -= used
                if geometry is not None:
                    record["geometry"] = geometry
                if truncated:
                    record["geometryTruncated"] = True
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


def verify(workspace: Path, job_dir: Path, request: dict[str, Any]) -> dict[str, Any]:
    try:
        path, _revision = resolve_input(workspace, request)
        checks, diagnostics = verify_dxf(path, request.get("policy", "basic"))
        preview = None
        if request.get("exportPreview", False):
            out = job_dir / "out"
            out.mkdir(parents=True, exist_ok=True)
            try:
                doc, _auditor = recover.readfile(str(path))
                rendered = render_dxf(doc, out / "preview.png", out / "preview.pdf", request.get("previewOptions"))
                digest = request.get("_previewKey") or sha256_file(path)
                if not re.fullmatch(r"[a-f0-9]{64}(?:_[a-f0-9]{16})?", digest):
                    raise ValueError("Invalid preview identity.")
                preview = {"png": f"cad/previews/{digest}.png", "pdf": f"cad/previews/{digest}.pdf", **rendered}
            except Exception as error:
                diagnostics.append(diag("cad.render", "warning", str(error)))
        return {
            **({"preview": preview} if preview else {}),
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
            emit(verify(workspace, job_dir, request))
        else:
            raise ValueError(f"Unsupported action: {action}")
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"protocol": CAD_ENGINE_PROTOCOL, "version": CAD_ENGINE_VERSION, "ok": False, "error": str(error)})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
