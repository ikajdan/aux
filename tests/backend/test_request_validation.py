# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import unittest
from unittest.mock import Mock, patch

from backend_support import compilation, configuration, server, validation
from werkzeug.exceptions import RequestEntityTooLarge


class RequestValidationTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()

    def test_compile_rejects_non_object_json(self):
        for payload in ("null", "[]", '"text"', "42", "true"):
            with self.subTest(payload=payload):
                response = self.client.post(
                    "/compile", data=payload, content_type="application/json"
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.get_json())

    def test_compile_rejects_invalid_files_before_starting_a_process(self):
        files = [
            None,
            [],
            "main.tex",
            {"path": "main.tex", "content": 12},
            {"path": "main.tex", "content": "!not-base64!"},
            {"path": "../main.tex", "content": ""},
            {"path": "aux-output/main.tex", "content": ""},
        ]
        with patch.object(compilation.subprocess, "Popen") as process:
            for item in files:
                with self.subTest(item=item):
                    response = self.client.post("/compile", json={"files": [item]})
                    self.assertEqual(response.status_code, 400)
            process.assert_not_called()

    def test_snapshot_limits_accept_exact_decoded_boundary(self):
        process = Mock()
        process.wait.return_value = 1
        with (
            patch.dict(
                server.CONFIG,
                {
                    "limits": {
                        **configuration.DEFAULT_LIMITS,
                        "snapshotBytes": 3,
                        "snapshotFiles": 1,
                        "snapshotEntries": 1,
                        "submoduleDepth": 0,
                    }
                },
            ),
            patch.object(
                compilation.subprocess, "Popen", return_value=process
            ) as popen,
        ):
            response = self.client.post(
                "/compile", json={"files": [{"path": "main.tex", "content": "YWJj"}]}
            )
            self.assertEqual(response.status_code, 422)
            popen.assert_called_once()

    def test_request_limit_boundary_and_413_message(self):
        with (
            patch.dict(server.CONFIG["limits"], {"requestBytes": 3}),
            patch.dict(server.app.config, {"MAX_CONTENT_LENGTH": 3}),
        ):
            with server.app.test_request_context(
                "/compile", method="POST", data=b"123"
            ):
                self.assertEqual(server.body(), b"123")
            with server.app.test_request_context(
                "/compile", method="POST", data=b"1234"
            ):
                with self.assertRaisesRegex(ValueError, "3 bytes"):
                    server.body()
                with self.assertRaises(RequestEntityTooLarge) as caught:
                    server.request.get_data()
                self.assertEqual(caught.exception.code, 413)
                response, status = server.request_too_large(caught.exception)
                self.assertEqual(status, 413)
                self.assertEqual(
                    response.get_json(), {"error": "Request body exceeds 3 bytes"}
                )

    def test_compile_slot_is_released_after_validation_failure(self):
        for _ in range(server.CONFIG["maxConcurrentBuilds"] + 1):
            self.assertEqual(self.client.post("/compile", json=[]).status_code, 400)

    def test_synctex_rejects_non_object_json(self):
        response = self.client.post(
            "/synctex", data="null", content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)

    def test_cross_origin_requests_are_refused(self):
        response = self.client.post(
            "/compile", json={}, headers={"Origin": "https://example.com"}
        )
        self.assertEqual(response.status_code, 403)

    def test_safe_path_rejects_traversal_and_git_metadata(self):
        for path in (
            "../main.tex",
            "/main.tex",
            "a/./b",
            "a//b",
            ".git/config",
            "a/.GIT/config",
            "a\\b",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validation.safe_path(path)
        self.assertEqual(
            str(validation.safe_path("chapters/intro.tex")), "chapters/intro.tex"
        )
