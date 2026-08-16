#!/usr/bin/env python3
"""Per-minute inbound passenger counting for a fixed surveillance video (ROI entry method).

Method: YOLO (person) + ByteTrack; a track is counted once when its foot point
enters the ROI from outside while moving upward (toward the gates). Counts are
aggregated per absolute minute and written to CSV.

Lean variant of process_entry_count.py: frame-skip sampling, no full-length
annotated video (optional short QA clip), full-duration oriented.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Deque

BASE_WIDTH = 1920
BASE_HEIGHT = 1080
TZ = timedelta(hours=8)  # 摄像头本地时间为北京时间 (+08:00)


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class Roi:
    x1: float
    y1: float
    x2: float
    y2: float

    def contains(self, point: Point) -> bool:
        return self.x1 <= point.x <= self.x2 and self.y1 <= point.y <= self.y2


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="ROI-based per-minute entry counting (YOLO + ByteTrack).")
    parser.add_argument("--video", type=Path, default=here / "监控" / "2026-06-30-16-39-58_高铁B1层14南通道地铁入口_31011210071322000777@002$1$0$0_1.mp4")
    parser.add_argument("--model", type=Path, default=here / "models" / "yolo26s.pt")
    parser.add_argument("--out-dir", type=Path, default=here / "outputs" / "entry_roi_full")
    parser.add_argument("--duration", type=float, default=0.0, help="Seconds to process; 0 = full video.")
    parser.add_argument("--sample-fps", type=float, default=5.0, help="Processed frames per second (frame skipping).")
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.5)
    parser.add_argument("--roi", default="560,345,1450,520", help="x1,y1,x2,y2 at 1920x1080 scale.")
    parser.add_argument("--min-up-pixels", type=float, default=8.0, help="Upward movement required at 1920x1080 scale.")
    parser.add_argument("--trail-length", type=int, default=30)
    parser.add_argument("--tracker", default="bytetrack.yaml")
    parser.add_argument("--device", default="mps")
    parser.add_argument("--annotate-seconds", type=float, default=180.0, help="Write an annotated QA clip for the first N seconds (0 = off).")
    return parser.parse_args()


def import_runtime_dependencies():
    here = Path(__file__).resolve().parent
    os.environ.setdefault("YOLO_CONFIG_DIR", str(here / "outputs" / ".ultralytics"))
    os.environ.setdefault("MPLCONFIGDIR", str(here / "outputs" / ".cache" / "matplotlib"))
    os.environ.setdefault("XDG_CACHE_HOME", str(here / "outputs" / ".cache"))
    try:
        import cv2  # type: ignore
        from ultralytics import YOLO  # type: ignore
    except ImportError as exc:
        raise SystemExit(f"缺少依赖（ultralytics / opencv-python）: {exc}") from exc
    return cv2, YOLO


def parse_roi(text: str) -> Roi:
    x1, y1, x2, y2 = [float(part.strip()) for part in text.split(",")]
    if x1 >= x2 or y1 >= y2:
        raise ValueError("--roi requires x1 < x2 and y1 < y2")
    return Roi(x1, y1, x2, y2)


def infer_start_time(video_path: Path) -> datetime | None:
    match = re.search(r"(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})", video_path.name)
    return datetime.strptime(match.group(1), "%Y-%m-%d-%H-%M-%S") if match else None


def moved_up(history: Deque[Point], current: Point, min_up_pixels: float) -> bool:
    if not history:
        return False
    oldest = history[0]
    previous = history[-1]
    return (oldest.y - current.y) >= min_up_pixels or (previous.y - current.y) >= max(2.0, min_up_pixels / 4)


def fmt(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else ""


def main() -> int:
    args = parse_args()
    cv2, YOLO = import_runtime_dependencies()

    video_path = args.video.expanduser().resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"视频不存在: {video_path}")
    if not args.model.exists():
        raise FileNotFoundError(f"模型不存在: {args.model}")
    out_dir = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    video_seconds = total_frames / fps if total_frames > 0 else args.duration
    target_seconds = video_seconds if args.duration <= 0 else min(args.duration, video_seconds)
    frame_limit = int(target_seconds * fps)
    stride = max(1, round(fps / args.sample_fps))

    scale_x, scale_y = width / BASE_WIDTH, height / BASE_HEIGHT
    base_roi = parse_roi(args.roi)
    roi = Roi(base_roi.x1 * scale_x, base_roi.y1 * scale_y, base_roi.x2 * scale_x, base_roi.y2 * scale_y)
    min_up_pixels = args.min_up_pixels * scale_y

    model = YOLO(str(args.model))

    start_time = infer_start_time(video_path)
    stem = video_path.stem
    tag = f"{int(target_seconds)}s"
    output_counts = out_dir / f"{stem}_roi_minute_counts_{tag}.csv"
    output_events = out_dir / f"{stem}_roi_entry_events_{tag}.csv"
    output_meta = out_dir / f"{stem}_roi_meta_{tag}.json"
    output_clip = out_dir / f"{stem}_roi_annotated_qa.mp4"

    writer = None
    if args.annotate_seconds > 0:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(output_clip), fourcc, args.sample_fps, (width, height))

    histories: dict[int, Deque[Point]] = defaultdict(lambda: deque(maxlen=args.trail_length))
    was_inside_roi: dict[int, bool] = {}
    counted_ids: set[int] = set()
    minute_counts: dict[int, int] = defaultdict(int)
    events: list[dict[str, object]] = []

    processed = 0
    frame_index = 0
    while frame_index < frame_limit:
        ok = capture.grab()
        if not ok:
            break
        if frame_index % stride != 0:
            frame_index += 1
            continue
        ok, frame = capture.retrieve()
        if not ok:
            break

        elapsed_sec = frame_index / fps
        minute_index = int(elapsed_sec // 60)
        results = model.track(
            frame,
            persist=True,
            classes=[0],
            conf=args.conf,
            iou=args.iou,
            tracker=args.tracker,
            device=args.device,
            verbose=False,
        )
        boxes = results[0].boxes if results else None
        if boxes is not None and boxes.id is not None:
            xyxy = boxes.xyxy.cpu().numpy()
            track_ids = boxes.id.int().cpu().tolist()
            for box, track_id in zip(xyxy, track_ids):
                x1, y1, x2, y2 = box
                foot = Point((float(x1) + float(x2)) / 2, float(y2))
                history = histories[track_id]
                inside_roi = roi.contains(foot)
                if (
                    inside_roi
                    and not was_inside_roi.get(track_id, False)
                    and track_id not in counted_ids
                    and moved_up(history, foot, min_up_pixels)
                ):
                    counted_ids.add(track_id)
                    minute_counts[minute_index] += 1
                    events.append(
                        {
                            "track_id": track_id,
                            "frame_index": frame_index,
                            "time_sec": round(elapsed_sec, 3),
                            "minute_index": minute_index,
                            "absolute_time": fmt(start_time + timedelta(seconds=elapsed_sec)) if start_time else "",
                            "foot_x": round(foot.x, 1),
                            "foot_y": round(foot.y, 1),
                        }
                    )
                was_inside_roi[track_id] = inside_roi
                history.append(foot)

                if writer is not None and elapsed_sec <= args.annotate_seconds:
                    color = (0, 255, 0) if track_id in counted_ids else (255, 255, 0)
                    cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                    cv2.putText(frame, str(track_id), (int(x1), max(20, int(y1) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

        if writer is not None and elapsed_sec <= args.annotate_seconds:
            cv2.rectangle(frame, (int(roi.x1), int(roi.y1)), (int(roi.x2), int(roi.y2)), (255, 128, 0), 3)
            cv2.putText(frame, f"t={elapsed_sec:.1f}s minute={minute_index} count={minute_counts.get(minute_index, 0)}", (30, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
            writer.write(frame)

        processed += 1
        frame_index += 1
        if processed % 500 == 0:
            print(f"processed {processed} samples / {elapsed_sec:.0f}s of {target_seconds:.0f}s", flush=True)

    capture.release()
    if writer is not None:
        writer.release()

    actual_seconds = frame_index / fps
    with output_counts.open("w", newline="", encoding="utf-8-sig") as file:
        writer_csv = csv.DictWriter(file, fieldnames=["minute_index", "absolute_start", "absolute_end", "relative_start_sec", "relative_end_sec", "entry_count"])
        writer_csv.writeheader()
        minute_total = max(1, int((actual_seconds + 59.999) // 60))
        for minute in range(minute_total):
            rel_start = minute * 60
            rel_end = min((minute + 1) * 60, actual_seconds)
            writer_csv.writerow(
                {
                    "minute_index": minute,
                    "absolute_start": fmt(start_time + timedelta(seconds=rel_start)) if start_time else "",
                    "absolute_end": fmt(start_time + timedelta(seconds=rel_end)) if start_time else "",
                    "relative_start_sec": rel_start,
                    "relative_end_sec": round(rel_end, 3),
                    "entry_count": minute_counts.get(minute, 0),
                }
            )

    with output_events.open("w", newline="", encoding="utf-8-sig") as file:
        fieldnames = ["track_id", "frame_index", "time_sec", "minute_index", "absolute_time", "foot_x", "foot_y"]
        writer_csv = csv.DictWriter(file, fieldnames=fieldnames)
        writer_csv.writeheader()
        writer_csv.writerows(events)

    output_meta.write_text(
        json.dumps(
            {
                "video": str(video_path),
                "model": str(args.model),
                "method": "roi-entry (first entry into ROI while moving upward, once per track)",
                "fps": fps,
                "sample_fps": args.sample_fps,
                "stride": stride,
                "width": width,
                "height": height,
                "processed_seconds": actual_seconds,
                "roi_1920x1080": [base_roi.x1, base_roi.y1, base_roi.x2, base_roi.y2],
                "min_up_pixels_1920x1080": args.min_up_pixels,
                "conf": args.conf,
                "iou": args.iou,
                "tracker": args.tracker,
                "device": args.device,
                "recording_start": fmt(start_time),
                "timezone": "+08:00",
                "total_entries": sum(minute_counts.values()),
                "outputs": {"counts_csv": str(output_counts), "events_csv": str(output_events)},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"每分钟计数: {output_counts}")
    print(f"进入事件: {output_events} ({len(events)} events)")
    print(f"运行参数: {output_meta}")
    if args.annotate_seconds > 0:
        print(f"QA 标注片段: {output_clip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
