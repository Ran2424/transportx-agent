from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(os.environ.get("SHANGHAI_TRAFFIC_PROJECT_ROOT", Path(__file__).resolve().parents[1]))
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "traffic_governance.sqlite"


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    table_name: str
    source_path: Path
    description: str
    domain: str
    grain: str
    governance_notes: str
    sheet_name: str | None = None


CSV_SPECS = {
    "data/amap_metro/amap_metro_lines.csv": ("amap_metro_lines", "raw_amap_metro_lines", "高德轨交方向线路表", "轨交供给", "方向线路", "高德 line_id 为方向线路ID；原始坐标为 GCJ-02。"),
    "data/amap_metro/amap_metro_stations.csv": ("amap_metro_stations", "raw_amap_metro_stations", "高德轨交站点表", "轨交供给", "高德站点", "保留高德站点ID与原始 GCJ-02 坐标。"),
    "data/amap_metro/amap_metro_line_stations.csv": ("amap_metro_line_stations", "raw_amap_metro_line_stations", "高德轨交方向线路站序表", "轨交供给", "方向线路-站点序号", "线路上下文坐标来自同一高德线路几何，用于点线一致性校验。"),
    "data/amap_metro/collection_report.csv": ("amap_metro_collection_report", "raw_amap_metro_collection_report", "高德轨交采集报告", "轨交供给", "统一线路", "记录20条统一线路的检索结果与方向数量。"),
    "data/bus/bus_lines.csv": ("bus_lines", "raw_bus_lines", "公交方向级线路表", "公交供给", "方向线路", "line_id 连接线路站点关系；原始坐标系字段为GCJ-02。"),
    "data/bus/bus_stops.csv": ("bus_stops", "raw_bus_stops", "公交站点表", "公交供给", "站点", "stop_id 连接线路站点关系；原始坐标为GCJ-02。"),
    "data/bus/collection_report.csv": ("bus_collection_report", "raw_bus_collection_report", "公交线路采集匹配报告", "公交供给", "请求线路", "用于判断线路采集与候选匹配质量。"),
    "data/bus/line_stops.csv": ("bus_line_stops", "raw_bus_line_stops", "公交线路站点序列表", "公交供给", "方向线路-站点序号", "line_id、stop_id 连接线路与站点。"),
    "data/metro/metro_line_stations.csv": ("metro_line_stations", "raw_metro_line_stations", "轨交线路站点关系表", "轨交供给", "线路-站点", "station_id 可连接轨交客流。"),
    "data/metro/metro_lines.csv": ("metro_lines", "raw_metro_lines", "遗留统一轨交线路表", "轨交供给", "统一线路", "提供20条稳定line_id；标准几何改用新高德方向线路转换结果。"),
    "data/metro/metro_station_coordinate_report.csv": ("metro_station_coordinate_report", "raw_metro_station_coordinate_report", "轨交站点坐标匹配报告", "轨交供给", "站点", "用于判断坐标来源和匹配方式。"),
    "data/metro/metro_stations.csv": ("metro_stations", "raw_metro_stations", "遗留统一轨交站点表", "轨交供给", "物理站点", "提供稳定station_id和旧高德ID映射；旧点位为GCJ-02。"),
    "data/poi/venue_pois.csv": ("venue_pois", "raw_poi_venue_pois", "重点场所 POI 表", "重点场所", "POI", "上海体育场空间锚点。"),
    "data/徐汇区各业态数据/公交线路客流.csv": ("xuhui_bus_passenger_flow", "raw_xuhui_bus_passenger_flow", "公交线路半小时客流交易表", "公交客流", "日期-半小时-线路", "日期范围与题目主范围不完全一致，需在融合分析中说明。"),
    "data/徐汇区各业态数据/轨交数据.csv": ("xuhui_metro_passenger_flow", "raw_xuhui_metro_passenger_flow", "轨交站点小时进出站客流表", "轨交客流", "日期-小时-线路-站点", "客流字段存在千分位逗号，分析前需转数值。"),
    "data/徐汇区各业态数据/网约车出发表.csv": ("xuhui_ridehail_departure", "raw_xuhui_ridehail_departure", "网约车上车出发记录表", "网约车", "订单-上车时间", "存在多坐标系标识和少量重复订单。"),
    "data/徐汇区各业态数据/网约车到达表.csv": ("xuhui_ridehail_arrival", "raw_xuhui_ridehail_arrival", "网约车下车到达记录表", "网约车", "订单-下车时间", "存在多坐标系标识和少量重复订单。"),
    "data/徐汇区各业态数据/支付订单上车地点是上海体育场的数据.csv": ("xuhui_payment_from_venue", "raw_xuhui_payment_from_venue", "支付订单离场记录表", "支付订单", "订单", "上车地点为上海体育场，主要刻画离场需求。"),
    "data/徐汇区各业态数据/支付订单下车地点是上海体育场的数据.csv": ("xuhui_payment_to_venue", "raw_xuhui_payment_to_venue", "支付订单到场记录表", "支付订单", "订单", "下车地点为上海体育场，主要刻画到场需求。"),
    "data/徐汇区各业态数据/气象数据.csv": ("xuhui_weather_grid", "raw_xuhui_weather_grid", "徐汇区气象网格表", "气象", "网格-更新时间", "更新时间为分钟级，建议按小时或最近时间融合。"),
}

