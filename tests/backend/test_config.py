# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend_support import configuration, server


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "gitlabUrl": "https://gitlab.example/team/",
            "repositoryGroups": [{"name": "Manuals", "path": "team/docs"}],
        }
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "config.json"

    def write_config(self, config):
        self.path.write_text(json.dumps(config), encoding="utf-8")

    def test_override_is_loaded_at_startup_and_served(self):
        self.config["limits"] = {
            **configuration.DEFAULT_LIMITS,
            "requestBytes": 1024,
            "submoduleDepth": 0,
        }
        self.write_config(self.config)
        code = (
            "import server.server as s; import json; "
            "r=s.app.test_client().get('/config'); "
            "print(json.dumps([r.status_code, r.get_json(), r.headers['Cache-Control'], s.CONFIG['gitlabUrl'] + '/api/v4/']))"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(server.__file__).resolve().parent.parent,
            env={**os.environ, "AUX_CONFIG_FILE": str(self.path)},
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        expected = {
            **self.config,
            "gitlabUrl": "https://gitlab.example/team",
            "limits": self.config["limits"],
            "maxConcurrentBuilds": 6,
            "mainDocument": "main.tex",
        }
        self.assertEqual(
            json.loads(result.stdout),
            [200, expected, "no-store", "https://gitlab.example/team/api/v4/"],
        )

    def test_invalid_values(self):
        cases = [None, [], {}, {**self.config, "secret": "never expose"}]
        for url in (
            "",
            "ftp://example.com",
            "https://u:p@example.com",
            "https://example.com?",
            "https://example.com#",
            "https:///path",
            "https://example.com:bad",
            "https://exa mple.com",
        ):
            cases.append({**self.config, "gitlabUrl": url})
        for group in ("", "/team", "team/", "team//docs", "../docs", None):
            cases.append(
                {**self.config, "repositoryGroups": [{"name": "Docs", "path": group}]}
            )

        for config in cases:
            with self.subTest(config=config):
                self.write_config(config)
                with self.assertRaisesRegex(ValueError, "Invalid Aux config"):
                    configuration.load_config(self.path)

    def test_repository_groups_validation(self):
        cases = [
            None,
            {},
            [],
            [None],
            ["team/docs"],
            [{}],
            [{"name": "Docs"}],
            [{"path": "team/docs"}],
            [{"name": "Docs", "path": "team/docs", "extra": True}],
            [
                {"name": "One", "path": "team/docs"},
                {"name": "Two", "path": "team/docs"},
            ],
        ]
        for name in (None, 1, "", "   ", " Docs", "Docs ", "x" * 81):
            cases.append([{"name": name, "path": "team/docs"}])
        for path in (1, [], "https://gitlab.example/team", "team/docs?x", "team/ docs"):
            cases.append([{"name": "Docs", "path": path}])
        for groups in cases:
            with self.subTest(groups=groups):
                self.write_config({**self.config, "repositoryGroups": groups})
                with self.assertRaisesRegex(ValueError, "repositoryGroups"):
                    configuration.load_config(self.path)

    def test_repository_groups_preserve_order_and_allow_overlaps(self):
        groups = [
            {"name": "x" * 80, "path": "team/docs/sub_group.v2-1"},
            {"name": "Docs", "path": "team/docs"},
            {"name": "Docs", "path": "other/docs"},
        ]
        self.write_config({**self.config, "repositoryGroups": groups})
        self.assertEqual(
            configuration.load_config(self.path)["repositoryGroups"], groups
        )

    def test_legacy_repository_group_normalized_in_public_config(self):
        legacy = {
            key: value
            for key, value in self.config.items()
            if key != "repositoryGroups"
        }
        legacy["repositoryGroup"] = "team/docs"
        self.write_config(legacy)
        effective = configuration.load_config(self.path)
        self.assertEqual(
            effective["repositoryGroups"], [{"name": "team/docs", "path": "team/docs"}]
        )
        self.assertNotIn("repositoryGroup", effective)
        with patch.object(server, "CONFIG", effective):
            response = server.app.test_client().get("/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), effective)
        for path in (None, "", "/team", "team/", "team//docs", "../docs"):
            with self.subTest(path=path):
                self.write_config({**legacy, "repositoryGroup": path})
                with self.assertRaises(ValueError):
                    configuration.load_config(self.path)

    def test_repository_group_fields_are_mutually_exclusive_and_required(self):
        missing = {
            key: value
            for key, value in self.config.items()
            if key != "repositoryGroups"
        }
        for config in (missing, {**self.config, "repositoryGroup": "team/docs"}):
            self.write_config(config)
            with self.assertRaisesRegex(ValueError, "exactly one"):
                configuration.load_config(self.path)

    def test_limit_defaults_and_custom_values(self):
        self.write_config(self.config)
        effective = configuration.load_config(self.path)
        self.assertEqual(
            set(effective),
            {
                "gitlabUrl",
                "repositoryGroups",
                "limits",
                "maxConcurrentBuilds",
                "mainDocument",
            },
        )
        self.assertEqual(effective["limits"], configuration.DEFAULT_LIMITS)
        self.write_config(
            {
                **self.config,
                "limits": {"requestBytes": 123, "submoduleDepth": 0},
            }
        )
        effective = configuration.load_config(self.path)
        self.assertEqual(
            effective["limits"],
            {**configuration.DEFAULT_LIMITS, "requestBytes": 123, "submoduleDepth": 0},
        )

    def test_main_document_defaults_to_main_tex(self):
        self.write_config(self.config)
        self.assertEqual(
            configuration.load_config(self.path)["mainDocument"], "main.tex"
        )

    def test_main_document_overrides_are_preserved_and_served(self):
        for main in (
            "main.tex",
            "report.tex",
            "docs/report.tex",
            "docs/annual report.tex",
            "文書/研究 報告.tex",
            "docs/aux-output/report.tex",
        ):
            with self.subTest(main=main):
                self.write_config({**self.config, "mainDocument": main})
                effective = configuration.load_config(self.path)
                self.assertEqual(effective["mainDocument"], main)
                with patch.object(server, "CONFIG", effective):
                    response = server.app.test_client().get("/config")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()["mainDocument"], main)

    def test_invalid_main_documents(self):
        cases = [
            None,
            True,
            False,
            1,
            1.5,
            [],
            {},
            "",
            " ",
            "\t\n",
            "/main.tex",
            "//docs/main.tex",
            "C:/docs/main.tex",
            "docs\\main.tex",
            "\\main.tex",
            ".git/main.tex",
            "docs/.git/main.tex",
            "docs/.GIT/main.tex",
            "../main.tex",
            "docs/../main.tex",
            "./main.tex",
            "docs/./main.tex",
            "docs//main.tex",
            "docs/main.tex/",
            "docs:main.tex",
            "docs/ma:in.tex",
            "aux-output/main.tex",
            "aux-output/docs/main.tex",
            "main",
            "main.pdf",
            "main.tex.bak",
        ]
        cases.extend(f"docs/re{chr(code)}port.tex" for code in (*range(32), 127))
        for main in cases:
            with self.subTest(main=main):
                self.write_config({**self.config, "mainDocument": main})
                with self.assertRaisesRegex(ValueError, "Invalid Aux config"):
                    configuration.load_config(self.path)

    def test_main_document_override_is_loaded_at_startup(self):
        main = "文書/annual report.tex"
        self.write_config({**self.config, "mainDocument": main})
        code = (
            "import server.server as s; import json; "
            "print(json.dumps([s.CONFIG['mainDocument'], "
            "s.app.test_client().get('/config').get_json()['mainDocument']]))"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(server.__file__).resolve().parent.parent,
            env={**os.environ, "AUX_CONFIG_FILE": str(self.path)},
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout), [main, main])

    def test_invalid_concurrent_build_counts(self):
        for value in (None, True, False, "6", 1.5, 0, -1, [], {}, 9007199254740992):
            with self.subTest(value=value):
                self.write_config({**self.config, "maxConcurrentBuilds": value})
                with self.assertRaisesRegex(ValueError, "maxConcurrentBuilds"):
                    configuration.load_config(self.path)

    def test_concurrent_build_capacity_at_startup_ignores_environment(self):
        code = """import server.server as s
import json
capacity = s.CONFIG['maxConcurrentBuilds']
acquired = [s.compiler.slots.acquire(blocking=False) for _ in range(capacity + 1)]
print(json.dumps([capacity, acquired]))
"""
        for configured, expected in ((None, 6), (3, 3)):
            with self.subTest(configured=configured):
                config = dict(self.config)
                if configured is not None:
                    config["maxConcurrentBuilds"] = configured
                self.write_config(config)
                result = subprocess.run(
                    [sys.executable, "-c", code],
                    cwd=Path(server.__file__).resolve().parent.parent,
                    env={
                        **os.environ,
                        "AUX_CONFIG_FILE": str(self.path),
                        "MAX_CONCURRENT_BUILDS": "not-used",
                    },
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=True,
                )
                self.assertEqual(
                    json.loads(result.stdout), [expected, [True] * expected + [False]]
                )

    def test_invalid_limits(self):
        cases = [{"limits": value} for value in (None, True, [], {"unknown": 1})]
        for key in configuration.DEFAULT_LIMITS:
            for value in (True, False, None, "1", 1.5, -1, 9007199254740992):
                cases.append({"limits": {key: value}})
            if key != "submoduleDepth":
                cases.append({"limits": {key: 0}})
        for extension in cases:
            with self.subTest(extension=extension):
                self.write_config({**self.config, **extension})
                with self.assertRaisesRegex(ValueError, "Invalid Aux config"):
                    configuration.load_config(self.path)

    def test_custom_limits_are_applied_at_startup(self):
        self.write_config(
            {
                **self.config,
                "limits": {"requestBytes": 128, "snapshotBytes": 2, "snapshotFiles": 1},
            }
        )
        code = """import server.server as s
import json
from unittest.mock import patch
from server import compilation
c = s.app.test_client()
with patch.object(compilation.subprocess, "Popen") as process:
    responses = [
        c.post('/compile', data='x' * 129),
        c.post('/compile', json={'files': [{'path': 'main.tex', 'content': 'YWJj'}]}),
        c.post('/compile', json={'files': [{'path': 'main.tex', 'content': ''}, {'path': 'a', 'content': ''}]}),
    ]
    print(json.dumps([s.CONFIG["limits"]["requestBytes"], s.app.config['MAX_CONTENT_LENGTH'], [[r.status_code, r.get_json()] for r in responses], process.call_count]))
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(server.__file__).resolve().parent.parent,
            env={**os.environ, "AUX_CONFIG_FILE": str(self.path)},
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        limit, flask_limit, responses, calls = json.loads(result.stdout)
        self.assertEqual((limit, flask_limit, calls), (128, 128, 0))
        self.assertEqual([r[0] for r in responses], [400, 400, 400])
        self.assertIn("128 bytes", responses[0][1]["error"])
        self.assertIn("2 decoded bytes", responses[1][1]["error"])
        self.assertEqual(responses[2][1]["error"], "Too many files")

    def test_missing_malformed_and_invalid_startup(self):
        with self.assertRaisesRegex(ValueError, "Invalid Aux config"):
            configuration.load_config(self.path)
        self.path.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Invalid Aux config"):
            configuration.load_config(self.path)
        result = subprocess.run(
            [sys.executable, "-c", "import server.server"],
            cwd=Path(server.__file__).resolve().parent.parent,
            env={**os.environ, "AUX_CONFIG_FILE": str(self.path)},
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Invalid Aux config", result.stderr)
        self.assertIn(str(self.path), result.stderr)
