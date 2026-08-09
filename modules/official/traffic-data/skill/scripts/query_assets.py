#!/usr/bin/env python3
"""Read-only query interface for the bundled SQLite data asset."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path


DATA_ROOT = os.environ.get("TRANSPORTX_TRAFFIC_DATA_ROOT")
DEFAULT_ROOT = Path(DATA_ROOT) if DATA_ROOT else None
DATABASES = ("common", "road", "metro", "bus", "ridehail")
MAX_ROWS_LIMIT = 5000


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_km = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    value = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    return 2 * radius_km * math.asin(math.sqrt(value))


def connect(db_dir: Path) -> sqlite3.Connection:
    catalog = db_dir / "catalog.sqlite"
    required = [catalog, *(db_dir / f"{name}.sqlite" for name in DATABASES)]
    missing = [path for path in required if not path.is_file()]
    if missing:
        names = ", ".join(path.name for path in missing)
        raise FileNotFoundError(
            f"Missing packaged databases in {db_dir}: {names}. "
            "Use the controlled installed asset or rebuild it as documented in references/governance.md."
        )
    conn = sqlite3.connect(f"file:{catalog}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    conn.create_function("haversine_km", 4, haversine_km, deterministic=True)
    conn.execute("ATTACH DATABASE ? AS catalog", (f"file:{catalog}?mode=ro&immutable=1",))
    for name in DATABASES:
        uri = f"file:{db_dir / f'{name}.sqlite'}?mode=ro&immutable=1"
        conn.execute(f"ATTACH DATABASE ? AS {name}", (uri,))
    conn.execute("PRAGMA query_only=ON")
    return conn


def render(rows: list[sqlite3.Row], output_format: str, truncated: bool) -> None:
    if not rows:
        print("No rows")
        return
    columns = rows[0].keys()
    values = [["" if row[column] is None else row[column] for column in columns] for row in rows]
    if output_format == "json":
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
    elif output_format == "csv":
        writer = csv.writer(sys.stdout)
        writer.writerow(columns)
        writer.writerows(values)
    else:
        widths = [len(str(column)) for column in columns]
        for row in values:
            widths = [max(width, len(str(value))) for width, value in zip(widths, row)]
        print(" | ".join(str(column).ljust(width) for column, width in zip(columns, widths)))
        print("-+-".join("-" * width for width in widths))
        for row in values:
            print(" | ".join(str(value).ljust(width) for value, width in zip(row, widths)))
    if truncated:
        print("Result truncated; increase --max-rows.", file=sys.stderr)


def run_query(
    conn: sqlite3.Connection,
    sql: str,
    max_rows: int,
    parameters: tuple[object, ...] = (),
) -> tuple[list[sqlite3.Row], bool]:
    cursor = conn.execute(sql, parameters)
    rows = cursor.fetchmany(max_rows + 1)
    return rows[:max_rows], len(rows) > max_rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Query the Shanghai traffic data asset in read-only mode.")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--sql", help="Read-only SQL. Use catalog.*, common.*, road.*, metro.*, bus.*, ridehail.*.")
    action.add_argument("--list", action="store_true", help="List all governed tables and views.")
    action.add_argument("--describe", metavar="DATABASE.TABLE", help="Describe one table or view.")
    action.add_argument("--metrics", action="store_true", help="List governed metrics.")
    action.add_argument("--ids", action="store_true", help="List canonical entity ID policies.")
    action.add_argument("--examples", action="store_true", help="List verified query examples.")
    action.add_argument("--coverage", action="store_true", help="Show domain grain, coverage, CRS, and usage notes.")
    action.add_argument("--business", action="store_true", help="List hourly, daily, and other business marts.")
    action.add_argument(
        "--order-sources",
        action="store_true",
        help="Explain the overlap between ride-hailing and venue-order sources.",
    )
    parser.add_argument("--format", choices=("table", "json", "csv"), default="table")
    parser.add_argument("--max-rows", type=int, default=200)
    parser.add_argument("--data-root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()

    if args.data_root is None:
        raise SystemExit("TRANSPORTX_TRAFFIC_DATA_ROOT or --data-root is required; install a Data module or provide an explicit root.")

    if not 1 <= args.max_rows <= MAX_ROWS_LIMIT:
        raise SystemExit(f"--max-rows must be between 1 and {MAX_ROWS_LIMIT}")

    try:
        conn = connect(args.data_root)
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc
    if args.sql:
        if not re.match(r"^(SELECT|WITH|EXPLAIN\s+QUERY\s+PLAN)\b", args.sql.lstrip(), re.IGNORECASE):
            raise SystemExit("--sql accepts one read-only SELECT, WITH, or EXPLAIN QUERY PLAN statement")
        rows, truncated = run_query(conn, args.sql, args.max_rows)
    elif args.describe:
        try:
            database_name, table_name = args.describe.split(".", 1)
        except ValueError as exc:
            raise SystemExit("--describe requires DATABASE.TABLE") from exc
        if database_name not in ("catalog", *DATABASES):
            raise SystemExit(f"Unknown database: {database_name}")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table_name):
            raise SystemExit(f"Invalid object name: {table_name}")
        exists = conn.execute(
            f"SELECT 1 FROM {database_name}.sqlite_master WHERE name=? AND type IN ('table','view')",
            (table_name,),
        ).fetchone()
        if not exists:
            raise SystemExit(f"Unknown object: {database_name}.{table_name}")
        rows, truncated = run_query(
            conn,
            f"SELECT cid + 1 AS ordinal_position, name AS column_name, type AS declared_type, "
            f"\"notnull\" AS is_not_null, pk AS primary_key_position "
            f"FROM {database_name}.pragma_table_info(?) ORDER BY cid",
            args.max_rows,
            (table_name,),
        )
    elif args.metrics:
        rows, truncated = run_query(conn, "SELECT * FROM meta_metric ORDER BY domain_code, metric_code", args.max_rows)
    elif args.ids:
        rows, truncated = run_query(conn, "SELECT * FROM meta_entity_id ORDER BY domain_code, entity_code", args.max_rows)
    elif args.examples:
        rows, truncated = run_query(conn, "SELECT * FROM meta_query_example ORDER BY example_id", args.max_rows)
    elif args.coverage:
        rows, truncated = run_query(conn, "SELECT * FROM meta_analysis_guide ORDER BY domain_code", args.max_rows)
    elif args.business:
        rows, truncated = run_query(
            conn,
            "SELECT database_name, table_name, row_count, description_cn "
            "FROM meta_table WHERE governance_layer='mart' ORDER BY database_name, table_name",
            args.max_rows,
        )
    elif args.order_sources:
        rows, truncated = run_query(
            conn,
            "SELECT * FROM meta_order_source_relation ORDER BY relation_code",
            args.max_rows,
        )
    else:
        rows, truncated = run_query(
            conn,
            "SELECT database_name, table_name, object_type, governance_layer, row_count, description_cn "
            "FROM meta_table ORDER BY database_name, table_name",
            args.max_rows,
        )
    render(rows, args.format, truncated)
    conn.close()


if __name__ == "__main__":
    main()
