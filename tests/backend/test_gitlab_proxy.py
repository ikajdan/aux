# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import io
import unittest
from email.message import Message
from unittest.mock import patch

from backend_support import gitlab_proxy, server


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.upstream = server.CONFIG["gitlabUrl"] + "/api/v4/"

    def test_missing_pat_is_rejected_without_outbound_request(self):
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            for method, path in (
                ("GET", "/api/user"),
                ("GET", "/api/users?username=foo"),
                ("GET", "/api/users/42/projects?page=2"),
                ("POST", "/api/projects/1"),
            ):
                with self.subTest(method=method):
                    response = self.client.open(path, method=method, json={})
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.get_json(), {"error": "PAT required"})
            build_opener.assert_not_called()

    def test_methods_and_bodies_are_forwarded(self):
        payload = b'{"topics":["manual","hardware"]}'
        for method in ("GET", "POST"):
            with (
                self.subTest(method=method),
                patch.object(
                    gitlab_proxy.urllib.request, "build_opener"
                ) as build_opener,
            ):
                upstream = build_opener.return_value.open.return_value
                upstream.__enter__.return_value = upstream
                upstream.code = 200
                upstream.read.return_value = payload
                response = self.client.open(
                    "/api/projects/team%2Fmanual?statistics=true",
                    method=method,
                    data=payload if method != "GET" else None,
                    content_type="application/json",
                    headers={"PRIVATE-TOKEN": "test-pat"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, payload)
                outbound = build_opener.return_value.open.call_args.args[0]
                self.assertEqual(outbound.get_method(), method)
                self.assertEqual(outbound.data, payload if method != "GET" else None)
                self.assertEqual(
                    outbound.full_url,
                    self.upstream + "projects/team%2Fmanual?statistics=true",
                )
                self.assertEqual(outbound.get_header("Private-token"), "test-pat")
                self.assertEqual(
                    outbound.get_header("Content-type"), "application/json"
                )

    def test_personal_namespace_gets_preserve_url_token_and_response(self):
        for endpoint, payload in (
            ("users?username=foo%2Bbar", b'[{"id":42,"username":"foo+bar"}]'),
            ("users?username=foo%26admin%3Dtrue", b"[]"),
            ("users/42/projects?per_page=100&page=1", b'[{"id":123}]'),
            ("users/42/projects?per_page=100&page=2&order_by=id&sort=asc", b"[]"),
        ):
            with (
                self.subTest(endpoint=endpoint),
                patch.object(
                    gitlab_proxy.urllib.request, "build_opener"
                ) as build_opener,
            ):
                upstream = build_opener.return_value.open.return_value
                upstream.__enter__.return_value = upstream
                upstream.code = 200
                upstream.read.return_value = payload
                response = self.client.get(
                    "/api/" + endpoint, headers={"PRIVATE-TOKEN": "test-pat"}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, payload)
                self.assertEqual(response.mimetype, "application/json")
                outbound = build_opener.return_value.open.call_args.args[0]
                self.assertEqual(
                    outbound.full_url,
                    self.upstream + endpoint,
                )
                self.assertEqual(outbound.get_method(), "GET")
                self.assertIsNone(outbound.data)
                self.assertEqual(outbound.get_header("Private-token"), "test-pat")

    def test_other_user_endpoints_never_create_an_outbound_client(self):
        paths = (
            "/api/users",
            "/api/users?username=",
            "/api/users?search=foo",
            "/api/users?username%3Dfoo",
            "/api/users/42?username=foo",
            "/api/users/42",
            "/api/users/foo/projects",
            "/api/users/0/projects",
            "/api/users/-1/projects",
            "/api/users/+1/projects",
            "/api/users/1.0/projects",
            "/api/users/01/projects",
            "/api/users/%D9%A1/projects",
            "/api/users/42/projects/123",
            "/api/users/42/events",
            "/api/users/42//projects",
            "/api/users/42/%2e%2e/projects",
            "/api/users/42%2f..%2fprojects",
            "/api/users/42%5cprojects",
            "/api/users/?username=foo",
            "/api/users/../users?username=foo",
            "/api/https://untrusted.example/users?username=foo",
        )
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            for path in paths:
                with self.subTest(path=path):
                    response = self.client.get(
                        path, headers={"PRIVATE-TOKEN": "test-pat"}
                    )
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(
                        response.get_json(), {"error": "Disallowed API path"}
                    )
            for path in ("/api/users?username=foo", "/api/users/42/projects?page=1"):
                with self.subTest(method="POST", path=path):
                    response = self.client.post(
                        path, json={}, headers={"PRIVATE-TOKEN": "test-pat"}
                    )
                    self.assertEqual(response.status_code, 400)
            build_opener.assert_not_called()

    def test_personal_namespace_raw_uri_checks(self):
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            response = self.client.get(
                "/api/users?username=foo",
                headers={"PRIVATE-TOKEN": "test-pat"},
                environ_overrides={"REQUEST_URI": None, "RAW_URI": None},
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(
                response.get_json(), {"error": "Raw request URI unavailable"}
            )
            response = self.client.get(
                "/api/users?username=foo",
                headers={"PRIVATE-TOKEN": "test-pat"},
                environ_overrides={"REQUEST_URI": "/api/users?username=foo#fragment"},
            )
            self.assertEqual(response.status_code, 400)
            build_opener.assert_not_called()

    def test_put_and_delete_remain_disallowed(self):
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            for method in ("PUT", "DELETE"):
                for path in (
                    "/api/",
                    "/api/projects/1",
                    "/api/users?username=foo",
                    "/api/users/42/projects?page=1",
                ):
                    with self.subTest(method=method, path=path):
                        response = self.client.open(
                            path,
                            method=method,
                            json={"topics": []},
                            headers={"PRIVATE-TOKEN": "test-pat"},
                        )
                        self.assertEqual(response.status_code, 405)
            build_opener.assert_not_called()

    def test_disallowed_paths_never_create_an_outbound_client(self):
        paths = (
            "/api/admin/users",
            "/api/projects/../users",
            "/api/projects/%2e%2e/users",
            "/api/projects/1//repository",
            "/api/projects/1%5crepository",
            "/api/projects/1%2f..%2fusers",
        )
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            for path in paths:
                with self.subTest(path=path):
                    response = self.client.get(
                        path, headers={"PRIVATE-TOKEN": "test-pat"}
                    )
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(
                        response.get_json(), {"error": "Disallowed API path"}
                    )
            build_opener.assert_not_called()

    def test_ca_timeout_redirect_handler_and_read_limit_are_preserved(self):
        for ca_file in (None, "", "/custom/gitlab-ca.pem"):
            with (
                self.subTest(ca_file=ca_file),
                patch.dict(gitlab_proxy.os.environ, {}, clear=True),
                patch.object(gitlab_proxy.ssl, "create_default_context") as context,
                patch.object(gitlab_proxy, "NoRedirect") as no_redirect,
                patch.object(gitlab_proxy.urllib.request, "HTTPSHandler") as https,
                patch.object(
                    gitlab_proxy.urllib.request, "build_opener"
                ) as build_opener,
            ):
                if ca_file is not None:
                    gitlab_proxy.os.environ["GITLAB_CA_FILE"] = ca_file
                upstream = build_opener.return_value.open.return_value
                upstream.__enter__.return_value = upstream
                upstream.code = 200
                upstream.read.return_value = b"{}"
                response = self.client.get(
                    "/api/projects/1", headers={"PRIVATE-TOKEN": "test-pat"}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b"{}")
                context.assert_called_once_with(cafile=ca_file or None)
                no_redirect.assert_called_once_with()
                https.assert_called_once_with(context=context.return_value)
                build_opener.assert_called_once_with(
                    no_redirect.return_value, https.return_value
                )
                self.assertEqual(
                    build_opener.return_value.open.call_args.kwargs, {"timeout": 100}
                )
                upstream.read.assert_called_once_with(64 * 1024 * 1024 + 1)

    def test_oversized_upstream_response_is_rejected(self):
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            upstream = build_opener.return_value.open.return_value
            upstream.__enter__.return_value = upstream
            upstream.code = 200
            upstream.read.return_value = b"x" * (64 * 1024 * 1024 + 1)
            response = self.client.get(
                "/api/projects/1", headers={"PRIVATE-TOKEN": "test-pat"}
            )
            self.assertEqual(response.status_code, 502)
            self.assertEqual(
                response.get_json(), {"error": "Upstream response too large"}
            )
            upstream.read.assert_called_once_with(64 * 1024 * 1024 + 1)

    def test_upstream_http_errors_preserve_status_and_body(self):
        payload = b'{"message":"upstream failure"}'
        with patch.object(gitlab_proxy.urllib.request, "build_opener") as build_opener:
            for status in (401, 403, 404, 429, 500):
                with self.subTest(status=status):
                    build_opener.return_value.open.side_effect = (
                        gitlab_proxy.urllib.error.HTTPError(
                            self.upstream + "projects/1",
                            status,
                            "failure",
                            {},
                            io.BytesIO(payload),
                        )
                    )
                    response = self.client.get(
                        "/api/projects/1", headers={"PRIVATE-TOKEN": "test-pat"}
                    )
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.data, payload)
                    self.assertEqual(response.mimetype, "application/json")

    def test_redirect_does_not_send_pat_to_another_host(self):
        for endpoint in ("user", "users?username=foo", "users/42/projects?page=2"):
            with self.subTest(endpoint=endpoint):
                headers = Message()
                headers["Location"] = "https://untrusted.example/collect"
                upstream = gitlab_proxy.urllib.response.addinfourl(
                    io.BytesIO(b"redirect body"),
                    headers,
                    self.upstream + endpoint,
                    302,
                )
                upstream.msg = "Found"
                # Keep urllib's real redirect/error processing; replace only the transport.
                with patch.object(
                    gitlab_proxy.urllib.request.HTTPSHandler,
                    "https_open",
                    return_value=upstream,
                ) as transport:
                    response = self.client.get(
                        "/api/" + endpoint, headers={"PRIVATE-TOKEN": "test-pat"}
                    )
                self.assertEqual(response.status_code, 302)
                self.assertEqual(response.data, b"redirect body")
                self.assertNotIn("Location", response.headers)
                transport.assert_called_once()
                outbound = transport.call_args.args[0]
                self.assertEqual(
                    outbound.full_url,
                    self.upstream + endpoint,
                )
                self.assertEqual(outbound.get_header("Private-token"), "test-pat")
