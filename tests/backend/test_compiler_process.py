# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

from backend_support import compilation, process_limits, server


class CompilerProcessTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.payload = {"files": [{"path": "main.tex", "content": ""}]}

    def test_timeout_kills_and_reaps_process_cleans_workspace_and_releases_slot(self):
        process = Mock(pid=12345)
        clock = Mock(return_value=0)

        def wait(timeout=None):
            if timeout is not None:
                clock.return_value = 111
                raise compilation.subprocess.TimeoutExpired("latexmk", timeout)
            return 0

        process.wait.side_effect = wait
        lock = threading.BoundedSemaphore(1)
        with (
            patch.object(server.compiler, "slots", lock),
            patch.object(compilation.time, "monotonic", clock),
            patch.object(
                compilation.subprocess, "Popen", return_value=process
            ) as popen,
            patch.object(compilation.os, "killpg") as killpg,
        ):
            response = self.client.post("/compile", json=self.payload)
            workspace = popen.call_args.kwargs["cwd"]
            self.assertEqual(response.status_code, 422)
            self.assertIn("timed out", response.get_json()["error"])
            killpg.assert_called_once_with(process.pid, compilation.signal.SIGKILL)
            self.assertEqual(process.wait.call_args_list, [call(timeout=0.25), call()])
            self.assertFalse(workspace.exists())
            self.assertTrue(
                lock.acquire(blocking=False), "compile slot leaked after timeout"
            )
            lock.release()
            # A subsequent valid request must reach the compiler rather than return 429.
            process.wait.side_effect = None
            process.wait.return_value = 1
            self.assertEqual(
                self.client.post("/compile", json=self.payload).status_code, 422
            )
            self.assertEqual(popen.call_count, 2)

    def test_compiler_uses_isolated_environment_and_safe_command(self):
        process = Mock()
        process.wait.return_value = 1
        with (
            patch.dict(
                compilation.os.environ,
                {"TEXINPUTS": "/host/secrets", "PERL5OPT": "-MUnsafe"},
            ),
            patch.object(
                compilation.subprocess, "Popen", return_value=process
            ) as popen,
        ):
            response = self.client.post("/compile", json=self.payload)
        self.assertEqual(response.status_code, 422)
        popen.assert_called_once()
        command = popen.call_args.args[0]
        options = popen.call_args.kwargs
        self.assertEqual(command[0], "latexmk")
        for flag in ("-norc", "-xelatex", "-no-shell-escape", "-outdir=aux-output"):
            self.assertIn(flag, command)
        self.assertEqual(command[-1], "./main.tex")
        self.assertFalse(options.get("shell", False))
        self.assertIs(options["preexec_fn"], process_limits.limits)
        self.assertEqual(options["stderr"], compilation.subprocess.STDOUT)
        env = options["env"]
        self.assertNotIn("TEXINPUTS", env)
        self.assertNotIn("PERL5OPT", env)
        self.assertEqual(env["openin_any"], "p")
        self.assertEqual(env["openout_any"], "p")
        for key in ("HOME", "TEXMFOUTPUT", "TEXMFVAR", "TEXMFCONFIG"):
            self.assertTrue(Path(env[key]).is_relative_to(options["cwd"]))
        self.assertTrue(options["stdout"].closed)
        self.assertFalse(options["cwd"].exists())
