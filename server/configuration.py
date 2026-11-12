# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import os
import re
import urllib.parse
from pathlib import Path

from .validation import safe_path

DEFAULT_LIMITS = {
    "requestBytes": 41943040,
    "snapshotBytes": 31457280,
    "snapshotFiles": 5000,
    "snapshotEntries": 10000,
    "submoduleDepth": 8,
}


def load_config(path=None):
    path = Path(
        path
        if path is not None
        else os.environ.get(
            "AUX_CONFIG_FILE", Path(__file__).resolve().with_name("config.json")
        )
    )
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(config, dict)
            or "gitlabUrl" not in config
            or len({"repositoryGroup", "repositoryGroups"} & set(config)) != 1
            or set(config)
            - {
                "gitlabUrl",
                "repositoryGroup",
                "repositoryGroups",
                "limits",
                "maxConcurrentBuilds",
                "mainDocument",
            }
        ):
            raise ValueError(
                "expected gitlabUrl, exactly one of repositoryGroups or legacy repositoryGroup, and optional limits, maxConcurrentBuilds, and mainDocument"
            )
        url = config["gitlabUrl"]
        if (
            not isinstance(url, str)
            or not url
            or any(c.isspace() or ord(c) < 32 for c in url)
        ):
            raise ValueError("gitlabUrl must be an HTTP(S) URL")
        parsed = urllib.parse.urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or "?" in url
            or "#" in url
            or "\\" in url
        ):
            raise ValueError(
                "gitlabUrl requires HTTP(S), a host, and no credentials, query or fragment"
            )
        parsed.port  # Validate the port before accepting the URL.
        groups = config.get("repositoryGroups")
        legacy = "repositoryGroup" in config
        if legacy:
            group = config.pop("repositoryGroup")
            groups = [{"name": group, "path": group}]
        if not isinstance(groups, list) or not groups:
            raise ValueError("repositoryGroups must be a nonempty array")
        paths = set()
        for index, group in enumerate(groups):
            field = f"repositoryGroups[{index}]"
            if not isinstance(group, dict) or set(group) != {"name", "path"}:
                raise ValueError(f"{field} requires exactly name and path")
            name, group_path = group["name"], group["path"]
            if (
                not isinstance(name, str)
                or not name.strip()
                or name != name.strip()
                or len(name) > 80
            ):
                raise ValueError(f"{field}.name must be 1–80 trimmed characters")
            if not isinstance(group_path, str) or not re.fullmatch(
                r"[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*",
                group_path,
            ):
                raise ValueError(
                    f"{field}.path must be a nonempty slash-separated group path"
                )
            if group_path in paths:
                raise ValueError("repositoryGroups paths must be unique")
            paths.add(group_path)

        max_concurrent_builds = config.get("maxConcurrentBuilds", 6)
        if (
            type(max_concurrent_builds) is not int
            or not 1 <= max_concurrent_builds <= 9007199254740991
        ):
            raise ValueError("maxConcurrentBuilds must be a safe integer >= 1")

        main_document = config.get("mainDocument", "main.tex")
        try:
            main_path = safe_path(main_document)
            if (
                main_path.suffix != ".tex"
                or main_path.parts[0] == "aux-output"
                or ":" in main_document
                or any(ord(c) < 32 or ord(c) == 127 for c in main_document)
            ):
                raise ValueError("Unsafe main document")
        except ValueError as error:
            raise ValueError(
                "mainDocument must be a safe project-relative .tex file path"
            ) from error

        configured_limits = config.get("limits", {})
        if not isinstance(configured_limits, dict) or set(configured_limits) - set(
            DEFAULT_LIMITS
        ):
            raise ValueError("limits must contain only supported limit keys")
        effective_limits = {**DEFAULT_LIMITS, **configured_limits}
        for key, value in effective_limits.items():
            minimum = 0 if key == "submoduleDepth" else 1
            if type(value) is not int or not minimum <= value <= 9007199254740991:
                raise ValueError(f"limits.{key} must be a safe integer >= {minimum}")

        return {
            **config,
            "gitlabUrl": url.rstrip("/"),
            "repositoryGroups": groups,
            "limits": effective_limits,
            "maxConcurrentBuilds": max_concurrent_builds,
            "mainDocument": main_document,
        }
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError(f"Invalid Aux config {path}: {error}") from error
