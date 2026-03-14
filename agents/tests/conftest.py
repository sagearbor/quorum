"""Pytest configuration for agents/tests.

Sets up sys.modules stubs needed for test_model_detection.py, which imports
apps.api.agent_engine directly.  The apps/ directory lacks __init__.py so
Python cannot import it as a package.  We register a namespace-package-style
entry so the import resolves correctly.
"""

from __future__ import annotations

import importlib
import importlib.util
import pathlib
import sys
import types

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent


def _ensure_namespace(dotted_name: str) -> types.ModuleType:
    """Ensure that `dotted_name` exists in sys.modules as a namespace package.

    If the module is already present (e.g., from a real install), this is a
    no-op.  Otherwise a fresh ModuleType is registered so that attribute
    lookups like `apps.api` succeed.
    """
    parts = dotted_name.split(".")
    for i in range(1, len(parts) + 1):
        partial = ".".join(parts[:i])
        if partial not in sys.modules:
            mod = types.ModuleType(partial)
            # Set __path__ so Python treats it as a package
            path_candidate = _REPO_ROOT
            for part in parts[:i]:
                path_candidate = path_candidate / part
            if path_candidate.is_dir():
                mod.__path__ = [str(path_candidate)]  # type: ignore[attr-defined]
                mod.__package__ = partial
            sys.modules[partial] = mod
        else:
            mod = sys.modules[partial]

        # Wire as attribute on parent
        if i > 1:
            parent_name = ".".join(parts[:i - 1])
            parent = sys.modules.get(parent_name)
            if parent is not None:
                setattr(parent, parts[i - 1], mod)

    return sys.modules[dotted_name]


# Register apps and apps.api as namespace packages so direct imports work
_ensure_namespace("apps")
_ensure_namespace("apps.api")
