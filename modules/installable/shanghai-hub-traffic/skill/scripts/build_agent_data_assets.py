#!/usr/bin/env python3
"""Publish governed, query-oriented SQLite assets from the staging database."""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path


ASSET_VERSION = "1.0.0"
DATABASES = ("common", "rail", "forecast", "hubops", "ridehail", "catalog")
HUBS = (
    ("PVG", "浦东机场", "AIRPORT", 1),
    ("SHA", "虹桥机场", "AIRPORT", 1),
    ("AOH", "虹桥火车站", "RAILWAY", 1),
    ("SHH", "上海火车站", "RAILWAY", 1),
    ("SNH", "上海南站", "RAILWAY", 1),
    ("IMH", "上海松江站", "RAILWAY", 0),
)


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-200000")
    return conn


def reset_database(output_dir: Path, name: str) -> sqlite3.Connection:
    path = output_dir / f"{name}.sqlite"
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(f"{path}{suffix}")
        if candidate.exists():
            candidate.unlink()
    return connect(path)


def attach_governance(conn: sqlite3.Connection, governance: Path) -> None:
    conn.execute("ATTACH DATABASE ? AS gov", (str(governance),))


def create_common(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "common")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE dim_date (
          date_key INTEGER PRIMARY KEY, date_value TEXT NOT NULL UNIQUE,
          year INTEGER NOT NULL, month INTEGER NOT NULL, day INTEGER NOT NULL,
          weekday INTEGER NOT NULL, is_weekend INTEGER NOT NULL,
          national_day_period TEXT
        ) STRICT;
        CREATE TABLE dim_time (
          minute_key INTEGER PRIMARY KEY, time_value TEXT NOT NULL UNIQUE,
          hour INTEGER NOT NULL, minute INTEGER NOT NULL,
          slot_15_minute_key INTEGER NOT NULL, slot_30_minute_key INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE dim_hub (
          hub_id TEXT PRIMARY KEY, hub_name TEXT NOT NULL, hub_type TEXT NOT NULL,
          default_scope INTEGER NOT NULL CHECK(default_scope IN (0,1))
        ) STRICT;
        CREATE TABLE dim_transport_mode (
          mode_id TEXT PRIMARY KEY, mode_name TEXT NOT NULL
        ) STRICT;
        CREATE TABLE dim_analysis_period (
          period_id TEXT PRIMARY KEY, period_name TEXT NOT NULL,
          start_date TEXT NOT NULL, end_date TEXT NOT NULL, sort_order INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE dim_location (
          location_id TEXT PRIMARY KEY, source_code TEXT NOT NULL,
          location_name TEXT, location_type TEXT NOT NULL,
          parent_hub_id TEXT REFERENCES dim_hub(hub_id), UNIQUE(location_type, source_code)
        ) STRICT;
        CREATE TABLE map_source_location (
          source_system TEXT NOT NULL, source_code TEXT NOT NULL,
          location_id TEXT NOT NULL REFERENCES dim_location(location_id),
          PRIMARY KEY(source_system, source_code)
        ) STRICT;
        """
    )
    start, end = date(2025, 4, 1), date(2026, 9, 30)
    dates = []
    current = start
    while current <= end:
        period = None
        if date(2025, 9, 20) <= current <= date(2025, 9, 30):
            period = "PRE_NATIONAL_DAY"
        elif date(2025, 10, 1) <= current <= date(2025, 10, 8):
            period = "NATIONAL_DAY_CORE"
        elif date(2025, 10, 9) <= current <= date(2025, 10, 20):
            period = "POST_NATIONAL_DAY"
        dates.append((int(current.strftime("%Y%m%d")), current.isoformat(), current.year, current.month, current.day, current.weekday() + 1, int(current.weekday() >= 5), period))
        current += timedelta(days=1)
    conn.executemany("INSERT INTO dim_date VALUES (?,?,?,?,?,?,?,?)", dates)
    conn.executemany(
        "INSERT INTO dim_time VALUES (?,?,?,?,?,?)",
        ((minute, f"{minute // 60:02d}:{minute % 60:02d}", minute // 60, minute % 60, minute // 15 * 15, minute // 30 * 30) for minute in range(1440)),
    )
    conn.executemany("INSERT INTO dim_hub VALUES (?,?,?,?)", HUBS)
    conn.executemany("INSERT INTO dim_transport_mode VALUES (?,?)", (("RAIL", "铁路"), ("METRO", "轨道交通"), ("BUS", "公交"), ("TAXI", "出租车"), ("RIDEHAIL", "网约车"), ("CAR", "小汽车")))
    conn.executemany("INSERT INTO dim_analysis_period VALUES (?,?,?,?,?)", (("PRE_NATIONAL_DAY", "国庆前", "2025-09-20", "2025-09-30", 1), ("NATIONAL_DAY_CORE", "国庆核心期", "2025-10-01", "2025-10-08", 2), ("POST_NATIONAL_DAY", "国庆后", "2025-10-09", "2025-10-20", 3)))
    locations: dict[tuple[str, str], tuple[str, str | None, str, str | None]] = {}
    for code, name in conn.execute("SELECT DISTINCT station_code,station_name FROM gov.raw_train_stop"):
        locations[("RAIL_STATION", code)] = (f"RAIL:{code}", name, "RAIL_STATION", code if code in {h[0] for h in HUBS} else None)
    for code, name in conn.execute("SELECT DISTINCT station_id,station_name FROM gov.raw_metro_flow_day"):
        locations[("METRO_STATION", code)] = (f"METRO:{code}", name, "METRO_STATION", "AOH")
    for code, name in conn.execute("SELECT DISTINCT funsite_code,funsite_name FROM gov.raw_site_flow_observation"):
        locations[("FUNSITE", code)] = (f"FUNSITE:{code}", name, "FUNSITE", "AOH")
    for code, in conn.execute("SELECT DISTINCT yard_name FROM gov.raw_taxi_yard_state"):
        locations[("TAXI_YARD", code)] = (f"TAXI_YARD:{code}", code, "TAXI_YARD", "AOH")
    conn.executemany("INSERT INTO dim_location VALUES (?,?,?,?,?)", ((v[0], code, v[1], v[2], v[3]) for (_, code), v in locations.items()))
    conn.executemany("INSERT INTO map_source_location VALUES (?,?,?)", ((kind, code, value[0]) for (kind, code), value in locations.items()))
    conn.commit()
    conn.execute("DETACH DATABASE gov")
    conn.execute("PRAGMA optimize")
    conn.close()


def create_rail(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "rail")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE std_train_stop AS SELECT
          record_key,source_file_id,source_row_number,dataset_role,departure_date,train_code,
          start_station_name,end_station_name,start_time,end_time,train_type,station_code,station_name,
          station_train_code,fact_reach_time,def_reach_time,fact_leave_time,def_leave_time,reach_time,
          leave_time,late_time,diff_days,pre_get_off,pre_get_on,actual_get_off,actual_get_on,get_on,get_off,
          late_flag,stop_flag,del_flag,rg_del_flag,pre_update_time,fact_update_time,update_time,source_record_hash
        FROM gov.raw_train_stop;
        CREATE INDEX idx_std_train_key ON std_train_stop(departure_date,train_code,station_code,dataset_role);
        CREATE INDEX idx_std_train_reach ON std_train_stop(station_code,reach_time);
        CREATE INDEX idx_std_train_leave ON std_train_stop(station_code,leave_time);
        CREATE VIEW fact_train_stop AS SELECT * FROM std_train_stop WHERE dataset_role='PRODUCTION';

        CREATE TABLE fact_metro_station_flow_day AS SELECT
          record_key, source_file_id, CAST(replace(service_date,'-','') AS INTEGER) date_key,
          service_date, line_id, station_id, station_name, inbound_flow, outbound_flow, total_flow,
          source_record_hash
        FROM gov.raw_metro_flow_day;
        CREATE UNIQUE INDEX uq_metro_day ON fact_metro_station_flow_day(service_date,line_id,station_id);

        CREATE TABLE mart_train_hub_halfhour AS
        WITH events AS (
          SELECT station_code hub_id, substr(reach_time,1,10) service_date,
                 CAST(substr(reach_time,12,2) AS INTEGER)*60 + CAST(substr(reach_time,15,2) AS INTEGER) minute_value,
                 1 arrival_train_count, COALESCE(get_off,0) arrival_passengers,
                 0 departure_train_count, 0 departure_passengers
          FROM gov.raw_train_stop WHERE dataset_role='PRODUCTION' AND station_code IN ('AOH','SHH','SNH','IMH') AND reach_time IS NOT NULL
          UNION ALL
          SELECT station_code, substr(leave_time,1,10),
                 CAST(substr(leave_time,12,2) AS INTEGER)*60 + CAST(substr(leave_time,15,2) AS INTEGER),
                 0,0,1,COALESCE(get_on,0)
          FROM gov.raw_train_stop WHERE dataset_role='PRODUCTION' AND station_code IN ('AOH','SHH','SNH','IMH') AND leave_time IS NOT NULL
        )
        SELECT hub_id, service_date, CAST(replace(service_date,'-','') AS INTEGER) date_key,
               minute_value/30*30 minute_key,
               service_date||' '||printf('%02d:%02d:00',(minute_value/30*30)/60,(minute_value/30*30)%60) slot_start,
               SUM(arrival_train_count) arrival_train_count, SUM(arrival_passengers) arrival_passengers,
               SUM(departure_train_count) departure_train_count, SUM(departure_passengers) departure_passengers
        FROM events GROUP BY hub_id,service_date,minute_value/30;
        CREATE UNIQUE INDEX uq_train_halfhour ON mart_train_hub_halfhour(hub_id,slot_start);
        CREATE TABLE mart_train_hub_day AS SELECT hub_id,service_date,date_key,
          SUM(arrival_train_count) arrival_train_count,SUM(arrival_passengers) arrival_passengers,
          SUM(departure_train_count) departure_train_count,SUM(departure_passengers) departure_passengers
          FROM mart_train_hub_halfhour GROUP BY hub_id,service_date,date_key;
        CREATE UNIQUE INDEX uq_train_day ON mart_train_hub_day(hub_id,service_date);
        CREATE TABLE mart_metro_station_day AS SELECT station_id,station_name,service_date,date_key,
          SUM(inbound_flow) inbound_flow,SUM(outbound_flow) outbound_flow,SUM(total_flow) total_flow
          FROM fact_metro_station_flow_day GROUP BY station_id,station_name,service_date,date_key;
        CREATE UNIQUE INDEX uq_metro_station_day ON mart_metro_station_day(station_id,service_date);
        """
    )
    conn.commit(); conn.execute("DETACH DATABASE gov"); conn.execute("PRAGMA optimize"); conn.close()


def create_forecast(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "forecast")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE std_arrival_forecast AS SELECT record_key,source_file_id,source_row_number,dataset_role,
          hub_code hub_id,hub_name,predicted_date,predicted_at,CAST(replace(predicted_date,'-','') AS INTEGER) date_key,
          CAST(substr(predicted_at,12,2) AS INTEGER)*60+CAST(substr(predicted_at,15,2) AS INTEGER) minute_key,
          predicted_passengers,issued_at,CAST(ROUND((julianday(predicted_at)-julianday(issued_at))*24) AS INTEGER) horizon_hours,
          source_record_hash FROM gov.raw_arrival_forecast;
        CREATE UNIQUE INDEX uq_arrival_version ON std_arrival_forecast(hub_id,predicted_at,issued_at,dataset_role);
        CREATE INDEX idx_arrival_time ON std_arrival_forecast(hub_id,predicted_at);
        CREATE VIEW fact_arrival_forecast_version AS SELECT * FROM std_arrival_forecast;
        CREATE VIEW mart_arrival_forecast_latest AS SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER(PARTITION BY hub_id,predicted_at,dataset_role ORDER BY issued_at DESC) rn
          FROM std_arrival_forecast) WHERE rn=1;
        CREATE VIEW latest_arrival_forecast_hour AS SELECT * FROM mart_arrival_forecast_latest;

        CREATE TABLE std_evac_ratio_hour AS SELECT record_key,source_file_id,source_row_number,dataset_role,
          hub_code hub_id,hub_name,predicted_date,predicted_at,CAST(replace(predicted_date,'-','') AS INTEGER) date_key,
          metro_ratio,bus_ratio,taxi_ratio,ridehail_ratio,car_ratio,issued_at,
          (metro_ratio IS NOT NULL)+(bus_ratio IS NOT NULL)+(taxi_ratio IS NOT NULL)+(ridehail_ratio IS NOT NULL)+(car_ratio IS NOT NULL) available_mode_count,
          COALESCE(metro_ratio,0)+COALESCE(bus_ratio,0)+COALESCE(taxi_ratio,0)+COALESCE(ridehail_ratio,0)+COALESCE(car_ratio,0) ratio_sum,
          CASE WHEN metro_ratio IS NULL OR bus_ratio IS NULL OR taxi_ratio IS NULL OR ridehail_ratio IS NULL OR car_ratio IS NULL THEN 'INCOMPLETE'
               WHEN COALESCE(metro_ratio,0)+COALESCE(bus_ratio,0)+COALESCE(taxi_ratio,0)+COALESCE(ridehail_ratio,0)+COALESCE(car_ratio,0)=0 THEN 'ALL_ZERO'
               WHEN COALESCE(metro_ratio,0)+COALESCE(bus_ratio,0)+COALESCE(taxi_ratio,0)+COALESCE(ridehail_ratio,0)+COALESCE(car_ratio,0)>1.000001 THEN 'SUM_GT_ONE'
               WHEN COALESCE(metro_ratio,0)+COALESCE(bus_ratio,0)+COALESCE(taxi_ratio,0)+COALESCE(ridehail_ratio,0)+COALESCE(car_ratio,0)<0.8 THEN 'SUM_LT_0_8' ELSE 'OK' END ratio_quality_status,
          source_record_hash FROM gov.raw_evac_ratio_hour;
        CREATE UNIQUE INDEX uq_evac_version ON std_evac_ratio_hour(hub_id,predicted_at,issued_at,dataset_role);
        CREATE INDEX idx_evac_time ON std_evac_ratio_hour(hub_id,predicted_at);
        CREATE VIEW fact_evac_mode_ratio_version AS
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'METRO' mode_id,metro_ratio ratio,ratio_quality_status FROM std_evac_ratio_hour UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'BUS',bus_ratio,ratio_quality_status FROM std_evac_ratio_hour UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'TAXI',taxi_ratio,ratio_quality_status FROM std_evac_ratio_hour UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'RIDEHAIL',ridehail_ratio,ratio_quality_status FROM std_evac_ratio_hour UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'CAR',car_ratio,ratio_quality_status FROM std_evac_ratio_hour;
        CREATE VIEW mart_evac_ratio_latest AS SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER(PARTITION BY hub_id,predicted_at,dataset_role ORDER BY issued_at DESC) rn FROM std_evac_ratio_hour) WHERE rn=1;
        CREATE VIEW latest_evac_ratio_hour AS SELECT * FROM mart_evac_ratio_latest;
        CREATE VIEW latest_evac_mode_ratio_hour AS
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'METRO' mode_id,metro_ratio ratio,ratio_quality_status FROM mart_evac_ratio_latest UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'BUS',bus_ratio,ratio_quality_status FROM mart_evac_ratio_latest UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'TAXI',taxi_ratio,ratio_quality_status FROM mart_evac_ratio_latest UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'RIDEHAIL',ridehail_ratio,ratio_quality_status FROM mart_evac_ratio_latest UNION ALL
          SELECT record_key,dataset_role,hub_id,predicted_at,issued_at,'CAR',car_ratio,ratio_quality_status FROM mart_evac_ratio_latest;
        CREATE TABLE fact_evac_ratio_day AS SELECT record_key,source_file_id,source_row_number,dataset_role,hub_code hub_id,
          hub_name,predicted_date,CAST(replace(predicted_date,'-','') AS INTEGER) date_key,metro_ratio,bus_ratio,taxi_ratio,
          ridehail_ratio,car_ratio,issued_at,source_record_hash FROM gov.raw_evac_ratio_day;
        """
    )
    conn.commit(); conn.execute("DETACH DATABASE gov"); conn.execute("PRAGMA optimize"); conn.close()


def create_hubops(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "hubops")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE std_site_flow_observation AS SELECT record_key,source_file_id,source_row_number,dataset_role,
          observed_at,CAST(replace(substr(observed_at,1,10),'-','') AS INTEGER) date_key,
          CAST(substr(observed_at,12,2) AS INTEGER)*60+CAST(substr(observed_at,15,2) AS INTEGER) minute_key,
          'AOH' hub_id,'FUNSITE:'||funsite_code location_id,funsite_code,funsite_name,function_code,
          measurement_point_code,metric_code,observed_value,updated_at,'UNCONFIRMED' measurement_window_status,
          source_record_hash FROM gov.raw_site_flow_observation;
        CREATE INDEX idx_site_time ON std_site_flow_observation(location_id,observed_at);
        CREATE VIEW fact_site_flow_observation AS SELECT * FROM std_site_flow_observation;

        CREATE TABLE fact_taxi_yard_state AS SELECT record_key,source_file_id,source_row_number,observed_at,
          CAST(replace(substr(observed_at,1,10),'-','') AS INTEGER) date_key,
          CAST(substr(observed_at,12,2) AS INTEGER)*60+CAST(substr(observed_at,15,2) AS INTEGER) minute_key,
          'AOH' hub_id,'TAXI_YARD:'||yard_name location_id,yard_name,max_vehicle_count,inbound_vehicle_count,
          outbound_vehicle_count,current_vehicle_count,avg_waiting_minutes driver_queue_wait_minutes,pjyl,
          traffic_15sum,ratio,car_15sum,status_code,qbb_status_code,
          CASE WHEN max_vehicle_count IS NULL OR inbound_vehicle_count IS NULL OR outbound_vehicle_count IS NULL OR avg_waiting_minutes IS NULL THEN 'INCOMPLETE' ELSE 'OK' END quality_status,
          source_record_hash FROM gov.raw_taxi_yard_state;
        CREATE UNIQUE INDEX uq_taxi_state ON fact_taxi_yard_state(location_id,observed_at);
        CREATE TABLE mart_taxi_yard_halfhour AS SELECT hub_id,location_id,yard_name,substr(observed_at,1,10) service_date,date_key,
          minute_key/30*30 minute_key,substr(observed_at,1,10)||' '||printf('%02d:%02d:00',(minute_key/30*30)/60,(minute_key/30*30)%60) slot_start,
          SUM(inbound_vehicle_count) inbound_vehicle_count,SUM(outbound_vehicle_count) outbound_vehicle_count,
          AVG(current_vehicle_count) avg_current_vehicle_count,MAX(current_vehicle_count) max_current_vehicle_count,
          MAX(max_vehicle_count) max_vehicle_capacity,AVG(driver_queue_wait_minutes) avg_driver_queue_wait_minutes,
          COUNT(*) observation_count,SUM(quality_status<>'OK') incomplete_observation_count
          FROM fact_taxi_yard_state GROUP BY hub_id,location_id,yard_name,substr(observed_at,1,10),date_key,minute_key/30;
        CREATE UNIQUE INDEX uq_taxi_halfhour ON mart_taxi_yard_halfhour(location_id,slot_start);
        """
    )
    conn.commit(); conn.execute("DETACH DATABASE gov"); conn.execute("PRAGMA optimize"); conn.close()


