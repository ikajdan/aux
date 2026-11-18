# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import binascii
import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_from_directory
from waitress import serve

# Support both `python -m server.server` and the existing direct script entrypoint.
if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "server"

from . import artifacts, compilation, configuration, gitlab_proxy
from .logging_setup import configure_logging, safe_log_value

ROOT = Path(__file__).resolve().parent.parent / "dist"
CONFIG = configuration.load_config()
configure_logging(CONFIG["logLevel"])
artifact_store = artifacts.ArtifactStore()
compiler = compilation.CompilationService(CONFIG, artifact_store)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = CONFIG["limits"]["requestBytes"]


@app.before_request
def check_origin():
    g.request_id = secrets.token_hex(8)
    g.request_started = time.monotonic()
    origin = request.headers.get("Origin")
    if request.headers.get("Sec-Fetch-Site") == "cross-site" or (
        origin and urllib.parse.urlsplit(origin).netloc != request.host
    ):
        return jsonify(error="Cross-origin request refused"), 403


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    nonce = getattr(g, "style_nonce", None)
    style_src = "style-src 'self'" + (f" 'nonce-{nonce}'" if nonce else "")
    response.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; {style_src}; connect-src 'self'; img-src 'self' blob:; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Request-ID"] = g.request_id
    return response


@app.after_request
def log_request(response):
    elapsed = (time.monotonic() - g.request_started) * 1000
    if response.status_code >= 500:
        level = logging.ERROR
    elif response.status_code >= 400:
        level = logging.WARNING
    elif request.method == "POST" or request.path in ("/", "/index.html"):
        level = logging.INFO
    else:
        level = logging.DEBUG
    app.logger.log(
        level,
        "request method=%s path=%s status=%s duration_ms=%.1f request_bytes=%s response_bytes=%s",
        request.method,
        safe_log_value(request.path),
        response.status_code,
        elapsed,
        request.content_length or 0,
        response.content_length,
    )
    return response


def body():
    limit = CONFIG["limits"]["requestBytes"]
    length = request.content_length
    if length is None or not 0 < length <= limit:
        raise ValueError(f"Request body missing or exceeds {limit} bytes")
    return request.get_data()


@app.errorhandler(413)
def request_too_large(error):
    return jsonify(
        error=f"Request body exceeds {CONFIG['limits']['requestBytes']} bytes"
    ), 413


@app.errorhandler(compilation.BuildCanceled)
def build_canceled(error):
    return jsonify(error="Build canceled", canceled=True), 409


@app.errorhandler(ValueError)
@app.errorhandler(KeyError)
@app.errorhandler(TypeError)
@app.errorhandler(binascii.Error)
def invalid_request(error):
    return jsonify(error=str(error)), 400


@app.errorhandler(OSError)
@app.errorhandler(urllib.error.URLError)
def upstream_error(error):
    app.logger.warning(
        "upstream_error type=%s reason_type=%s errno=%s",
        type(error).__name__,
        type(getattr(error, "reason", None)).__name__,
        getattr(error, "errno", None),
    )
    return jsonify(error=str(error)), 502


@app.route("/api/", defaults={"endpoint": ""}, methods=["GET", "POST"])
@app.route("/api/<path:endpoint>", methods=["GET", "POST"])
def relay(endpoint):
    return gitlab_proxy.relay(CONFIG["gitlabUrl"] + "/api/v4/", body)


@app.get("/config")
def public_config():
    return jsonify(CONFIG)


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/synctex")
def synctex():
    status, result = artifact_store.synctex_query(json.loads(body()))
    return jsonify(result), status


@app.post("/compile")
def compile_route():
    status, result = compiler.compile(json.loads(body()))
    return jsonify(result), status


@app.post("/compile/cancel")
def cancel_compile():
    status, result = compiler.cancel(json.loads(body()))
    return jsonify(result), status


@app.get("/")
@app.get("/index.html")
def index():
    g.style_nonce = secrets.token_urlsafe(32)
    data = (
        (ROOT / "index.html")
        .read_bytes()
        .replace(b"__STYLE_NONCE__", g.style_nonce.encode("ascii"))
    )
    return Response(data, content_type="text/html; charset=utf-8")


@app.get("/<path:path>")
def static_asset(path):
    return send_from_directory(ROOT, path)


def main():
    threading.Thread(target=artifact_store.janitor, daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    app.logger.info(
        "server_start host=%s port=%s gitlab=%s log_level=%s max_concurrent_builds=%s",
        safe_log_value(host),
        port,
        CONFIG["gitlabUrl"],
        CONFIG["logLevel"],
        CONFIG["maxConcurrentBuilds"],
    )
    serve(
        app,
        host=host,
        port=port,
        threads=8,
        connection_limit=100,
        backlog=100,
        channel_timeout=180,
        cleanup_interval=10,
        max_request_body_size=CONFIG["limits"]["requestBytes"],
        max_request_header_size=64 * 1024,
        expose_tracebacks=False,
        clear_untrusted_proxy_headers=True,
    )


if __name__ == "__main__":
    main()
