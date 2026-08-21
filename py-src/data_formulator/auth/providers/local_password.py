"""Built-in username / password authentication.

Accounts live in this application's own SQLite store (see
``auth/local_users.py``); an administrator creates them and can reset
passwords. Like the GitHub provider this is stateful: the gateway blueprint
verifies the password and writes the result into the Flask session, and this
provider reads that session back on every request.

Enable with::

    AUTH_PROVIDER=local
    ALLOW_ANONYMOUS=false
    FLASK_SECRET_KEY=<a stable random value>

``FLASK_SECRET_KEY`` matters here: without it Flask generates a new signing
key each start and every login is invalidated on restart.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from flask import Request, session

from .base import AuthProvider, AuthResult

logger = logging.getLogger(__name__)

PROVIDER_NAME = "local"
SESSION_KEY = "df_user"


class LocalPasswordProvider(AuthProvider):

    def __init__(self) -> None:
        # Deliberately does no I/O: providers are instantiated at import time
        # purely so their name can be read.
        self._label = os.environ.get("AUTH_DISPLAY_NAME", "Sign in")

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    @property
    def enabled(self) -> bool:
        return True

    def get_auth_info(self) -> dict:
        # "form" tells the frontend to collect a username and password and
        # POST them to login_url, rather than redirect to an external IdP.
        return {
            "action": "form",
            "label": self._label,
            "login_url": "/api/auth/local/login",
            "logout_url": "/api/auth/local/logout",
            "status_url": "/api/auth/local/status",
        }

    def authenticate(self, request: Request) -> Optional[AuthResult]:
        user_data = session.get(SESSION_KEY)
        if not user_data or user_data.get("provider") != PROVIDER_NAME:
            return None

        return AuthResult(
            user_id=user_data["user_id"],
            display_name=user_data.get("display_name"),
            email=user_data.get("email"),
        )