EXCEL_SPECS = {
    ("data/徐汇区各业态数据/路网发布段状态(逢变更新).xlsx", "SQL Results"): ("xuhui_road_segment_state", "raw_xuhui_road_segment_state", "路网发布段状态逢变更新表", "路网", "路段-状态事件", "需根据相邻事件计算状态持续时间。"),
    ("data/徐汇区各业态数据/路网发布段状态(逢变更新).xlsx", "SQL Statement"): ("xuhui_road_source_sql", "raw_xuhui_road_source_sql", "路网数据原始 SQL 口径表", "路网", "抽取 SQL", "保存原始抽取 SQL，服务数据血缘追溯。"),
    ("data/徐汇区各业态数据/公交线路站点基础数据.xlsx", "公交线路信息"): ("xuhui_bus_line_info", "raw_xuhui_bus_line_info", "公交线路官方基础信息表", "公交供给", "线路", "包含线路编码、首末班时间和营运企业。"),
    ("data/徐汇区各业态数据/公交线路站点基础数据.xlsx", "公交站点信息"): ("xuhui_bus_stop_info", "raw_xuhui_bus_stop_info", "公交站点官方基础信息表", "公交供给", "物理站点", "坐标系字段标注为 32651，空间融合前需转换。"),
    ("data/徐汇区各业态数据/公交线路站点基础数据.xlsx", "公交线路站级表"): ("xuhui_bus_line_stop_sequence", "raw_xuhui_bus_line_stop_sequence", "公交线路站级序列表", "公交供给", "线路-站级序号", "用于线路上下行和站序分析。"),
}

GEOJSON_SPECS = {
    "data/amap_metro/amap_metro_lines.geojson": ("amap_metro_lines_geojson", "raw_amap_metro_lines_geojson", "高德轨交方向线路原始几何", "轨交供给", "方向线路几何", "文件未声明CRS；依据采集字段按 GCJ-02 接纳，并在标准层转换为 EPSG:4326。"),
    "data/amap_metro/amap_metro_stations.geojson": ("amap_metro_stations_geojson", "raw_amap_metro_stations_geojson", "高德轨交站点原始几何", "轨交供给", "高德站点几何", "文件未声明CRS；依据采集字段按 GCJ-02 接纳，并在标准层转换为 EPSG:4326。"),
    "data/bus/bus_lines.geojson": ("bus_lines_geojson", "raw_bus_lines_geojson", "公交线路原始空间几何", "公交供给", "方向线路几何", "文件未声明CRS；依据对应CSV字段按GCJ-02接纳。"),
    "data/bus/bus_stops.geojson": ("bus_stops_geojson", "raw_bus_stops_geojson", "公交站点原始空间几何", "公交供给", "站点几何", "文件未声明CRS；依据对应CSV字段按GCJ-02接纳。"),
    "data/metro/metro_lines_wgs84.geojson": ("metro_lines_geojson", "raw_metro_lines_geojson", "遗留统一轨交线路WGS84几何", "轨交供给", "统一线路几何", "坐标为WGS84；2.0标准资产改用新高德方向几何转换结果。"),
    "data/metro/metro_stations.geojson": ("metro_stations_geojson", "raw_metro_stations_geojson", "遗留统一轨交站点原始几何", "轨交供给", "物理站点几何", "文件未声明CRS；依据对应CSV字段按GCJ-02接纳。"),
    "data/poi/venue_pois.geojson": ("venue_pois_geojson", "raw_poi_venue_pois_geojson", "重点场所 POI 空间几何表", "重点场所", "POI 几何", "上海体育场空间锚点。"),
}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def detect_encoding(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            pd.read_csv(path, encoding=encoding, nrows=5)
            return encoding
        except UnicodeDecodeError:
            continue
    return "gb18030"


def to_jsonable(value: Any) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat(sep=" ")
    text = str(value)
    return text if len(text) <= 200 else text[:197] + "..."


def normalize_df(df: pd.DataFrame, start_row: int = 1) -> pd.DataFrame:
    out = df.copy()
    out.insert(0, "_source_row_id", range(start_row, start_row + len(out)))
    for col in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[col]):
            out[col] = out[col].dt.strftime("%Y-%m-%d %H:%M:%S")
    return out


