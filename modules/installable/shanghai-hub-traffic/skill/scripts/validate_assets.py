#!/usr/bin/env python3
"""Validate checksums, schema integrity, governed row counts, and key business semantics."""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
from pathlib import Path


DATABASES = ("catalog", "common", "rail", "forecast", "hubops", "ridehail")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scalar(path: Path, sql: str) -> object:
    conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    try:
        return conn.execute(sql).fetchone()[0]
    finally:
        conn.close()


def validate(root: Path) -> None:
    expected_files = {f"{name}.sqlite" for name in DATABASES}
    checksum_file = root / "SHA256SUMS.txt"
    if not checksum_file.is_file():
        raise RuntimeError("缺少 SHA256SUMS.txt")
    checksums = {}
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        digest, name = line.split(maxsplit=1)
        checksums[name.strip()] = digest
    if set(checksums) != expected_files:
        raise RuntimeError(f"校验和文件清单不一致：{sorted(checksums)}")
    for name, expected in checksums.items():
        path = root / name
        if not path.is_file() or sha256(path) != expected:
            raise RuntimeError(f"文件缺失或校验和错误：{name}")
        if scalar(path, "PRAGMA integrity_check") != "ok":
            raise RuntimeError(f"SQLite 完整性检查失败：{name}")
    assertions = (
        ("catalog.sqlite", "SELECT SUM(source_row_count) FROM meta_source_dataset", 3_602_908, "源物理记录总数"),
        ("catalog.sqlite", "SELECT SUM(accepted_row_count) FROM meta_source_dataset", 3_594_268, "规范接纳记录总数"),
        ("catalog.sqlite", "SELECT COUNT(*) FROM meta_quality_rule WHERE severity='ERROR' AND passed=0", 0, "阻断级质量规则"),
        ("common.sqlite", "SELECT COUNT(*) FROM dim_hub", 6, "枢纽维度"),
        ("rail.sqlite", "SELECT COUNT(*) FROM std_train_stop", 801_433, "铁路标准层"),
        ("rail.sqlite", "SELECT COUNT(*) FROM fact_train_stop", 719_255, "铁路默认生产事实"),
        ("rail.sqlite", "SELECT COUNT(*) FROM fact_metro_station_flow_day WHERE total_flow<>inbound_flow+outbound_flow", 0, "轨交流量恒等式"),
        ("forecast.sqlite", "SELECT COUNT(*) FROM std_arrival_forecast", 750_912, "到达预测版本"),
        ("forecast.sqlite", "SELECT COUNT(*) FROM std_evac_ratio_hour", 750_912, "疏散比例版本"),
        ("hubops.sqlite", "SELECT COUNT(*) FROM fact_taxi_yard_state", 8_640, "出租车去重事实"),
        ("ridehail.sqlite", "SELECT COUNT(*) FROM fact_ridehail_demand", 17_833, "网约车需求事实"),
        ("ridehail.sqlite", "SELECT COUNT(*) FROM fact_ridehail_order_window", 44_586, "网约车订单窗口长表"),
    )
    for file_name, sql, expected, label in assertions:
        actual = scalar(root / file_name, sql)
        if actual != expected:
            raise RuntimeError(f"{label}校验失败：预期 {expected}，实际 {actual}")
    duplicate_train_keys = scalar(root / "rail.sqlite", "SELECT COUNT(*) FROM (SELECT departure_date,train_code,station_code,COUNT(*) n FROM fact_train_stop GROUP BY 1,2,3 HAVING n>1)")
    if duplicate_train_keys:
        raise RuntimeError(f"铁路生产事实存在 {duplicate_train_keys} 个重复业务键")
    duplicate_versions = scalar(root / "forecast.sqlite", "SELECT COUNT(*) FROM (SELECT hub_id,predicted_at,issued_at,dataset_role,COUNT(*) n FROM std_arrival_forecast GROUP BY 1,2,3,4 HAVING n>1)")
    if duplicate_versions:
        raise RuntimeError(f"到达预测存在 {duplicate_versions} 个重复版本键")
    conn = sqlite3.connect(f"file:{root / 'catalog.sqlite'}?mode=ro&immutable=1", uri=True)
    try:
        for name in ("common", "forecast", "hubops", "ridehail"):
            conn.execute(f"ATTACH DATABASE ? AS {name}", (f"file:{root / f'{name}.sqlite'}?mode=ro&immutable=1",))
        orphan_count = conn.execute(
            "SELECT "
            "(SELECT COUNT(*) FROM ridehail.fact_ridehail_demand f LEFT JOIN common.dim_hub h ON f.hub_id=h.hub_id WHERE h.hub_id IS NULL)+"
            "(SELECT COUNT(*) FROM forecast.std_arrival_forecast f LEFT JOIN common.dim_hub h ON f.hub_id=h.hub_id WHERE h.hub_id IS NULL)+"
            "(SELECT COUNT(*) FROM hubops.fact_taxi_yard_state f LEFT JOIN common.dim_location l ON f.location_id=l.location_id WHERE l.location_id IS NULL)+"
            "(SELECT COUNT(*) FROM hubops.std_site_flow_observation f LEFT JOIN common.dim_location l ON f.location_id=l.location_id WHERE l.location_id IS NULL)"
        ).fetchone()[0]
    finally:
        conn.close()
    if orphan_count:
        raise RuntimeError(f"跨库实体关系存在 {orphan_count} 条孤儿记录")
    print(f"Validated {len(DATABASES)} databases and {len(assertions) + 3} governed assertions.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate the Shanghai hub traffic data asset.")
    parser.add_argument("--data-root", type=Path, required=True)
    args = parser.parse_args()
    validate(args.data_root.resolve())


if __name__ == "__main__":
    main()
