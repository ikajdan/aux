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


def merge_config(base, overrides):
    merged = {**base}
    for key, value in overrides.items():
        if isinstance(merged.get(key), dict) and isinstance(value, dict):
            merged[key] = merge_config(merged[key], value)
        else:
            merged[key] = value
    return merged


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
        local_path = path.with_name(f"{path.stem}.local{path.suffix}")
        try:
            local_text = local_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            local_text = None
        except (OSError, UnicodeError) as error:
            raise ValueError(
                f"Could not read local config {local_path}: {error}"
            ) from error
        if local_text is not None:
            try:
                overrides = json.loads(local_text)
                if not isinstance(config, dict) or not isinstance(overrides, dict):
                    raise ValueError("base and local configs must be JSON objects")
                config = merge_config(config, overrides)
            except ValueError as error:
                raise ValueError(
                    f"Invalid local config {local_path}: {error}"
                ) from error
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
                "logLevel",
                "mainDocument",
                "templateRepository",
            }
        ):
            raise ValueError(
                "expected gitlabUrl, exactly one of repositoryGroups or legacy repositoryGroup, and optional limits, maxConcurrentBuilds, logLevel, mainDocument, and templateRepository"
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
        if not isinstance(groups, list):
            raise ValueError("repositoryGroups must be an array")
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

        template_repository = config.get("templateRepository", "")
        if not isinstance(template_repository, str) or (
            template_repository
            and not re.fullmatch(
                r"[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)+",
                template_repository,
            )
        ):
            raise ValueError(
                "templateRepository must be empty or a safe GitLab namespace/project path"
            )

        log_level = config.get("logLevel", "INFO")
        if not isinstance(log_level, str) or log_level.upper() not in {
            "DEBUG",
            "INFO",
            "WARNING",
            "ERROR",
            "CRITICAL",
        }:
            raise ValueError(
                "logLevel must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL"
            )
        log_level = log_level.upper()

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
            "logLevel": log_level,
            "mainDocument": main_document,
            "templateRepository": template_repository,
        }
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError(f"Invalid Aux config {path}: {error}") from error