def coerce_sqlite_values(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()

    def convert(value: Any) -> Any:
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, (pd.Timestamp, datetime)):
            return value.isoformat(sep=" ")
        return value

    for col in out.columns:
        if out[col].dtype == "object":
            out[col] = out[col].map(convert)
    return out


def infer_summary(df: pd.DataFrame) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "row_count": int(len(df)),
        "column_count": int(len(df.columns)),
        "columns": [str(c) for c in df.columns],
        "null_cells": int(df.isna().sum().sum()),
    }
    date_ranges = {}
    for col in df.columns:
        name = str(col)
        if name == "_source_row_id":
            continue
        if name == "日期":
            parsed = pd.to_datetime(df[col].astype(str), format="%Y%m%d", errors="coerce")
            if parsed.notna().any():
                date_ranges[name] = [str(parsed.min()), str(parsed.max())]
                continue
            parsed = pd.to_datetime(df[col], errors="coerce")
        elif any(token in name for token in ("时间", "日期", "FDT_TIME", "collected_at", "更新时间")):
            parsed = pd.to_datetime(df[col], errors="coerce")
        else:
            continue
        if parsed.notna().any():
            date_ranges[name] = [str(parsed.min()), str(parsed.max())]
    if date_ranges:
        summary["date_ranges"] = date_ranges

    coordinate_columns = [
        str(c)
        for c in df.columns
        if any(token in str(c).lower() for token in ("经度", "纬度", "维度", "longitude", "latitude"))
    ]
    if coordinate_columns:
        summary["coordinate_columns"] = coordinate_columns

    unique_columns = {}
    for col in df.columns:
        name = str(col)
        if any(token in name for token in ("订单号", "站点", "线路", "line_id", "station_id", "stop_id", "FSTR_ISSUESECTID", "FSTR_CFMSTATE")):
            unique_columns[name] = int(df[col].nunique(dropna=True))
    if unique_columns:
        summary["unique_counts"] = unique_columns
    return summary


def make_specs() -> list[DatasetSpec]:
    specs: list[DatasetSpec] = []
    for path_text, values in CSV_SPECS.items():
        dataset_id, table_name, description, domain, grain, notes = values
        specs.append(DatasetSpec(dataset_id, table_name, ROOT / path_text, description, domain, grain, notes))
    for (path_text, sheet_name), values in EXCEL_SPECS.items():
        dataset_id, table_name, description, domain, grain, notes = values
        specs.append(DatasetSpec(dataset_id, table_name, ROOT / path_text, description, domain, grain, notes, sheet_name))
    for path_text, values in GEOJSON_SPECS.items():
        dataset_id, table_name, description, domain, grain, notes = values
        specs.append(DatasetSpec(dataset_id, table_name, ROOT / path_text, description, domain, grain, notes))
    return specs


