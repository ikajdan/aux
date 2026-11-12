# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

from flask import Response, jsonify, request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a PAT across redirects.


def relay(upstream, read_body):
    # Preserve URL escaping, including encoded slashes in GitLab project IDs.
    raw_uri = request.environ.get("REQUEST_URI", request.environ.get("RAW_URI"))
    if raw_uri is None:
        return jsonify(error="Raw request URI unavailable"), 400
    endpoint = raw_uri[len("/api/") :]
    decoded = urllib.parse.unquote(endpoint.split("?")[0])
    if (
        not (
            decoded.startswith(("projects/", "groups/"))
            or (endpoint == "user" and request.method == "GET")
            or (
                request.method == "GET"
                and (
                    (decoded == "users" and request.args.get("username"))
                    or re.fullmatch(r"users/[1-9][0-9]*/projects", decoded)
                )
            )
        )
        or any(p in (".", "..", "") for p in decoded.split("/"))
        or "\\" in decoded
        or "#" in endpoint
    ):
        return jsonify(error="Disallowed API path"), 400
    token = request.headers.get("PRIVATE-TOKEN", "")
    if not token:
        return jsonify(error="PAT required"), 401
    upstream_request = urllib.request.Request(
        upstream + endpoint,
        data=read_body() if request.method == "POST" else None,
        method=request.method,
        headers={"PRIVATE-TOKEN": token, "Content-Type": "application/json"},
    )
    context = ssl.create_default_context(
        cafile=os.environ.get("GITLAB_CA_FILE") or None
    )
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=context)
    )
    try:
        response = opener.open(upstream_request, timeout=100)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            return jsonify(error="Upstream response too large"), 502
        return Response(data, status=response.code, content_type="application/json")
