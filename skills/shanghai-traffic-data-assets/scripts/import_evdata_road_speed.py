#!/usr/bin/env python3
"""Import or replace user-provided EVDATA road geometry and 15-minute speeds."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path


ASSET_VERSION = "3.2.0"
CANONICAL_CRS = "EPSG:4326"
SPEED_UNIT = "km/h"
EXPECTED_CSV_COLUMNS = {
    ("t.roadid", "t.time_num", "t.speed_avg"),
    ("t.date", "t.roadid", "t.time_num", "t.speed_avg"),
}
HIGH_SPEED_WARNING_THRESHOLD = 120.0
DEFAULT_DB_DIR = Path(__file__).resolve().parents[1] / "assets" / "databases"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def geometry_points(geometry: dict[str, object]) -> list[tuple[float, float]]:
    if geometry.get("type") != "MultiLineString":
        raise ValueError(f"Expected MultiLineString, got {geometry.get('type')!r}")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        raise ValueError("Road geometry has no coordinates")
    points: list[tuple[float, float]] = []
    for line in coordinates:
        if not isinstance(line, list) or len(line) < 2:
            raise ValueError("Each road geometry part must contain at least two points")
        for point in line:
            if not isinstance(point, list) or len(point) < 2:
                raise ValueError("Invalid road coordinate")
            lon, lat = float(point[0]), float(point[1])
            if not (math.isfinite(lon) and math.isfinite(lat)):
                raise ValueError("Non-finite road coordinate")
            points.append((lon, lat))
    return points


def load_segments(path: Path) -> list[tuple[object, ...]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("type") != "FeatureCollection":
        raise ValueError("GeoJSON must be a FeatureCollection")
    crs_name = document.get("crs", {}).get("properties", {}).get("name")
    if crs_name != "urn:ogc:def:crs:OGC:1.3:CRS84":
        raise ValueError(f"Expected CRS84 GeoJSON, got {crs_name!r}")

    rows: list[tuple[object, ...]] = []
    seen_ids: set[int] = set()
    for feature_number, feature in enumerate(document.get("features", []), start=1):
        properties = feature.get("properties") or {}
        road_id = int(properties["id"])
        if road_id in seen_ids:
            raise ValueError(f"Duplicate GeoJSON road id: {road_id}")
        seen_ids.add(road_id)
        geometry = feature.get("geometry") or {}
        points = geometry_points(geometry)
        lons = [point[0] for point in points]
        lats = [point[1] for point in points]
        rows.append(
            (
                road_id,
                properties.get("name"),
                json.dumps(geometry, ensure_ascii=False, separators=(",", ":")),
                geometry["type"],
                CANONICAL_CRS,
                min(lons),
                min(lats),
                max(lons),
                max(lats),
                feature_number,
                "evdata_road_segment_geojson",
            )
        )
    if not rows:
        raise ValueError("GeoJSON contains no features")
    return rows


def load_speed_rows(path: Path) -> list[tuple[object, ...]]:
    rows: list[tuple[object, ...]] = []
    seen_keys: set[tuple[int, str]] = set()
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        columns = tuple(reader.fieldnames or ())
        if columns not in EXPECTED_CSV_COLUMNS:
            raise ValueError(f"Expected CSV columns {EXPECTED_CSV_COLUMNS}, got {reader.fieldnames}")
        for source_record_number, record in enumerate(reader, start=2):
            road_id = int(record["t.roadid"])
            observed = datetime.strptime(record["t.time_num"].strip(), "%Y/%m/%d %H:%M")
            if "t.date" in record and record["t.date"].strip() != observed.strftime("%Y%m%d"):
                raise ValueError(f"t.date does not match t.time_num at CSV row {source_record_number}")
            if observed.minute not in (0, 15, 30, 45) or observed.second:
                raise ValueError(f"Timestamp is not aligned to 15 minutes at CSV row {source_record_number}")
            speed = float(record["t.speed_avg"])
            if not math.isfinite(speed) or speed < 0:
                raise ValueError(f"Invalid speed at CSV row {source_record_number}: {speed}")
            observed_at = observed.strftime("%Y-%m-%d %H:%M:%S")
            key = (road_id, observed_at)
            if key in seen_keys:
                raise ValueError(f"Duplicate road/time key at CSV row {source_record_number}: {key}")
            seen_keys.add(key)
            rows.append(
                (
                    road_id,
                    observed_at,
                    int(observed.strftime("%Y%m%d")),
                    observed.hour * 60 + observed.minute,
                    speed,
                    SPEED_UNIT,
                    "WARN_HIGH_SPEED" if speed > HIGH_SPEED_WARNING_THRESHOLD else "OK",
                    source_record_number,
                    "evdata_road_speed_csv",
                )
            )
    if not rows:
        raise ValueError("CSV contains no data rows")
    return rows


def refresh_catalog(
    conn: sqlite3.Connection,
    csv_path: Path,
    geojson_path: Path | None,
    segments: list[tuple[object, ...]],
    speeds: list[tuple[object, ...]],
) -> None:
    table_descriptions = {
        "dim_evdata_road_segment": ("table", "dim", len(segments), "EVDATA道路路段维度及WGS84几何。"),
        "std_evdata_road_speed_15m": (
            "table",
            "std",
            len(speeds),
            "EVDATA路段15分钟平均速度标准层；保留高值警告记录。",
        ),
        "fact_evdata_road_speed_15m": (
            "view",
            "fact",
            len(speeds),
            f"EVDATA路段15分钟平均速度事实视图；速度单位为{SPEED_UNIT}。",
        ),
    }
    for table_name, (object_type, layer, row_count, description) in table_descriptions.items():
        conn.execute(
            "INSERT OR REPLACE INTO catalog.meta_table VALUES (?, ?, ?, ?, ?, ?)",
            ("road", table_name, object_type, layer, row_count, description),
        )
        conn.execute(
            "DELETE FROM catalog.meta_column WHERE database_name='road' AND table_name=?",
            (table_name,),
        )
        columns = conn.execute(f"PRAGMA main.table_info({table_name})").fetchall()
        conn.executemany(
            "INSERT INTO catalog.meta_column VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("road", table_name, cid + 1, name, declared_type, not_null, int(pk > 0))
                for cid, name, declared_type, not_null, _default, pk in columns
            ],
        )

    if geojson_path is not None:
        conn.execute(
            "INSERT OR REPLACE INTO catalog.meta_source_dataset VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "evdata_road_segment_geojson",
                geojson_path.name,
                "ROAD",
                "一个EVDATA路段",
                len(segments),
                "road",
                "dim_evdata_road_segment",
                "CRS84按EPSG:4326发布；保留MultiLineString几何和来源名称。",
            ),
        )
    conn.execute(
        "INSERT OR REPLACE INTO catalog.meta_source_dataset VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "evdata_road_speed_csv",
            csv_path.name,
            "ROAD",
            "路段-15分钟时刻",
            len(speeds),
            "road",
            "std_evdata_road_speed_15m",
            f"时间规范为Asia/Shanghai；源字段speed_avg原值保留，单位为{SPEED_UNIT}。",
        ),
    )
    conn.execute(
        "INSERT OR REPLACE INTO catalog.meta_relationship VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "evdata_speed_segment",
            "road.fact_evdata_road_speed_15m",
            "road_id",
            "road.dim_evdata_road_segment",
            "road_id",
            "N:1",
            "EVDATA路段ID完全匹配。",
        ),
    )
    conn.execute(
        "INSERT INTO catalog.meta_entity_id VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(entity_code) DO UPDATE SET domain_code=excluded.domain_code, "
        "entity_name_cn=excluded.entity_name_cn, canonical_object=excluded.canonical_object, "
        "canonical_id_column=excluded.canonical_id_column, id_scope=excluded.id_scope, "
        "source_id_policy=excluded.source_id_policy",
        (
            "EVDATA_ROAD_SEGMENT",
            "ROAD",
            "EVDATA道路路段",
            "road.dim_evdata_road_segment",
            "road_id",
            "EVDATA",
            "保留EVDATA源roadid；不与原道路状态发布段强行合并。",
        ),
    )
    conn.execute("DELETE FROM catalog.meta_id_mapping WHERE entity_code='EVDATA_ROAD_SEGMENT'")
    next_mapping_id = conn.execute("SELECT COALESCE(MAX(mapping_id), 0) FROM catalog.meta_id_mapping").fetchone()[0] + 1
    conn.executemany(
        "INSERT INTO catalog.meta_id_mapping VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                next_mapping_id + offset,
                "EVDATA_ROAD_SEGMENT",
                "EVDATA",
                str(segment[0]),
                "",
                str(segment[0]),
                "SOURCE_IDENTITY",
                1.0,
            )
            for offset, segment in enumerate(segments)
        ],
    )
    conn.execute(
        "INSERT OR REPLACE INTO catalog.meta_metric VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "EVDATA_ROAD_SPEED_AVG",
            "EVDATA路段平均速度",
            "ROAD",
            "路段-15分钟时刻",
            SPEED_UNIT,
            f"源字段t.speed_avg的原值；用户确认单位为{SPEED_UNIT}。",
            "road.fact_evdata_road_speed_15m",
            "speed_avg",
        ),
    )
    conn.execute(
        "INSERT OR REPLACE INTO catalog.meta_query_example VALUES (?, ?, ?, ?)",
        (
            "evdata_event_window",
            "时代少年团演出周演前、演中和散场时段的EVDATA路段速度",
            "SELECT observed_at,road_id,speed_avg,speed_unit,quality_status "
            "FROM road.fact_evdata_road_speed_15m "
            "WHERE date_key IN (20250820,20250821,20250823,20250824) "
            "AND minute_key BETWEEN 900 AND 1439 "
            "ORDER BY observed_at,road_id",
            f"速度单位为{SPEED_UNIT}；高值警告记录保留；缺失时槽不补零。",
        ),
    )

    dates = [row[2] for row in speeds]
    conn.execute(
        "UPDATE catalog.meta_analysis_guide SET recommended_object=?, min_date_key=MIN(min_date_key, ?), "
        "max_date_key=MAX(max_date_key, ?), entity_coverage=?, spatial_scope=?, crs_policy=?, usage_note=? "
        "WHERE domain_code='ROAD'",
        (
            "road.mart_road_segment_hour / road.fact_evdata_road_speed_15m",
            min(dates),
            max(dates),
            f"89个状态发布段；{len(segments)}个EVDATA几何路段",
            "原状态发布段无几何；EVDATA路段覆盖上海体育场周边并提供MultiLineString几何",
            "EVDATA几何为EPSG:4326；原状态发布段无空间坐标",
            f"状态持续时间与EVDATA平均速度是两套独立口径；EVDATA速度单位为{SPEED_UNIT}。",
        ),
    )

    speed_ids = {int(row[0]) for row in speeds}
    dates = {int(row[2]) for row in speeds}
    speed_counts = Counter((int(row[0]), int(row[2])) for row in speeds)
    complete_road_days = sum(count == 96 for count in speed_counts.values())
    expected_road_days = len(segments) * len(dates)
    high_speed_count = sum(float(row[4]) > HIGH_SPEED_WARNING_THRESHOLD for row in speeds)
    quality_rows = [
        (
            "EVDATA_GEOMETRY_ID_COVERAGE",
            "ROAD",
            "ERROR",
            "CSV中的每个EVDATA roadid必须且只能匹配一个GeoJSON路段。",
            1,
            f"{len(speed_ids)}/{len(segments)}",
            "CSV与GeoJSON路段ID完全覆盖。",
        ),
        (
            "EVDATA_PRIMARY_KEY_UNIQUE",
            "ROAD",
            "ERROR",
            "EVDATA速度事实的路段-时刻组合必须唯一。",
            1,
            "0 duplicate keys",
            "未发现重复路段-时刻。",
        ),
        (
            "EVDATA_QUARTER_HOUR_ALIGNMENT",
            "ROAD",
            "ERROR",
            "EVDATA观测时间必须对齐15分钟边界。",
            1,
            f"{len(speeds)}/{len(speeds)}",
            "全部记录对齐00/15/30/45分钟。",
        ),
        (
            "EVDATA_DAILY_COMPLETENESS",
            "ROAD",
            "WARN",
            "每个EVDATA路段在单日应有96个15分钟时槽。",
            int(complete_road_days == expected_road_days),
            f"{complete_road_days}/{expected_road_days} complete road-days",
            f"{expected_road_days - complete_road_days}个路段日不足96个时槽；缺失表示未观测，不补零。",
        ),
        (
            "EVDATA_HIGH_SPEED_VALUES",
            "ROAD",
            "WARN",
            f"EVDATA speed_avg大于{HIGH_SPEED_WARNING_THRESHOLD:g}的记录需要业务复核。",
            int(high_speed_count == 0),
            f"{high_speed_count} rows",
            f"高值按源数据保留并标记WARN_HIGH_SPEED；速度单位为{SPEED_UNIT}。",
        ),
    ]
    checked_at = datetime.now().replace(microsecond=0).isoformat()
    for rule_code, domain, severity, description, passed, observed, note in quality_rows:
        conn.execute(
            "INSERT INTO catalog.meta_quality_rule VALUES (?, ?, ?, ?) "
            "ON CONFLICT(rule_code) DO UPDATE SET domain_code=excluded.domain_code, "
            "severity=excluded.severity, rule_description=excluded.rule_description",
            (rule_code, domain, severity, description),
        )
        conn.execute(
            "INSERT OR REPLACE INTO catalog.meta_quality_result VALUES (?, ?, ?, ?, ?)",
            (rule_code, checked_at, passed, observed, note),
        )

    build_values = {
        "asset_version": ASSET_VERSION,
        "evdata_imported_at": checked_at,
        "evdata_speed_csv_sha256": file_sha256(csv_path),
        "evdata_speed_unit": SPEED_UNIT,
    }
    if geojson_path is not None:
        build_values["evdata_road_geojson_sha256"] = file_sha256(geojson_path)
    conn.executemany(
        "INSERT OR REPLACE INTO catalog.meta_build VALUES (?, ?)",
        build_values.items(),
    )
    road_size = conn.execute("PRAGMA main.page_count").fetchone()[0] * conn.execute(
        "PRAGMA main.page_size"
    ).fetchone()[0]
    conn.execute(
        "UPDATE catalog.meta_database SET purpose=?, size_bytes=? WHERE database_name='road'",
        ("道路状态持续时间与EVDATA路段15分钟平均速度", road_size),
    )


def import_evdata(csv_path: Path, geojson_path: Path, db_dir: Path = DEFAULT_DB_DIR) -> None:
    road_db = db_dir / "road.sqlite"
    catalog_db = db_dir / "catalog.sqlite"
    if not road_db.is_file() or not catalog_db.is_file():
        raise FileNotFoundError(f"Expected road.sqlite and catalog.sqlite in {db_dir}")

    segments = load_segments(geojson_path)
    speeds = load_speed_rows(csv_path)
    segment_ids = {int(row[0]) for row in segments}
    speed_ids = {int(row[0]) for row in speeds}
    if segment_ids != speed_ids:
        raise ValueError(
            f"CSV/GeoJSON road ids differ: CSV-only={sorted(speed_ids - segment_ids)}, "
            f"GeoJSON-only={sorted(segment_ids - speed_ids)}"
        )

    conn = sqlite3.connect(road_db)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("ATTACH DATABASE ? AS catalog", (str(catalog_db),))
    try:
        with conn:
            conn.executescript(
                """
                DROP VIEW IF EXISTS fact_evdata_road_speed_15m;
                DROP TABLE IF EXISTS std_evdata_road_speed_15m;
                DROP TABLE IF EXISTS dim_evdata_road_segment;

                CREATE TABLE dim_evdata_road_segment (
                    road_id INTEGER PRIMARY KEY,
                    road_name TEXT,
                    geometry_geojson TEXT NOT NULL,
                    geometry_type TEXT NOT NULL CHECK (geometry_type = 'MultiLineString'),
                    crs TEXT NOT NULL CHECK (crs = 'EPSG:4326'),
                    bbox_min_longitude REAL NOT NULL,
                    bbox_min_latitude REAL NOT NULL,
                    bbox_max_longitude REAL NOT NULL,
                    bbox_max_latitude REAL NOT NULL,
                    source_feature_number INTEGER NOT NULL,
                    source_table TEXT NOT NULL
                ) STRICT;

                CREATE TABLE std_evdata_road_speed_15m (
                    road_id INTEGER NOT NULL REFERENCES dim_evdata_road_segment(road_id),
                    observed_at TEXT NOT NULL,
                    date_key INTEGER NOT NULL,
                    minute_key INTEGER NOT NULL CHECK (minute_key BETWEEN 0 AND 1439),
                    speed_avg REAL NOT NULL CHECK (speed_avg >= 0),
                    speed_unit TEXT NOT NULL CHECK (speed_unit = 'km/h'),
                    quality_status TEXT NOT NULL CHECK (quality_status IN ('OK', 'WARN_HIGH_SPEED')),
                    source_record_number INTEGER NOT NULL,
                    source_table TEXT NOT NULL,
                    PRIMARY KEY (road_id, observed_at)
                ) STRICT;

                CREATE VIEW fact_evdata_road_speed_15m AS
                SELECT * FROM std_evdata_road_speed_15m;

                CREATE INDEX idx_evdata_speed_time
                ON std_evdata_road_speed_15m(date_key, minute_key);
                """
            )
            conn.executemany(
                "INSERT INTO dim_evdata_road_segment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                segments,
            )
            conn.executemany(
                "INSERT INTO std_evdata_road_speed_15m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                speeds,
            )
            refresh_catalog(conn, csv_path, geojson_path, segments, speeds)
            for schema_name in ("main", "catalog"):
                result = conn.execute(f"PRAGMA {schema_name}.integrity_check").fetchone()[0]
                if result != "ok":
                    raise RuntimeError(f"{schema_name} integrity check failed: {result}")
            failed_errors = conn.execute(
                "SELECT COUNT(*) FROM catalog.meta_quality_result q "
                "JOIN catalog.meta_quality_rule r USING(rule_code) "
                "WHERE r.severity='ERROR' AND q.passed=0"
            ).fetchone()[0]
            if failed_errors:
                raise RuntimeError(f"{failed_errors} ERROR quality rules failed")
    finally:
        conn.close()


def replace_evdata_speeds(csv_path: Path, db_dir: Path = DEFAULT_DB_DIR) -> None:
    road_db = db_dir / "road.sqlite"
    catalog_db = db_dir / "catalog.sqlite"
    if not road_db.is_file() or not catalog_db.is_file():
        raise FileNotFoundError(f"Expected road.sqlite and catalog.sqlite in {db_dir}")

    speeds = load_speed_rows(csv_path)
    conn = sqlite3.connect(road_db)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("ATTACH DATABASE ? AS catalog", (str(catalog_db),))
    try:
        segments = conn.execute("SELECT * FROM dim_evdata_road_segment ORDER BY road_id").fetchall()
        segment_ids = {int(row[0]) for row in segments}
        speed_ids = {int(row[0]) for row in speeds}
        if segment_ids != speed_ids:
            raise ValueError(
                f"CSV/existing geometry road ids differ: CSV-only={sorted(speed_ids - segment_ids)}, "
                f"geometry-only={sorted(segment_ids - speed_ids)}"
            )
        with conn:
            conn.executescript(
                """
                DROP VIEW IF EXISTS fact_evdata_road_speed_15m;
                DROP TABLE IF EXISTS std_evdata_road_speed_15m;

                CREATE TABLE std_evdata_road_speed_15m (
                    road_id INTEGER NOT NULL REFERENCES dim_evdata_road_segment(road_id),
                    observed_at TEXT NOT NULL,
                    date_key INTEGER NOT NULL,
                    minute_key INTEGER NOT NULL CHECK (minute_key BETWEEN 0 AND 1439),
                    speed_avg REAL NOT NULL CHECK (speed_avg >= 0),
                    speed_unit TEXT NOT NULL CHECK (speed_unit = 'km/h'),
                    quality_status TEXT NOT NULL CHECK (quality_status IN ('OK', 'WARN_HIGH_SPEED')),
                    source_record_number INTEGER NOT NULL,
                    source_table TEXT NOT NULL,
                    PRIMARY KEY (road_id, observed_at)
                ) STRICT;

                CREATE VIEW fact_evdata_road_speed_15m AS
                SELECT * FROM std_evdata_road_speed_15m;

                CREATE INDEX idx_evdata_speed_time
                ON std_evdata_road_speed_15m(date_key, minute_key);
                """
            )
            conn.executemany(
                "INSERT INTO std_evdata_road_speed_15m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                speeds,
            )
            refresh_catalog(conn, csv_path, None, segments, speeds)
            for schema_name in ("main", "catalog"):
                result = conn.execute(f"PRAGMA {schema_name}.integrity_check").fetchone()[0]
                if result != "ok":
                    raise RuntimeError(f"{schema_name} integrity check failed: {result}")
            failed_errors = conn.execute(
                "SELECT COUNT(*) FROM catalog.meta_quality_result q "
                "JOIN catalog.meta_quality_rule r USING(rule_code) "
                "WHERE r.severity='ERROR' AND q.passed=0"
            ).fetchone()[0]
            if failed_errors:
                raise RuntimeError(f"{failed_errors} ERROR quality rules failed")
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path, help="EVDATA 15-minute speed CSV")
    parser.add_argument(
        "--geojson",
        type=Path,
        help="EVDATA road segment GeoJSON; omit to retain existing geometry and replace speeds only",
    )
    parser.add_argument("--db-dir", type=Path, default=DEFAULT_DB_DIR, help="Packaged SQLite directory")
    args = parser.parse_args()
    if args.geojson:
        import_evdata(args.csv.resolve(), args.geojson.resolve(), args.db_dir.resolve())
        action = "Imported EVDATA geometry and speeds"
    else:
        replace_evdata_speeds(args.csv.resolve(), args.db_dir.resolve())
        action = "Replaced EVDATA speeds using existing geometry"
    print(f"{action} in {args.db_dir.resolve()}")


if __name__ == "__main__":
    main()