def create_meta_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP TABLE IF EXISTS meta_datasets;
        DROP TABLE IF EXISTS meta_columns;
        DROP TABLE IF EXISTS meta_build;

        CREATE TABLE meta_build (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE meta_datasets (
            dataset_id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL UNIQUE,
            source_path TEXT NOT NULL,
            source_dir TEXT NOT NULL,
            source_file TEXT NOT NULL,
            file_type TEXT NOT NULL,
            encoding TEXT,
            sheet_name TEXT,
            domain TEXT NOT NULL,
            governance_layer TEXT NOT NULL,
            grain TEXT NOT NULL,
            description TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            column_count INTEGER NOT NULL,
            null_cells INTEGER,
            date_ranges_json TEXT,
            coordinate_columns_json TEXT,
            unique_counts_json TEXT,
            governance_notes TEXT,
            loaded_at TEXT NOT NULL
        );

        CREATE TABLE meta_columns (
            dataset_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            ordinal_position INTEGER NOT NULL,
            column_name TEXT NOT NULL,
            pandas_dtype TEXT,
            sqlite_declared_type TEXT,
            non_null_count INTEGER,
            sample_values_json TEXT,
            PRIMARY KEY (dataset_id, ordinal_position)
        );
        """
    )
    conn.commit()


def sqlite_type(dtype: Any) -> str:
    text = str(dtype)
    if "int" in text:
        return "INTEGER"
    if "float" in text:
        return "REAL"
    return "TEXT"


def write_dataset_meta(
    conn: sqlite3.Connection,
    spec: DatasetSpec,
    df: pd.DataFrame,
    file_type: str,
    encoding: str | None,
    summary: dict[str, Any],
) -> None:
    loaded_at = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO meta_datasets (
            dataset_id, table_name, source_path, source_dir, source_file,
            file_type, encoding, sheet_name, domain, governance_layer, grain,
            description, row_count, column_count, null_cells, date_ranges_json,
            coordinate_columns_json, unique_counts_json, governance_notes, loaded_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            spec.dataset_id,
            spec.table_name,
            rel(spec.source_path),
            rel(spec.source_path.parent),
            spec.source_path.name,
            file_type,
            encoding,
            spec.sheet_name,
            spec.domain,
            "raw",
            spec.grain,
            spec.description,
            summary["row_count"],
            summary["column_count"],
            summary.get("null_cells"),
            json.dumps(summary.get("date_ranges", {}), ensure_ascii=False),
            json.dumps(summary.get("coordinate_columns", []), ensure_ascii=False),
            json.dumps(summary.get("unique_counts", {}), ensure_ascii=False),
            spec.governance_notes,
            loaded_at,
        ),
    )
    for idx, col in enumerate(df.columns, start=1):
        samples = [to_jsonable(v) for v in df[col].dropna().head(5).tolist()]
        conn.execute(
            """
            INSERT INTO meta_columns (
                dataset_id, table_name, ordinal_position, column_name,
                pandas_dtype, sqlite_declared_type, non_null_count, sample_values_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                spec.dataset_id,
                spec.table_name,
                idx,
                str(col),
                str(df[col].dtype),
                sqlite_type(df[col].dtype),
                int(df[col].notna().sum()),
                json.dumps(samples, ensure_ascii=False),
            ),
        )
    conn.commit()


def drop_table(conn: sqlite3.Connection, table_name: str) -> None:
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", table_name):
        raise ValueError(f"Unsafe table name: {table_name}")
    conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
    conn.commit()


def load_csv(conn: sqlite3.Connection, spec: DatasetSpec) -> None:
    encoding = detect_encoding(spec.source_path)
    drop_table(conn, spec.table_name)
    start = 1
    chunks = []
    for chunk in pd.read_csv(spec.source_path, encoding=encoding, chunksize=100_000):
        normalized = normalize_df(chunk, start)
        normalized = coerce_sqlite_values(normalized)
        normalized.to_sql(spec.table_name, conn, if_exists="append", index=False)
        chunks.append(chunk)
        start += len(chunk)
    df = pd.concat(chunks, ignore_index=True) if chunks else pd.DataFrame()
    meta_df = normalize_df(df)
    write_dataset_meta(conn, spec, meta_df, "csv", encoding, infer_summary(meta_df))


def load_excel(conn: sqlite3.Connection, spec: DatasetSpec) -> None:
    drop_table(conn, spec.table_name)
    raw = pd.read_excel(spec.source_path, sheet_name=spec.sheet_name)
    if raw.empty and len(raw.columns) == 1 and spec.sheet_name == "SQL Statement":
        raw = pd.DataFrame({"source_sql": [str(raw.columns[0])]})
    normalized = normalize_df(raw)
    normalized = coerce_sqlite_values(normalized)
    normalized.to_sql(spec.table_name, conn, if_exists="replace", index=False)
    write_dataset_meta(conn, spec, normalized, "xlsx", None, infer_summary(normalized))


