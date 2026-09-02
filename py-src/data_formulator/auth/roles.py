"""Who may configure which models the server will call.

Model configuration is an operator decision, not a user preference: an
``api_base`` is an outbound destination and an ``api_key`` is a credential the
server spends on everyone's behalf. So the answer to "which endpoints exist"
comes from the environment (:mod:`data_formulator.model_registry`), and only an
administrator may reach the routes that probe or test an endpoint. Everyone
else picks from the models already loaded.

Who counts as an administrator depends on how the deployment authenticates:

* **Local accounts** (``AUTH_PROVIDER=local``) — the ``admin`` role on the
  signed-in account, which is where roles already live.
* **Single-user localhost** — the person at the keyboard owns the machine and
  the environment file, so they are the administrator.
* **SSO / anonymous** — nobody, unless ``DF_ADMIN_USERS`` names them. There is
  no role to read from an OIDC token by default, and silently promoting every
  signed-in user would hand a shared deployment's outbound calls to anyone.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_ADMIN_USERS_ENV = "DF_ADMIN_USERS"


def _named_admins() -> set[str]:
    """Usernames from ``DF_ADMIN_USERS``, lowercased for comparison."""
    raw = os.environ.get(_ADMIN_USERS_ENV, "")
    return {name.strip().lower() for name in raw.split(",") if name.strip()}


def _current_local_user():
    """The signed-in local account, or ``None`` when that provider is not in use."""
    try:
        from flask import session

        from data_formulator.auth.local_users import get_user_store
        from data_formulator.auth.providers.local_password import (
            PROVIDER_NAME,
            SESSION_KEY,
        )
    except ImportError:
        return None

    user_data = session.get(SESSION_KEY)
    if not user_data or user_data.get("provider") != PROVIDER_NAME:
        return None
    username = user_data.get("user_id")
    if not username:
        return None
    return get_user_store().get(username)


def is_admin() -> bool:
    """Whether the current request may configure models.

    Safe to call outside a request context and on a server with no accounts:
    every lookup that could fail is treated as "not an administrator", so a
    misconfiguration closes the door rather than opening it.
    """
    try:
        user = _current_local_user()
    except Exception:
        logger.warning("Could not read the local account for the admin check",
                       exc_info=True)
        user = None

    if user is not None:
        if user.is_admin:
            return True
        # A named admin still wins: it is how an operator grants access when
        # the account store is not the source of truth for roles.
        return user.username.strip().lower() in _named_admins()

    named = _named_admins()
    if named:
        try:
            from data_formulator.auth.identity import get_identity_id

            identity = get_identity_id() or ""
        except Exception:
            identity = ""
        # Identities are namespaced ("user:alice", "local:GT"); operators name
        # the account, not the namespace.
        _, _, value = identity.partition(":")
        if value.strip().lower() in named:
            return True

    try:
        from data_formulator.auth.identity import is_local_mode

        # Single-user localhost: the app, the environment file and the browser
        # all belong to the same person.
        return is_local_mode()
    except Exception:
        return False


def require_admin(action: str = "configure models") -> None:
    """Raise ``ACCESS_DENIED`` unless the current request is an administrator."""
    if is_admin():
        return
    from data_formulator.errors import AppError, ErrorCode

    raise AppError(
        ErrorCode.ACCESS_DENIED,
        f"Only an administrator can {action}. Pick one of the models your "
        f"administrator has already configured.",
    )
