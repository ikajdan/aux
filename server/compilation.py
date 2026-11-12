# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import os
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path, PurePosixPath

from .process_limits import limits
from .validation import build_id, safe_path


class BuildCanceled(Exception):
    pass


def check_canceled(job):
    if job is not None and job["event"].is_set():
        raise BuildCanceled()


class CompilationService:
    def __init__(self, config, artifact_store):
        self.config = config
        self.artifact_store = artifact_store
        self.slots = threading.BoundedSemaphore(config["maxConcurrentBuilds"])
        self.cancel_lock = threading.Lock()
        self.builds = {}
        self.build_ttl = 120
        self.max_build_ids = 1024

    def compile(self, data):
        job = None
        if isinstance(data, dict) and "buildId" in data:
            key = build_id(data)
            with self.cancel_lock:
                self.prune_builds()
                if key in self.builds:
                    check_canceled(self.builds[key])
                    return 409, {"error": "buildId already used"}
                if len(self.builds) >= self.max_build_ids:
                    return 503, {"error": "Build registry full. Retry shortly"}
                job = {"event": threading.Event(), "active": True, "expires": 0}
                self.builds[key] = job
        acquired = False
        try:
            check_canceled(job)
            acquired = self.slots.acquire(blocking=False)
            if not acquired:
                return 429, {"error": "Compiler busy. Retry shortly"}
            status, result = self.compile_document(data, job)
            with self.cancel_lock:
                check_canceled(job)
                if job is not None:
                    self.finish_build(job)
            return status, result
        finally:
            if acquired:
                self.slots.release()
            if job is not None:
                with self.cancel_lock:
                    self.finish_build(job)

    def cancel(self, data):
        key = build_id(data)
        with self.cancel_lock:
            self.prune_builds()
            job = self.builds.get(key)
            if job is None:
                if len(self.builds) >= self.max_build_ids:
                    return 503, {"error": "Build registry full. Retry shortly"}
                event = threading.Event()
                event.set()
                self.builds[key] = {
                    "event": event,
                    "active": False,
                    "expires": time.monotonic() + self.build_ttl,
                }
            elif job["active"]:
                job["event"].set()
        return 200, {"status": "cancel_requested"}

    def prune_builds(self):
        # Caller holds cancel_lock; never evict running builds or live tombstones.
        now = time.monotonic()
        for key, job in list(self.builds.items()):
            if not job["active"] and job["expires"] <= now:
                del self.builds[key]

    def finish_build(self, job):
        if job["active"]:
            job["active"] = False
            job["expires"] = time.monotonic() + self.build_ttl

    def compile_document(self, data, job=None):
        if not isinstance(data, dict):
            raise ValueError("Invalid compilation request: expected an object")
        check_canceled(job)
        main = self.config["mainDocument"]
        if "main" in data and data["main"] != main:
            raise ValueError(
                f"Unsupported main file: the configured main document is {main}"
            )
        if data.get("engine", "xelatex") != "xelatex":
            raise ValueError("Unsupported engine: only XeLaTeX is supported")
        files = data["files"]
        if (
            not isinstance(files, list)
            or len(files) > self.config["limits"]["snapshotFiles"]
        ):
            raise ValueError("Too many files")
        workspace = tempfile.TemporaryDirectory(prefix="aux-")
        retained = False
        try:
            directory = workspace.name
            root = Path(directory)
            total = 0
            seen = set()
            for item in files:
                check_canceled(job)
                if not isinstance(item, dict):
                    raise ValueError("Invalid file: expected an object")
                if not isinstance(item.get("content"), str):
                    raise ValueError("Invalid file content: expected a base64 string")
                relative = str(safe_path(item["path"]))
                if PurePosixPath(relative).parts[0] == "aux-output":
                    raise ValueError("aux-output is reserved for generated build files")
                if relative in seen:
                    raise ValueError("Duplicate file")
                seen.add(relative)
                content = base64.b64decode(item["content"], validate=True)
                total += len(content)
                if total > self.config["limits"]["snapshotBytes"]:
                    raise ValueError(
                        f"Project exceeds {self.config['limits']['snapshotBytes']} decoded bytes"
                    )
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                check_canceled(job)
                path.write_bytes(content)
            check_canceled(job)
            if main not in seen:
                raise ValueError(f"Missing configured main document: {main}")
            output_dir = root / "aux-output"
            output_dir.mkdir()
            # TeX creates include auxiliary files but cannot create their parent directories.
            for relative in seen:
                check_canceled(job)
                (output_dir / PurePosixPath(relative).parent).mkdir(
                    parents=True, exist_ok=True
                )
            # -norc ignores project latexmkrc files (which otherwise execute arbitrary Perl).
            command = [
                "latexmk",
                "-norc",
                "-xelatex",
                "-no-shell-escape",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "-synctex=1",
                "-outdir=aux-output",
                "./" + main,
            ]
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": directory,
                "LANG": "C.UTF-8",
                "openin_any": "p",
                "openout_any": "p",
                "TEXMFOUTPUT": directory,
                "TEXMFVAR": directory + "/texmf-var",
                "TEXMFCONFIG": directory + "/texmf-config",
            }
            log_path = root / "aux-compile.log"
            with log_path.open("wb") as log:
                check_canceled(job)
                process = subprocess.Popen(
                    command,
                    cwd=root,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    preexec_fn=limits,
                )
                deadline = time.monotonic() + 110
                try:
                    while True:
                        check_canceled(job)
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise subprocess.TimeoutExpired(command, 110)
                        try:
                            code = process.wait(timeout=min(0.25, remaining))
                            break
                        except subprocess.TimeoutExpired:
                            continue
                except (BuildCanceled, subprocess.TimeoutExpired) as error:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # The process group may have exited just before cancellation.
                    finally:
                        process.wait()
                    if isinstance(error, BuildCanceled):
                        raise
                    check_canceled(job)
                    return 422, {
                        "error": "Compilation timed out (110 seconds)",
                        "log": log_path.read_text(errors="replace")[-100000:],
                    }
            check_canceled(job)
            output = root / "aux-output" / (Path(main).stem + ".pdf")
            text = log_path.read_text(errors="replace")[-100000:]
            if code or not output.exists():
                return 422, {"error": "LaTeX compilation failed", "log": text}
            result = {
                "pdf": base64.b64encode(output.read_bytes()).decode(),
                "log": text,
            }
            mapping = output.with_suffix(".synctex.gz")
            # Commit success atomically with cancellation so a canceled build retains nothing.
            with self.cancel_lock:
                check_canceled(job)
                if mapping.is_file():
                    build = self.artifact_store.retain(
                        workspace, seen, output.relative_to(root).as_posix()
                    )
                    if build is not None:
                        retained = True
                        result["synctex"] = build
                if job is not None:
                    self.finish_build(job)
            return 200, result
        finally:
            if not retained:
                workspace.cleanup()
