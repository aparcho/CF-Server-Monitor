#!/usr/bin/env python3
"""Run serial iperf3 probes on deb and report summaries to CFSM."""
import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request
import urllib.error
import uuid


def probe(server, family, address, direction, duration, port, run_id, output):
    cmd = ["iperf3", "-J", "-i", "1", "--get-server-output", "-c", address, "-p", str(port), "-t", str(duration),
           "-4" if family == "ipv4" else "-6"]
    if direction == "download":
        cmd.append("-R")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=duration + 20)
    name = f"{server['id']}-{family}-{direction}"
    (output / f"{name}.json").write_text(result.stdout, encoding="utf-8")
    (output / f"{name}.stderr").write_text(result.stderr, encoding="utf-8")
    row = dict(run_id=run_id, server_id=server["id"], source="deb", family=family,
               direction=direction, tested_at=int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
               duration_seconds=duration, port=port, status="failed", mbps=None,
               retransmits=None, error=None)
    try:
        data = json.loads(result.stdout)
        if result.returncode or data.get("error"):
            raise ValueError(data.get("error") or result.stderr.strip() or "iperf3 failed")
        end = data["end"]
        speed = end["sum_received" if direction == "download" else "sum_sent"]["bits_per_second"]
        sender = end.get("sum_sent", {})
        if direction == "download":
            sender = data.get("server_output_json", {}).get("end", {}).get("sum_sent", sender)
        retransmits = sender.get("retransmits")
        if retransmits is None:
            raise ValueError("missing TCP retransmits in iperf3 JSON")
        row.update(status="ok", mbps=round(speed / 1_000_000, 2), retransmits=int(retransmits))
    except (ValueError, KeyError, TypeError) as exc:
        row["error"] = str(exc)[:200]
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config", help="JSON with worker_url and targets [{id, ipv4, ipv6, port}]")
    parser.add_argument("--output", default="iperf-results")
    parser.add_argument("--duration", type=int, default=30)
    parser.add_argument("--no-upload", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.duration <= 120:
        parser.error("duration must be 1..120 seconds")
    token = os.environ.get("IPERF_REPORT_TOKEN")
    if not token and not args.no_upload:
        parser.error("IPERF_REPORT_TOKEN is required")
    config = json.loads(pathlib.Path(args.config).read_text(encoding="utf-8"))
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    output = pathlib.Path(args.output) / run_id
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for server in config["targets"]:
        for family in ("ipv4", "ipv6"):
            address = server.get(family)
            if not address:
                continue
            for direction in ("download", "upload"):
                if rows:
                    time.sleep(2)
                try:
                    row = probe(server, family, address, direction, args.duration,
                                int(server.get("port", 5202)), run_id, output)
                except subprocess.TimeoutExpired as exc:
                    name = f"{server['id']}-{family}-{direction}"
                    stdout = exc.stdout or b""
                    stderr = exc.stderr or b""
                    (output / f"{name}.json").write_bytes(stdout if isinstance(stdout, bytes) else stdout.encode())
                    (output / f"{name}.stderr").write_bytes(stderr if isinstance(stderr, bytes) else stderr.encode())
                    row = dict(run_id=run_id, server_id=server["id"], source="deb", family=family,
                               direction=direction, tested_at=int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
                               duration_seconds=args.duration, port=int(server.get("port", 5202)),
                               status="no_response", mbps=None, retransmits=None, error="timeout")
                rows.append(row)
                print(f"{server['id']} {family} {direction}: {row['status']} {row['mbps']} Mbps", flush=True)
    (output / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.no_upload:
        return
    for start in range(0, len(rows), 8):
        req = urllib.request.Request(config["worker_url"].rstrip("/") + "/api/iperf/report",
            data=json.dumps({"results": rows[start:start + 8]}).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-Iperf-Token": token,
                     "User-Agent": "CFSM-Iperf/1.0"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as response:
                    print(response.read().decode(), flush=True)
                break
            except urllib.error.HTTPError as exc:
                if exc.code < 500 or attempt == 2:
                    raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise
            time.sleep(2 * (attempt + 1))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
