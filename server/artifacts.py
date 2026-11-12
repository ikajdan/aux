# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import math
import os
import secrets
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .process_limits import limits
from .validation import safe_path


class ArtifactStore:
    def __init__(self):
        self.lock = threading.Lock()
        self.artifacts = {}
        self.ttl = 30 * 60
        self.max_bytes = 200 * 1024 * 1024

    def prune(self):
        now = time.monotonic()
        for key, artifact in list(self.artifacts.items()):
            if now - artifact["created"] >= self.ttl:
                self.artifacts.pop(key)["workspace"].cleanup()

    def retain(self, workspace, paths, output):
        root = Path(workspace.name)
        size = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
        if size > self.max_bytes:
            return None
        with self.lock:
            self.prune()
            while self.artifacts and (
                len(self.artifacts) >= 10
                or sum(item["size"] for item in self.artifacts.values()) + size
                > self.max_bytes
            ):
                self.artifacts.pop(next(iter(self.artifacts)))["workspace"].cleanup()
            key = secrets.token_urlsafe(32)
            self.artifacts[key] = {
                "workspace": workspace,
                "paths": paths,
                "output": output,
                "size": size,
                "created": time.monotonic(),
            }
            return key

    def janitor(self):
        while True:
            time.sleep(60)
            with self.lock:
                self.prune()

    def synctex_query(self, data):
        if not isinstance(data, dict):
            raise ValueError("Invalid navigation request")
        key = data.get("build")
        if not isinstance(key, str):
            raise ValueError("Missing build reference")
        with self.lock:
            self.prune()
            artifact = self.artifacts.get(key)
            if artifact is None:
                return 410, {
                    "error": "Navigation data has expired. Rebuild the document to restore source and PDF navigation."
                }
            root = Path(artifact["workspace"].name)
            output = root / artifact["output"]
            direction = data.get("direction")
            if direction == "forward":
                path = str(safe_path(data["path"]))
                if path not in artifact["paths"] or any(c in path for c in ":\r\n"):
                    raise ValueError("Source is not part of this build")
                line, column = data["line"], data.get("column", 0)
                if (
                    type(line) is not int
                    or not 1 <= line <= 10000000
                    or type(column) is not int
                    or not 0 <= column <= 10000000
                ):
                    raise ValueError("Invalid source position")
                args = [
                    "view",
                    "-i",
                    f"{line}:{column}:{root / path}",
                    "-o",
                    str(output),
                ]
            elif direction == "backward":
                page, x, y = data["page"], data["x"], data["y"]
                if (
                    type(page) is not int
                    or not 1 <= page <= 1000000
                    or any(
                        type(v) not in (int, float)
                        or not math.isfinite(v)
                        or not 0 <= v <= 1000000
                        for v in (x, y)
                    )
                ):
                    raise ValueError("Invalid PDF position")
                args = ["edit", "-o", f"{page}:{x}:{y}:{output}"]
            else:
                raise ValueError("Invalid navigation direction")
            with tempfile.TemporaryFile() as log:
                process = subprocess.Popen(
                    ["synctex", *args],
                    cwd=root,
                    env={
                        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                        "HOME": str(root),
                        "LANG": "C.UTF-8",
                    },
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    preexec_fn=limits,
                )
                try:
                    code = process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # The process group may have exited just before the timeout.
                    finally:
                        process.wait()
                    return 504, {"error": "Navigation timed out"}
                log.seek(0)
                text = log.read(1024 * 1024).decode("utf-8", errors="replace")
            if code:
                return 422, {
                    "error": "Could not find a matching source or PDF position."
                }
            results = []
            record = {}
            for row in text.splitlines():
                if row.startswith("Output:") and record:
                    results.append(record)
                    record = {}
                name, separator, value = row.partition(":")
                if separator:
                    record[name] = value
            if record:
                results.append(record)
            for record in results:
                try:
                    if direction == "forward":
                        position = {
                            name: float(record[field])
                            for name, field in (
                                ("x", "h"),
                                ("y", "v"),
                                ("width", "W"),
                                ("height", "H"),
                            )
                        }
                        page = int(record["Page"])
                        if page < 1 or not all(
                            math.isfinite(v) for v in position.values()
                        ):
                            continue
                        return 200, {"page": page, **position}
                    source = Path(record["Input"])
                    source = Path(os.path.abspath(root / source))
                    path = source.relative_to(root).as_posix()
                    line = int(record["Line"])
                    if path in artifact["paths"] and line > 0:
                        return 200, {
                            "path": path,
                            "line": line,
                            "column": max(0, int(record.get("Column", "0"))),
                        }
                except (ValueError, KeyError):
                    continue
            return 404, {"error": "No source mapping at this position"}
