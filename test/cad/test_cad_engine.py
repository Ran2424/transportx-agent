from __future__ import annotations

import json
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import ezdxf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENGINE = ROOT / "modules" / "capabilities" / "cad" / "scripts" / "cad_engine.py"
FIXTURES = HERE / "fixtures"


class CadEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tau_cad_engine_")
        self.workspace = Path(self.temp.name)
        (self.workspace / "input").mkdir()
        (self.workspace / ".tau" / "cad-jobs").mkdir(parents=True)
        shutil.copyfile(FIXTURES / "01_centerline_buffer.geojson", self.workspace / "input" / "01.geojson")
        shutil.copyfile(FIXTURES / "08_layer_edit.geojson", self.workspace / "input" / "08.geojson")
        shutil.copyfile(FIXTURES / "10_units_missing.dxf", self.workspace / "input" / "units_missing.dxf")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def commit(self, job_name: str, file_id: str, revision: int) -> None:
        source = self.workspace / ".tau" / "cad-jobs" / job_name / "out" / f"r{revision}.dxf"
        target = self.workspace / "cad" / file_id / f"r{revision}.dxf"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        manifest_path = self.workspace / '.tau' / 'cad-drawings' / file_id / 'manifest.json'
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps({'protocol': 'tau-cad-drawing', 'version': '1.0', 'currentRevision': revision, 'revisions': [{'revision': revision, 'path': target.relative_to(self.workspace).as_posix(), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}]}), encoding='utf-8')

    def run_engine(self, action: str, request: dict, job_name: str = "job") -> dict:
        job_dir = self.workspace / ".tau" / "cad-jobs" / job_name
        job_dir.mkdir(parents=True, exist_ok=True)
        envelope = {
            "protocol": "tau-cad-engine",
            "version": "1.0",
            "action": action,
            "workspaceRoot": str(self.workspace),
            "jobDir": str(job_dir),
            "request": request,
        }
        request_path = job_dir / "request.json"
        request_path.write_text(json.dumps(envelope, ensure_ascii=False), encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(ENGINE), "--request", str(request_path)],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_health(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ENGINE), "--health"],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["ezdxf"], "1.4.5")

    def test_from_geojson_draw_and_dry_run(self) -> None:
        request = {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "from-geojson",
            "sourceCrs": "EPSG:4326",
            "fileId": "junction_plan",
            "exportPreview": True,
            "sourcePath": "input/01.geojson",
            "target": {"kind": "epsg", "code": "EPSG:32651"},
            "layerMap": {"roads": "ROAD-CENTERLINE", "buffers": "LANDUSE-300"},
            "dryRun": False,
        }
        result = self.run_engine("draw", request, "draw")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["drawing"]["revision"], 1)
        self.assertEqual(result["drawing"]["units"], "m")
        self.assertTrue((self.workspace / ".tau" / "cad-jobs" / "draw" / "out" / "r1.dxf").is_file())
        self.assertTrue((self.workspace / ".tau" / "cad-jobs" / "draw" / "out" / "r1.png").is_file())
        self.assertTrue((self.workspace / ".tau" / "cad-jobs" / "draw" / "out" / "r1.pdf").is_file())

        dry = self.run_engine("draw", {**request, "dryRun": True}, "dry")
        self.assertTrue(dry["ok"], dry)
        self.assertTrue(dry["dryRun"])
        self.assertIn("plan", dry)
        self.assertNotIn("drawing", dry)
        self.assertFalse((self.workspace / ".tau" / "cad-jobs" / "dry" / "out" / "r1.dxf").exists())

    def test_local_target(self) -> None:
        result = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "from-geojson",
            "sourceCrs": "EPSG:4326",
            "fileId": "local_plan",
            "sourcePath": "input/01.geojson",
            "target": {"kind": "local", "origin": [121.47, 31.23], "rotationDeg": 90, "scale": 1},
            "layerMap": {"roads": "ROAD-CENTERLINE", "buffers": "LANDUSE-300"},
            "dryRun": False,
        }, "local")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["drawing"]["units"], "m")
        self.assertIsNotNone(result["drawing"]["extents"])

    def test_rejects_path_escape_and_missing_units(self) -> None:
        escaped = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "from-geojson",
            "sourceCrs": "EPSG:4326",
            "sourcePath": "../secret.geojson",
            "target": {"kind": "epsg", "code": "EPSG:32651"},
            "layerMap": {"roads": "ROAD-CENTERLINE"},
        }, "escape")
        self.assertFalse(escaped["ok"])
        self.assertTrue(escaped["diagnostics"])

        missing = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "import",
            "sourcePath": "input/units_missing.dxf",
            "fileId": "units_missing",
        }, "missing")
        self.assertFalse(missing["ok"])
        self.assertIn("INSUNITS", " ".join(item["message"] for item in missing["diagnostics"]))

        imported = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "import",
            "sourcePath": "input/units_missing.dxf",
            "fileId": "units_missing",
            "units": "m",
        }, "imported")
        self.assertTrue(imported["ok"], imported)
        self.assertEqual(imported["drawing"]["revision"], 1)
        self.assertEqual(imported["drawing"]["units"], "m")

    def test_edit_inspect_and_verify(self) -> None:
        created = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "from-geojson",
            "sourceCrs": "EPSG:4326",
            "fileId": "edit_plan",
            "sourcePath": "input/08.geojson",
            "target": {"kind": "epsg", "code": "EPSG:32651"},
            "layerMap": {"roads": "ROAD-CENTERLINE", "markings": "MARKING", "signals": "SIGNAL"},
            "dryRun": False,
        }, "edit-create")
        self.assertTrue(created["ok"], created)
        self.commit("edit-create", "edit_plan", 1)

        edited = self.run_engine("draw", {
            "protocol": "tau-cad",
            "version": "1.0",
            "kind": "edit",
            "fileId": "edit_plan",
            "baseRevision": 1,
            "expectedSha256": hashlib.sha256((self.workspace / "cad/edit_plan/r1.dxf").read_bytes()).hexdigest(),
            "operations": [
                {"op": "move", "selector": {"kind": "layer", "layer": "SIGNAL"}, "dx": 2, "dy": 0},
                {"op": "copy", "selector": {"kind": "layer", "layer": "SIGNAL"}, "dx": 5, "dy": 0, "count": 1},
                {"op": "setLayer", "selector": {"kind": "layer", "layer": "MARKING"}, "layer": "MARKING-REVIEW"},
                {"op": "drawPolyline", "layer": "MARKING", "points": [[354240, 3456090], [354250, 3456090], [354250, 3456100]]},
                {"op": "drawText", "layer": "LABEL", "position": [354240, 3456090], "text": "测试", "height": 2.5},
                {"op": "drawHatch", "layer": "PAVEMENT", "boundary": [[354240, 3456090], [354250, 3456090], [354250, 3456100]]},
                {"op": "delete", "selector": {"kind": "layer", "layer": "ROAD-CENTERLINE"}},
            ],
            "dryRun": False,
        }, "edit")
        self.assertTrue(edited["ok"], edited)
        self.assertEqual(edited["drawing"]["revision"], 2)
        self.assertNotIn("preview", edited)
        self.assertFalse((self.workspace / ".tau/cad-jobs/edit/out/r2.png").exists())
        self.assertGreaterEqual(edited["plan"]["wouldModify"], 1)
        self.commit("edit", "edit_plan", 2)

        inspected = self.run_engine("inspect", {
            "protocol": "tau-cad",
            "version": "1.0",
            "fileId": "edit_plan",
            "include": ["summary", "layers", "entities"],
            "limit": 100,
        }, "inspect")
        self.assertEqual(inspected["summary"]["units"], "m")
        self.assertGreater(inspected["summary"]["entityCount"], 0)
        self.assertTrue(inspected["entities"])

        verified = self.run_engine("verify", {
            "protocol": "tau-cad",
            "version": "1.0",
            "fileId": "edit_plan",
            "policy": "traffic-v1",
        }, "verify")
        self.assertTrue(verified["ok"], verified)

    def test_explicit_source_crs_and_rotation(self) -> None:
        from pyproj import Transformer
        coordinates = [[121.44, 31.19], [121.441, 31.191]]
        forward = Transformer.from_crs('EPSG:4326', 'EPSG:32651', always_xy=True)
        projected = [list(forward.transform(*point)) for point in coordinates]
        def collection(points):
            return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'kind': 'signal'}, 'geometry': {'type': 'Point', 'coordinates': point}} for point in points]}
        path = self.workspace / 'input' / 'projected.geojson'
        path.write_text(json.dumps(collection(projected)), encoding='utf-8')
        request = {'protocol': 'tau-cad', 'version': '1.0', 'kind': 'from-geojson', 'fileId': 'projected', 'sourcePath': 'input/projected.geojson', 'sourceCrs': 'EPSG:32651', 'target': {'kind': 'epsg', 'code': 'EPSG:32651'}, 'layerMap': {'signal': 'SIGNAL'}}
        result = self.run_engine('draw', request, 'projected')
        self.assertTrue(result['ok'], result)
        self.assertAlmostEqual(result['drawing']['extents']['min'][0], min(point[0] for point in projected), places=5)
        self.assertFalse(self.run_engine('draw', {**request, 'sourceCrs': 'EPSG:4326'}, 'wrong-crs')['ok'])
        self.assertFalse(self.run_engine('draw', {key: value for key, value in request.items() if key != 'sourceCrs'}, 'missing-crs')['ok'])
        path.write_text(json.dumps(collection(coordinates)), encoding='utf-8')
        normal = self.run_engine('draw', {**request, 'sourceCrs': 'EPSG:4326', 'target': {'kind': 'local', 'origin': coordinates[0]}}, 'normal')
        rotated = self.run_engine('draw', {**request, 'sourceCrs': 'EPSG:4326', 'target': {'kind': 'local', 'origin': coordinates[0], 'rotationDeg': 90, 'scale': 2}}, 'rotated')
        self.assertTrue(normal['ok'], normal)
        self.assertTrue(rotated['ok'], rotated)
        normal_doc = ezdxf.readfile(self.workspace / '.tau/cad-jobs/normal/out/r1.dxf')
        rotated_doc = ezdxf.readfile(self.workspace / '.tau/cad-jobs/rotated/out/r1.dxf')
        x, y, _ = list(normal_doc.modelspace())[1].dxf.location
        rx, ry, _ = list(rotated_doc.modelspace())[1].dxf.location
        self.assertAlmostEqual(rx, -2 * y, places=5)
        self.assertAlmostEqual(ry, 2 * x, places=5)

    def test_verify_rejects_open_boundary(self) -> None:
        doc = ezdxf.new("R2013", setup=False)
        doc.header["$INSUNITS"] = 6
        doc.layers.add("WORKZONE")
        doc.modelspace().add_lwpolyline([(0, 0), (10, 0), (10, 10)], close=False, dxfattribs={"layer": "WORKZONE"})
        broken = self.workspace / "input" / "broken.dxf"
        doc.saveas(str(broken))

        verified = self.run_engine("verify", {
            "protocol": "tau-cad",
            "version": "1.0",
            "path": "input/broken.dxf",
            "policy": "traffic-v1",
        }, "broken")
        self.assertFalse(verified["ok"], verified)
        self.assertTrue(any(item["id"] == "closed" and item["status"] == "fail" for item in verified["checks"]))


if __name__ == "__main__":
    unittest.main()