def load_geojson(conn: sqlite3.Connection, spec: DatasetSpec) -> None:
    drop_table(conn, spec.table_name)
    with spec.source_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    rows = []
    for idx, feature in enumerate(data.get("features", []), start=1):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        row = dict(props)
        row["_source_row_id"] = idx
        row["geometry_type"] = geometry.get("type")
        row["geometry_json"] = json.dumps(geometry, ensure_ascii=False)
        rows.append(row)
    df = pd.DataFrame(rows)
    if "_source_row_id" in df.columns:
        cols = ["_source_row_id"] + [c for c in df.columns if c != "_source_row_id"]
        df = df[cols]
    df = coerce_sqlite_values(df)
    df.to_sql(spec.table_name, conn, if_exists="replace", index=False)
    write_dataset_meta(conn, spec, df, "geojson", "utf-8", infer_summary(df))


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(str(value).replace("\n", "<br>") for value in row) + " |")
    return "\n".join(lines)


def format_json_summary(value: str, empty: str = "-") -> str:
    try:
        parsed = json.loads(value or "{}")
    except json.JSONDecodeError:
        return empty
    if not parsed:
        return empty
    if isinstance(parsed, list):
        return "、".join(map(str, parsed)) if parsed else empty
    if isinstance(parsed, dict):
        return "<br>".join(f"{k}: {v}" for k, v in parsed.items()) if parsed else empty
    return str(parsed)


