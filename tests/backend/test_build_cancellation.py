# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import subprocess
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, call, patch

from backend_support import compilation, server


class BuildCancellationTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.key = str(uuid.uuid4())
        self.payload = {
            "buildId": self.key,
            "files": [{"path": "main.tex", "content": ""}],
        }
        self.registry = patch.object(server.compiler, "builds", {})
        self.registry.start()
        self.addCleanup(self.registry.stop)

    def assert_canceled(self, response):
        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.get_json(), {"error": "Build canceled", "canceled": True}
        )

    def test_compilation_service_instances_have_independent_build_state(self):
        first = compilation.CompilationService(server.CONFIG, Mock())
        second = compilation.CompilationService(server.CONFIG, Mock())
        self.assertIs(first.config, server.CONFIG)
        self.assertIs(second.config, server.CONFIG)
        self.assertIsNot(first.slots, second.slots)
        self.assertIsNot(first.cancel_lock, second.cancel_lock)
        self.assertIsNot(first.builds, second.builds)
        self.assertEqual(
            first.cancel(self.payload), (200, {"status": "cancel_requested"})
        )
        self.assertNotIn(self.key, second.builds)
        self.assertNotIn(self.key, server.compiler.builds)

        with (
            patch.object(first, "compile_document") as first_compile,
            patch.object(
                second, "compile_document", return_value=(200, {})
            ) as second_compile,
        ):
            with self.assertRaises(compilation.BuildCanceled):
                first.compile(self.payload)
            first_compile.assert_not_called()
            self.assertEqual(second.compile(self.payload), (200, {}))
            second_compile.assert_called_once_with(
                self.payload, second.builds[self.key]
            )
            self.assertIs(second_compile.call_args.args[1], second.builds[self.key])
        self.assertTrue(first.builds[self.key]["event"].is_set())
        self.assertFalse(second.builds[self.key]["event"].is_set())
        self.assertFalse(second.builds[self.key]["active"])

    def test_invalid_ids_and_cross_origin_cancel_never_signal_processes(self):
        with patch.object(compilation.os, "killpg") as killpg:
            for payload in (None, [], {}, {"buildId": 123}, {"buildId": "bad"}):
                self.assertEqual(
                    self.client.post("/compile/cancel", json=payload).status_code, 400
                )
            for value in (None, 123, "bad"):
                self.assertEqual(
                    self.client.post(
                        "/compile", json={**self.payload, "buildId": value}
                    ).status_code,
                    400,
                )
            for headers in (
                {"Origin": "https://example.com"},
                {"Sec-Fetch-Site": "cross-site"},
            ):
                self.assertEqual(
                    self.client.post(
                        "/compile/cancel", json={"buildId": self.key}, headers=headers
                    ).status_code,
                    403,
                )
            killpg.assert_not_called()
        self.assertFalse(server.compiler.builds)

    def test_cancel_before_registration_prevents_spawn_and_is_idempotent(self):
        with patch.object(compilation.subprocess, "Popen") as popen:
            for _ in range(2):
                response = self.client.post(
                    "/compile/cancel", json={"buildId": self.key.upper()}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json(), {"status": "cancel_requested"})
            self.assert_canceled(self.client.post("/compile", json=self.payload))
            popen.assert_not_called()
        self.assertEqual(len(server.compiler.builds), 1)

    def test_cancel_during_snapshot_cleans_workspace_and_does_not_spawn(self):
        write = Path.write_bytes
        roots = []

        def cancel_after_write(path, content):
            result = write(path, content)
            roots.append(path.parent)
            with server.app.test_client() as client:
                self.assertEqual(
                    client.post(
                        "/compile/cancel", json={"buildId": self.key}
                    ).status_code,
                    200,
                )
            return result

        with (
            patch.object(Path, "write_bytes", cancel_after_write),
            patch.object(compilation.subprocess, "Popen") as popen,
        ):
            self.assert_canceled(self.client.post("/compile", json=self.payload))
            popen.assert_not_called()
        self.assertFalse(roots[0].exists())
        self.assertFalse(server.compiler.builds[self.key]["active"])

    def test_cancel_immediately_before_spawn(self):
        original = Path.open

        def open_log(path, *args, **kwargs):
            if path.name == "aux-compile.log":
                self.client.post("/compile/cancel", json={"buildId": self.key})
            return original(path, *args, **kwargs)

        with (
            patch.object(Path, "open", open_log),
            patch.object(compilation.subprocess, "Popen") as popen,
        ):
            self.assert_canceled(self.client.post("/compile", json=self.payload))
            popen.assert_not_called()

    def test_threaded_cancel_kills_owned_group_reaps_and_releases_slot(self):
        started = threading.Event()
        canceled = threading.Event()
        process = Mock(pid=12345)
        lock = threading.BoundedSemaphore(1)
        responses = []

        def wait(timeout=None):
            if timeout is None:
                return 0
            started.set()
            self.assertTrue(canceled.wait(3))
            raise subprocess.TimeoutExpired("latexmk", timeout)

        process.wait.side_effect = wait

        def compile_request():
            with server.app.test_client() as client:
                responses.append(client.post("/compile", json=self.payload))

        with (
            patch.object(server.compiler, "slots", lock),
            patch.object(
                compilation.subprocess, "Popen", return_value=process
            ) as popen,
            patch.object(compilation.os, "killpg") as killpg,
            patch.object(server.artifact_store, "retain") as retain,
        ):
            worker = threading.Thread(target=compile_request)
            worker.start()
            try:
                self.assertTrue(started.wait(3))
                duplicate = self.client.post("/compile", json=self.payload)
                self.assertEqual(duplicate.status_code, 409)
                # A different capability cannot cancel this compiler.
                self.client.post("/compile/cancel", json={"buildId": str(uuid.uuid4())})
                self.assertFalse(server.compiler.builds[self.key]["event"].is_set())
                response = self.client.post(
                    "/compile/cancel", json={"buildId": self.key}
                )
                self.assertEqual(response.status_code, 200)
            finally:
                canceled.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assert_canceled(responses[0])
            killpg.assert_called_once_with(process.pid, compilation.signal.SIGKILL)
            self.assertEqual(process.wait.call_args_list, [call(timeout=0.25), call()])
            retain.assert_not_called()
            self.assertFalse(popen.call_args.kwargs["cwd"].exists())
            self.assertTrue(lock.acquire(blocking=False))
            lock.release()

    def test_cancel_when_process_finishes_does_not_retain_artifact(self):
        process = Mock(pid=12345)

        def spawn(*args, **kwargs):
            output = kwargs["cwd"] / "aux-output"
            (output / "main.pdf").write_bytes(b"pdf")
            (output / "main.synctex.gz").write_bytes(b"mapping")
            return process

        def wait(timeout=None):
            self.client.post("/compile/cancel", json={"buildId": self.key})
            return 0

        process.wait.side_effect = wait
        with (
            patch.object(compilation.subprocess, "Popen", side_effect=spawn) as popen,
            patch.object(server.artifact_store, "retain") as retain,
        ):
            self.assert_canceled(self.client.post("/compile", json=self.payload))
            retain.assert_not_called()
            self.assertFalse(popen.call_args.kwargs["cwd"].exists())

    def test_cancel_during_spawn_reaps_even_if_group_already_exited(self):
        process = Mock(pid=12345)

        def spawn(*args, **kwargs):
            self.client.post("/compile/cancel", json={"buildId": self.key})
            return process

        with (
            patch.object(compilation.subprocess, "Popen", side_effect=spawn) as popen,
            patch.object(
                compilation.os, "killpg", side_effect=ProcessLookupError
            ) as killpg,
        ):
            self.assert_canceled(self.client.post("/compile", json=self.payload))
            killpg.assert_called_once_with(process.pid, compilation.signal.SIGKILL)
            process.wait.assert_called_once_with()
            self.assertFalse(popen.call_args.kwargs["cwd"].exists())

    def test_busy_compiler_finishes_registration_without_leaking_slot(self):
        lock = threading.BoundedSemaphore(1)
        lock.acquire()
        with patch.object(server.compiler, "slots", lock):
            self.assertEqual(
                self.client.post("/compile", json=self.payload).status_code, 429
            )
            self.assertFalse(server.compiler.builds[self.key]["active"])
            self.assertFalse(lock.acquire(blocking=False))
        lock.release()

    def test_completed_ids_are_not_reused_and_late_cancel_never_signals(self):
        with (
            patch.object(
                server.compiler, "compile_document", return_value=(200, {})
            ) as compile,
            patch.object(compilation.os, "killpg") as killpg,
        ):
            self.assertEqual(
                self.client.post("/compile", json=self.payload).status_code, 200
            )
            self.assertEqual(
                self.client.post(
                    "/compile/cancel", json={"buildId": self.key}
                ).status_code,
                200,
            )
            self.assertEqual(
                self.client.post("/compile", json=self.payload).status_code, 409
            )
            compile.assert_called_once_with(
                self.payload, server.compiler.builds[self.key]
            )
            self.assertIs(compile.call_args.args[1], server.compiler.builds[self.key])
            killpg.assert_not_called()

    def test_registry_is_bounded_and_tombstones_expire(self):
        with (
            patch.object(server.compiler, "max_build_ids", 1),
            patch.object(compilation.time, "monotonic", return_value=0) as clock,
        ):
            self.assertEqual(
                self.client.post(
                    "/compile/cancel", json={"buildId": self.key}
                ).status_code,
                200,
            )
            other = str(uuid.uuid4())
            self.assertEqual(
                self.client.post(
                    "/compile/cancel", json={"buildId": other}
                ).status_code,
                503,
            )
            self.assertEqual(
                self.client.post(
                    "/compile", json={**self.payload, "buildId": other}
                ).status_code,
                503,
            )
            clock.return_value = server.compiler.build_ttl - 1
            self.client.post("/compile/cancel", json={"buildId": self.key})
            self.assertEqual(
                server.compiler.builds[self.key]["expires"], server.compiler.build_ttl
            )
            clock.return_value = server.compiler.build_ttl
            self.assertEqual(
                self.client.post(
                    "/compile/cancel", json={"buildId": other}
                ).status_code,
                200,
            )
            self.assertNotIn(self.key, server.compiler.builds)
            self.assertEqual(len(server.compiler.builds), 1)

    def test_active_jobs_are_not_pruned_and_failures_finish_registration(self):
        def fail(data, job):
            self.assertEqual(data, self.payload)
            self.assertIs(job, server.compiler.builds[self.key])
            with server.compiler.cancel_lock:
                server.compiler.prune_builds()
            self.assertIn(self.key, server.compiler.builds)
            raise ValueError("invalid snapshot")

        with patch.object(server.compiler, "compile_document", side_effect=fail):
            self.assertEqual(
                self.client.post("/compile", json=self.payload).status_code, 400
            )
        self.assertFalse(server.compiler.builds[self.key]["active"])
