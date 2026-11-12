# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend_support import artifacts, compilation, server


class MainDocumentTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.main = "docs/report.tex"
        config = patch.object(
            server.compiler,
            "config",
            {**server.compiler.config, "mainDocument": self.main},
        )
        config.start()
        self.addCleanup(config.stop)
        registry = patch.object(server.artifact_store, "artifacts", {})
        registry.start()
        self.addCleanup(registry.stop)
        self.addCleanup(self.cleanup_artifacts)

    def cleanup_artifacts(self):
        for artifact in server.artifact_store.artifacts.values():
            artifact["workspace"].cleanup()
        server.artifact_store.artifacts.clear()

    def payload(self, *paths):
        return {"files": [{"path": path, "content": ""} for path in paths]}

    def test_missing_configured_target_does_not_start_compiler(self):
        with patch.object(compilation.subprocess, "Popen") as popen:
            response = self.client.post("/compile", json=self.payload("main.tex"))
        self.assertEqual(response.status_code, 400)
        self.assertIn(self.main, response.get_json()["error"])
        popen.assert_not_called()

    def test_different_request_main_does_not_override_configured_target(self):
        for main in ("main.tex", "docs/other.tex", None, ""):
            with self.subTest(main=main):
                payload = {**self.payload(self.main, "main.tex"), "main": main}
                with patch.object(compilation.subprocess, "Popen") as popen:
                    response = self.client.post("/compile", json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn(self.main, response.get_json()["error"])
                popen.assert_not_called()

    def compile_successfully(self, main, explicit_main=False):
        server.compiler.config["mainDocument"] = main
        pdf = b"%PDF-1.4\ncustom document\n"
        relative_output = "aux-output/" + Path(main).stem + ".pdf"
        roots = []

        def compile_process(command, **options):
            root = options["cwd"]
            roots.append(root)
            self.assertEqual(command[0], "latexmk")
            self.assertEqual(command[-1], "./" + main)
            self.assertIn("-outdir=aux-output", command)
            self.assertFalse(options.get("shell", False))
            # Nested targets must not change cwd to the document's parent.
            self.assertTrue((root / main).is_file())
            self.assertTrue((root / "project-root.txt").is_file())
            self.assertTrue((root / "main.tex").is_file())
            output = root / relative_output
            output.write_bytes(pdf)
            output.with_suffix(".synctex.gz").write_bytes(b"mock mapping")
            options["stdout"].write(b"custom compilation succeeded\n")
            return Mock(wait=Mock(return_value=0))

        payload = self.payload(main, "main.tex", "project-root.txt")
        if explicit_main:
            payload["main"] = main
        with patch.object(
            compilation.subprocess, "Popen", side_effect=compile_process
        ) as popen:
            response = self.client.post("/compile", json=payload)
        self.assertEqual(response.status_code, 200, response.get_json())
        popen.assert_called_once()
        result = response.get_json()
        self.assertEqual(base64.b64decode(result["pdf"]), pdf)
        self.assertIn("custom compilation succeeded", result["log"])
        artifact = server.artifact_store.artifacts[result["synctex"]]
        self.assertEqual(artifact["output"], relative_output)
        self.assertEqual(Path(artifact["workspace"].name), roots[0])
        self.assertEqual(artifact["paths"], {main, "main.tex", "project-root.txt"})
        self.assertTrue((roots[0] / relative_output).is_file())
        self.assertTrue(
            (roots[0] / relative_output).with_suffix(".synctex.gz").is_file()
        )

    def test_compiles_configured_target_and_retains_actual_output(self):
        for main in ("report.tex", "docs/report.tex", "文書/annual 報告.tex"):
            with self.subTest(main=main):
                self.compile_successfully(main)

    def test_matching_request_main_is_accepted(self):
        self.compile_successfully(self.main, explicit_main=True)

    def test_synctex_uses_stored_output_for_both_directions(self):
        workspace = tempfile.TemporaryDirectory(prefix="aux-test-")
        self.addCleanup(workspace.cleanup)
        root = Path(workspace.name)
        source = "文書/annual 報告.tex"
        relative_output = "aux-output/annual 報告.pdf"
        output = root / relative_output
        output.parent.mkdir()
        output.write_bytes(b"%PDF-1.4\n")
        output.with_suffix(".synctex.gz").write_bytes(b"mock mapping")
        (root / source).parent.mkdir()
        (root / source).write_text("", encoding="utf-8")
        server.artifact_store.artifacts["custom-build"] = {
            "workspace": workspace,
            "paths": {source},
            "output": relative_output,
            "size": 0,
            "created": time.monotonic(),
        }
        # Navigation belongs to the retained build, not the current config target.
        server.compiler.config["mainDocument"] = "different.tex"
        cases = [
            (
                {"direction": "forward", "path": source, "line": 7, "column": 2},
                ["synctex", "view", "-i", f"7:2:{root / source}", "-o", str(output)],
                "Page:1\nh:10\nv:20\nW:30\nH:40\n",
                {"page": 1, "x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0},
            ),
            (
                {"direction": "backward", "page": 1, "x": 10, "y": 20},
                ["synctex", "edit", "-o", f"1:10:20:{output}"],
                f"Input:{root / source}\nLine:7\nColumn:2\n",
                {"path": source, "line": 7, "column": 2},
            ),
        ]
        for request, expected_command, log, expected_result in cases:
            with self.subTest(direction=request["direction"]):

                def synctex_process(command, **options):
                    self.assertEqual(command, expected_command)
                    self.assertEqual(options["cwd"], root)
                    options["stdout"].write(log.encode("utf-8"))
                    return Mock(wait=Mock(return_value=0))

                with patch.object(
                    artifacts.subprocess, "Popen", side_effect=synctex_process
                ) as popen:
                    status, result = server.artifact_store.synctex_query(
                        {"build": "custom-build", **request}
                    )
                popen.assert_called_once()
                self.assertEqual(status, 200)
                self.assertEqual(result, expected_result)
