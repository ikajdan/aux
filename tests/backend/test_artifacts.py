# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

from backend_support import artifacts, process_limits


class ArtifactStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = artifacts.ArtifactStore()

    def workspace(self, size=1):
        workspace = tempfile.TemporaryDirectory(prefix="aux-artifact-test-")
        self.addCleanup(workspace.cleanup)
        root = Path(workspace.name)
        (root / "nested").mkdir()
        (root / "nested" / "main.tex").write_bytes(b"x" * size)
        return workspace

    def retain(self, size=1):
        workspace = self.workspace(size)
        key = self.store.retain(workspace, {"nested/main.tex"}, "aux-output/main.pdf")
        return key, workspace

    def test_defaults_and_instances_are_independent(self):
        other = artifacts.ArtifactStore()
        self.assertEqual(self.store.ttl, 30 * 60)
        self.assertEqual(self.store.max_bytes, 200 * 1024 * 1024)
        self.assertIsNot(self.store.lock, other.lock)
        key, workspace = self.retain()
        self.assertEqual(other.artifacts, {})
        self.assertIs(self.store.artifacts[key]["workspace"], workspace)
        self.assertTrue(self.store.lock.acquire(blocking=False))
        self.store.lock.release()

    def test_retain_counts_all_files_and_preserves_metadata(self):
        workspace = self.workspace(3)
        root = Path(workspace.name)
        (root / "main.pdf").write_bytes(b"12345")
        paths = {"nested/main.tex"}
        with (
            patch.object(artifacts.time, "monotonic", return_value=100),
            patch.object(
                artifacts.secrets, "token_urlsafe", return_value="build"
            ) as token,
        ):
            key = self.store.retain(workspace, paths, "main.pdf")
        token.assert_called_once_with(32)
        self.assertEqual(key, "build")
        self.assertEqual(
            self.store.artifacts[key],
            {
                "workspace": workspace,
                "paths": paths,
                "output": "main.pdf",
                "size": 8,
                "created": 100,
            },
        )

    def test_prune_expires_at_ttl_and_cleans_workspace(self):
        self.store.ttl = 10
        with patch.object(artifacts.time, "monotonic", return_value=100):
            expired_key, expired = self.retain()
        with patch.object(artifacts.time, "monotonic", return_value=101):
            live_key, live = self.retain()
        with patch.object(artifacts.time, "monotonic", return_value=110):
            with self.store.lock:
                self.store.prune()
        self.assertNotIn(expired_key, self.store.artifacts)
        self.assertFalse(Path(expired.name).exists())
        self.assertIn(live_key, self.store.artifacts)
        self.assertTrue(Path(live.name).exists())

    def test_retain_prunes_expired_entries(self):
        with patch.object(artifacts.time, "monotonic", return_value=0):
            old_key, old = self.retain()
        with patch.object(artifacts.time, "monotonic", return_value=self.store.ttl):
            new_key, _ = self.retain()
        self.assertEqual(list(self.store.artifacts), [new_key])
        self.assertNotIn(old_key, self.store.artifacts)
        self.assertFalse(Path(old.name).exists())

    def test_count_limit_evicts_oldest_and_cleans_workspace(self):
        entries = [self.retain() for _ in range(11)]
        self.assertEqual(list(self.store.artifacts), [key for key, _ in entries[1:]])
        self.assertFalse(Path(entries[0][1].name).exists())
        self.assertTrue(Path(entries[1][1].name).exists())

    def test_byte_limit_evicts_until_new_workspace_fits(self):
        self.store.max_bytes = 6
        first, first_workspace = self.retain(2)
        second, second_workspace = self.retain(2)
        third, third_workspace = self.retain(2)
        latest, _ = self.retain(5)
        self.assertEqual(list(self.store.artifacts), [latest])
        for key, workspace in (
            (first, first_workspace),
            (second, second_workspace),
            (third, third_workspace),
        ):
            self.assertNotIn(key, self.store.artifacts)
            self.assertFalse(Path(workspace.name).exists())

    def test_exact_byte_limit_is_retained(self):
        self.store.max_bytes = 3
        key, workspace = self.retain(3)
        self.assertIn(key, self.store.artifacts)
        self.assertTrue(Path(workspace.name).exists())

    def test_oversized_workspace_is_not_cleaned_and_does_not_prune(self):
        self.store.max_bytes = 3
        with patch.object(artifacts.time, "monotonic", return_value=0):
            old_key, old = self.retain()
        oversized = self.workspace(4)
        with patch.object(artifacts.time, "monotonic", return_value=self.store.ttl):
            self.assertIsNone(self.store.retain(oversized, set(), "main.pdf"))
        self.assertIn(old_key, self.store.artifacts)
        self.assertTrue(Path(old.name).exists())
        self.assertTrue(Path(oversized.name).exists())

    def test_janitor_sleeps_before_pruning_under_lock(self):
        def prune():
            self.assertTrue(self.store.lock.locked())

        with (
            patch.object(
                artifacts.time, "sleep", side_effect=[None, InterruptedError]
            ) as sleep,
            patch.object(self.store, "prune", side_effect=prune) as cleanup,
        ):
            with self.assertRaises(InterruptedError):
                self.store.janitor()
        self.assertEqual(sleep.call_args_list, [call(60), call(60)])
        cleanup.assert_called_once_with()
        self.assertFalse(self.store.lock.locked())

    def test_expired_query_prunes_before_returning_gone(self):
        with patch.object(artifacts.time, "monotonic", return_value=0):
            key, workspace = self.retain()
        with (
            patch.object(artifacts.time, "monotonic", return_value=self.store.ttl),
            patch.object(artifacts.subprocess, "Popen") as popen,
        ):
            status, result = self.store.synctex_query({"build": key})
        self.assertEqual(status, 410)
        self.assertIn("expired", result["error"])
        popen.assert_not_called()
        self.assertFalse(Path(workspace.name).exists())

    def test_query_validation_does_not_start_process(self):
        key, _ = self.retain()
        invalid = [
            ([], "Invalid navigation request"),
            ({}, "Missing build reference"),
            ({"build": key}, "Invalid navigation direction"),
            (
                {"build": key, "direction": "forward", "path": "other.tex", "line": 1},
                "Source is not part",
            ),
            (
                {
                    "build": key,
                    "direction": "forward",
                    "path": "nested/main.tex",
                    "line": True,
                },
                "Invalid source position",
            ),
            (
                {
                    "build": key,
                    "direction": "backward",
                    "page": 1,
                    "x": float("nan"),
                    "y": 0,
                },
                "Invalid PDF position",
            ),
        ]
        with patch.object(artifacts.subprocess, "Popen") as popen:
            for request, message in invalid:
                with self.subTest(request=request):
                    with self.assertRaisesRegex(ValueError, message):
                        self.store.synctex_query(request)
            popen.assert_not_called()
        self.assertFalse(self.store.lock.locked())

    def query(self, key):
        return self.store.synctex_query(
            {"build": key, "direction": "forward", "path": "nested/main.tex", "line": 1}
        )

    def test_timeout_kills_and_reaps_process_without_removing_artifact(self):
        key, workspace = self.retain()
        for kill_error in (None, ProcessLookupError()):
            with self.subTest(group_already_exited=kill_error is not None):
                process = Mock(pid=12345)
                process.wait.side_effect = [
                    artifacts.subprocess.TimeoutExpired("synctex", 5),
                    0,
                ]
                with (
                    patch.object(
                        artifacts.subprocess, "Popen", return_value=process
                    ) as popen,
                    patch.object(
                        artifacts.os, "killpg", side_effect=kill_error
                    ) as killpg,
                ):
                    status, result = self.query(key)
                self.assertEqual(
                    (status, result), (504, {"error": "Navigation timed out"})
                )
                killpg.assert_called_once_with(process.pid, artifacts.signal.SIGKILL)
                self.assertEqual(process.wait.call_args_list, [call(timeout=5), call()])
                self.assertIs(
                    popen.call_args.kwargs["preexec_fn"], process_limits.limits
                )
                self.assertTrue(popen.call_args.kwargs["stdout"].closed)
                self.assertIn(key, self.store.artifacts)
                self.assertTrue(Path(workspace.name).exists())
                self.assertFalse(self.store.lock.locked())

    def test_query_holds_lock_while_running_and_parsing(self):
        key, _ = self.retain()

        def start(command, **options):
            self.assertTrue(self.store.lock.locked())
            options["stdout"].write(b"Page:1\nh:10\nv:20\nW:30\nH:40\n")
            return Mock(wait=Mock(return_value=0))

        with patch.object(artifacts.subprocess, "Popen", side_effect=start):
            self.assertEqual(
                self.query(key),
                (200, {"page": 1, "x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0}),
            )
        self.assertFalse(self.store.lock.locked())

    def test_process_failure_and_missing_mapping_statuses(self):
        key, _ = self.retain()
        for code, status, message in (
            (1, 422, "Could not find a matching source or PDF position."),
            (0, 404, "No source mapping at this position"),
        ):
            with self.subTest(code=code):
                with patch.object(
                    artifacts.subprocess,
                    "Popen",
                    return_value=Mock(wait=Mock(return_value=code)),
                ):
                    self.assertEqual(self.query(key), (status, {"error": message}))

    def test_spawn_error_propagates_and_releases_lock(self):
        key, _ = self.retain()
        with patch.object(artifacts.subprocess, "Popen", side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                self.query(key)
        self.assertFalse(self.store.lock.locked())
        self.assertIn(key, self.store.artifacts)
