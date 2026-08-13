#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone

from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree


def read_collection(item, repair_invalid):
    with open(item["absolutePath"], "r", encoding="utf-8") as handle:
        collection = json.load(handle)
    records = []
    invalid = 0
    empty = 0
    for index, feature in enumerate(collection["features"]):
        geometry_value = feature.get("geometry")
        if geometry_value is None:
            empty += 1
            records.append({"feature": feature, "geometry": None, "index": index})
            continue
        geometry = shape(geometry_value)
        if geometry.is_empty:
            empty += 1
            records.append({"feature": feature, "geometry": None, "index": index})
            continue
        if not geometry.is_valid:
            invalid += 1
            if not repair_invalid:
                raise ValueError(f"Invalid geometry at feature {index}; set repairInvalid=true to repair it")
            geometry = make_valid(geometry)
            if geometry.is_empty:
                empty += 1
                geometry = None
        records.append({"feature": feature, "geometry": geometry, "index": index})
    return records, invalid, empty


def projector(source, target):
    transformer = Transformer.from_crs(source, target, always_xy=True)
    return lambda geometry: transform(transformer.transform, geometry)


def feature_id(record):
    feature = record["feature"]
    properties = feature.get("properties") or {}
    return feature.get("id", properties.get("id", record["index"]))


def copied_properties(record, fields):
    properties = record["feature"].get("properties") or {}
    return {f"right_{field}": properties.get(field) for field in fields}


def make_feature(record, geometry, extra):
    feature = record["feature"]
    return {
        "type": "Feature",
        **({"id": feature["id"]} if "id" in feature else {}),
        "properties": {**(feature.get("properties") or {}), **extra},
        "geometry": mapping(geometry) if geometry is not None else None,
    }


def run_buffer(inputs, parameters, stats):
    records = inputs[0]["records"]
    to_metric = projector(parameters["inputCrs"], parameters["metricCrs"])
    to_wgs84 = projector(parameters["metricCrs"], "EPSG:4326")
    buffered = [(record, to_metric(record["geometry"]).buffer(parameters["distanceMeters"])) for record in records if record["geometry"] is not None]
    if parameters.get("dissolve"):
        geometry = unary_union([item[1] for item in buffered])
        return [{"type": "Feature", "properties": {"distance_m": parameters["distanceMeters"], "dissolved": True}, "geometry": mapping(to_wgs84(geometry))}]
    return [make_feature(record, to_wgs84(geometry), {"distance_m": parameters["distanceMeters"]}) for record, geometry in buffered]


def run_nearest(inputs, parameters, stats):
    left_records, right_records = inputs[0]["records"], inputs[1]["records"]
    left_to_metric = projector(parameters["leftCrs"], parameters["metricCrs"])
    right_to_metric = projector(parameters["rightCrs"], parameters["metricCrs"])
    left_to_wgs84 = projector(parameters["leftCrs"], "EPSG:4326")
    right_valid = [record for record in right_records if record["geometry"] is not None]
    right_metric = [right_to_metric(record["geometry"]) for record in right_valid]
    tree = STRtree(right_metric) if right_metric else None
    fields = [field for field in parameters.get("rightFields", "").split(",") if field]
    maximum = parameters.get("maxDistanceMeters")
    output = []
    for record in left_records:
        geometry = record["geometry"]
        result_geometry = left_to_wgs84(geometry) if geometry is not None else None
        if geometry is None or tree is None:
            stats["unmatched"] += 1
            output.append(make_feature(record, result_geometry, {"nearest_right_id": None, "nearest_distance_m": None, "match_status": "unmatched"}))
            continue
        metric_geometry = left_to_metric(geometry)
        right_index = int(tree.nearest(metric_geometry))
        distance = float(metric_geometry.distance(right_metric[right_index]))
        matched = maximum is None or distance <= maximum
        if not matched:
            stats["unmatched"] += 1
            output.append(make_feature(record, result_geometry, {"nearest_right_id": None, "nearest_distance_m": round(distance, 3), "match_status": "unmatched"}))
            continue
        right = right_valid[right_index]
        output.append(make_feature(record, result_geometry, {"nearest_right_id": feature_id(right), "nearest_distance_m": round(distance, 3), "match_status": "matched", **copied_properties(right, fields)}))
    return output


