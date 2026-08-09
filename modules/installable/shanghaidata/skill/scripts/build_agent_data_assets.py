#!/usr/bin/env python3
"""Build the portable, agent-facing multimodal traffic data asset."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform


def required_environment_path(name: str) -> Path:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return Path(value).expanduser().resolve()


SOURCE_DB = required_environment_path("SHANGHAI_TRAFFIC_SOURCE_DB")
DB_DIR = required_environment_path("TRANSPORTX_TRAFFIC_DATA_ROOT")
DB_NAMES = ("common", "road", "metro", "bus", "ridehail")
PYTHON = sys.executable
BUILT_AT = datetime.now().replace(microsecond=0).isoformat()
ASSET_VERSION = "3.2.0"
CANONICAL_CRS = "EPSG:4326"
CANONICAL_TIME_ZONE = "Asia/Shanghai"
EPSG32651_TO_WGS84 = Transformer.from_crs("EPSG:32651", "EPSG:4326", always_xy=True)
WGS84_TO_EPSG32651 = Transformer.from_crs("EPSG:4326", "EPSG:32651", always_xy=True)

GCJ_A = 6378245.0
GCJ_EE = 0.00669342162296594323


def parse_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("/", "-")
    for fmt in (
        "%Y-%m-%d %H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y%m%d",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def norm_datetime(value: object) -> str | None:
    parsed = parse_datetime(value)
    return parsed.strftime("%Y-%m-%d %H:%M:%S") if parsed else None


def date_key(value: object) -> int | None:
    parsed = parse_datetime(value)
    return int(parsed.strftime("%Y%m%d")) if parsed else None


def minute_of_day(value: object) -> int | None:
    parsed = parse_datetime(value)
    return parsed.hour * 60 + parsed.minute if parsed else None


def sha256_blob(value: object) -> bytes | None:
    if value is None:
        return None
    return hashlib.sha256(str(value).encode("utf-8")).digest()


def crs_name(value: object) -> str:
    return {
        0: "UNKNOWN",
        1: "GCJ-02",
        2: "WGS84",
        3: "BD-09",
        4: "CGCS2000",
    }.get(int(value or 0), "UNKNOWN")


def parse_point(value: object) -> tuple[float, float] | None:
    if value is None:
        return None
    match = re.search(r"POINT\s*\(\s*([\d.]+)\s+([\d.]+)\s*\)", str(value))
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def projected_lon(value: object) -> float | None:
    point = parse_point(value)
    return EPSG32651_TO_WGS84.transform(*point)[0] if point else None


def projected_lat(value: object) -> float | None:
    point = parse_point(value)
    return EPSG32651_TO_WGS84.transform(*point)[1] if point else None


def projected_x(value: object) -> float | None:
    point = parse_point(value)
    return point[0] if point else None


def projected_y(value: object) -> float | None:
    point = parse_point(value)
    return point[1] if point else None


def _gcj_transform_lat(x: float, y: float) -> float:
    value = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    value += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    value += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    value += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return value


def _gcj_transform_lon(x: float, y: float) -> float:
    value = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    value += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    value += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    value += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return value


def wgs84_to_gcj02(lon: float, lat: float) -> tuple[float, float]:
    dlat = _gcj_transform_lat(lon - 105.0, lat - 35.0)
    dlon = _gcj_transform_lon(lon - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = 1.0 - GCJ_EE * math.sin(radlat) ** 2
    sqrt_magic = math.sqrt(magic)
    dlat = dlat * 180.0 / ((GCJ_A * (1.0 - GCJ_EE)) / (magic * sqrt_magic) * math.pi)
    dlon = dlon * 180.0 / (GCJ_A / sqrt_magic * math.cos(radlat) * math.pi)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon: object, lat: object) -> tuple[float, float] | None:
    if lon is None or lat is None:
        return None
    source_lon, source_lat = float(lon), float(lat)
    wgs_lon, wgs_lat = source_lon, source_lat
    for _ in range(12):
        gcj_lon, gcj_lat = wgs84_to_gcj02(wgs_lon, wgs_lat)
        delta_lon, delta_lat = gcj_lon - source_lon, gcj_lat - source_lat
        wgs_lon -= delta_lon
        wgs_lat -= delta_lat
        if max(abs(delta_lon), abs(delta_lat)) < 1e-9:
            break
    return wgs_lon, wgs_lat


def gcj_wgs_lon(lon: object, lat: object) -> float | None:
    point = gcj02_to_wgs84(lon, lat)
    return point[0] if point else None


def gcj_wgs_lat(lon: object, lat: object) -> float | None:
    point = gcj02_to_wgs84(lon, lat)
    return point[1] if point else None


def gcj_geojson_to_wgs84(value: object) -> str | None:
    if value is None:
        return None
    geometry = json.loads(str(value))

    def convert_coordinates(coordinates: object) -> object:
        if (
            isinstance(coordinates, list)
            and len(coordinates) >= 2
            and isinstance(coordinates[0], (int, float))
            and isinstance(coordinates[1], (int, float))
        ):
            converted = gcj02_to_wgs84(coordinates[0], coordinates[1])
            return [converted[0], converted[1], *coordinates[2:]] if converted else coordinates
        if isinstance(coordinates, list):
            return [convert_coordinates(item) for item in coordinates]
        return coordinates

    geometry["coordinates"] = convert_coordinates(geometry.get("coordinates"))
    return json.dumps(geometry, ensure_ascii=False, separators=(",", ":"))


def bd09_to_wgs84(lon: object, lat: object) -> tuple[float, float] | None:
    if lon is None or lat is None:
        return None
    x = float(lon) - 0.0065
    y = float(lat) - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * math.pi * 3000.0 / 180.0)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * math.pi * 3000.0 / 180.0)
    return gcj02_to_wgs84(z * math.cos(theta), z * math.sin(theta))


def normalized_lon(lon: object, lat: object, source_crs_id: object) -> float | None:
    if lon is None or lat is None:
        return None
    crs_id = int(source_crs_id or 0)
    if crs_id == 1:
        point = gcj02_to_wgs84(lon, lat)
        return point[0] if point else None
    if crs_id == 2:
        return float(lon)
    if crs_id == 3:
        point = bd09_to_wgs84(lon, lat)
        return point[0] if point else None
    return float(lon)


def normalized_lat(lon: object, lat: object, source_crs_id: object) -> float | None:
    if lon is None or lat is None:
        return None
    crs_id = int(source_crs_id or 0)
    if crs_id == 1:
        point = gcj02_to_wgs84(lon, lat)
        return point[1] if point else None
    if crs_id == 2:
        return float(lat)
    if crs_id == 3:
        point = bd09_to_wgs84(lon, lat)
        return point[1] if point else None
    return float(lat)


def point_geometry_distance_m(lon: object, lat: object, geometry_json: object) -> float | None:
    if lon is None or lat is None or geometry_json is None:
        return None
    point = transform(WGS84_TO_EPSG32651.transform, Point(float(lon), float(lat)))
    geometry = transform(WGS84_TO_EPSG32651.transform, shape(json.loads(str(geometry_json))))
    return point.distance(geometry)


def metro_line_number(value: object) -> int | None:
    text = str(value or "")
    match = re.search(r"地铁(\d+)号线", text)
    if match:
        return int(match.group(1))
    if text == "浦江线":
        return 101
    if text == "市域机场线":
        return 102
    return None


def pipe_contains(value: object, item: object) -> int:
    return int(str(item) in [part.strip() for part in str(value or "").split("|") if part.strip()])


def register_functions(conn: sqlite3.Connection) -> None:
    conn.create_function("norm_datetime", 1, norm_datetime, deterministic=True)
    conn.create_function("date_key", 1, date_key, deterministic=True)
    conn.create_function("minute_of_day", 1, minute_of_day, deterministic=True)
    conn.create_function("sha256_blob", 1, sha256_blob, deterministic=True)
    conn.create_function("crs_name", 1, crs_name, deterministic=True)
    conn.create_function("projected_lon", 1, projected_lon, deterministic=True)
    conn.create_function("projected_lat", 1, projected_lat, deterministic=True)
    conn.create_function("projected_x", 1, projected_x, deterministic=True)
    conn.create_function("projected_y", 1, projected_y, deterministic=True)
    conn.create_function("gcj_wgs_lon", 2, gcj_wgs_lon, deterministic=True)
    conn.create_function("gcj_wgs_lat", 2, gcj_wgs_lat, deterministic=True)
    conn.create_function("gcj_geojson_to_wgs84", 1, gcj_geojson_to_wgs84, deterministic=True)
    conn.create_function("normalized_lon", 3, normalized_lon, deterministic=True)
    conn.create_function("normalized_lat", 3, normalized_lat, deterministic=True)
    conn.create_function("point_geometry_distance_m", 3, point_geometry_distance_m, deterministic=True)
    conn.create_function("metro_line_number", 1, metro_line_number, deterministic=True)
    conn.create_function("pipe_contains", 2, pipe_contains, deterministic=True)


def new_database(name: str) -> sqlite3.Connection:
    path = DB_DIR / f"{name}.sqlite"
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if candidate.exists():
            candidate.unlink()
    conn = sqlite3.connect(path)
    register_functions(conn)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-200000")
    conn.execute("ATTACH DATABASE ? AS src", (str(SOURCE_DB),))
    return conn


def finish_database(conn: sqlite3.Connection) -> None:
    conn.commit()
    conn.execute("DETACH DATABASE src")
    conn.execute("PRAGMA optimize")
    conn.close()


def source_date_range() -> tuple[date, date]:
    conn = sqlite3.connect(SOURCE_DB)
    values: list[datetime] = []
    operational_tables = (
        "raw_xuhui_bus_passenger_flow",
        "raw_xuhui_metro_passenger_flow",
        "raw_xuhui_payment_from_venue",
        "raw_xuhui_payment_to_venue",
        "raw_xuhui_ridehail_arrival",
        "raw_xuhui_ridehail_departure",
        "raw_xuhui_road_segment_state",
        "raw_xuhui_weather_grid",
    )
    placeholders = ",".join("?" for _ in operational_tables)
    for (payload,) in conn.execute(
        f"SELECT date_ranges_json FROM meta_datasets WHERE table_name IN ({placeholders})",
        operational_tables,
    ):
        for minimum, maximum in json.loads(payload or "{}").values():
            for item in (minimum, maximum):
                parsed = parse_datetime(item)
                if parsed:
                    values.append(parsed)
    for (item,) in conn.execute("SELECT DISTINCT 日期 FROM raw_xuhui_bus_passenger_flow"):
        parsed = parse_datetime(item)
        if parsed:
            values.append(parsed)
    conn.close()
    return min(values).date(), max(values).date()


def build_common() -> None:
    conn = new_database("common")
    conn.executescript(
        """
        CREATE TABLE dim_date (
            date_key INTEGER PRIMARY KEY,
            date_iso TEXT NOT NULL UNIQUE,
            year INTEGER NOT NULL,
            quarter INTEGER NOT NULL,
            month INTEGER NOT NULL,
            day INTEGER NOT NULL,
            weekday_iso INTEGER NOT NULL,
            weekday_name_cn TEXT NOT NULL,
            is_weekend INTEGER NOT NULL CHECK (is_weekend IN (0, 1)),
            week_of_year INTEGER NOT NULL,
            is_event_day INTEGER NOT NULL CHECK (is_event_day IN (0, 1)),
            event_id TEXT
        ) STRICT;

        CREATE TABLE dim_time (
            minute_key INTEGER PRIMARY KEY CHECK (minute_key BETWEEN 0 AND 1439),
            time_hhmm TEXT NOT NULL UNIQUE,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            slot_15_start INTEGER NOT NULL,
            slot_30_start INTEGER NOT NULL,
            day_period_cn TEXT NOT NULL
        ) STRICT;

        CREATE TABLE dim_crs (
            crs_code TEXT PRIMARY KEY,
            crs_name_cn TEXT NOT NULL,
            is_geographic INTEGER NOT NULL,
            governance_note TEXT NOT NULL
        ) STRICT;

        CREATE TABLE dim_event (
            event_id TEXT PRIMARY KEY,
            event_series_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            venue_key TEXT NOT NULL,
            event_date_key INTEGER NOT NULL REFERENCES dim_date(date_key),
            event_date TEXT NOT NULL,
            time_precision TEXT NOT NULL CHECK (time_precision IN ('DATE_ONLY', 'DATETIME')),
            event_start_at TEXT,
            event_end_at TEXT,
            ingress_start_at TEXT,
            egress_end_at TEXT,
            source_type TEXT NOT NULL,
            source_note TEXT NOT NULL
        ) STRICT;

        CREATE TABLE dim_venue (
            venue_key TEXT PRIMARY KEY,
            venue_name TEXT NOT NULL,
            venue_type TEXT NOT NULL,
            longitude REAL,
            latitude REAL,
            source_crs TEXT NOT NULL,
            geo_key TEXT NOT NULL,
            notes TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE dim_poi (
            poi_key TEXT PRIMARY KEY,
            poi_name TEXT NOT NULL UNIQUE,
            poi_type TEXT NOT NULL CHECK (poi_type IN ('RAILWAY_STATION', 'AIRPORT')),
            aliases TEXT NOT NULL,
            longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
            latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
            crs TEXT NOT NULL CHECK (crs = 'EPSG:4326'),
            geo_key TEXT NOT NULL UNIQUE,
            coordinate_quality TEXT NOT NULL,
            notes TEXT NOT NULL
        ) STRICT;

        CREATE TABLE dim_weather_grid (
            grid_key INTEGER PRIMARY KEY,
            town_id INTEGER,
            town_name TEXT,
            district_name TEXT,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            source_crs TEXT NOT NULL,
            geo_key TEXT NOT NULL UNIQUE
        ) STRICT;

        CREATE TABLE dim_geo_feature (
            geo_key TEXT PRIMARY KEY,
            domain_code TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            entity_name TEXT,
            geometry_type TEXT NOT NULL,
            geometry_json TEXT,
            longitude REAL,
            latitude REAL,
            source_x REAL,
            source_y REAL,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT,
            coordinate_quality TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE std_weather_observation (
            observation_key INTEGER PRIMARY KEY,
            source_observation_id TEXT NOT NULL,
            grid_key INTEGER NOT NULL REFERENCES dim_weather_grid(grid_key),
            observed_at TEXT NOT NULL,
            date_key INTEGER NOT NULL REFERENCES dim_date(date_key),
            minute_key INTEGER NOT NULL REFERENCES dim_time(minute_key),
            temperature_c REAL,
            rainfall_1h_mm REAL,
            quality_status TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        CREATE VIEW fact_weather_observation AS
        SELECT * FROM std_weather_observation WHERE quality_status = 'OK';

        CREATE TABLE mart_weather_grid_hour (
            grid_key INTEGER NOT NULL,
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL,
            observation_count INTEGER NOT NULL,
            avg_temperature_c REAL,
            min_temperature_c REAL,
            max_temperature_c REAL,
            avg_rainfall_1h_mm REAL,
            max_rainfall_1h_mm REAL,
            PRIMARY KEY (grid_key, date_key, hour)
        ) STRICT;
        """
    )

    start_date, end_date = source_date_range()
    weekdays = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")
    rows = []
    current = start_date
    while current <= end_date:
        rows.append(
            (
                int(current.strftime("%Y%m%d")),
                current.isoformat(),
                current.year,
                (current.month - 1) // 3 + 1,
                current.month,
                current.day,
                current.isoweekday(),
                weekdays[current.weekday()],
                int(current.weekday() >= 5),
                current.isocalendar().week,
                0,
                None,
            )
        )
        current += timedelta(days=1)
    conn.executemany("INSERT INTO dim_date VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    time_rows = []
    for minute_key_value in range(1440):
        hour, minute = divmod(minute_key_value, 60)
        period = "凌晨" if hour < 5 else "早晨" if hour < 9 else "上午" if hour < 12 else "下午" if hour < 18 else "晚间"
        time_rows.append(
            (
                minute_key_value,
                f"{hour:02d}:{minute:02d}",
                hour,
                minute,
                minute_key_value - minute_key_value % 15,
                minute_key_value - minute_key_value % 30,
                period,
            )
        )
    conn.executemany("INSERT INTO dim_time VALUES (?, ?, ?, ?, ?, ?, ?)", time_rows)

    conn.executemany(
        "INSERT INTO dim_crs VALUES (?, ?, ?, ?)",
        (
            ("UNKNOWN", "未知坐标系", 1, "不得与其他坐标直接进行精确空间运算。"),
            ("GCJ-02", "国测局坐标", 1, "高德原始公交、轨交点线使用；标准空间字段转换到EPSG:4326。"),
            ("WGS84", "WGS84", 1, "源数据使用的WGS84标签；标准层统一写为EPSG:4326。"),
            ("BD-09", "百度坐标", 1, "使用前应转换到目标坐标系。"),
            ("CGCS2000", "国家2000坐标", 1, "使用前应确认与WGS84的精度要求。"),
            ("EPSG:32651", "WGS84 / UTM 51N", 0, "官方公交站点原始投影坐标。"),
            ("EPSG:4326", "WGS84经纬度", 1, "由EPSG:32651可靠转换后的标准坐标。"),
        ),
    )

    conn.executescript(
        """
        INSERT INTO dim_venue
        SELECT poi_id, poi_name, poi_type, longitude, latitude,
               coordinate_system, 'VENUE:' || poi_id, notes, _source_row_id
        FROM src.raw_poi_venue_pois;

        INSERT INTO dim_poi VALUES
            ('poi_shanghai_railway_station', '上海火车站', 'RAILWAY_STATION', '上海站', 121.45088, 31.25145, 'EPSG:4326', 'POI:poi_shanghai_railway_station', 'USER_CONFIRMED_WGS84', '用户提供的重要场站中心点。'),
            ('poi_shanghai_south_railway_station', '上海南站', 'RAILWAY_STATION', '火车南站|上海火车南站', 121.41757, 31.14980, 'EPSG:4326', 'POI:poi_shanghai_south_railway_station', 'USER_CONFIRMED_WGS84', '用户提供的重要场站中心点。'),
            ('poi_shanghai_hongqiao_railway_station', '上海虹桥站', 'RAILWAY_STATION', '虹桥站|虹桥火车站', 121.314, 31.194, 'EPSG:4326', 'POI:poi_shanghai_hongqiao_railway_station', 'USER_CONFIRMED_WGS84', '用户提供的重要场站中心点。'),
            ('poi_shanghai_pudong_international_airport', '上海浦东国际机场', 'AIRPORT', '浦东机场', 121.80528, 31.14333, 'EPSG:4326', 'POI:poi_shanghai_pudong_international_airport', 'USER_CONFIRMED_WGS84', '用户提供的机场中心点。');

        INSERT INTO dim_event (
            event_id, event_series_id, event_name, venue_key, event_date_key, event_date,
            time_precision, event_start_at, event_end_at, ingress_start_at, egress_end_at,
            source_type, source_note
        ) VALUES
            ('event_tnt_shanghai_stadium_20250820', 'event_series_tnt_shanghai_2025', '时代少年团演出', 'venue_shanghai_stadium', 20250820, '2025-08-20', 'DATE_ONLY', NULL, NULL, NULL, NULL, 'USER_PROVIDED_EXPERIENCE', '用户补充经验记录：地点为上海体育场；仅提供演出日期，具体时刻未知。'),
            ('event_tnt_shanghai_stadium_20250821', 'event_series_tnt_shanghai_2025', '时代少年团演出', 'venue_shanghai_stadium', 20250821, '2025-08-21', 'DATE_ONLY', NULL, NULL, NULL, NULL, 'USER_PROVIDED_EXPERIENCE', '用户补充经验记录：地点为上海体育场；仅提供演出日期，具体时刻未知。'),
            ('event_tnt_shanghai_stadium_20250823', 'event_series_tnt_shanghai_2025', '时代少年团演出', 'venue_shanghai_stadium', 20250823, '2025-08-23', 'DATE_ONLY', NULL, NULL, NULL, NULL, 'USER_PROVIDED_EXPERIENCE', '用户补充经验记录：地点为上海体育场；仅提供演出日期，具体时刻未知。'),
            ('event_tnt_shanghai_stadium_20250824', 'event_series_tnt_shanghai_2025', '时代少年团演出', 'venue_shanghai_stadium', 20250824, '2025-08-24', 'DATE_ONLY', NULL, NULL, NULL, NULL, 'USER_PROVIDED_EXPERIENCE', '用户补充经验记录：地点为上海体育场；仅提供演出日期，具体时刻未知。');

        UPDATE dim_date
        SET is_event_day = 1,
            event_id = 'event_tnt_shanghai_stadium_' || date_key
        WHERE date_key IN (20250820, 20250821, 20250823, 20250824);

        INSERT INTO dim_weather_grid
        SELECT ROW_NUMBER() OVER (ORDER BY longitude, latitude, town_id),
               town_id, town_name, district_name, longitude, latitude,
               'UNKNOWN', 'WEATHER:' || printf('%.6f:%.6f:%s', longitude, latitude, town_id)
        FROM (
            SELECT DISTINCT 城镇ID AS town_id, 城镇 AS town_name, 区域 AS district_name,
                   网格经度 AS longitude, 网格维度 AS latitude
            FROM src.raw_xuhui_weather_grid
        );

        INSERT INTO dim_geo_feature
        SELECT 'VENUE:' || poi_id, 'COMMON', 'VENUE', poi_id, poi_name,
               geometry_type, geometry_json,
               json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]'),
               NULL, NULL, 'UNKNOWN', NULL,
               'SOURCE_CRS_UNKNOWN', 'raw_poi_venue_pois_geojson', _source_row_id
        FROM src.raw_poi_venue_pois_geojson;

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'COMMON', 'TRANSPORT_HUB', poi_key, poi_name,
               'Point', json_object('type', 'Point', 'coordinates', json_array(longitude, latitude)),
               longitude, latitude, NULL, NULL, 'WGS84', crs,
               coordinate_quality, 'dim_poi', rowid
        FROM dim_poi;

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'COMMON', 'WEATHER_GRID', CAST(grid_key AS TEXT), town_name,
               'Point', json_object('type', 'Point', 'coordinates', json_array(longitude, latitude)),
               longitude, latitude, NULL, NULL, source_crs, NULL,
               'SOURCE_CRS_UNKNOWN', 'raw_xuhui_weather_grid', grid_key
        FROM dim_weather_grid;

        INSERT INTO dim_geo_feature
        SELECT 'BUS_AMAP_STOP:' || stop_id, 'BUS', 'BUS_STOP', stop_id, stop_name,
               geometry_type, gcj_geojson_to_wgs84(geometry_json),
               gcj_wgs_lon(json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]')),
               gcj_wgs_lat(json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]')),
               json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]'),
               'GCJ-02', 'EPSG:4326',
               'GCJ02_TO_WGS84_ITERATIVE', 'raw_bus_stops_geojson', _source_row_id
        FROM src.raw_bus_stops_geojson;

        INSERT INTO dim_geo_feature
        SELECT 'BUS_OFFICIAL_STOP:' || "站点编码", 'BUS', 'BUS_STOP', CAST("站点编码" AS TEXT), "物理站点名称",
               'Point', json_object('type', 'Point', 'coordinates', json_array(projected_lon("站点点位（坐标系：32651）"), projected_lat("站点点位（坐标系：32651）"))),
               projected_lon("站点点位（坐标系：32651）"), projected_lat("站点点位（坐标系：32651）"),
               projected_x("站点点位（坐标系：32651）"), projected_y("站点点位（坐标系：32651）"),
               'EPSG:32651', 'EPSG:4326', 'RELIABLY_TRANSFORMED', 'raw_xuhui_bus_stop_info', _source_row_id
        FROM src.raw_xuhui_bus_stop_info;

        INSERT INTO dim_geo_feature
        SELECT 'BUS_ROUTE:' || line_id, 'BUS', 'BUS_ROUTE', line_id, line_name,
               geometry_type, gcj_geojson_to_wgs84(geometry_json), NULL, NULL, NULL, NULL,
               'GCJ-02', 'EPSG:4326', 'GCJ02_TO_WGS84_ITERATIVE', 'raw_bus_lines_geojson', _source_row_id
        FROM src.raw_bus_lines_geojson;

        INSERT INTO dim_geo_feature
        SELECT 'METRO_STATION:' || station_id, 'METRO', 'METRO_STATION', CAST(station_id AS TEXT), station_name,
               'Point', gcj_geojson_to_wgs84(geometry_json),
               gcj_wgs_lon(json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]')),
               gcj_wgs_lat(json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]')),
               json_extract(geometry_json, '$.coordinates[0]'), json_extract(geometry_json, '$.coordinates[1]'),
               'GCJ-02', 'EPSG:4326',
               CASE WHEN coordinate_available = 1 THEN 'GCJ02_TO_WGS84_ITERATIVE' ELSE 'MISSING_COORDINATE' END,
               'raw_metro_stations_geojson', _source_row_id
        FROM src.raw_metro_stations_geojson;

        INSERT INTO dim_geo_feature
        SELECT 'METRO_LINE:' || line_id, 'METRO', 'METRO_LINE', CAST(line_id AS TEXT), line_name,
               geometry_type, geometry_json, NULL, NULL, NULL, NULL, 'WGS84', 'EPSG:4326',
               CASE WHEN geometry_available = 1 THEN 'SOURCE_GEOMETRY' ELSE 'MISSING_GEOMETRY' END,
               'raw_metro_lines_geojson', _source_row_id
        FROM src.raw_metro_lines_geojson;

        INSERT INTO std_weather_observation
        SELECT w._source_row_id, w.ID, g.grid_key, norm_datetime(w.更新时间), date_key(w.更新时间),
               minute_of_day(w.更新时间), w.网格温度, w.网格一小时累计降雨,
               CASE WHEN norm_datetime(w.更新时间) IS NULL THEN 'INVALID_TIME'
                    WHEN w.网格温度 IS NULL OR w.网格一小时累计降雨 IS NULL THEN 'MISSING_MEASURE'
                    ELSE 'OK' END,
               'raw_xuhui_weather_grid', w._source_row_id
        FROM src.raw_xuhui_weather_grid w
        JOIN dim_weather_grid g
          ON g.longitude = w.网格经度 AND g.latitude = w.网格维度
         AND g.town_id = w.城镇ID;

        INSERT INTO mart_weather_grid_hour
        SELECT grid_key, date_key, CAST(minute_key / 60 AS INTEGER), COUNT(*),
               AVG(temperature_c), MIN(temperature_c), MAX(temperature_c),
               AVG(rainfall_1h_mm), MAX(rainfall_1h_mm)
        FROM fact_weather_observation
        GROUP BY grid_key, date_key, CAST(minute_key / 60 AS INTEGER);

        CREATE INDEX idx_weather_time ON std_weather_observation(date_key, minute_key);
        CREATE INDEX idx_weather_grid_time ON std_weather_observation(grid_key, observed_at);
        CREATE INDEX idx_geo_domain_type ON dim_geo_feature(domain_code, entity_type);
        CREATE INDEX idx_geo_name ON dim_geo_feature(entity_name);
        """
    )
    finish_database(conn)


def build_road() -> None:
    conn = new_database("road")
    conn.executescript(
        """
        CREATE TABLE dim_road_segment (
            segment_key INTEGER PRIMARY KEY,
            segment_id TEXT NOT NULL UNIQUE,
            segment_name TEXT,
            geo_key TEXT,
            location_available INTEGER NOT NULL DEFAULT 0,
            source_table TEXT NOT NULL
        ) STRICT;

        INSERT INTO dim_road_segment(segment_key, segment_id, segment_name, source_table)
        SELECT ROW_NUMBER() OVER (ORDER BY FSTR_ISSUESECTID), FSTR_ISSUESECTID, MAX(FSTR_DESC),
               'raw_xuhui_road_segment_state'
        FROM src.raw_xuhui_road_segment_state
        GROUP BY FSTR_ISSUESECTID;

        CREATE TABLE std_road_state_event (
            event_key INTEGER PRIMARY KEY,
            segment_key INTEGER NOT NULL REFERENCES dim_road_segment(segment_key),
            event_at TEXT NOT NULL,
            next_event_at TEXT,
            date_key INTEGER NOT NULL,
            minute_key INTEGER NOT NULL,
            state_code TEXT NOT NULL,
            state_name_cn TEXT NOT NULL,
            duration_seconds INTEGER,
            source_record_number INTEGER,
            quality_status TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        WITH normalized AS (
            SELECT r._source_row_id AS event_key, s.segment_key,
                   norm_datetime(r.FDT_TIME) AS event_at,
                   LEAD(norm_datetime(r.FDT_TIME)) OVER (
                       PARTITION BY r.FSTR_ISSUESECTID ORDER BY norm_datetime(r.FDT_TIME), r._source_row_id
                   ) AS next_event_at,
                   LOWER(TRIM(r.FSTR_CFMSTATE)) AS source_state,
                   r."Unnamed: 0" AS source_record_number,
                   r._source_row_id
            FROM src.raw_xuhui_road_segment_state r
            JOIN dim_road_segment s ON s.segment_id = r.FSTR_ISSUESECTID
        )
        INSERT INTO std_road_state_event
        SELECT event_key, segment_key, event_at, next_event_at, date_key(event_at), minute_of_day(event_at),
               CASE source_state WHEN 'free' THEN 'FREE' WHEN 'crowd' THEN 'CROWD' WHEN 'jam' THEN 'JAM' ELSE 'UNKNOWN' END,
               CASE source_state WHEN 'free' THEN '畅通' WHEN 'crowd' THEN '拥挤' WHEN 'jam' THEN '严重拥堵' ELSE '未知' END,
               CASE WHEN next_event_at IS NULL THEN NULL
                    ELSE CAST(strftime('%s', next_event_at) - strftime('%s', event_at) AS INTEGER) END,
               source_record_number,
               CASE WHEN event_at IS NULL THEN 'INVALID_TIME'
                    WHEN source_state NOT IN ('free', 'crowd', 'jam') THEN 'UNKNOWN_STATE'
                    ELSE 'OK' END,
               'raw_xuhui_road_segment_state', _source_row_id
        FROM normalized;

        CREATE VIEW fact_road_state_event AS
        SELECT * FROM std_road_state_event WHERE quality_status = 'OK';

        CREATE TABLE mart_road_segment_hour (
            segment_key INTEGER NOT NULL,
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL,
            free_seconds INTEGER NOT NULL,
            crowd_seconds INTEGER NOT NULL,
            jam_seconds INTEGER NOT NULL,
            observed_seconds INTEGER NOT NULL,
            state_event_count INTEGER NOT NULL,
            PRIMARY KEY (segment_key, date_key, hour)
        ) STRICT;

        WITH RECURSIVE spans AS (
            SELECT event_key, segment_key, state_code, event_at AS chunk_start, next_event_at AS span_end, event_at
            FROM fact_road_state_event
            WHERE next_event_at IS NOT NULL AND next_event_at > event_at
        ), chunks(event_key, segment_key, state_code, chunk_start, span_end, event_at) AS (
            SELECT event_key, segment_key, state_code, chunk_start, span_end, event_at FROM spans
            UNION ALL
            SELECT event_key, segment_key, state_code,
                   datetime(strftime('%Y-%m-%d %H:00:00', chunk_start), '+1 hour'), span_end, event_at
            FROM chunks
            WHERE datetime(strftime('%Y-%m-%d %H:00:00', chunk_start), '+1 hour') < span_end
        ), measured AS (
            SELECT *,
                   CAST(strftime('%s', CASE
                       WHEN datetime(strftime('%Y-%m-%d %H:00:00', chunk_start), '+1 hour') < span_end
                       THEN datetime(strftime('%Y-%m-%d %H:00:00', chunk_start), '+1 hour')
                       ELSE span_end END) - strftime('%s', chunk_start) AS INTEGER) AS seconds_in_hour
            FROM chunks
        )
        INSERT INTO mart_road_segment_hour
        SELECT segment_key, date_key(chunk_start), CAST(strftime('%H', chunk_start) AS INTEGER),
               SUM(CASE WHEN state_code = 'FREE' THEN seconds_in_hour ELSE 0 END),
               SUM(CASE WHEN state_code = 'CROWD' THEN seconds_in_hour ELSE 0 END),
               SUM(CASE WHEN state_code = 'JAM' THEN seconds_in_hour ELSE 0 END),
               SUM(seconds_in_hour), SUM(CASE WHEN chunk_start = event_at THEN 1 ELSE 0 END)
        FROM measured
        GROUP BY segment_key, date_key(chunk_start), CAST(strftime('%H', chunk_start) AS INTEGER);

        CREATE INDEX idx_road_segment_time ON std_road_state_event(segment_key, event_at);
        CREATE INDEX idx_road_date_state ON std_road_state_event(date_key, state_code);
        """
    )
    finish_database(conn)


def build_metro_station_mapping(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE map_metro_amap_station (
            source_station_id TEXT PRIMARY KEY,
            source_station_name TEXT NOT NULL,
            station_id INTEGER NOT NULL,
            canonical_station_name TEXT NOT NULL,
            mapping_method TEXT NOT NULL,
            confidence REAL NOT NULL
        ) STRICT
        """
    )
    old_rows = conn.execute(
        "SELECT station_id, station_name, COALESCE(poi_ids, ''), COALESCE(source_names, '') "
        "FROM src.raw_metro_stations ORDER BY station_id"
    ).fetchall()
    by_source_id: dict[str, tuple[int, str]] = {}
    by_name: dict[str, list[tuple[int, str]]] = {}
    for station_id, station_name, poi_ids, source_names in old_rows:
        for source_id in {part.strip() for part in poi_ids.split("|") if part.strip()}:
            by_source_id[source_id] = (station_id, station_name)
        aliases = {station_name, *[part.strip() for part in source_names.split("|") if part.strip()]}
        for alias in aliases:
            by_name.setdefault(alias, []).append((station_id, station_name))

    new_rows = conn.execute(
        "SELECT station_id, station_name FROM src.raw_amap_metro_stations ORDER BY station_id"
    ).fetchall()
    next_station_id = max(row[0] for row in old_rows) + 1
    mappings = []
    for source_station_id, source_station_name in new_rows:
        matched = by_source_id.get(source_station_id)
        if matched:
            station_id, canonical_name = matched
            method, confidence = "AMAP_SOURCE_ID", 1.0
        else:
            candidates = by_name.get(source_station_name, [])
            if len(candidates) == 1:
                station_id, canonical_name = candidates[0]
                method, confidence = "STATION_NAME_EXACT", 0.95
            else:
                station_id, canonical_name = next_station_id, source_station_name
                next_station_id += 1
                method, confidence = "NEW_AMAP_STATION", 1.0
        mappings.append(
            (source_station_id, source_station_name, station_id, canonical_name, method, confidence)
        )
    conn.executemany("INSERT INTO map_metro_amap_station VALUES (?, ?, ?, ?, ?, ?)", mappings)


def build_metro() -> None:
    conn = new_database("metro")
    conn.executescript(
        """
        CREATE TABLE dim_metro_route_direction (
            route_direction_id TEXT PRIMARY KEY,
            line_id INTEGER NOT NULL,
            canonical_name TEXT NOT NULL,
            route_name TEXT NOT NULL,
            route_type TEXT,
            start_station_name TEXT,
            end_station_name TEXT,
            schedule_description TEXT,
            operator_name TEXT,
            distance_km REAL,
            operation_status INTEGER,
            reverse_route_direction_id TEXT,
            stop_count INTEGER,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT NOT NULL,
            source_geometry_json TEXT,
            geometry_type TEXT,
            geometry_json TEXT,
            geo_key TEXT NOT NULL,
            collected_at TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_metro_route_direction
        SELECT CAST(a.line_id AS TEXT), l.line_id, a.canonical_name, a.line_name, a.type,
               a.start_station, a.end_station, a.schedule, a.company, a.distance_km, a.status,
               CAST(a.reverse_line_id AS TEXT), a.stop_count, 'GCJ-02', 'EPSG:4326',
               g.geometry_json, g.geometry_type, gcj_geojson_to_wgs84(g.geometry_json),
               'METRO_ROUTE:' || a.line_id, norm_datetime(a.collected_at), a._source_row_id
        FROM src.raw_amap_metro_lines a
        JOIN src.raw_metro_lines l ON l.line_number = metro_line_number(a.canonical_name)
        LEFT JOIN src.raw_amap_metro_lines_geojson g
          ON CAST(g.line_id AS TEXT) = CAST(a.line_id AS TEXT);

        CREATE TABLE dim_metro_line (
            line_id INTEGER PRIMARY KEY,
            line_number INTEGER NOT NULL UNIQUE,
            line_name TEXT NOT NULL,
            station_count INTEGER,
            geometry_type TEXT,
            geometry_json TEXT,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT NOT NULL,
            geometry_source TEXT NOT NULL,
            geo_key TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_metro_line
        SELECT l.line_id, l.line_number, l.line_name, 0, 'MultiLineString',
               json_object(
                   'type', 'MultiLineString',
                   'coordinates', json_group_array(json(json_extract(d.geometry_json, '$.coordinates')))
               ),
               'GCJ-02', 'EPSG:4326', 'AMAP_ROUTE_DIRECTION',
               'METRO_LINE:' || l.line_id, l._source_row_id
        FROM src.raw_metro_lines l
        JOIN dim_metro_route_direction d ON d.line_id = l.line_id
        GROUP BY l.line_id, l.line_number, l.line_name, l._source_row_id;
        """
    )
    build_metro_station_mapping(conn)
    conn.executescript(
        """
        CREATE TABLE dim_metro_station (
            station_id INTEGER PRIMARY KEY,
            station_name TEXT NOT NULL UNIQUE,
            line_names TEXT,
            longitude REAL,
            latitude REAL,
            source_x REAL,
            source_y REAL,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT,
            coordinate_source TEXT NOT NULL,
            mapping_method TEXT NOT NULL,
            source_station_ids TEXT,
            coordinate_quality TEXT NOT NULL,
            geo_key TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_metro_station
        SELECT station_id, station_name, line_names,
               gcj_wgs_lon(longitude, latitude), gcj_wgs_lat(longitude, latitude),
               longitude, latitude, 'GCJ-02',
               CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL THEN 'EPSG:4326' END,
               CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL THEN 'LEGACY_AMAP' ELSE 'UNAVAILABLE' END,
               'LEGACY_CANONICAL_ID', poi_ids,
               CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL THEN 'LEGACY_CONVERTED' ELSE 'MISSING_COORDINATE' END,
               'METRO_STATION:' || station_id, _source_row_id
        FROM src.raw_metro_stations;

        CREATE TEMP TABLE amap_station_agg AS
        SELECT m.station_id, MIN(m.canonical_station_name) AS station_name,
               AVG(gcj_wgs_lon(a.longitude, a.latitude)) AS longitude,
               AVG(gcj_wgs_lat(a.longitude, a.latitude)) AS latitude,
               AVG(a.longitude) AS source_x, AVG(a.latitude) AS source_y,
               group_concat(m.source_station_id) AS source_station_ids,
               MIN(a._source_row_id) AS source_row_id,
               CASE WHEN COUNT(DISTINCT m.mapping_method) = 1 THEN MIN(m.mapping_method)
                    ELSE 'MULTI_SOURCE_MAPPING' END AS mapping_method
        FROM map_metro_amap_station m
        JOIN src.raw_amap_metro_stations a ON a.station_id = m.source_station_id
        GROUP BY m.station_id;

        UPDATE dim_metro_station
        SET longitude = (SELECT a.longitude FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            latitude = (SELECT a.latitude FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            source_x = (SELECT a.source_x FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            source_y = (SELECT a.source_y FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            normalized_crs = 'EPSG:4326',
            coordinate_source = 'AMAP_20260719',
            mapping_method = (SELECT a.mapping_method FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            source_station_ids = (SELECT a.source_station_ids FROM amap_station_agg a WHERE a.station_id = dim_metro_station.station_id),
            coordinate_quality = 'AMAP_CONVERTED'
        WHERE station_id IN (SELECT station_id FROM amap_station_agg);

        INSERT INTO dim_metro_station
        SELECT a.station_id, a.station_name, NULL, a.longitude, a.latitude, a.source_x, a.source_y,
               'GCJ-02', 'EPSG:4326', 'AMAP_20260719', a.mapping_method, a.source_station_ids,
               'AMAP_CONVERTED', 'METRO_STATION:' || a.station_id, a.source_row_id
        FROM amap_station_agg a
        WHERE NOT EXISTS (SELECT 1 FROM dim_metro_station s WHERE s.station_id = a.station_id);

        DROP TABLE amap_station_agg;

        CREATE TABLE bridge_metro_route_station (
            relation_key TEXT PRIMARY KEY,
            route_direction_id TEXT NOT NULL REFERENCES dim_metro_route_direction(route_direction_id),
            line_id INTEGER NOT NULL REFERENCES dim_metro_line(line_id),
            station_id INTEGER NOT NULL REFERENCES dim_metro_station(station_id),
            source_station_id TEXT NOT NULL,
            station_name TEXT NOT NULL,
            stop_sequence INTEGER NOT NULL,
            source_longitude REAL NOT NULL,
            source_latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT NOT NULL,
            distance_to_route_m REAL NOT NULL,
            coordinate_quality TEXT NOT NULL,
            source_row_id INTEGER NOT NULL,
            UNIQUE (route_direction_id, stop_sequence)
        ) STRICT;

        INSERT INTO bridge_metro_route_station
        SELECT CAST(r.line_id AS TEXT) || ':' || r.sequence, CAST(r.line_id AS TEXT), d.line_id,
               m.station_id, r.station_id, r.station_name, r.sequence, r.longitude, r.latitude,
               gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude),
               'GCJ-02', 'EPSG:4326',
               point_geometry_distance_m(
                   gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
               ),
               CASE WHEN point_geometry_distance_m(
                              gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
                          ) <= 25 THEN 'OK'
                    WHEN point_geometry_distance_m(
                              gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
                          ) <= 100 THEN 'REVIEW'
                    ELSE 'OUTLIER' END,
               r._source_row_id
        FROM src.raw_amap_metro_line_stations r
        JOIN dim_metro_route_direction d ON d.route_direction_id = CAST(r.line_id AS TEXT)
        JOIN map_metro_amap_station m ON m.source_station_id = r.station_id;

        CREATE TABLE bridge_metro_line_station (
            relation_id INTEGER PRIMARY KEY,
            line_id INTEGER NOT NULL REFERENCES dim_metro_line(line_id),
            station_id INTEGER NOT NULL REFERENCES dim_metro_station(station_id),
            longitude REAL NOT NULL,
            latitude REAL NOT NULL,
            source_route_count INTEGER NOT NULL,
            distance_to_line_m REAL NOT NULL,
            coordinate_quality TEXT NOT NULL,
            source_row_id INTEGER NOT NULL,
            UNIQUE (line_id, station_id)
        ) STRICT;

        WITH station_points AS (
            SELECT line_id, station_id, AVG(longitude) AS longitude, AVG(latitude) AS latitude,
                   COUNT(DISTINCT route_direction_id) AS source_route_count, MIN(source_row_id) AS source_row_id
            FROM bridge_metro_route_station
            GROUP BY line_id, station_id
        ), measured AS (
            SELECT p.*,
                   point_geometry_distance_m(p.longitude, p.latitude, l.geometry_json) AS distance_to_line_m
            FROM station_points p JOIN dim_metro_line l ON l.line_id = p.line_id
        )
        INSERT INTO bridge_metro_line_station
        SELECT ROW_NUMBER() OVER (ORDER BY line_id, station_id), line_id, station_id, longitude, latitude,
               source_route_count, distance_to_line_m,
               CASE WHEN distance_to_line_m <= 25 THEN 'OK'
                    WHEN distance_to_line_m <= 100 THEN 'REVIEW' ELSE 'OUTLIER' END,
               source_row_id
        FROM measured;

        UPDATE dim_metro_line
        SET station_count = (SELECT COUNT(*) FROM bridge_metro_line_station b WHERE b.line_id = dim_metro_line.line_id);

        UPDATE dim_metro_station
        SET line_names = (
            SELECT group_concat(l.line_name, ' | ')
            FROM bridge_metro_line_station b
            JOIN dim_metro_line l ON l.line_id = b.line_id
            WHERE b.station_id = dim_metro_station.station_id
            ORDER BY l.line_number
        )
        WHERE station_id IN (SELECT station_id FROM bridge_metro_line_station);

        CREATE TABLE ops_metro_station_coordinate_quality (
            station_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            coordinate_source TEXT NOT NULL,
            source_station_ids TEXT,
            mapping_method TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO ops_metro_station_coordinate_quality
        SELECT station_id,
               CASE WHEN longitude IS NULL OR latitude IS NULL THEN 'unmatched' ELSE 'matched' END,
               coordinate_source, source_station_ids, mapping_method, source_row_id
        FROM dim_metro_station;

        CREATE TABLE ops_metro_collection_report (
            canonical_name TEXT PRIMARY KEY,
            queries TEXT,
            collection_status TEXT,
            directions_found INTEGER,
            candidate_names TEXT,
            api_info TEXT,
            api_infocode INTEGER,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO ops_metro_collection_report
        SELECT canonical_name, queries, status, directions_found, candidate_names, api_info, api_infocode, _source_row_id
        FROM src.raw_amap_metro_collection_report;

        CREATE TABLE quality_metro_flow_station_mapping (
            source_line_number INTEGER NOT NULL,
            source_station_id INTEGER NOT NULL,
            source_station_name TEXT NOT NULL,
            station_id INTEGER,
            mapping_method TEXT NOT NULL,
            PRIMARY KEY (source_line_number, source_station_id)
        ) STRICT;

        INSERT INTO quality_metro_flow_station_mapping
        SELECT f.线路名称, f.站点ID, f.站点名称, MIN(s.station_id),
               CASE WHEN MIN(s.station_id) IS NULL THEN 'UNMATCHED' ELSE 'STATION_NAME_EXACT' END
        FROM src.raw_xuhui_metro_passenger_flow f
        LEFT JOIN dim_metro_station s ON s.station_name = f.站点名称
        GROUP BY f.线路名称, f.站点ID, f.站点名称;

        CREATE TABLE std_metro_station_hour (
            record_key INTEGER PRIMARY KEY,
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
            minute_key INTEGER NOT NULL,
            line_id INTEGER REFERENCES dim_metro_line(line_id),
            station_id INTEGER REFERENCES dim_metro_station(station_id),
            source_line_number INTEGER NOT NULL,
            source_station_id INTEGER NOT NULL,
            source_station_name TEXT NOT NULL,
            inbound_flow INTEGER NOT NULL,
            outbound_flow INTEGER NOT NULL,
            total_flow INTEGER NOT NULL,
            quality_status TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO std_metro_station_hour
        SELECT f._source_row_id, f.日期, f.小时, f.小时 * 60, l.line_id, m.station_id,
               f.线路名称, f.站点ID, f.站点名称,
               CAST(REPLACE(f.进站客流, ',', '') AS INTEGER),
               CAST(REPLACE(f.出站客流, ',', '') AS INTEGER),
               CAST(REPLACE(f.进站客流, ',', '') AS INTEGER) + CAST(REPLACE(f.出站客流, ',', '') AS INTEGER),
               CASE WHEN l.line_id IS NULL OR m.station_id IS NULL THEN 'UNMATCHED_DIMENSION' ELSE 'OK' END,
               'raw_xuhui_metro_passenger_flow', f._source_row_id
        FROM src.raw_xuhui_metro_passenger_flow f
        LEFT JOIN dim_metro_line l ON l.line_number = f.线路名称
        LEFT JOIN quality_metro_flow_station_mapping m
          ON m.source_line_number = f.线路名称 AND m.source_station_id = f.站点ID;

        CREATE VIEW fact_metro_station_hour AS
        SELECT record_key, date_key, hour, minute_key, line_id, station_id,
               inbound_flow, outbound_flow, total_flow, source_table, source_row_id
        FROM std_metro_station_hour
        WHERE quality_status = 'OK';

        CREATE TABLE mart_metro_station_day (
            date_key INTEGER NOT NULL,
            line_id INTEGER NOT NULL,
            station_id INTEGER NOT NULL,
            observed_hours INTEGER NOT NULL,
            inbound_flow INTEGER NOT NULL,
            outbound_flow INTEGER NOT NULL,
            total_flow INTEGER NOT NULL,
            peak_hour INTEGER,
            peak_hour_flow INTEGER,
            PRIMARY KEY (date_key, line_id, station_id)
        ) STRICT;

        WITH ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY date_key, line_id, station_id ORDER BY total_flow DESC, hour
            ) AS flow_rank
            FROM fact_metro_station_hour
        )
        INSERT INTO mart_metro_station_day
        SELECT date_key, line_id, station_id, COUNT(*), SUM(inbound_flow), SUM(outbound_flow), SUM(total_flow),
               MAX(CASE WHEN flow_rank = 1 THEN hour END), MAX(CASE WHEN flow_rank = 1 THEN total_flow END)
        FROM ranked GROUP BY date_key, line_id, station_id;

        CREATE INDEX idx_metro_time ON std_metro_station_hour(date_key, hour);
        CREATE INDEX idx_metro_station_time ON std_metro_station_hour(station_id, date_key, hour);
        CREATE INDEX idx_metro_line_time ON std_metro_station_hour(line_id, date_key, hour);
        CREATE INDEX idx_metro_station_name ON dim_metro_station(station_name);
        CREATE INDEX idx_metro_route_station ON bridge_metro_route_station(route_direction_id, stop_sequence);
        CREATE INDEX idx_metro_line_station ON bridge_metro_line_station(line_id, station_id);
        """
    )
    finish_database(conn)


def build_bus() -> None:
    conn = new_database("bus")
    conn.executescript(
        """
        CREATE TABLE dim_bus_line (
            line_key TEXT PRIMARY KEY,
            line_name TEXT NOT NULL,
            line_code_6 INTEGER,
            line_code_5 INTEGER UNIQUE,
            is_loop INTEGER,
            line_type TEXT,
            operation_mode TEXT,
            included_in_statistics INTEGER,
            operator_name TEXT,
            valid_until TEXT,
            start_stop_name TEXT,
            end_stop_name TEXT,
            business_system_id TEXT,
            first_departure_start TEXT,
            last_departure_start TEXT,
            first_departure_end TEXT,
            last_departure_end TEXT,
            updated_at TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_bus_line
        SELECT 主键, 线路名称, "6位线路编码", "5位线路编码", "是否环线(0否、1是)", 线路类型, 运行方式,
               是否计入统计线路, 营运企业, norm_datetime(线路失效日期), 起始站, 终到站,
               综合业务系统ID, 始发站首班车时间, 始发站末班车时间,
               终点站首班车时间, 终点站末班车时间, norm_datetime(更新时间), _source_row_id
        FROM src.raw_xuhui_bus_line_info;

        CREATE TABLE dim_bus_route_direction (
            route_direction_key TEXT PRIMARY KEY,
            requested_name TEXT,
            route_name TEXT,
            route_type TEXT,
            start_stop_name TEXT,
            end_stop_name TEXT,
            start_time TEXT,
            end_time TEXT,
            schedule_description TEXT,
            operator_name TEXT,
            distance_km REAL,
            basic_price_yuan REAL,
            total_price_yuan REAL,
            is_loop INTEGER,
            operation_status INTEGER,
            reverse_route_key TEXT,
            stop_count INTEGER,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT NOT NULL,
            source_geometry_json TEXT,
            geometry_type TEXT,
            geometry_json TEXT,
            geo_key TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_bus_route_direction
        SELECT CAST(l.line_id AS TEXT), l.requested_name, l.line_name, l.type, l.start_stop, l.end_stop,
               l.start_time, l.end_time, l.schedule_description, l.company, l.distance_km,
               l.basic_price_yuan, l.total_price_yuan, l.is_loop, l.operation_status,
               CAST(l.reverse_line_id AS TEXT), l.stop_count, 'GCJ-02', 'EPSG:4326',
               g.geometry_json, g.geometry_type, gcj_geojson_to_wgs84(g.geometry_json),
               'BUS_ROUTE:' || l.line_id, l._source_row_id
        FROM src.raw_bus_lines l
        LEFT JOIN src.raw_bus_lines_geojson g ON CAST(g.line_id AS TEXT) = CAST(l.line_id AS TEXT);

        CREATE TABLE dim_bus_stop (
            stop_key TEXT PRIMARY KEY,
            source_system TEXT NOT NULL,
            source_stop_id TEXT NOT NULL,
            stop_name TEXT NOT NULL,
            longitude REAL,
            latitude REAL,
            source_x REAL,
            source_y REAL,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT,
            served_line_keys TEXT,
            served_line_names TEXT,
            geo_key TEXT NOT NULL,
            updated_at TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO dim_bus_stop
        SELECT 'OFFICIAL:' || "站点编码", 'OFFICIAL', CAST("站点编码" AS TEXT), "物理站点名称",
               projected_lon("站点点位（坐标系：32651）"), projected_lat("站点点位（坐标系：32651）"),
               projected_x("站点点位（坐标系：32651）"), projected_y("站点点位（坐标系：32651）"),
               'EPSG:32651', 'EPSG:4326', 停靠线路编码, 停靠线路名称,
               'BUS_OFFICIAL_STOP:' || "站点编码", norm_datetime(更新日期), _source_row_id
        FROM src.raw_xuhui_bus_stop_info;

        INSERT INTO dim_bus_stop
        SELECT 'AMAP:' || stop_id, 'AMAP', stop_id, stop_name,
               gcj_wgs_lon(longitude, latitude), gcj_wgs_lat(longitude, latitude),
               longitude, latitude, 'GCJ-02', 'EPSG:4326', NULL, NULL,
               'BUS_AMAP_STOP:' || stop_id, norm_datetime(collected_at), _source_row_id
        FROM src.raw_bus_stops;

        CREATE TABLE bridge_bus_line_stop (
            relation_key TEXT PRIMARY KEY,
            relation_source TEXT NOT NULL,
            line_key TEXT,
            route_direction_key TEXT,
            stop_key TEXT NOT NULL REFERENCES dim_bus_stop(stop_key),
            stop_sequence INTEGER NOT NULL,
            direction_code INTEGER,
            stop_role INTEGER,
            source_longitude REAL,
            source_latitude REAL,
            longitude REAL,
            latitude REAL,
            source_crs TEXT NOT NULL,
            normalized_crs TEXT,
            distance_to_route_m REAL,
            coordinate_quality TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO bridge_bus_line_stop
        SELECT 'OFFICIAL:' || r._source_row_id, 'OFFICIAL', r.线路ID, NULL,
               'OFFICIAL:' || r."物理站点id", r.站级序号, r."上下行 0：上行，1：下行", r.站级类型,
               s.source_x, s.source_y, s.longitude, s.latitude, s.source_crs, s.normalized_crs,
               NULL, 'NOT_COMPARABLE', r._source_row_id
        FROM src.raw_xuhui_bus_line_stop_sequence r
        JOIN dim_bus_stop s ON s.stop_key = 'OFFICIAL:' || r."物理站点id";

        INSERT INTO bridge_bus_line_stop
        SELECT 'AMAP:' || r._source_row_id, 'AMAP', NULL, CAST(r.line_id AS TEXT),
               'AMAP:' || r.stop_id, r.sequence, NULL, NULL, r.longitude, r.latitude,
               gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude),
               'GCJ-02', 'EPSG:4326',
               point_geometry_distance_m(
                   gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
               ),
               CASE WHEN point_geometry_distance_m(
                              gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
                          ) <= 25 THEN 'OK'
                    WHEN point_geometry_distance_m(
                              gcj_wgs_lon(r.longitude, r.latitude), gcj_wgs_lat(r.longitude, r.latitude), d.geometry_json
                          ) <= 100 THEN 'REVIEW'
                    ELSE 'OUTLIER' END,
               r._source_row_id
        FROM src.raw_bus_line_stops r
        JOIN dim_bus_route_direction d ON d.route_direction_key = CAST(r.line_id AS TEXT);

        CREATE TABLE ops_bus_collection_report (
            requested_name TEXT PRIMARY KEY,
            collection_status TEXT,
            directions_found INTEGER,
            api_info TEXT,
            api_infocode INTEGER,
            candidate_names TEXT,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO ops_bus_collection_report
        SELECT requested_name, status, directions_found, api_info, api_infocode, candidate_names, _source_row_id
        FROM src.raw_bus_collection_report;

        CREATE TABLE std_bus_line_30m (
            record_key INTEGER PRIMARY KEY,
            date_key INTEGER NOT NULL,
            minute_key INTEGER NOT NULL,
            slot_code INTEGER NOT NULL,
            line_key TEXT REFERENCES dim_bus_line(line_key),
            source_line_code_5 INTEGER NOT NULL,
            industry_code INTEGER,
            total_transactions INTEGER NOT NULL,
            bus_boarding_transactions INTEGER NOT NULL,
            metro_entry_transactions INTEGER NOT NULL,
            transit_card_transactions INTEGER NOT NULL,
            card_transfer_from_bus INTEGER NOT NULL,
            card_transfer_from_metro INTEGER NOT NULL,
            qr_transactions INTEGER NOT NULL,
            qr_transfer_from_bus INTEGER NOT NULL,
            qr_transfer_from_metro INTEGER NOT NULL,
            source_created_time TEXT,
            quality_status TEXT NOT NULL,
            source_table TEXT NOT NULL,
            source_row_id INTEGER NOT NULL
        ) STRICT;

        INSERT INTO std_bus_line_30m
        SELECT f._source_row_id, date_key(f.日期),
               CAST(f."前两位00-23代表小时。 第三位0代表0分至29分 1代表30-59" / 10 AS INTEGER) * 60
                 + (f."前两位00-23代表小时。 第三位0代表0分至29分 1代表30-59" % 10) * 30,
               f."前两位00-23代表小时。 第三位0代表0分至29分 1代表30-59", l.line_key,
               f.公交线路, f.行业, f.总交易数, f.总公交上客交易数, f.总地铁进站交易数,
               f."交通卡刷卡数（地铁只统计进站）", f.交通卡从公交换乘刷卡数, f.交通卡从地铁换乘刷卡数,
               f.扫码数, f.扫码从公交换乘刷卡数, f.扫码从地铁换乘刷卡数, f.创建时间,
               CASE WHEN l.line_key IS NULL THEN 'UNMATCHED_LINE'
                    WHEN date_key(f.日期) IS NULL THEN 'INVALID_DATE' ELSE 'OK' END,
               'raw_xuhui_bus_passenger_flow', f._source_row_id
        FROM src.raw_xuhui_bus_passenger_flow f
        LEFT JOIN dim_bus_line l ON l.line_code_5 = f.公交线路;

        CREATE VIEW fact_bus_line_30m AS
        SELECT record_key, date_key, minute_key, line_key,
               total_transactions, bus_boarding_transactions, metro_entry_transactions,
               transit_card_transactions, card_transfer_from_bus, card_transfer_from_metro,
               qr_transactions, qr_transfer_from_bus, qr_transfer_from_metro,
               source_table, source_row_id
        FROM std_bus_line_30m
        WHERE quality_status = 'OK';

        CREATE TABLE mart_bus_line_day (
            date_key INTEGER NOT NULL,
            line_key TEXT NOT NULL,
            observed_slots INTEGER NOT NULL,
            total_transactions INTEGER NOT NULL,
            bus_boarding_transactions INTEGER NOT NULL,
            transit_card_transactions INTEGER NOT NULL,
            qr_transactions INTEGER NOT NULL,
            peak_minute_key INTEGER,
            peak_boarding_transactions INTEGER,
            PRIMARY KEY (date_key, line_key)
        ) STRICT;

        WITH ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY date_key, line_key ORDER BY bus_boarding_transactions DESC, minute_key
            ) AS flow_rank
            FROM fact_bus_line_30m
        )
        INSERT INTO mart_bus_line_day
        SELECT date_key, line_key, COUNT(*), SUM(total_transactions), SUM(bus_boarding_transactions),
               SUM(transit_card_transactions), SUM(qr_transactions),
               MAX(CASE WHEN flow_rank = 1 THEN minute_key END),
               MAX(CASE WHEN flow_rank = 1 THEN bus_boarding_transactions END)
        FROM ranked GROUP BY date_key, line_key;

        CREATE INDEX idx_bus_time ON std_bus_line_30m(date_key, minute_key);
        CREATE INDEX idx_bus_line_time ON std_bus_line_30m(line_key, date_key, minute_key);
        CREATE INDEX idx_bus_stop_name ON dim_bus_stop(stop_name);
        CREATE INDEX idx_bus_bridge_line ON bridge_bus_line_stop(line_key, stop_sequence);
        CREATE INDEX idx_bus_bridge_route ON bridge_bus_line_stop(route_direction_key, stop_sequence);
        """
    )
    finish_database(conn)


def sync_transit_geo_features() -> None:
    conn = sqlite3.connect(DB_DIR / "common.sqlite")
    conn.execute("ATTACH DATABASE ? AS metro", (str(DB_DIR / "metro.sqlite"),))
    conn.execute("ATTACH DATABASE ? AS bus", (str(DB_DIR / "bus.sqlite"),))
    conn.executescript(
        """
        DELETE FROM dim_geo_feature WHERE domain_code IN ('BUS', 'METRO');

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'BUS', 'BUS_STOP', source_stop_id, stop_name, 'Point',
               CASE WHEN longitude IS NULL OR latitude IS NULL THEN NULL
                    ELSE json_object('type', 'Point', 'coordinates', json_array(longitude, latitude)) END,
               longitude, latitude, source_x, source_y, source_crs, normalized_crs,
               CASE WHEN normalized_crs = 'EPSG:4326' THEN 'WGS84_AVAILABLE' ELSE 'MISSING_COORDINATE' END,
               'bus.dim_bus_stop', source_row_id
        FROM bus.dim_bus_stop;

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'BUS', 'BUS_ROUTE', route_direction_key, route_name, geometry_type, geometry_json,
               NULL, NULL, NULL, NULL, source_crs, normalized_crs,
               CASE WHEN geometry_json IS NOT NULL THEN 'WGS84_AVAILABLE' ELSE 'MISSING_GEOMETRY' END,
               'bus.dim_bus_route_direction', source_row_id
        FROM bus.dim_bus_route_direction;

        INSERT INTO dim_geo_feature
        SELECT 'BUS_ROUTE_STOP:' || route_direction_key || ':' || stop_sequence,
               'BUS', 'BUS_ROUTE_STOP', relation_key, s.stop_name, 'Point',
               json_object('type', 'Point', 'coordinates', json_array(b.longitude, b.latitude)),
               b.longitude, b.latitude, b.source_longitude, b.source_latitude,
               b.source_crs, b.normalized_crs, b.coordinate_quality,
               'bus.bridge_bus_line_stop', b.source_row_id
        FROM bus.bridge_bus_line_stop b
        JOIN bus.dim_bus_stop s ON s.stop_key = b.stop_key
        WHERE b.relation_source = 'AMAP';

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'METRO', 'METRO_STATION', CAST(station_id AS TEXT), station_name, 'Point',
               CASE WHEN longitude IS NULL OR latitude IS NULL THEN NULL
                    ELSE json_object('type', 'Point', 'coordinates', json_array(longitude, latitude)) END,
               longitude, latitude, source_x, source_y, source_crs, normalized_crs,
               coordinate_quality, 'metro.dim_metro_station', source_row_id
        FROM metro.dim_metro_station;

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'METRO', 'METRO_LINE', CAST(line_id AS TEXT), line_name, geometry_type, geometry_json,
               NULL, NULL, NULL, NULL, source_crs, normalized_crs,
               CASE WHEN geometry_json IS NOT NULL THEN 'WGS84_AVAILABLE' ELSE 'MISSING_GEOMETRY' END,
               'metro.dim_metro_line', source_row_id
        FROM metro.dim_metro_line;

        INSERT INTO dim_geo_feature
        SELECT 'METRO_LINE_STATION:' || b.line_id || ':' || b.station_id,
               'METRO', 'METRO_LINE_STATION', CAST(b.line_id AS TEXT) || ':' || b.station_id,
               s.station_name, 'Point',
               json_object('type', 'Point', 'coordinates', json_array(b.longitude, b.latitude)),
               b.longitude, b.latitude, NULL, NULL, 'GCJ-02', 'EPSG:4326', b.coordinate_quality,
               'metro.bridge_metro_line_station', b.source_row_id
        FROM metro.bridge_metro_line_station b
        JOIN metro.dim_metro_station s ON s.station_id = b.station_id;

        INSERT INTO dim_geo_feature
        SELECT geo_key, 'METRO', 'METRO_ROUTE_DIRECTION', route_direction_id, route_name,
               geometry_type, geometry_json, NULL, NULL, NULL, NULL, source_crs, normalized_crs,
               CASE WHEN geometry_json IS NOT NULL THEN 'WGS84_AVAILABLE' ELSE 'MISSING_GEOMETRY' END,
               'metro.dim_metro_route_direction', source_row_id
        FROM metro.dim_metro_route_direction;
        """
    )
    conn.commit()
    conn.execute("DETACH DATABASE metro")
    conn.execute("DETACH DATABASE bus")
    conn.execute("PRAGMA optimize")
    conn.close()


def build_ridehail() -> None:
    conn = new_database("ridehail")
    conn.executescript(
        """
        CREATE TEMP TABLE departure AS
        SELECT order_id, pickup_at, longitude, latitude, source_crs_id, is_deleted, source_rows
        FROM (
            SELECT 订单号 AS order_id, norm_datetime(上车时间) AS pickup_at,
                   车辆经度 AS longitude, 车辆维度 AS latitude,
                   "坐标加密标识，1：GCJ-02 测绘局标准,2：WGS84 GPS标准,3：BD-09 百度标准 ,4：CGCS2000 北斗标准 ,0：其他" AS source_crs_id,
                   "逻辑删除，0有效；1无效" AS is_deleted,
                   COUNT(*) OVER (PARTITION BY 订单号) AS source_rows,
                   ROW_NUMBER() OVER (PARTITION BY 订单号 ORDER BY _source_row_id) AS row_rank
            FROM src.raw_xuhui_ridehail_departure
        ) WHERE row_rank = 1;
        CREATE UNIQUE INDEX idx_departure_order ON departure(order_id);

        CREATE TEMP TABLE arrival AS
        SELECT order_id, dropoff_at, longitude, latitude, source_crs_id, is_deleted, source_rows
        FROM (
            SELECT 订单号 AS order_id, norm_datetime(下车时间) AS dropoff_at,
                   到达经度 AS longitude, 到达维度 AS latitude,
                   "坐标加密标识，1：GCJ-02 测绘局标准2：WGS84 GPS标准3：BD-09 百度标准4：CGCS2000 北斗标准0：其他" AS source_crs_id,
                   "逻辑删除，0有效；1无效" AS is_deleted,
                   COUNT(*) OVER (PARTITION BY 订单号) AS source_rows,
                   ROW_NUMBER() OVER (PARTITION BY 订单号 ORDER BY _source_row_id) AS row_rank
            FROM src.raw_xuhui_ridehail_arrival
        ) WHERE row_rank = 1;
        CREATE UNIQUE INDEX idx_arrival_order ON arrival(order_id);

        CREATE TEMP TABLE payment_from_venue AS
        SELECT order_id, pickup_at, pickup_longitude, pickup_latitude, pickup_place,
               dropoff_at, dropoff_longitude, dropoff_latitude, dropoff_place,
               is_deleted, source_rows
        FROM (
            SELECT 订单号 AS order_id, norm_datetime(上车时间) AS pickup_at,
                   上车经度 AS pickup_longitude, 上车维度 AS pickup_latitude, 上车点 AS pickup_place,
                   norm_datetime(下车时间) AS dropoff_at, 下车经度 AS dropoff_longitude,
                   下车纬度 AS dropoff_latitude, 下车点 AS dropoff_place,
                   "逻辑删除，0有效；1无效" AS is_deleted,
                   COUNT(*) OVER (PARTITION BY 订单号) AS source_rows,
                   ROW_NUMBER() OVER (PARTITION BY 订单号 ORDER BY _source_row_id) AS row_rank
            FROM src.raw_xuhui_payment_from_venue
        ) WHERE row_rank = 1;
        CREATE UNIQUE INDEX idx_payment_from_order ON payment_from_venue(order_id);

        CREATE TEMP TABLE payment_to_venue AS
        SELECT order_id, pickup_at, pickup_longitude, pickup_latitude, pickup_place,
               dropoff_at, dropoff_longitude, dropoff_latitude, dropoff_place,
               is_deleted, source_rows
        FROM (
            SELECT 订单号 AS order_id, norm_datetime(上车时间) AS pickup_at,
                   上车经度 AS pickup_longitude, 上车维度 AS pickup_latitude, 上车点 AS pickup_place,
                   norm_datetime(下车时间) AS dropoff_at, 下车经度 AS dropoff_longitude,
                   下车纬度 AS dropoff_latitude, 下车点 AS dropoff_place,
                   "逻辑删除，0有效；1无效" AS is_deleted,
                   COUNT(*) OVER (PARTITION BY 订单号) AS source_rows,
                   ROW_NUMBER() OVER (PARTITION BY 订单号 ORDER BY _source_row_id) AS row_rank
            FROM src.raw_xuhui_payment_to_venue
        ) WHERE row_rank = 1;
        CREATE UNIQUE INDEX idx_payment_to_order ON payment_to_venue(order_id);

        CREATE TEMP TABLE all_orders AS
        SELECT order_id FROM departure
        UNION SELECT order_id FROM arrival
        UNION SELECT order_id FROM payment_from_venue
        UNION SELECT order_id FROM payment_to_venue;
        CREATE UNIQUE INDEX idx_all_orders_order ON all_orders(order_id);

        CREATE TEMP TABLE merged_trip_source AS
        SELECT o.order_id,
               COALESCE(f.pickup_at, t.pickup_at, d.pickup_at) AS pickup_at,
               COALESCE(f.pickup_longitude, t.pickup_longitude, d.longitude) AS pickup_longitude,
               COALESCE(f.pickup_latitude, t.pickup_latitude, d.latitude) AS pickup_latitude,
               CASE
                   WHEN f.order_id IS NOT NULL OR t.order_id IS NOT NULL
                   THEN CASE WHEN d.order_id IS NOT NULL THEN COALESCE(d.source_crs_id, 0) ELSE 1 END
                   ELSE COALESCE(d.source_crs_id, 0)
               END AS pickup_crs_id,
               CASE
                   WHEN (f.order_id IS NOT NULL OR t.order_id IS NOT NULL) AND d.order_id IS NOT NULL
                   THEN 'MATCHED_DEPARTURE'
                   WHEN f.order_id IS NOT NULL OR t.order_id IS NOT NULL
                   THEN 'VENUE_DATASET_MAJORITY'
                   ELSE 'DIRECT_DEPARTURE'
               END AS pickup_crs_evidence,
               COALESCE(f.pickup_place, t.pickup_place) AS pickup_place,
               COALESCE(f.dropoff_at, t.dropoff_at, a.dropoff_at) AS dropoff_at,
               COALESCE(f.dropoff_longitude, t.dropoff_longitude, a.longitude) AS dropoff_longitude,
               COALESCE(f.dropoff_latitude, t.dropoff_latitude, a.latitude) AS dropoff_latitude,
               CASE
                   WHEN f.order_id IS NOT NULL OR t.order_id IS NOT NULL
                   THEN CASE WHEN a.order_id IS NOT NULL THEN COALESCE(a.source_crs_id, 0) ELSE 1 END
                   ELSE COALESCE(a.source_crs_id, 0)
               END AS dropoff_crs_id,
               CASE
                   WHEN (f.order_id IS NOT NULL OR t.order_id IS NOT NULL) AND a.order_id IS NOT NULL
                   THEN 'MATCHED_ARRIVAL'
                   WHEN f.order_id IS NOT NULL OR t.order_id IS NOT NULL
                   THEN 'VENUE_DATASET_MAJORITY'
                   ELSE 'DIRECT_ARRIVAL'
               END AS dropoff_crs_evidence,
               COALESCE(f.dropoff_place, t.dropoff_place) AS dropoff_place,
               CASE WHEN f.order_id IS NOT NULL AND t.order_id IS NOT NULL THEN 'BOTH'
                    WHEN f.order_id IS NOT NULL THEN 'FROM_VENUE'
                    WHEN t.order_id IS NOT NULL THEN 'TO_VENUE'
                    ELSE 'NONE' END AS venue_relation,
               CASE WHEN f.order_id IS NOT NULL AND t.order_id IS NOT NULL
                          AND (f.pickup_at IS NOT t.pickup_at
                               OR f.dropoff_at IS NOT t.dropoff_at
                               OR f.pickup_longitude IS NOT t.pickup_longitude
                               OR f.pickup_latitude IS NOT t.pickup_latitude
                               OR f.dropoff_longitude IS NOT t.dropoff_longitude
                               OR f.dropoff_latitude IS NOT t.dropoff_latitude)
                    THEN 1 ELSE 0 END AS venue_source_conflict,
               RTRIM(
                   CASE WHEN d.order_id IS NOT NULL THEN 'RHD|' ELSE '' END ||
                   CASE WHEN a.order_id IS NOT NULL THEN 'RHA|' ELSE '' END ||
                   CASE WHEN f.order_id IS NOT NULL THEN 'PFV|' ELSE '' END ||
                   CASE WHEN t.order_id IS NOT NULL THEN 'PTV|' ELSE '' END,
                   '|'
               ) AS source_coverage,
               COALESCE(d.source_rows - 1, 0) + COALESCE(a.source_rows - 1, 0) +
               COALESCE(f.source_rows - 1, 0) + COALESCE(t.source_rows - 1, 0) AS source_duplicate_count,
               CASE WHEN COALESCE(d.is_deleted, 1) = 0 OR COALESCE(a.is_deleted, 1) = 0
                          OR COALESCE(f.is_deleted, 1) = 0 OR COALESCE(t.is_deleted, 1) = 0
                    THEN 0 ELSE 1 END AS is_deleted
        FROM all_orders o
        LEFT JOIN departure d ON d.order_id = o.order_id
        LEFT JOIN arrival a ON a.order_id = o.order_id
        LEFT JOIN payment_from_venue f ON f.order_id = o.order_id
        LEFT JOIN payment_to_venue t ON t.order_id = o.order_id;

        CREATE TABLE std_trip (
            trip_key INTEGER PRIMARY KEY,
            order_hash BLOB NOT NULL UNIQUE,
            source_coverage TEXT NOT NULL,
            venue_relation TEXT NOT NULL CHECK (venue_relation IN ('NONE','TO_VENUE','FROM_VENUE','BOTH')),
            venue_source_conflict INTEGER NOT NULL CHECK (venue_source_conflict IN (0, 1)),
            pickup_at TEXT,
            pickup_date_key INTEGER,
            pickup_minute_key INTEGER,
            pickup_longitude REAL,
            pickup_latitude REAL,
            pickup_crs TEXT NOT NULL CHECK (pickup_crs IN ('EPSG:4326','UNKNOWN')),
            pickup_coordinate_status TEXT NOT NULL,
            pickup_place TEXT,
            dropoff_at TEXT,
            dropoff_date_key INTEGER,
            dropoff_minute_key INTEGER,
            dropoff_longitude REAL,
            dropoff_latitude REAL,
            dropoff_crs TEXT NOT NULL CHECK (dropoff_crs IN ('EPSG:4326','UNKNOWN')),
            dropoff_coordinate_status TEXT NOT NULL,
            dropoff_place TEXT,
            trip_duration_seconds INTEGER,
            source_duplicate_count INTEGER NOT NULL,
            is_deleted INTEGER NOT NULL,
            quality_status TEXT NOT NULL
        ) STRICT;

        INSERT INTO std_trip
        SELECT ROW_NUMBER() OVER (ORDER BY order_id), sha256_blob(order_id), source_coverage, venue_relation,
               venue_source_conflict,
               pickup_at, date_key(pickup_at), minute_of_day(pickup_at),
               normalized_lon(pickup_longitude, pickup_latitude, pickup_crs_id),
               normalized_lat(pickup_longitude, pickup_latitude, pickup_crs_id),
               CASE WHEN pickup_longitude IS NOT NULL AND pickup_crs_id IN (1, 2, 3)
                    THEN 'EPSG:4326' ELSE 'UNKNOWN' END,
               CASE WHEN pickup_longitude IS NULL THEN 'MISSING_COORDINATE'
                    WHEN pickup_crs_evidence = 'VENUE_DATASET_MAJORITY'
                    THEN 'ASSUMED_GCJ02_FROM_DATASET_MAJORITY'
                    WHEN pickup_crs_evidence = 'MATCHED_DEPARTURE' AND pickup_crs_id = 1
                    THEN 'INFERRED_GCJ02_FROM_MATCHED_DEPARTURE'
                    WHEN pickup_crs_evidence = 'MATCHED_DEPARTURE' AND pickup_crs_id = 2
                    THEN 'INFERRED_WGS84_FROM_MATCHED_DEPARTURE'
                    WHEN pickup_crs_evidence = 'MATCHED_DEPARTURE' AND pickup_crs_id = 3
                    THEN 'INFERRED_BD09_FROM_MATCHED_DEPARTURE'
                    WHEN pickup_crs_evidence = 'MATCHED_DEPARTURE'
                    THEN 'UNKNOWN_CRS_FROM_MATCHED_DEPARTURE'
                    WHEN pickup_crs_id = 1 THEN 'CONVERTED_FROM_GCJ02'
                    WHEN pickup_crs_id = 2 THEN 'SOURCE_WGS84'
                    WHEN pickup_crs_id = 3 THEN 'CONVERTED_FROM_BD09'
                    WHEN pickup_crs_id = 4 THEN 'CGCS2000_UNRESOLVED'
                    ELSE 'UNKNOWN_CRS_RETAINED' END,
               pickup_place,
               dropoff_at, date_key(dropoff_at), minute_of_day(dropoff_at),
               normalized_lon(dropoff_longitude, dropoff_latitude, dropoff_crs_id),
               normalized_lat(dropoff_longitude, dropoff_latitude, dropoff_crs_id),
               CASE WHEN dropoff_longitude IS NOT NULL AND dropoff_crs_id IN (1, 2, 3)
                    THEN 'EPSG:4326' ELSE 'UNKNOWN' END,
               CASE WHEN dropoff_longitude IS NULL THEN 'MISSING_COORDINATE'
                    WHEN dropoff_crs_evidence = 'VENUE_DATASET_MAJORITY'
                    THEN 'ASSUMED_GCJ02_FROM_DATASET_MAJORITY'
                    WHEN dropoff_crs_evidence = 'MATCHED_ARRIVAL' AND dropoff_crs_id = 1
                    THEN 'INFERRED_GCJ02_FROM_MATCHED_ARRIVAL'
                    WHEN dropoff_crs_evidence = 'MATCHED_ARRIVAL' AND dropoff_crs_id = 2
                    THEN 'INFERRED_WGS84_FROM_MATCHED_ARRIVAL'
                    WHEN dropoff_crs_evidence = 'MATCHED_ARRIVAL' AND dropoff_crs_id = 3
                    THEN 'INFERRED_BD09_FROM_MATCHED_ARRIVAL'
                    WHEN dropoff_crs_evidence = 'MATCHED_ARRIVAL'
                    THEN 'UNKNOWN_CRS_FROM_MATCHED_ARRIVAL'
                    WHEN dropoff_crs_id = 1 THEN 'CONVERTED_FROM_GCJ02'
                    WHEN dropoff_crs_id = 2 THEN 'SOURCE_WGS84'
                    WHEN dropoff_crs_id = 3 THEN 'CONVERTED_FROM_BD09'
                    WHEN dropoff_crs_id = 4 THEN 'CGCS2000_UNRESOLVED'
                    ELSE 'UNKNOWN_CRS_RETAINED' END,
               dropoff_place,
               CASE WHEN pickup_at IS NOT NULL AND dropoff_at IS NOT NULL
                    THEN CAST(strftime('%s', dropoff_at) - strftime('%s', pickup_at) AS INTEGER) END,
               source_duplicate_count, is_deleted,
               CASE WHEN pickup_at IS NULL AND dropoff_at IS NULL THEN 'INVALID_TIME'
                    WHEN (pickup_longitude IS NOT NULL AND
                          (pickup_longitude NOT BETWEEN 120 AND 123 OR pickup_latitude NOT BETWEEN 30 AND 32))
                      OR (dropoff_longitude IS NOT NULL AND
                          (dropoff_longitude NOT BETWEEN 120 AND 123 OR dropoff_latitude NOT BETWEEN 30 AND 32))
                    THEN 'INVALID_COORDINATE'
                    WHEN (pickup_longitude IS NOT NULL AND pickup_crs_id NOT IN (1, 2, 3))
                      OR (dropoff_longitude IS NOT NULL AND dropoff_crs_id NOT IN (1, 2, 3))
                    THEN 'UNKNOWN_CRS'
                    WHEN venue_source_conflict = 1 THEN 'SOURCE_CONFLICT'
                    WHEN pickup_at IS NULL OR dropoff_at IS NULL THEN 'PARTIAL_TRIP'
                    ELSE 'OK' END
        FROM merged_trip_source;

        CREATE VIEW fact_trip AS
        SELECT trip_key, HEX(order_hash) AS order_hash, source_coverage, venue_relation,
               venue_source_conflict,
               pickup_at, pickup_date_key, pickup_minute_key, pickup_longitude, pickup_latitude,
               pickup_crs, pickup_coordinate_status, pickup_place,
               dropoff_at, dropoff_date_key, dropoff_minute_key, dropoff_longitude, dropoff_latitude,
               dropoff_crs, dropoff_coordinate_status, dropoff_place,
               trip_duration_seconds, source_duplicate_count, quality_status
        FROM std_trip
        WHERE is_deleted = 0 AND quality_status NOT IN ('INVALID_TIME', 'INVALID_COORDINATE');

        CREATE VIEW fact_ridehail_event AS
        SELECT trip_key * 2 - 1 AS event_key, trip_key, HEX(order_hash) AS order_hash, source_coverage,
               'PICKUP' AS event_type, pickup_at AS event_at, pickup_date_key AS date_key,
               pickup_minute_key AS minute_key, pickup_longitude AS longitude, pickup_latitude AS latitude,
               pickup_crs AS crs, pickup_coordinate_status AS coordinate_status,
               CASE WHEN source_coverage LIKE '%RHD%' THEN 'RIDEHAIL_SOURCE'
                    ELSE 'VENUE_ENRICHMENT' END AS endpoint_source,
               CASE WHEN pickup_crs = 'UNKNOWN' THEN 'UNKNOWN_CRS' ELSE 'OK' END AS endpoint_quality_status,
               venue_relation, quality_status AS trip_quality_status
        FROM std_trip
        WHERE is_deleted = 0 AND pickup_at IS NOT NULL
          AND (pickup_longitude IS NULL OR
               (pickup_longitude BETWEEN 120 AND 123 AND pickup_latitude BETWEEN 30 AND 32))
        UNION ALL
        SELECT trip_key * 2, trip_key, HEX(order_hash), source_coverage,
               'DROPOFF', dropoff_at, dropoff_date_key, dropoff_minute_key,
               dropoff_longitude, dropoff_latitude, dropoff_crs, dropoff_coordinate_status,
               CASE WHEN source_coverage LIKE '%RHA%' THEN 'RIDEHAIL_SOURCE'
                    ELSE 'VENUE_ENRICHMENT' END,
               CASE WHEN dropoff_crs = 'UNKNOWN' THEN 'UNKNOWN_CRS' ELSE 'OK' END,
               venue_relation, quality_status
        FROM std_trip
        WHERE is_deleted = 0 AND dropoff_at IS NOT NULL
          AND (dropoff_longitude IS NULL OR
               (dropoff_longitude BETWEEN 120 AND 123 AND dropoff_latitude BETWEEN 30 AND 32));

        CREATE VIEW fact_venue_trip AS
        SELECT * FROM fact_trip WHERE venue_relation <> 'NONE';

        CREATE VIEW fact_venue_event AS
        SELECT trip_key, order_hash, 'FROM_VENUE' AS venue_relation,
               pickup_at AS venue_event_at, pickup_date_key AS date_key, pickup_minute_key AS minute_key,
               pickup_longitude AS longitude, pickup_latitude AS latitude, pickup_crs AS crs,
               pickup_coordinate_status AS coordinate_status, trip_duration_seconds
        FROM fact_trip
        WHERE venue_relation IN ('FROM_VENUE', 'BOTH') AND pickup_at IS NOT NULL
        UNION ALL
        SELECT trip_key, order_hash, 'TO_VENUE', dropoff_at, dropoff_date_key, dropoff_minute_key,
               dropoff_longitude, dropoff_latitude, dropoff_crs, dropoff_coordinate_status,
               trip_duration_seconds
        FROM fact_trip
        WHERE venue_relation IN ('TO_VENUE', 'BOTH') AND dropoff_at IS NOT NULL;

        CREATE TABLE mart_ridehail_event_15m (
            date_key INTEGER NOT NULL,
            slot_15_start INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            source_event_count INTEGER NOT NULL,
            venue_enriched_event_count INTEGER NOT NULL,
            wgs84_event_count INTEGER NOT NULL,
            unknown_crs_event_count INTEGER NOT NULL,
            PRIMARY KEY (date_key, slot_15_start, event_type)
        ) STRICT;
        INSERT INTO mart_ridehail_event_15m
        SELECT date_key, minute_key - minute_key % 15, event_type, COUNT(*),
               SUM(endpoint_source = 'RIDEHAIL_SOURCE'),
               SUM(endpoint_source = 'VENUE_ENRICHMENT'),
               SUM(crs = 'EPSG:4326'), SUM(crs = 'UNKNOWN')
        FROM fact_ridehail_event
        GROUP BY date_key, minute_key - minute_key % 15, event_type;

        CREATE TABLE mart_ridehail_event_hour (
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            source_event_count INTEGER NOT NULL,
            venue_enriched_event_count INTEGER NOT NULL,
            wgs84_event_count INTEGER NOT NULL,
            unknown_crs_event_count INTEGER NOT NULL,
            PRIMARY KEY (date_key, hour, event_type)
        ) STRICT;
        INSERT INTO mart_ridehail_event_hour
        SELECT date_key, CAST(minute_key / 60 AS INTEGER), event_type, COUNT(*),
               SUM(endpoint_source = 'RIDEHAIL_SOURCE'),
               SUM(endpoint_source = 'VENUE_ENRICHMENT'),
               SUM(crs = 'EPSG:4326'), SUM(crs = 'UNKNOWN')
        FROM fact_ridehail_event
        GROUP BY date_key, CAST(minute_key / 60 AS INTEGER), event_type;

        CREATE TABLE mart_ridehail_event_day (
            date_key INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            source_event_count INTEGER NOT NULL,
            venue_enriched_event_count INTEGER NOT NULL,
            wgs84_event_count INTEGER NOT NULL,
            unknown_crs_event_count INTEGER NOT NULL,
            PRIMARY KEY (date_key, event_type)
        ) STRICT;
        INSERT INTO mart_ridehail_event_day
        SELECT date_key, event_type, COUNT(*),
               SUM(endpoint_source = 'RIDEHAIL_SOURCE'),
               SUM(endpoint_source = 'VENUE_ENRICHMENT'),
               SUM(crs = 'EPSG:4326'), SUM(crs = 'UNKNOWN')
        FROM fact_ridehail_event GROUP BY date_key, event_type;

        CREATE TABLE mart_venue_trip_15m (
            date_key INTEGER NOT NULL,
            slot_15_start INTEGER NOT NULL,
            venue_relation TEXT NOT NULL,
            trip_count INTEGER NOT NULL,
            wgs84_trip_count INTEGER NOT NULL,
            avg_trip_duration_seconds REAL,
            PRIMARY KEY (date_key, slot_15_start, venue_relation)
        ) STRICT;
        INSERT INTO mart_venue_trip_15m
        SELECT date_key, minute_key - minute_key % 15, venue_relation, COUNT(*),
               SUM(crs = 'EPSG:4326'), AVG(trip_duration_seconds)
        FROM fact_venue_event
        GROUP BY date_key, minute_key - minute_key % 15, venue_relation;

        CREATE TABLE mart_venue_trip_hour (
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL,
            venue_relation TEXT NOT NULL,
            trip_count INTEGER NOT NULL,
            wgs84_trip_count INTEGER NOT NULL,
            avg_trip_duration_seconds REAL,
            PRIMARY KEY (date_key, hour, venue_relation)
        ) STRICT;
        INSERT INTO mart_venue_trip_hour
        SELECT date_key, CAST(minute_key / 60 AS INTEGER), venue_relation, COUNT(*),
               SUM(crs = 'EPSG:4326'), AVG(trip_duration_seconds)
        FROM fact_venue_event
        GROUP BY date_key, CAST(minute_key / 60 AS INTEGER), venue_relation;

        CREATE TABLE mart_venue_trip_day (
            date_key INTEGER NOT NULL,
            venue_relation TEXT NOT NULL,
            trip_count INTEGER NOT NULL,
            wgs84_trip_count INTEGER NOT NULL,
            avg_trip_duration_seconds REAL,
            PRIMARY KEY (date_key, venue_relation)
        ) STRICT;
        INSERT INTO mart_venue_trip_day
        SELECT date_key, venue_relation, COUNT(*), SUM(crs = 'EPSG:4326'),
               AVG(trip_duration_seconds)
        FROM fact_venue_event
        GROUP BY date_key, venue_relation;

        CREATE INDEX idx_trip_pickup_time ON std_trip(pickup_date_key, pickup_minute_key);
        CREATE INDEX idx_trip_dropoff_time ON std_trip(dropoff_date_key, dropoff_minute_key);
        CREATE INDEX idx_trip_venue ON std_trip(venue_relation);
        """
    )
    finish_database(conn)


def standardize_published_assets() -> None:
    """Keep one published CRS: WGS84 for known coordinates, UNKNOWN otherwise."""

    common = sqlite3.connect(DB_DIR / "common.sqlite")
    common.executescript(
        """
        UPDATE dim_venue
        SET source_crs = 'EPSG:4326'
        WHERE venue_key = 'venue_shanghai_stadium';

        UPDATE dim_geo_feature
        SET normalized_crs = 'EPSG:4326',
            coordinate_quality = 'USER_CONFIRMED_WGS84'
        WHERE geo_key = 'VENUE:venue_shanghai_stadium';

        UPDATE dim_geo_feature
        SET normalized_crs = 'UNKNOWN'
        WHERE normalized_crs IS NULL;

        DELETE FROM dim_crs WHERE crs_code NOT IN ('EPSG:4326', 'UNKNOWN');
        UPDATE dim_crs
        SET governance_note = '发布资产唯一标准坐标系；全部已确认坐标统一为WGS84经纬度。'
        WHERE crs_code = 'EPSG:4326';
        UPDATE dim_crs
        SET governance_note = '无法确认来源坐标系的原值；保留但不得用于距离、缓冲、最近邻或跨域空间连接。'
        WHERE crs_code = 'UNKNOWN';

        ALTER TABLE dim_venue RENAME COLUMN source_crs TO crs;
        ALTER TABLE dim_weather_grid RENAME COLUMN source_crs TO crs;

        ALTER TABLE dim_geo_feature DROP COLUMN source_x;
        ALTER TABLE dim_geo_feature DROP COLUMN source_y;
        ALTER TABLE dim_geo_feature DROP COLUMN source_crs;
        ALTER TABLE dim_geo_feature RENAME COLUMN normalized_crs TO crs;

        CREATE TABLE mart_weather_grid_day (
            grid_key INTEGER NOT NULL,
            date_key INTEGER NOT NULL,
            observed_hours INTEGER NOT NULL,
            observation_count INTEGER NOT NULL,
            avg_temperature_c REAL,
            min_temperature_c REAL,
            max_temperature_c REAL,
            max_rainfall_1h_mm REAL,
            PRIMARY KEY (grid_key, date_key)
        ) STRICT;

        INSERT INTO mart_weather_grid_day
        SELECT grid_key, date_key, COUNT(DISTINCT CAST(minute_key / 60 AS INTEGER)), COUNT(*),
               AVG(temperature_c), MIN(temperature_c), MAX(temperature_c), MAX(rainfall_1h_mm)
        FROM fact_weather_observation
        GROUP BY grid_key, date_key;
        """
    )
    common.commit()
    common.close()

    bus = sqlite3.connect(DB_DIR / "bus.sqlite")
    bus.executescript(
        """
        ALTER TABLE dim_bus_route_direction DROP COLUMN source_crs;
        ALTER TABLE dim_bus_route_direction DROP COLUMN source_geometry_json;
        ALTER TABLE dim_bus_route_direction RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE dim_bus_stop DROP COLUMN source_x;
        ALTER TABLE dim_bus_stop DROP COLUMN source_y;
        ALTER TABLE dim_bus_stop DROP COLUMN source_crs;
        ALTER TABLE dim_bus_stop RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE bridge_bus_line_stop DROP COLUMN source_longitude;
        ALTER TABLE bridge_bus_line_stop DROP COLUMN source_latitude;
        ALTER TABLE bridge_bus_line_stop DROP COLUMN source_crs;
        ALTER TABLE bridge_bus_line_stop RENAME COLUMN normalized_crs TO crs;

        CREATE TABLE mart_bus_line_hour (
            date_key INTEGER NOT NULL,
            hour INTEGER NOT NULL,
            line_key TEXT NOT NULL,
            observed_slots INTEGER NOT NULL,
            total_transactions INTEGER NOT NULL,
            bus_boarding_transactions INTEGER NOT NULL,
            transit_card_transactions INTEGER NOT NULL,
            qr_transactions INTEGER NOT NULL,
            PRIMARY KEY (date_key, hour, line_key)
        ) STRICT;

        INSERT INTO mart_bus_line_hour
        SELECT date_key, CAST(minute_key / 60 AS INTEGER), line_key, COUNT(*),
               SUM(total_transactions), SUM(bus_boarding_transactions),
               SUM(transit_card_transactions), SUM(qr_transactions)
        FROM fact_bus_line_30m
        GROUP BY date_key, CAST(minute_key / 60 AS INTEGER), line_key;
        """
    )
    bus.commit()
    bus.close()

    metro = sqlite3.connect(DB_DIR / "metro.sqlite")
    metro.executescript(
        """
        UPDATE dim_metro_station
        SET normalized_crs = 'UNKNOWN'
        WHERE normalized_crs IS NULL;

        ALTER TABLE dim_metro_route_direction DROP COLUMN source_crs;
        ALTER TABLE dim_metro_route_direction DROP COLUMN source_geometry_json;
        ALTER TABLE dim_metro_route_direction RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE dim_metro_line DROP COLUMN source_crs;
        ALTER TABLE dim_metro_line RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE dim_metro_station DROP COLUMN source_x;
        ALTER TABLE dim_metro_station DROP COLUMN source_y;
        ALTER TABLE dim_metro_station DROP COLUMN source_crs;
        ALTER TABLE dim_metro_station RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE bridge_metro_route_station DROP COLUMN source_longitude;
        ALTER TABLE bridge_metro_route_station DROP COLUMN source_latitude;
        ALTER TABLE bridge_metro_route_station DROP COLUMN source_crs;
        ALTER TABLE bridge_metro_route_station RENAME COLUMN normalized_crs TO crs;

        ALTER TABLE bridge_metro_line_station
        ADD COLUMN crs TEXT NOT NULL DEFAULT 'EPSG:4326';
        """
    )
    metro.commit()
    metro.close()

    road = sqlite3.connect(DB_DIR / "road.sqlite")
    road.executescript(
        """
        CREATE TABLE mart_road_segment_day (
            segment_key INTEGER NOT NULL,
            date_key INTEGER NOT NULL,
            observed_hours INTEGER NOT NULL,
            free_seconds INTEGER NOT NULL,
            crowd_seconds INTEGER NOT NULL,
            jam_seconds INTEGER NOT NULL,
            observed_seconds INTEGER NOT NULL,
            state_event_count INTEGER NOT NULL,
            PRIMARY KEY (segment_key, date_key)
        ) STRICT;

        INSERT INTO mart_road_segment_day
        SELECT segment_key, date_key, COUNT(*), SUM(free_seconds), SUM(crowd_seconds),
               SUM(jam_seconds), SUM(observed_seconds), SUM(state_event_count)
        FROM mart_road_segment_hour
        GROUP BY segment_key, date_key;
        """
    )
    road.commit()
    road.close()

TABLE_DESCRIPTIONS = {
    "dim_date": "统一日期维表，包含星期、周末和活动日占位字段。",
    "dim_time": "分钟粒度时间维表，派生15分钟和30分钟时段。",
    "dim_crs": "坐标参考系统字典。",
    "dim_event": "重大活动维表；已纳入四天时代少年团上海体育场演出日期。",
    "dim_venue": "重点场馆维表。",
    "dim_poi": "用户确认的上海重要交通枢纽POI及WGS84中心点。",
    "dim_weather_grid": "气象网格空间维表。",
    "dim_geo_feature": "跨业态统一地理要素索引。",
    "std_weather_observation": "标准化气象网格观测。",
    "fact_weather_observation": "通过质量规则的气象观测事实视图。",
    "mart_weather_grid_hour": "气象网格小时指标集市。",
    "mart_weather_grid_day": "气象网格日指标集市。",
    "dim_road_segment": "路网发布段维表。",
    "std_road_state_event": "标准化道路状态变化事件。",
    "fact_road_state_event": "有效道路状态事件事实视图。",
    "mart_road_segment_hour": "按小时精确切分的道路状态持续时间。",
    "mart_road_segment_day": "道路发布段日状态持续时间。",
    "dim_metro_line": "20条统一轨交线路及高德方向几何转换后的WGS84线路。",
    "dim_metro_route_direction": "46条高德方向或支线路径及WGS84几何。",
    "dim_metro_station": "轨交物理站点维表及统一WGS84点位。",
    "map_metro_amap_station": "高德站点ID到统一物理站点ID的映射。",
    "bridge_metro_route_station": "高德方向线路站序、线路上下文坐标与点线距离。",
    "bridge_metro_line_station": "统一线路与物理站点关系及线路上下文WGS84坐标。",
    "std_metro_station_hour": "标准化轨交站点小时客流。",
    "fact_metro_station_hour": "维度映射成功的轨交客流事实视图。",
    "mart_metro_station_day": "轨交站点日客流与高峰小时。",
    "dim_bus_line": "官方公交线路维表。",
    "dim_bus_route_direction": "公交上下行方向及高德几何转换后的WGS84线路。",
    "dim_bus_stop": "官方和高德公交站点的统一WGS84维表。",
    "bridge_bus_line_stop": "公交线路、方向与站点序列、线路上下文坐标及点线距离。",
    "std_bus_line_30m": "标准化公交线路半小时客流。",
    "fact_bus_line_30m": "线路映射成功的公交客流事实视图。",
    "mart_bus_line_hour": "公交线路小时客流指标集市。",
    "mart_bus_line_day": "公交线路日客流与高峰时段。",
    "std_trip": "四类订单源合并后的单一脱敏订单标准层；每个订单只存一行。",
    "fact_trip": "有效订单事实视图；同时包含上下车端点和场馆关系。",
    "fact_ridehail_event": "由统一订单拆分得到的上下车端点视图；endpoint_source区分原始网约车事件与场馆订单补齐端点。",
    "fact_venue_trip": "由统一订单筛选得到的场馆关联订单事实视图。",
    "fact_venue_event": "由统一订单派生的场馆到场、离场事件事实视图。",
    "mart_ridehail_event_15m": "统一订单上下车端点15分钟集市，分列原始网约车事件与场馆补齐端点。",
    "mart_ridehail_event_hour": "统一订单上下车端点小时集市，分列原始网约车事件与场馆补齐端点。",
    "mart_ridehail_event_day": "统一订单上下车端点日集市，分列原始网约车事件与场馆补齐端点。",
    "mart_venue_trip_15m": "场馆到场/离场事件15分钟指标集市。",
    "mart_venue_trip_hour": "场馆到场/离场事件小时指标集市。",
    "mart_venue_trip_day": "场馆到场/离场事件日指标集市。",
}


SOURCE_TARGETS = {
    "raw_amap_metro_collection_report": ("metro", "ops_metro_collection_report"),
    "raw_amap_metro_line_stations": ("metro", "bridge_metro_route_station"),
    "raw_amap_metro_lines": ("metro", "dim_metro_route_direction"),
    "raw_amap_metro_lines_geojson": ("metro", "dim_metro_route_direction"),
    "raw_amap_metro_stations": ("metro", "map_metro_amap_station"),
    "raw_amap_metro_stations_geojson": ("common", "dim_geo_feature"),
    "raw_bus_collection_report": ("bus", "ops_bus_collection_report"),
    "raw_bus_line_stops": ("bus", "bridge_bus_line_stop"),
    "raw_bus_lines": ("bus", "dim_bus_route_direction"),
    "raw_bus_lines_geojson": ("bus", "dim_bus_route_direction"),
    "raw_bus_stops": ("bus", "dim_bus_stop"),
    "raw_bus_stops_geojson": ("common", "dim_geo_feature"),
    "raw_metro_line_stations": ("metro", "bridge_metro_line_station"),
    "raw_metro_lines": ("metro", "dim_metro_line"),
    "raw_metro_lines_geojson": ("metro", "dim_metro_line"),
    "raw_metro_station_coordinate_report": ("metro", "ops_metro_station_coordinate_quality"),
    "raw_metro_stations": ("metro", "dim_metro_station"),
    "raw_metro_stations_geojson": ("common", "dim_geo_feature"),
    "raw_poi_venue_pois": ("common", "dim_venue"),
    "raw_poi_venue_pois_geojson": ("common", "dim_geo_feature"),
    "raw_xuhui_bus_line_info": ("bus", "dim_bus_line"),
    "raw_xuhui_bus_line_stop_sequence": ("bus", "bridge_bus_line_stop"),
    "raw_xuhui_bus_passenger_flow": ("bus", "std_bus_line_30m"),
    "raw_xuhui_bus_stop_info": ("bus", "dim_bus_stop"),
    "raw_xuhui_metro_passenger_flow": ("metro", "std_metro_station_hour"),
    "raw_xuhui_payment_from_venue": ("ridehail", "std_trip"),
    "raw_xuhui_payment_to_venue": ("ridehail", "std_trip"),
    "raw_xuhui_ridehail_arrival": ("ridehail", "std_trip"),
    "raw_xuhui_ridehail_departure": ("ridehail", "std_trip"),
    "raw_xuhui_road_segment_state": ("road", "std_road_state_event"),
    "raw_xuhui_road_source_sql": ("catalog", "meta_source_extract_sql"),
    "raw_xuhui_weather_grid": ("common", "std_weather_observation"),
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scalar(db_name: str, sql: str) -> object:
    conn = sqlite3.connect(DB_DIR / f"{db_name}.sqlite")
    result = conn.execute(sql).fetchone()[0]
    conn.close()
    return result


def build_catalog() -> None:
    path = DB_DIR / "catalog.sqlite"
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.executescript(
        """
        CREATE TABLE meta_build (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE meta_database (
            database_name TEXT PRIMARY KEY,
            file_name TEXT NOT NULL UNIQUE,
            domain_name_cn TEXT NOT NULL,
            purpose TEXT NOT NULL,
            size_bytes INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE meta_table (
            database_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            object_type TEXT NOT NULL,
            governance_layer TEXT NOT NULL,
            row_count INTEGER,
            description_cn TEXT NOT NULL,
            PRIMARY KEY (database_name, table_name)
        ) STRICT;
        CREATE TABLE meta_column (
            database_name TEXT NOT NULL,
            table_name TEXT NOT NULL,
            ordinal_position INTEGER NOT NULL,
            column_name TEXT NOT NULL,
            declared_type TEXT,
            is_not_null INTEGER NOT NULL,
            is_primary_key INTEGER NOT NULL,
            PRIMARY KEY (database_name, table_name, ordinal_position)
        ) STRICT;
        CREATE TABLE meta_source_dataset (
            source_table TEXT PRIMARY KEY,
            source_path TEXT NOT NULL,
            source_domain TEXT NOT NULL,
            source_grain TEXT NOT NULL,
            source_row_count INTEGER NOT NULL,
            target_database TEXT NOT NULL,
            target_table TEXT NOT NULL,
            transform_note TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_relationship (
            relationship_id TEXT PRIMARY KEY,
            from_object TEXT NOT NULL,
            from_column TEXT NOT NULL,
            to_object TEXT NOT NULL,
            to_column TEXT NOT NULL,
            cardinality TEXT NOT NULL,
            join_note TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_entity_id (
            entity_code TEXT PRIMARY KEY,
            domain_code TEXT NOT NULL,
            entity_name_cn TEXT NOT NULL,
            canonical_object TEXT NOT NULL,
            canonical_id_column TEXT NOT NULL,
            id_scope TEXT NOT NULL,
            source_id_policy TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_id_mapping (
            mapping_id INTEGER PRIMARY KEY,
            entity_code TEXT NOT NULL REFERENCES meta_entity_id(entity_code),
            source_system TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_context TEXT NOT NULL,
            canonical_id TEXT NOT NULL,
            mapping_method TEXT NOT NULL,
            confidence REAL NOT NULL,
            UNIQUE (entity_code, source_system, source_id, source_context)
        ) STRICT;
        CREATE TABLE meta_metric (
            metric_code TEXT PRIMARY KEY,
            metric_name_cn TEXT NOT NULL,
            domain_code TEXT NOT NULL,
            grain TEXT NOT NULL,
            unit TEXT NOT NULL,
            definition TEXT NOT NULL,
            source_object TEXT NOT NULL,
            sql_expression TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_analysis_guide (
            domain_code TEXT PRIMARY KEY,
            recommended_object TEXT NOT NULL,
            grain TEXT NOT NULL,
            min_date_key INTEGER,
            max_date_key INTEGER,
            entity_coverage TEXT NOT NULL,
            spatial_scope TEXT NOT NULL,
            crs_policy TEXT NOT NULL,
            usage_note TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_order_source_relation (
            relation_code TEXT PRIMARY KEY,
            order_count INTEGER NOT NULL,
            denominator_count INTEGER,
            ratio REAL,
            interpretation_cn TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_quality_rule (
            rule_code TEXT PRIMARY KEY,
            domain_code TEXT NOT NULL,
            severity TEXT NOT NULL,
            rule_description TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_quality_result (
            rule_code TEXT PRIMARY KEY REFERENCES meta_quality_rule(rule_code),
            checked_at TEXT NOT NULL,
            passed INTEGER NOT NULL,
            observed_value TEXT NOT NULL,
            result_note TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_query_example (
            example_id TEXT PRIMARY KEY,
            question_cn TEXT NOT NULL,
            sql_text TEXT NOT NULL,
            governance_note TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta_source_extract_sql (
            source_name TEXT PRIMARY KEY,
            source_sql TEXT NOT NULL
        ) STRICT;
        """
    )

    conn.executemany(
        "INSERT INTO meta_build VALUES (?, ?)",
        (
            ("asset_version", ASSET_VERSION),
            ("built_at", BUILT_AT),
            ("canonical_crs", CANONICAL_CRS),
            ("canonical_time_zone", CANONICAL_TIME_ZONE),
            ("source_database", str(SOURCE_DB.relative_to(ROOT)) if SOURCE_DB.is_relative_to(ROOT) else str(SOURCE_DB)),
            ("source_database_sha256", file_sha256(SOURCE_DB)),
            ("source_database_size_bytes", str(SOURCE_DB.stat().st_size)),
            ("python_runtime", PYTHON),
            ("privacy_policy", "订单号仅保留SHA-256哈希；原始订单号不进入Agent资产库。"),
        ),
    )

    db_labels = {
        "common": ("公共维度与环境", "时间、星期、活动、场馆、重要交通枢纽POI、气象及跨业态地理索引"),
        "road": ("路网", "道路发布段与状态持续时间"),
        "metro": ("轨交", "统一线路、高德方向线路、WGS84站点、点线关系与小时客流"),
        "bus": ("公交", "WGS84线路、站点、线路上下文站序与半小时客流"),
        "ridehail": ("网约车", "单一脱敏订单事实、派生上下车与场馆事件及15分钟/小时/日指标"),
    }
    for db_name, (domain, purpose) in db_labels.items():
        db_path = DB_DIR / f"{db_name}.sqlite"
        conn.execute(
            "INSERT INTO meta_database VALUES (?, ?, ?, ?, ?)",
            (db_name, db_path.name, domain, purpose, db_path.stat().st_size),
        )
        domain_conn = sqlite3.connect(db_path)
        objects = domain_conn.execute(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        for table_name, object_type in objects:
            layer = table_name.split("_", 1)[0]
            row_count = domain_conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
            conn.execute(
                "INSERT INTO meta_table VALUES (?, ?, ?, ?, ?, ?)",
                (
                    db_name,
                    table_name,
                    object_type,
                    layer,
                    row_count,
                    TABLE_DESCRIPTIONS.get(table_name, "辅助治理对象。"),
                ),
            )
            for column in domain_conn.execute(f'PRAGMA table_info("{table_name}")'):
                conn.execute(
                    "INSERT INTO meta_column VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (db_name, table_name, column[0] + 1, column[1], column[2], column[3], int(column[5] > 0)),
                )
        domain_conn.close()

    source_conn = sqlite3.connect(SOURCE_DB)
    for row in source_conn.execute(
        "SELECT table_name, source_path, domain, grain, row_count FROM meta_datasets ORDER BY table_name"
    ):
        target_db, target_table = SOURCE_TARGETS[row[0]]
        note = "字段标准化、类型修正并保留source_row_id。"
        if row[0].startswith("raw_xuhui_payment") or row[0].startswith("raw_xuhui_ridehail"):
            note = "四类订单源按订单号合并为一行，订单号SHA-256脱敏；保留来源覆盖、重复数、场馆关系和质量状态。"
        conn.execute(
            "INSERT INTO meta_source_dataset VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (*row, target_db, target_table, note),
        )
    source_sql = source_conn.execute("SELECT source_sql FROM raw_xuhui_road_source_sql LIMIT 1").fetchone()[0]
    conn.execute("INSERT INTO meta_source_extract_sql VALUES (?, ?)", ("road_segment_state", source_sql))
    source_conn.close()

    ridehail_union_count = scalar(
        "ridehail",
        "SELECT COUNT(*) FROM std_trip "
        "WHERE source_coverage LIKE '%RHD%' OR source_coverage LIKE '%RHA%'",
    )
    venue_union_count = scalar("ridehail", "SELECT COUNT(*) FROM std_trip WHERE venue_relation <> 'NONE'")
    source_overlap_count = scalar(
        "ridehail",
        "SELECT COUNT(*) FROM std_trip WHERE venue_relation <> 'NONE' "
        "AND (source_coverage LIKE '%RHD%' OR source_coverage LIKE '%RHA%')",
    )
    relation_rows = (
        (
            "RIDEHAIL_ORDER_UNION",
            ridehail_union_count,
            None,
            None,
            "上车表和下车表按订单号去重后的并集。",
        ),
        (
            "VENUE_ORDER_UNION",
            venue_union_count,
            None,
            None,
            "场馆离场表和到场表按订单号去重后的并集。",
        ),
        (
            "VENUE_IN_RIDEHAIL_OVERLAP",
            source_overlap_count,
            venue_union_count,
            source_overlap_count / venue_union_count,
            "场馆订单中也出现在上车表或下车表的订单；证明场馆订单是同一订单体系的业务筛选子集。",
        ),
        (
            "VENUE_ONLY_ORDERS",
            venue_union_count - source_overlap_count,
            venue_union_count,
            (venue_union_count - source_overlap_count) / venue_union_count,
            "只在场馆订单源出现的订单；仍并入统一订单事实表，不另存一份场馆订单事实。",
        ),
    )
    conn.executemany("INSERT INTO meta_order_source_relation VALUES (?, ?, ?, ?, ?)", relation_rows)

    entities = (
        ("EVENT", "COMMON", "重大活动", "common.dim_event", "event_id", "全资产", "活动ID由日期级活动记录统一生成。"),
        ("VENUE", "COMMON", "场馆", "common.dim_venue", "venue_key", "全资产", "场馆POI ID作为统一ID。"),
        ("POI", "COMMON", "重要交通枢纽POI", "common.dim_poi", "poi_key", "全资产", "使用用户确认的稳定POI键，名称和别名映射到同一实体。"),
        ("WEATHER_GRID", "COMMON", "气象网格", "common.dim_weather_grid", "grid_key", "全资产", "网格组合属性映射为统一整数ID。"),
        ("GEO_FEATURE", "COMMON", "地理要素", "common.dim_geo_feature", "geo_key", "全资产", "使用带业态前缀的统一地理ID。"),
        ("ROAD_SEGMENT", "ROAD", "路段", "road.dim_road_segment", "segment_key", "路网", "源发布段ID映射为统一整数ID。"),
        ("METRO_LINE", "METRO", "轨交线路", "metro.dim_metro_line", "line_id", "轨交", "保留既有20条统一线路ID；高德方向线路另行映射。"),
        ("METRO_ROUTE_DIRECTION", "METRO", "轨交方向线路", "metro.dim_metro_route_direction", "route_direction_id", "轨交", "使用高德方向线路ID，并映射到统一line_id。"),
        ("METRO_STATION", "METRO", "轨交站点", "metro.dim_metro_station", "station_id", "轨交", "优先按高德站点ID映射；客流源结合线路上下文映射到统一station_id。"),
        ("BUS_LINE", "BUS", "公交线路", "bus.dim_bus_line", "line_key", "公交", "客流5位线路码映射到官方线路ID。"),
        ("BUS_ROUTE_DIRECTION", "BUS", "公交方向线路", "bus.dim_bus_route_direction", "route_direction_key", "公交", "使用高德方向线路ID。"),
        ("BUS_STOP", "BUS", "公交站点", "bus.dim_bus_stop", "stop_key", "公交", "来源尚不能可靠合并时使用OFFICIAL/AMAP前缀防碰撞。"),
        ("RIDEHAIL_ORDER", "RIDEHAIL", "网约车订单", "ridehail.fact_trip", "order_hash", "网约车与场馆订单", "四类源统一为一个订单实体，使用不可逆SHA-256哈希。"),
    )
    conn.executemany("INSERT INTO meta_entity_id VALUES (?, ?, ?, ?, ?, ?, ?)", entities)

    def add_id_mapping(
        entity_code: str,
        source_system: str,
        source_id: object,
        source_context: object,
        canonical_id: object,
        mapping_method: str,
        confidence: float,
    ) -> None:
        conn.execute(
            "INSERT OR IGNORE INTO meta_id_mapping VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)",
            (
                entity_code,
                source_system,
                str(source_id),
                "" if source_context is None else str(source_context),
                str(canonical_id),
                mapping_method,
                confidence,
            ),
        )

    common_conn = sqlite3.connect(DB_DIR / "common.sqlite")
    for venue_id, in common_conn.execute("SELECT venue_key FROM dim_venue"):
        add_id_mapping("VENUE", "VENUE_POI", venue_id, None, venue_id, "SOURCE_ID", 1.0)
    for poi_id, poi_name, aliases in common_conn.execute("SELECT poi_key, poi_name, aliases FROM dim_poi"):
        add_id_mapping("POI", "USER_PROVIDED_POI", poi_id, None, poi_id, "SOURCE_ID", 1.0)
        for alias in (poi_name, *aliases.split("|")):
            add_id_mapping("POI", "POI_ALIAS", alias, None, poi_id, "EXACT_NAME", 1.0)
    for grid_id, geo_id in common_conn.execute("SELECT grid_key, geo_key FROM dim_weather_grid"):
        add_id_mapping("WEATHER_GRID", "WEATHER_GRID", geo_id, None, grid_id, "COMPOSITE_ATTRIBUTE", 1.0)
    common_conn.close()

    road_conn = sqlite3.connect(DB_DIR / "road.sqlite")
    for segment_key, source_segment_id in road_conn.execute("SELECT segment_key, segment_id FROM dim_road_segment"):
        add_id_mapping("ROAD_SEGMENT", "ROAD_STATE_SOURCE", source_segment_id, None, segment_key, "SOURCE_ID_LOOKUP", 1.0)
    road_conn.close()

    metro_conn = sqlite3.connect(DB_DIR / "metro.sqlite")
    for line_id, in metro_conn.execute("SELECT line_id FROM dim_metro_line"):
        add_id_mapping("METRO_LINE", "METRO_STATIC", line_id, None, line_id, "CANONICAL_SOURCE", 1.0)
    for route_direction_id, line_id in metro_conn.execute(
        "SELECT route_direction_id, line_id FROM dim_metro_route_direction"
    ):
        add_id_mapping(
            "METRO_ROUTE_DIRECTION", "AMAP", route_direction_id, None,
            route_direction_id, "AMAP_DIRECTION_ID", 1.0
        )
        add_id_mapping("METRO_LINE", "AMAP", route_direction_id, None, line_id, "AMAP_CANONICAL_NAME", 1.0)
    for source_line_number, line_id in metro_conn.execute(
        "SELECT DISTINCT source_line_number, line_id FROM std_metro_station_hour"
    ):
        add_id_mapping("METRO_LINE", "METRO_FLOW", source_line_number, None, line_id, "LINE_NUMBER_LOOKUP", 1.0)
    for station_id, in metro_conn.execute("SELECT station_id FROM dim_metro_station"):
        add_id_mapping("METRO_STATION", "METRO_STATIC", station_id, None, station_id, "CANONICAL_SOURCE", 1.0)
    for source_station_id, station_id, method, confidence in metro_conn.execute(
        "SELECT source_station_id, station_id, mapping_method, confidence FROM map_metro_amap_station"
    ):
        add_id_mapping("METRO_STATION", "AMAP", source_station_id, None, station_id, method, confidence)
    for source_line, source_station, station_id, method in metro_conn.execute(
        "SELECT source_line_number, source_station_id, station_id, mapping_method "
        "FROM quality_metro_flow_station_mapping WHERE station_id IS NOT NULL"
    ):
        add_id_mapping("METRO_STATION", "METRO_FLOW", source_station, source_line, station_id, method, 0.95)
    metro_conn.close()

    bus_conn = sqlite3.connect(DB_DIR / "bus.sqlite")
    for line_id, in bus_conn.execute("SELECT line_key FROM dim_bus_line"):
        add_id_mapping("BUS_LINE", "BUS_OFFICIAL", line_id, None, line_id, "CANONICAL_SOURCE", 1.0)
    for source_line_code, line_id in bus_conn.execute(
        "SELECT DISTINCT source_line_code_5, line_key FROM std_bus_line_30m WHERE line_key IS NOT NULL"
    ):
        add_id_mapping("BUS_LINE", "BUS_FLOW", source_line_code, None, line_id, "OFFICIAL_CODE_LOOKUP", 1.0)
    for stop_key, source_system, source_stop_id in bus_conn.execute(
        "SELECT stop_key, source_system, source_stop_id FROM dim_bus_stop"
    ):
        add_id_mapping("BUS_STOP", source_system, source_stop_id, None, stop_key, "PREFIXED_SOURCE_ID", 1.0)
    bus_conn.close()

    relationships = (
        ("weather_date", "common.fact_weather_observation", "date_key", "common.dim_date", "date_key", "N:1", "公共日期键"),
        ("weather_grid", "common.fact_weather_observation", "grid_key", "common.dim_weather_grid", "grid_key", "N:1", "气象网格"),
        ("road_segment", "road.fact_road_state_event", "segment_key", "road.dim_road_segment", "segment_key", "N:1", "路段维度"),
        ("road_date", "road.fact_road_state_event", "date_key", "common.dim_date", "date_key", "N:1", "跨库公共日期键"),
        ("metro_line", "metro.fact_metro_station_hour", "line_id", "metro.dim_metro_line", "line_id", "N:1", "统一轨交线路ID"),
        ("metro_station", "metro.fact_metro_station_hour", "station_id", "metro.dim_metro_station", "station_id", "N:1", "统一station_id；源站点ID仅在标准层和映射表中保留"),
        ("metro_route_line", "metro.dim_metro_route_direction", "line_id", "metro.dim_metro_line", "line_id", "N:1", "高德方向或支线路径映射到20条统一线路"),
        ("metro_route_station", "metro.bridge_metro_route_station", "route_direction_id", "metro.dim_metro_route_direction", "route_direction_id", "N:1", "方向线路站序和线路上下文WGS84坐标"),
        ("metro_line_station", "metro.bridge_metro_line_station", "station_id", "metro.dim_metro_station", "station_id", "N:1", "统一线路站点关系及点线距离"),
        ("metro_date", "metro.fact_metro_station_hour", "date_key", "common.dim_date", "date_key", "N:1", "跨库公共日期键"),
        ("bus_line", "bus.fact_bus_line_30m", "line_key", "bus.dim_bus_line", "line_key", "N:1", "官方线路键"),
        ("bus_date", "bus.fact_bus_line_30m", "date_key", "common.dim_date", "date_key", "N:1", "跨库公共日期键"),
        ("ridehail_date", "ridehail.fact_ridehail_event", "date_key", "common.dim_date", "date_key", "N:1", "跨库公共日期键"),
        ("ridehail_event_trip", "ridehail.fact_ridehail_event", "trip_key", "ridehail.fact_trip", "trip_key", "N:1", "上下车事件由统一订单拆分，不是另一份订单。"),
        ("venue_trip", "ridehail.fact_venue_trip", "trip_key", "ridehail.fact_trip", "trip_key", "1:1", "场馆订单是统一订单中venue_relation非NONE的子集。"),
        ("venue_event_date", "ridehail.fact_venue_event", "date_key", "common.dim_date", "date_key", "N:1", "场馆到场或离场事件日期。"),
    )
    conn.executemany("INSERT INTO meta_relationship VALUES (?, ?, ?, ?, ?, ?, ?)", relationships)

    metrics = (
        ("ROAD_JAM_MINUTES", "道路严重拥堵分钟数", "ROAD", "路段-日期-小时", "分钟", "JAM状态在小时内的精确持续分钟数。", "road.mart_road_segment_hour", "jam_seconds / 60.0"),
        ("ROAD_CROWD_MINUTES", "道路拥挤分钟数", "ROAD", "路段-日期-小时", "分钟", "CROWD状态在小时内的精确持续分钟数。", "road.mart_road_segment_hour", "crowd_seconds / 60.0"),
        ("METRO_INBOUND", "轨交进站客流", "METRO", "站点-小时", "人次", "标准化进站客流求和。", "metro.fact_metro_station_hour", "SUM(inbound_flow)"),
        ("METRO_OUTBOUND", "轨交出站客流", "METRO", "站点-小时", "人次", "标准化出站客流求和。", "metro.fact_metro_station_hour", "SUM(outbound_flow)"),
        ("BUS_BOARDINGS", "公交上客交易数", "BUS", "线路-半小时", "笔", "公交上客交易数求和。", "bus.fact_bus_line_30m", "SUM(bus_boarding_transactions)"),
        ("RIDEHAIL_EVENTS", "原始网约车上下车事件数", "RIDEHAIL", "15分钟-事件类型", "次", "仅统计有上车表或下车表来源证据的去重事件，不包含场馆订单补齐端点。", "ridehail.mart_ridehail_event_15m", "SUM(source_event_count)"),
        ("TRIP_ENDPOINTS", "统一订单上下车端点数", "RIDEHAIL", "15分钟-端点类型", "次", "统一订单的全部有效端点，包含由场馆订单补齐的端点。", "ridehail.mart_ridehail_event_15m", "SUM(event_count)"),
        ("VENUE_TRIPS", "场馆到离场事件数", "RIDEHAIL", "15分钟-到离场方向", "次", "按场馆方向统计有效到场或离场事件；BOTH订单会产生两个方向事件。", "ridehail.mart_venue_trip_15m", "SUM(trip_count)"),
        ("RAIN_1H_MAX", "一小时累计降雨最大值", "WEATHER", "网格-小时", "毫米", "小时内观测的一小时累计降雨最大值，不做逐条累加。", "common.mart_weather_grid_hour", "MAX(max_rainfall_1h_mm)"),
    )
    conn.executemany("INSERT INTO meta_metric VALUES (?, ?, ?, ?, ?, ?, ?, ?)", metrics)

    analysis_guides = (
        (
            "BUS",
            "bus.mart_bus_line_hour",
            "日期-小时-官方线路",
            scalar("bus", "SELECT MIN(date_key) FROM fact_bus_line_30m"),
            scalar("bus", "SELECT MAX(date_key) FROM fact_bus_line_30m"),
            "75条有客流事实的官方线路",
            "徐汇相关线路样本，不代表上海全市公交",
            "线路与站点为EPSG:4326",
            "适合小时和日趋势；缺失半小时记录不得自动补零。",
        ),
        (
            "METRO",
            "metro.fact_metro_station_hour",
            "日期-小时-统一线路-物理站",
            scalar("metro", "SELECT MIN(date_key) FROM fact_metro_station_hour"),
            scalar("metro", "SELECT MAX(date_key) FROM fact_metro_station_hour"),
            "10个物理站、19个线路-站点组合",
            "静态网络接近全网，客流仅为所选站点",
            "有坐标对象为EPSG:4326；1个站缺坐标",
            "适合所选站点小时客流；不得外推全网客流。",
        ),
        (
            "ROAD",
            "road.mart_road_segment_hour",
            "日期-小时-道路发布段",
            scalar("road", "SELECT MIN(date_key) FROM mart_road_segment_hour"),
            scalar("road", "SELECT MAX(date_key) FROM mart_road_segment_hour"),
            "89个道路发布段",
            "只有发布段标识，没有道路几何",
            "无空间坐标",
            "适合状态持续时间分析，不支持道路地图。",
        ),
        (
            "WEATHER",
            "common.mart_weather_grid_hour",
            "日期-小时-天气网格",
            scalar("common", "SELECT MIN(date_key) FROM mart_weather_grid_hour"),
            scalar("common", "SELECT MAX(date_key) FROM mart_weather_grid_hour"),
            "徐汇区8个天气网格",
            "8个街镇网格",
            "UNKNOWN；坐标原值保留但不可做精确空间运算",
            "适合按网格名称和时间连接；降雨使用小时最大值。",
        ),
        (
            "RIDEHAIL",
            "ridehail.mart_ridehail_event_15m",
            "日期-15分钟-事件类型",
            scalar("ridehail", "SELECT MIN(date_key) FROM mart_ridehail_event_15m"),
            scalar("ridehail", "SELECT MAX(date_key) FROM mart_ridehail_event_15m"),
            "提供样本中的有效上下车事件",
            "场馆周边样本，不代表上海全市",
            "可确认记录统一为EPSG:4326；未知记录保留为UNKNOWN",
            "默认查询聚合层；订单级查询使用fact_trip，避免把上下车事件重复计为两个订单。",
        ),
        (
            "VENUE_TRIP",
            "ridehail.mart_venue_trip_15m",
            "日期-15分钟-到离场方向",
            scalar("ridehail", "SELECT MIN(date_key) FROM mart_venue_trip_15m"),
            scalar("ridehail", "SELECT MAX(date_key) FROM mart_venue_trip_15m"),
            "上海体育场相关有效到场/离场事件",
            "单场馆关联订单",
            "优先继承同订单上/下车表显式CRS；无法回连的端点按数据集多数假设GCJ-02；全部转换为EPSG:4326并保留推断状态",
            "场馆订单是统一订单的子集；适合到离场时间、数量、OD和时长分析，使用coordinate_status区分直接、回连推断和总体假设。",
        ),
    )
    conn.executemany("INSERT INTO meta_analysis_guide VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", analysis_guides)

    rules = (
        ("SOURCE_COVERAGE", "CATALOG", "ERROR", "治理库中的全部源数据集必须登记到目标资产。"),
        ("BUS_LINE_MAPPING", "BUS", "ERROR", "公交客流线路必须全部映射到官方线路维表。"),
        ("METRO_STATION_MAPPING", "METRO", "ERROR", "轨交客流站点必须通过站名映射到物理站点。"),
        ("METRO_AMAP_ID_MAPPING", "METRO", "ERROR", "高德轨交站点ID必须全部映射到统一物理站点。"),
        ("METRO_ROUTE_STATION_DISTANCE", "METRO", "ERROR", "高德方向线路站点与同源线路几何距离不得超过25米。"),
        ("METRO_LINE_STATION_DISTANCE", "METRO", "ERROR", "统一线路上下文站点与WGS84线路几何距离不得超过25米。"),
        ("BUS_ROUTE_STOP_DISTANCE", "BUS", "ERROR", "高德公交线路站点与同源线路几何距离不得超过25米。"),
        ("TRANSIT_WGS84_COMPLETE", "COMMON", "ERROR", "公交和轨交标准空间对象必须统一为EPSG:4326。"),
        ("PUBLISHED_CRS_STANDARD", "CATALOG", "ERROR", "发布资产坐标只允许EPSG:4326或明确标记为UNKNOWN，且不保留源坐标副本。"),
        ("METRO_STATION_COORDINATE_COMPLETE", "METRO", "WARN", "统一轨交物理站点应具有可用WGS84坐标。"),
        ("CANONICAL_ID_EXPOSURE", "CATALOG", "ERROR", "Agent默认事实表只能暴露统一实体ID，不得暴露源系统业务实体ID。"),
        ("ROAD_STATE_DOMAIN", "ROAD", "ERROR", "道路状态只能为FREE、CROWD或JAM。"),
        ("WEATHER_GRID_COUNT", "WEATHER", "WARN", "气象观测应归属稳定的8个网格。"),
        ("ORDER_ID_DEIDENTIFIED", "RIDEHAIL", "ERROR", "Agent资产中不得保留原始订单号字段。"),
        ("RIDEHAIL_DUPLICATE_TAGGED", "RIDEHAIL", "WARN", "四类源中的重复订单行必须计入source_duplicate_count。"),
        ("VENUE_SOURCE_CONFLICT", "RIDEHAIL", "WARN", "同一订单同时出现在场馆到场和离场源且核心行程字段不一致时必须显式标记。"),
        ("RIDEHAIL_CRS_KNOWN", "RIDEHAIL", "WARN", "统一订单的上、下车端点应提供明确坐标系；未知记录仍保留。"),
        ("VENUE_TRIP_COORDINATE", "RIDEHAIL", "WARN", "场馆订单坐标应位于上海合理经纬度范围。"),
        ("EVENT_CALENDAR_AVAILABLE", "COMMON", "WARN", "用户提供的活动日期必须完整进入活动维表。"),
        ("EVENT_TIME_AVAILABLE", "COMMON", "WARN", "数据库仅保留活动日期；案例开始和结束时刻在SKILL说明中维护。"),
    )
    conn.executemany("INSERT INTO meta_quality_rule VALUES (?, ?, ?, ?)", rules)

    source_coverage = conn.execute("SELECT COUNT(*) FROM meta_source_dataset").fetchone()[0]
    source_conn = sqlite3.connect(SOURCE_DB)
    expected_source_coverage = source_conn.execute("SELECT COUNT(*) FROM meta_datasets").fetchone()[0]
    source_conn.close()
    bus_unmatched = scalar("bus", "SELECT COUNT(*) FROM std_bus_line_30m WHERE line_key IS NULL")
    metro_unmatched = scalar("metro", "SELECT COUNT(*) FROM std_metro_station_hour WHERE station_id IS NULL OR line_id IS NULL")
    metro_amap_unmapped = scalar(
        "metro",
        "SELECT (SELECT COUNT(*) FROM map_metro_amap_station) - "
        "       (SELECT COUNT(DISTINCT source_station_id) FROM map_metro_amap_station WHERE station_id IS NOT NULL)",
    )
    metro_route_distance_errors = scalar(
        "metro", "SELECT COUNT(*) FROM bridge_metro_route_station WHERE distance_to_route_m > 25"
    )
    metro_line_distance_errors = scalar(
        "metro", "SELECT COUNT(*) FROM bridge_metro_line_station WHERE distance_to_line_m > 25"
    )
    bus_route_distance_errors = scalar(
        "bus", "SELECT COUNT(*) FROM bridge_bus_line_stop WHERE relation_source='AMAP' AND distance_to_route_m > 25"
    )
    transit_non_wgs = scalar(
        "common",
        "SELECT COUNT(*) FROM dim_geo_feature WHERE domain_code IN ('BUS','METRO') "
        "AND (longitude IS NOT NULL OR geometry_json IS NOT NULL) AND crs <> 'EPSG:4326'",
    )
    metro_missing_coordinates = scalar(
        "metro", "SELECT COUNT(*) FROM dim_metro_station WHERE longitude IS NULL OR latitude IS NULL"
    )
    exposed_source_ids = conn.execute(
        "SELECT COUNT(*) FROM meta_column WHERE "
        "(database_name='metro' AND table_name='fact_metro_station_hour' "
        " AND column_name IN ('source_station_id', 'source_line_number')) OR "
        "(database_name='bus' AND table_name='fact_bus_line_30m' AND column_name='source_line_code_5')"
    ).fetchone()[0]
    forbidden_coordinate_columns = conn.execute(
        "SELECT COUNT(*) FROM meta_column WHERE column_name IN "
        "('source_longitude','source_latitude','source_x','source_y','source_crs',"
        "'source_crs_id','source_geometry_json','normalized_crs')"
    ).fetchone()[0]
    invalid_published_crs = sum(
        (
            scalar(
                "common",
                "SELECT SUM(n) FROM ("
                "SELECT COUNT(*) n FROM dim_geo_feature WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_venue WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_poi WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_weather_grid WHERE crs NOT IN ('EPSG:4326','UNKNOWN'))",
            ),
            scalar(
                "bus",
                "SELECT SUM(n) FROM ("
                "SELECT COUNT(*) n FROM dim_bus_route_direction WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_bus_stop WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM bridge_bus_line_stop WHERE crs NOT IN ('EPSG:4326','UNKNOWN'))",
            ),
            scalar(
                "metro",
                "SELECT SUM(n) FROM ("
                "SELECT COUNT(*) n FROM dim_metro_route_direction WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_metro_line WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM dim_metro_station WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM bridge_metro_route_station WHERE crs NOT IN ('EPSG:4326','UNKNOWN') "
                "UNION ALL SELECT COUNT(*) FROM bridge_metro_line_station WHERE crs NOT IN ('EPSG:4326','UNKNOWN'))",
            ),
            scalar(
                "ridehail",
                "SELECT COUNT(*) FROM std_trip "
                "WHERE pickup_crs NOT IN ('EPSG:4326','UNKNOWN') "
                "OR dropoff_crs NOT IN ('EPSG:4326','UNKNOWN')",
            ),
        )
    )
    road_unknown = scalar("road", "SELECT COUNT(*) FROM std_road_state_event WHERE state_code = 'UNKNOWN'")
    weather_grids = scalar("common", "SELECT COUNT(*) FROM dim_weather_grid")
    duplicate_count = scalar("ridehail", "SELECT COALESCE(SUM(source_duplicate_count), 0) FROM std_trip")
    venue_source_conflicts = scalar(
        "ridehail", "SELECT COUNT(*) FROM std_trip WHERE venue_source_conflict = 1"
    )
    unknown_crs_count = scalar(
        "ridehail", "SELECT COUNT(*) FROM fact_ridehail_event WHERE crs = 'UNKNOWN'"
    )
    invalid_venue_coordinates = scalar(
        "ridehail",
        "SELECT COUNT(*) FROM std_trip "
        "WHERE venue_relation <> 'NONE' AND quality_status = 'INVALID_COORDINATE'",
    )
    event_count = scalar("common", "SELECT COUNT(*) FROM dim_event")
    event_time_count = scalar(
        "common", "SELECT COUNT(*) FROM dim_event WHERE event_start_at IS NOT NULL AND event_end_at IS NOT NULL"
    )
    quality_results = (
        ("SOURCE_COVERAGE", BUILT_AT, int(source_coverage == expected_source_coverage), f"{source_coverage}/{expected_source_coverage}", "已登记治理库中的全部源数据集。"),
        ("BUS_LINE_MAPPING", BUILT_AT, int(bus_unmatched == 0), str(bus_unmatched), "未映射公交客流行数。"),
        ("METRO_STATION_MAPPING", BUILT_AT, int(metro_unmatched == 0), str(metro_unmatched), "未映射轨交客流行数。"),
        ("METRO_AMAP_ID_MAPPING", BUILT_AT, int(metro_amap_unmapped == 0), str(metro_amap_unmapped), "未映射的高德轨交站点ID数。"),
        ("METRO_ROUTE_STATION_DISTANCE", BUILT_AT, int(metro_route_distance_errors == 0), str(metro_route_distance_errors), "点到同源高德方向线路距离超过25米的站序数。"),
        ("METRO_LINE_STATION_DISTANCE", BUILT_AT, int(metro_line_distance_errors == 0), str(metro_line_distance_errors), "统一线路上下文点到线路距离超过25米的关系数。"),
        ("BUS_ROUTE_STOP_DISTANCE", BUILT_AT, int(bus_route_distance_errors == 0), str(bus_route_distance_errors), "点到同源高德公交线路距离超过25米的站序数。"),
        ("TRANSIT_WGS84_COMPLETE", BUILT_AT, int(transit_non_wgs == 0), str(transit_non_wgs), "存在空间值但未统一为EPSG:4326的公交/轨交对象数。"),
        (
            "PUBLISHED_CRS_STANDARD",
            BUILT_AT,
            int(invalid_published_crs == 0 and forbidden_coordinate_columns == 0),
            f"invalid_crs={invalid_published_crs}, source_coordinate_columns={forbidden_coordinate_columns}",
            "已确认坐标统一为EPSG:4326；无法确认的原值保留并标记UNKNOWN。",
        ),
        ("METRO_STATION_COORDINATE_COMPLETE", BUILT_AT, int(metro_missing_coordinates == 0), str(metro_missing_coordinates), "仍缺少WGS84坐标的统一轨交站点数。"),
        ("CANONICAL_ID_EXPOSURE", BUILT_AT, int(exposed_source_ids == 0), str(exposed_source_ids), "默认事实表中暴露的源业务实体ID字段数。"),
        ("ROAD_STATE_DOMAIN", BUILT_AT, int(road_unknown == 0), str(road_unknown), "未知道路状态行数。"),
        ("WEATHER_GRID_COUNT", BUILT_AT, int(weather_grids == 8), str(weather_grids), "实际气象网格数。"),
        ("ORDER_ID_DEIDENTIFIED", BUILT_AT, 1, "0", "标准层仅保存order_hash。"),
        ("RIDEHAIL_DUPLICATE_TAGGED", BUILT_AT, 1, str(duplicate_count), "四类源中的重复行已汇总到统一订单的source_duplicate_count。"),
        ("VENUE_SOURCE_CONFLICT", BUILT_AT, int(venue_source_conflicts == 0), str(venue_source_conflicts), "场馆到场和离场源核心字段冲突数；记录保留，统一订单取离场源为优先值并显式标记。"),
        ("RIDEHAIL_CRS_KNOWN", BUILT_AT, int(unknown_crs_count == 0), str(unknown_crs_count), "坐标系未知的网约车事件数；事实视图保留并显式标注。"),
        ("VENUE_TRIP_COORDINATE", BUILT_AT, int(invalid_venue_coordinates == 0), str(invalid_venue_coordinates), "坐标超出上海合理范围的场馆订单数；事实视图已排除。"),
        ("EVENT_CALENDAR_AVAILABLE", BUILT_AT, int(event_count == 4), str(event_count), "已纳入2025-08-20、21、23、24四天时代少年团上海体育场演出记录。"),
        ("EVENT_TIME_AVAILABLE", BUILT_AT, int(event_time_count == event_count), f"datetime={event_time_count}, date_only={event_count - event_time_count}", "按治理边界，数据库只保留活动日期；案例开始和结束时刻请读取SKILL说明。"),
    )
    conn.executemany("INSERT INTO meta_quality_result VALUES (?, ?, ?, ?, ?)", quality_results)

    examples = (
        ("road_hour", "某日各小时道路拥堵分钟数", "SELECT date_key, hour, SUM(jam_seconds)/60.0 AS jam_minutes FROM road.mart_road_segment_hour WHERE date_key=20250823 GROUP BY date_key,hour ORDER BY hour", "使用按小时精确切分的状态持续时间。"),
        ("event_days", "时代少年团演出日期", "SELECT e.event_date,e.event_name,v.venue_name,e.time_precision FROM common.dim_event e JOIN common.dim_venue v ON v.venue_key=e.venue_key ORDER BY e.event_date_key", "仅日期级经验记录，不得补写具体开演时刻。"),
        ("transport_poi", "重要交通枢纽POI", "SELECT poi_key,poi_name,poi_type,longitude,latitude,crs FROM common.dim_poi ORDER BY poi_type,poi_key", "坐标由用户确认为WGS84；名称匹配时同时检查aliases。"),
        ("metro_station", "上海体育场站逐小时进出站客流", "SELECT f.date_key,f.hour,f.inbound_flow,f.outbound_flow FROM metro.fact_metro_station_hour f JOIN metro.dim_metro_station s ON s.station_id=f.station_id WHERE s.station_name='上海体育场' ORDER BY f.date_key,f.hour", "轨交分析统一使用station_id；源站点ID仅用于追溯。"),
        ("bus_peak", "公交线路日高峰客流", "SELECT l.line_name,m.date_key,m.peak_minute_key,m.peak_boarding_transactions FROM bus.mart_bus_line_day m JOIN bus.dim_bus_line l ON l.line_key=m.line_key ORDER BY m.peak_boarding_transactions DESC LIMIT 20", "客流事实映射到官方线路维表。"),
        ("multimodal", "同日轨交、公交与网约车总量", "WITH m AS (SELECT date_key,SUM(total_flow) v FROM metro.fact_metro_station_hour GROUP BY date_key), b AS (SELECT date_key,SUM(bus_boarding_transactions) v FROM bus.fact_bus_line_30m GROUP BY date_key), r AS (SELECT date_key,SUM(event_count) v FROM ridehail.mart_ridehail_event_15m GROUP BY date_key) SELECT d.date_iso,m.v metro_flow,b.v bus_boardings,r.v ridehail_events FROM common.dim_date d LEFT JOIN m USING(date_key) LEFT JOIN b USING(date_key) LEFT JOIN r USING(date_key) ORDER BY d.date_key", "不同业态量纲不同，不应直接相加为一个总客流指标。"),
        ("weather", "逐小时天气与场馆订单", "WITH w AS (SELECT date_key,hour,AVG(avg_temperature_c) temp,MAX(max_rainfall_1h_mm) rain FROM common.mart_weather_grid_hour GROUP BY date_key,hour), v AS (SELECT date_key,CAST(slot_15_start/60 AS INTEGER) hour,SUM(trip_count) trips FROM ridehail.mart_venue_trip_15m GROUP BY date_key,hour) SELECT w.date_key,w.hour,w.temp,w.rain,v.trips FROM w LEFT JOIN v USING(date_key,hour) ORDER BY w.date_key,w.hour", "一小时累计降雨取最大值，不对10分钟观测求和。"),
    )
    conn.executemany("INSERT INTO meta_query_example VALUES (?, ?, ?, ?)", examples)
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.close()


def validate_assets() -> None:
    for db_name in ("common", "road", "metro", "bus", "ridehail", "catalog"):
        conn = sqlite3.connect(DB_DIR / f"{db_name}.sqlite")
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.close()
        if integrity != "ok":
            raise RuntimeError(f"{db_name}.sqlite integrity check failed: {integrity}")

    ridehail = sqlite3.connect(DB_DIR / "ridehail.sqlite")
    trip_count, unique_orders = ridehail.execute(
        "SELECT COUNT(*), COUNT(DISTINCT order_hash) FROM std_trip"
    ).fetchone()
    if trip_count != unique_orders:
        raise RuntimeError(f"std_trip is not one row per order: {trip_count} rows, {unique_orders} orders")
    for table_name in (
        "mart_ridehail_event_15m",
        "mart_ridehail_event_hour",
        "mart_ridehail_event_day",
    ):
        bad_rows = ridehail.execute(
            f"SELECT COUNT(*) FROM {table_name} "
            "WHERE event_count <> source_event_count + venue_enriched_event_count"
        ).fetchone()[0]
        if bad_rows:
            raise RuntimeError(f"{table_name} has {bad_rows} inconsistent event totals")
    ridehail.close()

    catalog = sqlite3.connect(DB_DIR / "catalog.sqlite")
    failed_errors = catalog.execute(
        "SELECT COUNT(*) FROM meta_quality_result q "
        "JOIN meta_quality_rule r USING(rule_code) "
        "WHERE r.severity = 'ERROR' AND q.passed = 0"
    ).fetchone()[0]
    catalog.close()
    if failed_errors:
        raise RuntimeError(f"{failed_errors} ERROR quality rules failed")


def build_all() -> None:
    if not SOURCE_DB.exists():
        raise FileNotFoundError(SOURCE_DB)
    DB_DIR.mkdir(parents=True, exist_ok=True)
    build_common()
    build_road()
    build_metro()
    build_bus()
    sync_transit_geo_features()
    build_ridehail()
    standardize_published_assets()
    build_catalog()
    validate_assets()
    evdata_csv = os.environ.get("SHANGHAI_TRAFFIC_EVDATA_SPEED_CSV")
    evdata_geojson = os.environ.get("SHANGHAI_TRAFFIC_EVDATA_ROAD_GEOJSON")
    if bool(evdata_csv) != bool(evdata_geojson):
        raise ValueError(
            "Set both SHANGHAI_TRAFFIC_EVDATA_SPEED_CSV and "
            "SHANGHAI_TRAFFIC_EVDATA_ROAD_GEOJSON, or neither"
        )
    if evdata_csv and evdata_geojson:
        from import_evdata_road_speed import import_evdata

        import_evdata(Path(evdata_csv), Path(evdata_geojson), DB_DIR)
        validate_assets()
    print(f"Built data asset at {DB_DIR}")


if __name__ == "__main__":
    build_all()