def fetch_meta(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return conn.execute(
        """
        SELECT *
        FROM meta_datasets
        ORDER BY source_dir, source_file, COALESCE(sheet_name, '')
        """
    ).fetchall()


def write_root_data_md(conn: sqlite3.Connection) -> None:
    rows = fetch_meta(conn)
    outputs = [DATA_DIR / "data.md", ROOT / "data.md"]
    total_rows = sum(int(r["row_count"]) for r in rows)
    table_rows = [
        [
            r["table_name"],
            r["description"],
            r["domain"],
            r["grain"],
            r["row_count"],
            r["source_path"] + (f" / {r['sheet_name']}" if r["sheet_name"] else ""),
        ]
        for r in rows
    ]
    dir_rows = []
    by_dir: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_dir.setdefault(row["source_dir"], []).append(row)
    for source_dir, items in sorted(by_dir.items()):
        dir_rows.append([source_dir, len(items), sum(int(i["row_count"]) for i in items)])

    content = f"""# data 数据治理总览

生成时间：{datetime.now().isoformat(timespec="seconds")}

## 1. 总体说明

本目录数据已统一入库到 `{DB_PATH.relative_to(ROOT).as_posix()}`。数据库采用 SQLite，当前为原始治理层 `raw` 加元数据层 `meta` 的结构：业务数据表保留原始字段并增加 `_source_row_id`，元数据表记录来源路径、编码、行数、字段、时间范围、空间字段和治理注意事项。

## 2. 入库范围

| 指标 | 数值 |
|---|---:|
| 入库数据集数量 | {len(rows)} |
| 入库总记录数 | {total_rows} |
| SQLite 文件 | `{DB_PATH.relative_to(ROOT).as_posix()}` |
| 元数据表 | `meta_build`、`meta_datasets`、`meta_columns` |

## 3. 分目录汇总

{markdown_table(["目录", "数据集数", "记录数"], dir_rows)}

## 4. 数据集清单

{markdown_table(["SQLite 表", "数据说明", "领域", "粒度", "行数", "来源"], table_rows)}

## 5. 原始治理规则

- 原始文件不做覆盖修改，所有入库表以 `raw_` 开头。
- 每张业务表新增 `_source_row_id`，用于回溯原始文件内行号或 GeoJSON 要素序号。
- CSV 编码自动识别，中文业务原始 CSV 多为 `gb18030`，空间基础 CSV 多为 `utf-8-sig`。
- Excel 多工作表拆成多张表；空的 SQL 说明工作表被整理为一行 `source_sql`，用于保留抽取口径。
- GeoJSON 入库时保留属性字段，并增加 `geometry_type` 与 `geometry_json`。
- `data/amap_metro` 和 `data/bus` 中高德文件的坐标字段明确标注为 GCJ-02；其 GeoJSON 未声明 CRS，不得直接按 WGS84 使用。
- `data/metro` 是旧版统一线路、物理站点和客流连接所需的遗留静态源；`data/amap_metro` 是2026-07-19采集的较完整高德方向线路与站点源。

## 6. 标准资产去向

- `scripts/build_agent_data_assets.py` 基于本治理库生成分域 SQLite 标准资产。
- 公交和轨交标准空间字段统一转换为 WGS84（`EPSG:4326`），原始坐标继续保留用于追溯。
- 高德方向线路、线路站序和点线距离在标准资产中单独建模；既有客流事实继续使用稳定的统一线路和站点ID。
- 活动、指标、质量规则和查询样例由 `catalog.sqlite` 统一登记。
"""
    for output in outputs:
        output.write_text(content, encoding="utf-8")


def write_dir_data_md(conn: sqlite3.Connection) -> None:
    rows = fetch_meta(conn)
    by_dir: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_dir.setdefault(row["source_dir"], []).append(row)

    for source_dir, items in by_dir.items():
        path = ROOT / source_dir / "data.md"
        dataset_rows = []
        for row in items:
            dataset_rows.append(
                [
                    row["table_name"],
                    row["source_file"] + (f" / {row['sheet_name']}" if row["sheet_name"] else ""),
                    row["description"],
                    row["grain"],
                    row["row_count"],
                    format_json_summary(row["date_ranges_json"]),
                    row["governance_notes"] or "-",
                ]
            )
        content = f"""# {source_dir} 数据说明

生成时间：{datetime.now().isoformat(timespec="seconds")}

## 1. 目录定位

本目录下的数据已入库到 `{DB_PATH.relative_to(ROOT).as_posix()}`。下表列出本目录对应的 SQLite 表、原始文件、业务粒度和治理注意事项。

## 2. 数据集清单

{markdown_table(["SQLite 表", "来源", "说明", "粒度", "行数", "时间范围", "治理注意事项"], dataset_rows)}

## 3. 字段索引

"""
        for row in items:
            cols = conn.execute(
                """
                SELECT column_name, pandas_dtype, sqlite_declared_type, non_null_count, sample_values_json
                FROM meta_columns
                WHERE dataset_id = ?
                ORDER BY ordinal_position
                """,
                (row["dataset_id"],),
            ).fetchall()
            col_rows = []
            for col in cols:
                col_rows.append(
                    [
                        col["column_name"],
                        col["pandas_dtype"],
                        col["sqlite_declared_type"],
                        col["non_null_count"],
                        format_json_summary(col["sample_values_json"], empty=""),
                    ]
                )
            content += f"### {row['table_name']}\n\n"
            content += f"- 来源：`{row['source_path']}`"
            if row["sheet_name"]:
                content += f"，工作表：`{row['sheet_name']}`"
            content += f"\n- 说明：{row['description']}\n\n"
            content += markdown_table(["字段", "Pandas 类型", "SQLite 类型", "非空数", "样例值"], col_rows)
            content += "\n\n"
        path.write_text(content, encoding="utf-8")


def build() -> None:
    for path in (DB_PATH, Path(str(DB_PATH) + "-wal"), Path(str(DB_PATH) + "-shm")):
        if path.exists():
            path.unlink()
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=NORMAL")
        create_meta_tables(conn)
        conn.execute("INSERT INTO meta_build VALUES (?, ?)", ("built_at", datetime.now().isoformat(timespec="seconds")))
        conn.execute("INSERT INTO meta_build VALUES (?, ?)", ("database_path", DB_PATH.relative_to(ROOT).as_posix()))
        conn.commit()

        for spec in make_specs():
            suffix = spec.source_path.suffix.lower()
            print(f"loading {spec.table_name} <- {rel(spec.source_path)}" + (f" [{spec.sheet_name}]" if spec.sheet_name else ""))
            if suffix == ".csv":
                load_csv(conn, spec)
            elif suffix == ".xlsx":
                load_excel(conn, spec)
            elif suffix == ".geojson":
                load_geojson(conn, spec)
            else:
                raise ValueError(f"Unsupported file type: {spec.source_path}")

        write_root_data_md(conn)
        write_dir_data_md(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    build()