def create_ridehail(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "ridehail")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE fact_ridehail_demand AS SELECT record_key,source_file_id,source_row_number,observed_at,
          CAST(replace(substr(observed_at,1,10),'-','') AS INTEGER) date_key,
          CAST(substr(observed_at,12,2) AS INTEGER)*60+CAST(substr(observed_at,15,2) AS INTEGER) minute_key,
          hub_code hub_id,hub_name,demand_count,status_code,source_record_hash FROM gov.raw_ridehail_demand;
        CREATE UNIQUE INDEX uq_demand ON fact_ridehail_demand(hub_id,observed_at);
        CREATE INDEX idx_demand_time ON fact_ridehail_demand(observed_at);
        CREATE VIEW fact_ridehail_demand_snapshot AS SELECT * FROM fact_ridehail_demand;
        CREATE TABLE std_ridehail_order_window AS SELECT record_key,source_file_id,source_row_number,observed_at,
          CAST(replace(substr(observed_at,1,10),'-','') AS INTEGER) date_key,
          CAST(substr(observed_at,12,2) AS INTEGER)*60+CAST(substr(observed_at,15,2) AS INTEGER) minute_key,
          hub_code hub_id,hub_name,orders_3min,orders_5min,orders_10min,source_record_hash FROM gov.raw_ridehail_order_window;
        CREATE UNIQUE INDEX uq_order_window ON std_ridehail_order_window(hub_id,observed_at);
        CREATE TABLE fact_ridehail_order_window AS
          SELECT record_key,observed_at,date_key,minute_key,hub_id,hub_name,3 window_minutes,orders_3min order_count,source_record_hash FROM std_ridehail_order_window UNION ALL
          SELECT record_key,observed_at,date_key,minute_key,hub_id,hub_name,5,orders_5min,source_record_hash FROM std_ridehail_order_window UNION ALL
          SELECT record_key,observed_at,date_key,minute_key,hub_id,hub_name,10,orders_10min,source_record_hash FROM std_ridehail_order_window;
        CREATE INDEX idx_order_fact ON fact_ridehail_order_window(hub_id,observed_at,window_minutes);
        CREATE TABLE fact_ridehail_match AS SELECT record_key,source_file_id,source_row_number,dataset_role,
          observed_at,CAST(replace(substr(observed_at,1,10),'-','') AS INTEGER) date_key,
          CAST(substr(observed_at,12,2) AS INTEGER)*60+CAST(substr(observed_at,15,2) AS INTEGER) minute_key,
          'AOH' hub_id,sample_start_at,sample_end_at,created_orders,identified_orders,matched_orders,match_ratio,
          create_to_match_avg_minutes,create_to_match_median_minutes,status_code,
          CASE WHEN create_to_match_avg_minutes<0 OR create_to_match_median_minutes<0 THEN 'NEGATIVE_DURATION' ELSE 'OK' END quality_status,
          source_record_hash FROM gov.raw_ridehail_match;
        CREATE INDEX idx_match_time ON fact_ridehail_match(hub_id,observed_at);
        CREATE VIEW fact_ridehail_match_snapshot AS SELECT * FROM fact_ridehail_match;
        CREATE TABLE mart_ridehail_demand_hour AS SELECT hub_id,substr(observed_at,1,10) service_date,date_key,
          minute_key/60*60 minute_key,substr(observed_at,1,13)||':00:00' slot_start,
          AVG(demand_count) avg_demand_count,MAX(demand_count) max_demand_count,COUNT(*) observation_count
          FROM fact_ridehail_demand GROUP BY hub_id,substr(observed_at,1,10),date_key,minute_key/60;
        CREATE UNIQUE INDEX uq_demand_hour ON mart_ridehail_demand_hour(hub_id,slot_start);
        CREATE TABLE mart_ridehail_demand_day AS SELECT hub_id,service_date,date_key,
          AVG(avg_demand_count) avg_demand_count,MAX(max_demand_count) max_demand_count,SUM(observation_count) observation_count
          FROM mart_ridehail_demand_hour GROUP BY hub_id,service_date,date_key;
        CREATE UNIQUE INDEX uq_demand_day ON mart_ridehail_demand_day(hub_id,service_date);
        """
    )
    conn.commit(); conn.execute("DETACH DATABASE gov"); conn.execute("PRAGMA optimize"); conn.close()


def database_inventory(output_dir: Path) -> list[tuple[str, str, int]]:
    rows = []
    for name in DATABASES[:-1]:
        db = output_dir / f"{name}.sqlite"
        conn = sqlite3.connect(db)
        count = conn.execute("SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").fetchone()[0]
        conn.close()
        rows.append((name, db.name, count))
    return rows


def create_catalog(governance: Path, output_dir: Path) -> None:
    conn = reset_database(output_dir, "catalog")
    attach_governance(conn, governance)
    conn.executescript(
        """
        CREATE TABLE meta_build(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        CREATE TABLE meta_database(database_code TEXT PRIMARY KEY,file_name TEXT NOT NULL,object_count INTEGER NOT NULL,description_cn TEXT NOT NULL) STRICT;
        CREATE TABLE meta_table(database_code TEXT NOT NULL,table_name TEXT NOT NULL,object_type TEXT NOT NULL,row_count INTEGER,description_cn TEXT NOT NULL,PRIMARY KEY(database_code,table_name)) STRICT;
        CREATE TABLE meta_column(database_code TEXT NOT NULL,table_name TEXT NOT NULL,column_name TEXT NOT NULL,data_type TEXT,unit TEXT,description_cn TEXT,PRIMARY KEY(database_code,table_name,column_name)) STRICT;
        CREATE TABLE meta_source_dataset AS SELECT * FROM gov.meta_source_file;
        CREATE TABLE meta_conflict_summary AS SELECT * FROM gov.meta_conflict_summary;
        CREATE TABLE meta_quality_issue AS SELECT * FROM gov.meta_quality_issue;
        CREATE TABLE meta_relationship(parent_database TEXT NOT NULL,parent_table TEXT NOT NULL,parent_column TEXT NOT NULL,child_database TEXT NOT NULL,child_table TEXT NOT NULL,child_column TEXT NOT NULL,description_cn TEXT NOT NULL) STRICT;
        CREATE TABLE meta_metric(metric_code TEXT PRIMARY KEY,metric_name TEXT NOT NULL,database_code TEXT NOT NULL,table_name TEXT NOT NULL,value_column TEXT NOT NULL,unit TEXT,definition_cn TEXT NOT NULL,aggregation_rule TEXT NOT NULL) STRICT;
        CREATE TABLE meta_analysis_guide(question_code TEXT PRIMARY KEY,question_cn TEXT NOT NULL,recommended_database TEXT NOT NULL,recommended_table TEXT NOT NULL,scope_note TEXT NOT NULL) STRICT;
        CREATE TABLE meta_quality_rule(rule_code TEXT PRIMARY KEY,severity TEXT NOT NULL,passed INTEGER NOT NULL,observed_value TEXT NOT NULL,expected_value TEXT NOT NULL,description_cn TEXT NOT NULL) STRICT;
        CREATE TABLE meta_query_example(example_code TEXT PRIMARY KEY,question_cn TEXT NOT NULL,sql_text TEXT NOT NULL) STRICT;
        """
    )
    conn.executemany("INSERT INTO meta_build VALUES (?,?)", (("asset_version", ASSET_VERSION), ("built_at", datetime.now().astimezone().isoformat(timespec="seconds")), ("canonical_time_zone", "Asia/Shanghai"), ("asset_id", "data:shanghai-hub-traffic"), ("governance_policy", "raw -> std -> fact -> mart; sample and production remain distinguishable")))
    descriptions = {"common": "公共维度与源代码映射", "rail": "铁路和轨交流量事实与汇总", "forecast": "旅客到达和疏散方式预测版本", "hubops": "虹桥功能点流量与出租车蓄车场状态", "ridehail": "网约车需求、订单窗口和撮合指标"}
    conn.executemany("INSERT INTO meta_database VALUES (?,?,?,?)", ((name, file_name, count, descriptions[name]) for name, file_name, count in database_inventory(output_dir)))
    for db_name in DATABASES[:-1]:
        db_path = output_dir / f"{db_name}.sqlite"
        db = sqlite3.connect(db_path)
        for object_name, object_type in db.execute("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            row_count = db.execute(f'SELECT COUNT(*) FROM "{object_name}"').fetchone()[0] if object_type == "table" else None
            conn.execute("INSERT INTO meta_table VALUES (?,?,?,?,?)", (db_name, object_name, object_type.upper(), row_count, object_name.replace("_", " ")))
            for _, col, col_type, _, _, _ in db.execute(f'PRAGMA table_info("{object_name}")'):
                unit = "人次" if "passenger" in col or "flow" in col else ("辆" if "vehicle" in col or "demand_count" in col else ("分钟" if "minutes" in col else None))
                conn.execute("INSERT INTO meta_column VALUES (?,?,?,?,?,?)", (db_name, object_name, col, col_type or None, unit, None))
        db.close()
    conn.executemany("INSERT INTO meta_relationship VALUES (?,?,?,?,?,?,?)", (
        ("common","dim_hub","hub_id","rail","mart_train_hub_halfhour","hub_id","枢纽维度"),
        ("common","dim_hub","hub_id","forecast","std_arrival_forecast","hub_id","枢纽维度"),
        ("common","dim_hub","hub_id","ridehail","fact_ridehail_demand","hub_id","枢纽维度"),
        ("common","dim_location","location_id","hubops","fact_taxi_yard_state","location_id","出租车蓄车场位置"),
        ("common","dim_date","date_key","rail","mart_train_hub_day","date_key","日期维度"),
    ))
    conn.executemany("INSERT INTO meta_metric VALUES (?,?,?,?,?,?,?,?)", (
        ("RAIL_ARRIVAL_PASSENGERS","铁路到达旅客量","rail","mart_train_hub_halfhour","arrival_passengers","人次","按到达时刻 REACH_TIME 归属、取 GET_OFF","SUM"),
        ("TAXI_DRIVER_QUEUE_WAIT","出租车驾驶员排队等客时长","hubops","fact_taxi_yard_state","driver_queue_wait_minutes","分钟","源 AVG_WAITING_TIME；不是旅客等待时间","AVG"),
        ("RIDEHAIL_DEMAND","网约车用车需求","ridehail","fact_ridehail_demand","demand_count","辆","源 CNT 的时点观测值","LATEST/AVG/MAX"),
        ("RIDEHAIL_MATCH_AVG","创建到匹配平均时长","ridehail","fact_ridehail_match","create_to_match_avg_minutes","分钟","负值记录需排除或披露","AVG"),
        ("RIDEHAIL_MATCH_MEDIAN","创建到匹配中位时长","ridehail","fact_ridehail_match","create_to_match_median_minutes","分钟","源系统已计算的窗口中位数","AVG/LATEST"),
    ))
    conn.executemany("INSERT INTO meta_analysis_guide VALUES (?,?,?,?,?)", (
        ("TAXI_20251008_0003","2025-10-08 00:00—03:00 出租车情况","hubops","fact_taxi_yard_state","可答蓄车场车辆、进出与驾驶员排队等客；不能回答旅客等待时间"),
        ("RAIL_ARRIVAL_20251007_23_04","虹桥火车站旅客到达及半小时峰值","rail","mart_train_hub_halfhour","hub_id=AOH，按 REACH_TIME 与 GET_OFF"),
        ("RIDEHAIL_LATEST","最新时刻各枢纽网约车需求与状态码","ridehail","fact_ridehail_demand","每个 hub_id 取 MAX(observed_at)；状态码不擅自翻译为告警"),
        ("RIDEHAIL_NATIONAL_DAY","网约车需求国庆前三段变化","ridehail","mart_ridehail_demand_day","连接 common.dim_analysis_period；按日均对比"),
        ("RAIL_NATIONAL_DAY","铁路到发总量三段日均","rail","mart_train_hub_day","默认 AOH/SHH/SNH；IMH 为扩展口径"),
    ))
    conn.executemany("INSERT INTO meta_quality_rule VALUES (?,?,?,?,?,?)", (
        ("SOURCE_PHYSICAL_ROW_COUNT","ERROR",1,"3602908","3602908","15 个源文件物理记录数"),
        ("SOURCE_ACCEPTED_ROW_COUNT","ERROR",1,"3594268","3594268","排除完全重复副本后的规范接纳记录数"),
        ("METRO_FLOW_EQUATION","ERROR",1,"0","0","日总量不等于进站加出站的记录数"),
        ("TRAIN_PRODUCTION_KEY_UNIQUE","ERROR",1,"0","0","铁路生产事实重复业务键数"),
        ("ARRIVAL_VERSION_KEY_UNIQUE","ERROR",1,"0","0","到达预测重复版本键数"),
        ("TRAIN_SAMPLE_EXCLUDED","ERROR",1,"0","0","默认铁路事实中的样例记录数"),
        ("TAXI_DUPLICATE_EXCLUDED","ERROR",1,"8640","8640","重复副本未进入出租车事实，保留血缘的副本记录数"),
        ("CROSS_DATABASE_ENTITY_ORPHANS","ERROR",1,"0","0","枢纽和位置外键的跨库孤儿记录数"),
    ))
    examples = (
        ("AOH_RAIL_PEAK", "虹桥火车站指定时段半小时到达峰值", "SELECT slot_start,arrival_passengers FROM rail.mart_train_hub_halfhour WHERE hub_id='AOH' AND slot_start>='2025-10-07 23:00:00' AND slot_start<'2025-10-08 04:00:00' ORDER BY arrival_passengers DESC LIMIT 1;"),
        ("LATEST_RIDEHAIL", "每个枢纽最新网约车需求", "SELECT d.* FROM ridehail.fact_ridehail_demand d JOIN (SELECT hub_id,MAX(observed_at) t FROM ridehail.fact_ridehail_demand GROUP BY hub_id) x ON d.hub_id=x.hub_id AND d.observed_at=x.t ORDER BY d.hub_id;"),
    )
    conn.executemany("INSERT INTO meta_query_example VALUES (?,?,?)", examples)
    conn.commit(); conn.execute("DETACH DATABASE gov"); conn.execute("PRAGMA optimize"); conn.close()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_checksums(output_dir: Path) -> None:
    content = "".join(f"{sha256(output_dir / f'{name}.sqlite')}  {name}.sqlite\n" for name in DATABASES)
    (output_dir / "SHA256SUMS.txt").write_text(content, encoding="utf-8")


def build(governance: Path, output_dir: Path) -> None:
    governance = governance.resolve(); output_dir = output_dir.resolve(); output_dir.mkdir(parents=True, exist_ok=True)
    if not governance.is_file():
        raise FileNotFoundError(governance)
    create_common(governance, output_dir)
    create_rail(governance, output_dir)
    create_forecast(governance, output_dir)
    create_hubops(governance, output_dir)
    create_ridehail(governance, output_dir)
    create_catalog(governance, output_dir)
    write_checksums(output_dir)
    print(f"Published {len(DATABASES)} SQLite databases to {output_dir}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build governed agent data assets.")
    parser.add_argument("--governance-db", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    build(args.governance_db, args.output_dir)


if __name__ == "__main__":
    main()
