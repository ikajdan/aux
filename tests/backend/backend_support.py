# SPDX-FileCopyrightText: Ignacy Kajdan <ignacy.kajdan@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import (
    artifacts as artifacts,
)
from server import (
    compilation as compilation,
)
from server import (
    configuration as configuration,
)
from server import (
    gitlab_proxy as gitlab_proxy,
)
from server import (
    process_limits as process_limits,
)
from server import (
    server as server,
)
from server import (
    validation as validation,
)
