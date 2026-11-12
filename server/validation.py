# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from pathlib import PurePosixPath


def safe_path(value):
    if (
        not isinstance(value, str)
        or not value
        or value.startswith("/")
        or "\\" in value
        or "\0" in value
    ):
        raise ValueError("Unsafe path")
    if any(p in ("", ".", "..") or p.lower() == ".git" for p in value.split("/")):
        raise ValueError("Unsafe path")
    return PurePosixPath(value)


def build_id(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid compilation request: expected an object")
    value = data.get("buildId")
    if not isinstance(value, str):
        raise ValueError("buildId must be a UUID")
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise ValueError("buildId must be a UUID") from None
