# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ServerStartupTests(unittest.TestCase):
    def test_module_and_direct_script_startup_use_the_same_services(self):
        config = {
            "gitlabUrl": "https://gitlab.example",
            "repositoryGroups": [{"name": "Docs", "path": "team/docs"}],
            "mainDocument": "docs/report.tex",
            "maxConcurrentBuilds": 3,
            "limits": {"requestBytes": 1024},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            for mode in ("module", "script"):
                with self.subTest(mode=mode):
                    entry = (
                        "runpy.run_module('server.server', run_name='__main__')"
                        if mode == "module"
                        else f"runpy.run_path({str(ROOT / 'server/server.py')!r}, run_name='__main__')"
                    )
                    code = f"""import json, runpy
from unittest.mock import patch
with patch('waitress.serve') as serve, patch('threading.Thread') as thread:
    namespace = {entry}
    serve.assert_called_once()
    thread.assert_called_once()
    thread.return_value.start.assert_called_once()
    assert thread.call_args.kwargs['daemon'] is True
    assert thread.call_args.kwargs['target'] == namespace['artifact_store'].janitor
    assert serve.call_args.args[0] is namespace['app']
    assert namespace['compiler'].config is namespace['CONFIG']
    assert namespace['compiler'].artifact_store is namespace['artifact_store']
    assert serve.call_args.kwargs['threads'] == 8
    assert serve.call_args.kwargs['max_request_body_size'] == 1024
    assert namespace['ROOT'] == __import__('pathlib').Path({str(ROOT / "dist")!r})
    response = namespace['app'].test_client().get('/health')
    print(json.dumps([response.status_code, response.get_json(), namespace['CONFIG']['mainDocument']]))
"""
                    result = subprocess.run(
                        [sys.executable, "-c", code],
                        cwd=ROOT if mode == "module" else directory,
                        env={**os.environ, "AUX_CONFIG_FILE": str(path)},
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=True,
                    )
                    self.assertEqual(
                        json.loads(result.stdout),
                        [200, {"ok": True}, "docs/report.tex"],
                    )

    def test_service_modules_import_without_loading_app_or_configuration(self):
        code = """import sys
from server import artifacts, compilation, configuration, gitlab_proxy, process_limits, validation
assert 'server.server' not in sys.modules
assert not hasattr(compilation, 'app')
assert not hasattr(artifacts, 'app')
print('independent imports')
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=ROOT,
            env={
                **os.environ,
                "AUX_CONFIG_FILE": str(ROOT / "nonexistent-config.json"),
            },
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        self.assertEqual(result.stdout.strip(), "independent imports")
