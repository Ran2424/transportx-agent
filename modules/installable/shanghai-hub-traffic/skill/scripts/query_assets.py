#!/usr/bin/env python3
"""Read-only query interface for the Shanghai hub traffic asset."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
from pathlib import Path


ASSET_ID = "data:shanghai-hub-traffic"
DATABASES = ("common", "rail", "forecast", "hubops", "ridehail")
MAX_ROWS = 5000


def default_root() -> Path | None:
    raw = os.environ.get("TRANSPORTX_DATA_ASSETS_JSON", "{}")
    try:
        assets = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(assets, dict) and isinstance(assets.get(ASSET_ID), str):
        return Path(assets[ASSET_ID])
    if isinstance(assets, list):
        for item in assets:
            if isinstance(item, dict) and item.get("id") == ASSET_ID and isinstance(item.get("path"), str):
                return Path(item["path"])
    return None


def connect(root: Path) -> sqlite3.Connection:
    required = ("catalog", *DATABASES)
    missing = [name for name in required if not (root / f"{name}.sqlite").is_file()]
    if missing:
        raise FileNotFoundError(f"数据资产不完整，缺少：{', '.join(missing)}")
    catalog = root / "catalog.sqlite"
    conn = sqlite3.connect(f"file:{catalog}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ? AS catalog", (f"file:{catalog}?mode=ro&immutable=1",))
    for name in DATABASES:
        conn.execute(f"ATTACH DATABASE ? AS {name}", (f"file:{root / f'{name}.sqlite'}?mode=ro&immutable=1",))
    conn.execute("PRAGMA query_only=ON")
    return conn


def render(rows: list[sqlite3.Row], output_format: str, truncated: bool) -> None:
    if output_format == "json":
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    elif output_format == "csv":
        writer = csv.writer(sys.stdout)
        if rows:
            writer.writerow(rows[0].keys())
            writer.writerows(tuple(row) for row in rows)
    elif not rows:
        print("No rows")
    else:
        columns = list(rows[0].keys())
        values = [["" if row[col] is None else str(row[col]) for col in columns] for row in rows]
        widths = [max(len(str(col)), *(len(row[i]) for row in values)) for i, col in enumerate(columns)]
        print(" | ".join(str(col).ljust(widths[i]) for i, col in enumerate(columns)))
        print("-+-".join("-" * width for width in widths))
        for row in values:
            print(" | ".join(value.ljust(widths[i]) for i, value in enumerate(row)))
    if truncated:
        print("Result truncated; increase --max-rows.", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Query the governed Shanghai hub traffic SQLite asset.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--sql", help="One read-only SELECT/WITH/EXPLAIN QUERY PLAN statement.")
    group.add_argument("--list", action="store_true", help="List governed objects.")
    group.add_argument("--describe", metavar="DATABASE.TABLE")
    group.add_argument("--metrics", action="store_true")
    group.add_argument("--coverage", action="store_true")
    group.add_argument("--examples", action="store_true")
    group.add_argument("--quality", action="store_true")
    group.add_argument("--conflicts", action="store_true")
    group.add_argument("--business", action="store_true", help="List mart objects.")
    parser.add_argument("--data-root", type=Path, default=default_root())
    parser.add_argument("--format", choices=("table", "json", "csv"), default="table")
    parser.add_argument("--max-rows", type=int, default=200)
    args = parser.parse_args()
    if args.data_root is None:
        raise SystemExit(f"{ASSET_ID} 未注入；请安装模块或传入 --data-root。")
    if not 1 <= args.max_rows <= MAX_ROWS:
        raise SystemExit(f"--max-rows 必须在 1 到 {MAX_ROWS} 之间")
    try:
        conn = connect(args.data_root.resolve())
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc
    if args.sql:
        if not re.match(r"^(SELECT|WITH|EXPLAIN\s+QUERY\s+PLAN)\b", args.sql.lstrip(), re.I):
            raise SystemExit("--sql 仅接受一条只读 SELECT、WITH 或 EXPLAIN QUERY PLAN")
        cursor = conn.execute(args.sql)
    elif args.describe:
        try:
            database, table = args.describe.split(".", 1)
        except ValueError as exc:
            raise SystemExit("--describe 格式应为 DATABASE.TABLE") from exc
        if database not in ("catalog", *DATABASES) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table):
            raise SystemExit("数据库或对象名不合法")
        cursor = conn.execute(f"SELECT cid+1 ordinal_position,name column_name,type declared_type,\"notnull\" is_not_null,pk primary_key_position FROM {database}.pragma_table_info(?) ORDER BY cid", (table,))
    elif args.metrics:
        cursor = conn.execute("SELECT * FROM meta_metric ORDER BY metric_code")
    elif args.coverage:
        cursor = conn.execute("SELECT * FROM meta_analysis_guide ORDER BY question_code")
    elif args.examples:
        cursor = conn.execute("SELECT * FROM meta_query_example ORDER BY example_code")
    elif args.quality:
        cursor = conn.execute("SELECT * FROM meta_quality_issue ORDER BY severity,issue_code")
    elif args.conflicts:
        cursor = conn.execute("SELECT * FROM meta_conflict_summary ORDER BY conflict_code")
    elif args.business:
        cursor = conn.execute("SELECT * FROM meta_table WHERE table_name LIKE 'mart_%' ORDER BY database_code,table_name")
    else:
        cursor = conn.execute("SELECT * FROM meta_table ORDER BY database_code,table_name")
    rows = cursor.fetchmany(args.max_rows + 1)
    render(rows[: args.max_rows], args.format, len(rows) > args.max_rows)
    conn.close()


if __name__ == "__main__":
    main()