def run_spatial_join(inputs, parameters, stats):
    left_records, right_records = inputs[0]["records"], inputs[1]["records"]
    right_to_left = projector(parameters["rightCrs"], parameters["leftCrs"])
    left_to_wgs84 = projector(parameters["leftCrs"], "EPSG:4326")
    right_valid = [record for record in right_records if record["geometry"] is not None]
    right_geometries = [right_to_left(record["geometry"]) for record in right_valid]
    tree = STRtree(right_geometries) if right_geometries else None
    fields = [field for field in parameters.get("rightFields", "").split(",") if field]
    output = []
    for left in left_records:
        geometry = left["geometry"]
        result_geometry = left_to_wgs84(geometry) if geometry is not None else None
        matches = [] if geometry is None or tree is None else [int(index) for index in tree.query(geometry, predicate=parameters["predicate"])]
        if not matches:
            stats["unmatched"] += 1
            output.append(make_feature(left, result_geometry, {"spatial_match_count": 0, "matched_right_id": None, "match_status": "unmatched"}))
            continue
        if parameters["cardinality"] == "one-to-one" and len(matches) > 1 and parameters["multipleMatchStrategy"] == "error":
            raise ValueError(f"Feature {feature_id(left)} has {len(matches)} matches; select one-to-many or an explicit multipleMatchStrategy")
        selected = matches if parameters["cardinality"] == "one-to-many" else matches[:1]
        for right_index in selected:
            right = right_valid[right_index]
            output.append(make_feature(left, result_geometry, {"spatial_match_count": len(matches), "matched_right_id": feature_id(right), "match_status": "matched", **copied_properties(right, fields)}))
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    with open(args.request, "r", encoding="utf-8") as handle:
        request = json.load(handle)
    parameters = request["parameters"]
    repair_invalid = parameters.get("repairInvalid", False)
    input_records = []
    invalid = 0
    empty = 0
    for item in request["inputs"]:
        records, item_invalid, item_empty = read_collection(item, repair_invalid)
        input_records.append({"metadata": item, "records": records})
        invalid += item_invalid
        empty += item_empty
    stats = {"unmatched": 0}
    if request["operation"] == "buffer":
        features = run_buffer(input_records, parameters, stats)
    elif request["operation"] == "nearest":
        features = run_nearest(input_records, parameters, stats)
    else:
        features = run_spatial_join(input_records, parameters, stats)
    collection = {"type": "FeatureCollection", "features": features}
    encoded = (json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    os.makedirs(os.path.dirname(request["resultPath"]), exist_ok=True)
    with open(request["resultPath"], "wb") as handle:
        handle.write(encoded)
    geometry_types = sorted({feature["geometry"]["type"] for feature in features if feature.get("geometry")})
    result = {
        "protocol": "transportx-spatial-analysis",
        "schemaVersion": 1,
        "analysisId": request["analysisId"],
        "operation": request["operation"],
        "inputs": [{key: item["metadata"][key] for key in ("role", "relativePath", "sha256", "crs", "featureCount")} for item in input_records],
        "parameters": parameters,
        "counts": {"input": sum(item["metadata"]["featureCount"] for item in input_records), "output": len(features), "unmatched": stats["unmatched"], "invalidGeometry": invalid, "emptyGeometry": empty},
        "output": {"relativePath": request["resultRelativePath"], "sha256": hashlib.sha256(encoded).hexdigest(), "crs": "EPSG:4326", "geometryTypes": geometry_types, "featureCount": len(features)},
        "warnings": ([f"Repaired {invalid} invalid geometries"] if invalid else []) + ([f"Ignored or retained {empty} empty geometries"] if empty else []),
        "durationMs": round((time.monotonic() - started) * 1000, 3),
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
