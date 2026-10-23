from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from ezdxf import bbox


CAD_PROTOCOL = "tau-cad"
CAD_VERSION = "1.0"
CAD_ENGINE_PROTOCOL = "tau-cad-engine"
CAD_ENGINE_VERSION = "1.0"
CAD_DRAWING_PROTOCOL = "tau-cad-drawing"
CAD_DRAWING_VERSION = "1.0"

MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_ENTITY_COUNT = 20_000
MAX_MATCHED = 5_000
MAX_HANDLES = 500
MAX_TEXT = 500

FILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LAYER_RE = re.compile(r'^[^<>/\\":;?*|,=\x00-\x1f]{1,255}$')
EPSG_RE = re.compile(r"^EPSG:[0-9]{4,6}$")

SUPPORTED_ENTITY_TYPES = {
    "LINE", "LWPOLYLINE", "POLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT",
    "POINT", "INSERT", "HATCH",
}



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
        doc.layers.add(name, color=7)


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
    from cad_fonts import cjk_font
    if "CJK" not in doc.styles:
        doc.styles.add("CJK", font=cjk_font() or "sans-serif")
    return "CJK"


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
    raise ValueError(f"Committed CAD revision not found in manifest: {file_id} r{revision}.")


def resolve_input(workspace: Path, request: dict[str, Any]) -> tuple[Path, int | None]:
    if request.get("path") is not None:
        return workspace_path(workspace, request.get("path"), {".dxf"}), request.get("revision")
    file_id = request.get("fileId")
    if not isinstance(file_id, str) or not FILE_ID_RE.match(file_id):
        raise ValueError("fileId or path is required.")
    return resolve_drawing_path(workspace, file_id, request.get("revision"))


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


def save_document(doc: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    doc.saveas(str(temporary))
    os.replace(temporary, path)


def split_diagnostics(diagnostics: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    warnings = [item for item in diagnostics if item.get("severity") != "error"]
    errors = [item for item in diagnostics if item.get("severity") == "error"]
    return warnings, errors
