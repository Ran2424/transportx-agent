#!/usr/bin/env python3
"""Count visible people once per second for the Hongqiao entrance recording.

This is an occupancy measure, not an entry/exit flow measure: each sampled
frame is independently detected with YOLO and the number of ``person`` boxes
is recorded.  The resulting CSV can therefore drive a video player's live
"current people in view" indicator.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from datetime import datetime, timedelta
from pathlib import Path


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="YOLO per-second visible-person counting.")
    parser.add_argument("--video", type=Path, default=here.parent / "data" / "videos" / "hongqiao_b1_metro_entrance_20260630.mp4")
    parser.add_argument("--model", type=Path, default=Path("yolo26s.pt"), help="YOLO weights path or model name accepted by Ultralytics.")
    parser.add_argument("--out", type=Path, default=here.parent / "data" / "metrics" / "visible_people_second.csv")
    parser.add_argument("--start-time", default="2026-06-30T16:39:58+08:00", help="Recording start time as ISO 8601 with an explicit offset.")
    parser.add_argument("--conf", type=float, default=0.15)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument("--imgsz", type=int, default=1280, help="YOLO inference image size in pixels.")
    parser.add_argument("--device", default="mps")
    parser.add_argument("--duration", type=float, default=0.0, help="Seconds to process; 0 = the entire recording.")
    return parser.parse_args()


def import_runtime_dependencies():
    os.environ.setdefault("YOLO_CONFIG_DIR", str(Path(__file__).resolve().parent / "outputs" / ".ultralytics"))
    try:
        import cv2  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"缺少依赖（ultralytics / opencv-python）: {exc}") from exc
    return cv2, YOLO


def recording_start(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("--start-time 必须包含时区，例如 2026-06-30T16:39:58+08:00")
    return parsed


def main() -> int:
    args = parse_args()
    cv2, YOLO = import_runtime_dependencies()
    video_path = args.video.expanduser().resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"视频不存在: {video_path}")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    video_seconds = total_frames / fps
    target_seconds = min(video_seconds, args.duration) if args.duration > 0 else video_seconds
    sample_count = int(target_seconds) + (1 if target_seconds % 1 else 0)
    start = recording_start(args.start_time)
    model = YOLO(str(args.model))
    rows: list[dict[str, object]] = []

    for second in range(sample_count):
        capture.set(cv2.CAP_PROP_POS_FRAMES, min(round(second * fps), max(total_frames - 1, 0)))
        ok, frame = capture.read()
        if not ok:
            break
        result = model.predict(frame, classes=[0], conf=args.conf, iou=args.iou, imgsz=args.imgsz, device=args.device, verbose=False)
        boxes = result[0].boxes if result else None
        count = int(len(boxes)) if boxes is not None else 0
        absolute_time = start + timedelta(seconds=second)
        rows.append({
            "relative_second": second,
            "absolute_time": absolute_time.isoformat(timespec="seconds"),
            "value": count,
        })
        if (second + 1) % 120 == 0 or second + 1 == sample_count:
            print(f"processed {second + 1}/{sample_count} seconds", flush=True)

    capture.release()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=["relative_second", "absolute_time", "value"])
        writer.writeheader()
        writer.writerows(rows)
    args.out.with_suffix(".meta.json").write_text(json.dumps({
        "method": "YOLO person detection; one independently sampled frame per second",
        "metric_id": "visible_people",
        "label": "画面当前人数",
        "unit": "人",
        "model": args.model.name,
        "confidence": args.conf,
        "iou": args.iou,
        "image_size": args.imgsz,
        "device": args.device,
        "video": video_path.name,
        "fps": fps,
        "sample_count": len(rows),
        "recording_start": start.isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"视频指标: {args.out} ({len(rows)} samples)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
