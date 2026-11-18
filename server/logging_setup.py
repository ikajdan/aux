# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import sys
import time

from flask import g, has_request_context


def safe_log_value(value):
    return "".join(c if c.isprintable() else "?" for c in str(value))[:2048]


class RequestContextFilter(logging.Filter):
    def filter(self, record):
        record.request_id = (
            getattr(g, "request_id", "-") if has_request_context() else "-"
        )
        return True


def configure_logging(level):
    root = logging.getLogger()
    root.setLevel(level)
    handler = next(
        (item for item in root.handlers if item.get_name() == "aux.stdout"), None
    )
    if handler is None:
        handler = logging.StreamHandler(sys.stdout)
        handler.set_name("aux.stdout")
        handler.addFilter(RequestContextFilter())
        root.addHandler(handler)
    formatter = logging.Formatter(
        "%(asctime)sZ %(levelname)s %(name)s request_id=%(request_id)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    # Avoid duplicate/raw access logs; Aux logs requests without query strings.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    logging.getLogger("waitress").setLevel(logging.WARNING)
