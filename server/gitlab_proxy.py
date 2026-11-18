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
        return None  # The relay validates canonical project aliases explicitly.


def canonical_project_redirect(upstream, source_url, location):
    if not location or any(ord(c) <= 32 or ord(c) == 127 for c in location):
        return None
    try:
        base = urllib.parse.urlsplit(upstream)
        source = urllib.parse.urlsplit(source_url)
        target = urllib.parse.urlsplit(urllib.parse.urljoin(source_url, location))
        if (
            target.scheme != base.scheme
            or target.netloc.lower() != base.netloc.lower()
            or target.username is not None
            or target.password is not None
            or target.fragment
        ):
            return None
        prefix = base.path + "projects/"
        if not source.path.startswith(prefix) or not target.path.startswith(prefix):
            return None
        source_project, _, source_operation = source.path[len(prefix) :].partition("/")
        target_project, _, target_operation = target.path[len(prefix) :].partition("/")
        if (
            not source_project
            or not re.fullmatch(r"[1-9][0-9]*", target_project)
            or target_operation != source_operation
        ):
            return None
        if target.query and sorted(
            urllib.parse.parse_qsl(target.query, keep_blank_values=True)
        ) != sorted(urllib.parse.parse_qsl(source.query, keep_blank_values=True)):
            return None
        # GitLab can omit the query in Location; keep the pinned ref and pagination.
        return urllib.parse.urlunsplit(target._replace(query=source.query))
    except ValueError:
        return None


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
            or (decoded == "projects" and request.method == "POST")
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
    for attempt in range(3):
        try:
            response = opener.open(upstream_request, timeout=100)
        except urllib.error.HTTPError as error:
            response = error
        target = None
        if request.method == "GET" and response.code in (301, 302, 303, 307, 308):
            target = canonical_project_redirect(
                upstream,
                upstream_request.full_url,
                response.headers.get("Location", ""),
            )
        if target is None or target == upstream_request.full_url or attempt == 2:
            break
        response.close()
        upstream_request = urllib.request.Request(
            target,
            method="GET",
            headers={"PRIVATE-TOKEN": token, "Content-Type": "application/json"},
        )
    with response:
        data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            return jsonify(error="Upstream response too large"), 502
        return Response(data, status=response.code, content_type="application/json")
