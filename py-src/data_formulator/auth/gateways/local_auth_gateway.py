"""Login, logout, and account administration for the local password provider.

Two groups of routes:

* session routes anyone may call — ``login``, ``logout``, ``status``, and
  ``change-password`` for the signed-in account;
* administration routes gated by :func:`_require_admin` — listing, creating
  and deleting accounts, and resetting other people's passwords.

An administrator manages *accounts*; they cannot read another account's data.
Isolation comes from per-identity workspace storage, not from a role check,
so there is deliberately no "view as user" route here.
"""

from __future__ import annotations

import logging
import time

from flask import Blueprint, request, session

from data_formulator.auth.local_users import (
    ROLE_ADMIN,
    ROLE_USER,
    LocalUserStore,
    UserError,
    get_user_store,
)
from data_formulator.auth.providers.local_password import PROVIDER_NAME, SESSION_KEY
from data_formulator.errors import AppError, ErrorCode
from data_formulator.error_handler import json_ok

logger = logging.getLogger(__name__)

local_auth_bp = Blueprint("local_auth", __name__, url_prefix="/api/auth/local")

# Failed-login throttle: per username+IP, in memory. Enough to blunt online
# guessing without adding storage; a restart clears it.
_FAILURES: dict[str, list[float]] = {}
_FAILURE_WINDOW_SECONDS = 300
_MAX_FAILURES = 10


def _throttle_key() -> str:
    username = (request.get_json(silent=True) or {}).get("username", "")
    return f"{str(username).lower()}|{request.remote_addr or '-'}"


def _check_not_throttled(key: str) -> None:
    now = time.time()
    recent = [t for t in _FAILURES.get(key, []) if now - t < _FAILURE_WINDOW_SECONDS]
    _FAILURES[key] = recent
    if len(recent) >= _MAX_FAILURES:
        raise AppError(
            ErrorCode.ACCESS_DENIED,
            "Too many failed sign-in attempts. Try again in a few minutes.",
        )


def _record_failure(key: str) -> None:
    _FAILURES.setdefault(key, []).append(time.time())
    # Keep the map from growing without bound on a long-lived server.
    if len(_FAILURES) > 5000:
        now = time.time()
        for k in list(_FAILURES):
            if not any(now - t < _FAILURE_WINDOW_SECONDS for t in _FAILURES[k]):
                _FAILURES.pop(k, None)


def _store() -> LocalUserStore:
    return get_user_store()


def _current_username() -> str | None:
    user_data = session.get(SESSION_KEY)
    if not user_data or user_data.get("provider") != PROVIDER_NAME:
        return None
    return user_data.get("user_id")


def _require_login() -> str:
    username = _current_username()
    if not username:
        raise AppError(ErrorCode.AUTH_REQUIRED, "Sign in to continue")
    return username


def _require_admin() -> str:
    username = _require_login()
    user = _store().get(username)
    if user is None or not user.is_admin:
        raise AppError(ErrorCode.ACCESS_DENIED, "Administrator access required")
    return username


def _session_payload(user) -> dict:
    return {
        "provider": PROVIDER_NAME,
        "user_id": user.username,
        "display_name": user.username,
        "email": None,
    }


@local_auth_bp.route("/status", methods=["GET"])
def status():
    """Report whether this browser is signed in, and as whom."""
    username = _current_username()
    if not username:
        return json_ok({"authenticated": False})

    user = _store().get(username)
    if user is None:
        # The account was deleted while its session was still alive.
        session.pop(SESSION_KEY, None)
        return json_ok({"authenticated": False})

    return json_ok({"authenticated": True, "user": user.to_dict()})


@local_auth_bp.route("/login", methods=["POST"])
def login():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")

    key = _throttle_key()
    _check_not_throttled(key)

    user = _store().authenticate(username, password)
    if user is None:
        _record_failure(key)
        logger.info("Failed sign-in for '%s' from %s", username.lower(), request.remote_addr)
        # Identical message whether the account is unknown or the password is
        # wrong, so the response cannot be used to enumerate accounts.
        raise AppError(ErrorCode.AUTH_REQUIRED, "Incorrect username or password")

    _FAILURES.pop(key, None)
    session.permanent = True
    session[SESSION_KEY] = _session_payload(user)
    logger.info("Signed in: %s", user.username)
    return json_ok({"authenticated": True, "user": user.to_dict()})


@local_auth_bp.route("/logout", methods=["POST"])
def logout():
    session.pop(SESSION_KEY, None)
    session.clear()
    return json_ok({"authenticated": False})


@local_auth_bp.route("/change-password", methods=["POST"])
def change_password():
    """Change the signed-in account's own password."""
    username = _require_login()
    payload = request.get_json(silent=True) or {}
    current_password = str(payload.get("current_password") or "")
    new_password = str(payload.get("new_password") or "")

    if _store().authenticate(username, current_password) is None:
        raise AppError(ErrorCode.ACCESS_DENIED, "Current password is incorrect")

    try:
        _store().set_password(username, new_password, must_change_password=False)
    except UserError as e:
        raise AppError(ErrorCode.INVALID_REQUEST, str(e)) from e

    user = _store().get(username)
    session[SESSION_KEY] = _session_payload(user)
    return json_ok({"user": user.to_dict()})


# --- administration ----------------------------------------------------

@local_auth_bp.route("/users", methods=["GET"])
def list_users():
    _require_admin()
    return json_ok({"users": [u.to_dict() for u in _store().list_users()]})


@local_auth_bp.route("/users", methods=["POST"])
def create_user():
    _require_admin()
    payload = request.get_json(silent=True) or {}
    try:
        user = _store().create(
            username=str(payload.get("username") or ""),
            password=str(payload.get("password") or ""),
            role=str(payload.get("role") or ROLE_USER),
            # A password the admin typed is known to someone else, so the
            # account owner is asked to replace it at first sign-in.
            must_change_password=bool(payload.get("must_change_password", True)),
        )
    except UserError as e:
        raise AppError(ErrorCode.INVALID_REQUEST, str(e)) from e
    return json_ok({"user": user.to_dict()})


@local_auth_bp.route("/users/<username>/password", methods=["POST"])
def reset_password(username: str):
    _require_admin()
    payload = request.get_json(silent=True) or {}
    try:
        _store().set_password(
            username,
            str(payload.get("password") or ""),
            must_change_password=bool(payload.get("must_change_password", True)),
        )
    except UserError as e:
        raise AppError(ErrorCode.INVALID_REQUEST, str(e)) from e
    return json_ok({"username": username.lower()})


@local_auth_bp.route("/users/<username>/role", methods=["POST"])
def set_role(username: str):
    _require_admin()
    payload = request.get_json(silent=True) or {}
    role = str(payload.get("role") or ROLE_USER)
    try:
        _store().set_role(username, role)
    except UserError as e:
        raise AppError(ErrorCode.INVALID_REQUEST, str(e)) from e
    return json_ok({"username": username.lower(), "role": role})


@local_auth_bp.route("/users/<username>", methods=["DELETE"])
def delete_user(username: str):
    admin = _require_admin()
    if username.lower() == admin.lower():
        raise AppError(ErrorCode.INVALID_REQUEST, "You cannot delete your own account")

    try:
        _store().delete(username)
    except UserError as e:
        raise AppError(ErrorCode.INVALID_REQUEST, str(e)) from e

    # Remove the account's stored data as well: leaving it behind would keep
    # files on disk that nobody can sign in to reach.
    _purge_user_data(username.lower())
    return json_ok({"username": username.lower()})


def _purge_user_data(username: str) -> None:
    import shutil

    from data_formulator.datalake.workspace import get_user_home

    for identity in (f"user:{username}",):
        try:
            home = get_user_home(identity)
            if home.exists():
                shutil.rmtree(home, ignore_errors=True)
                logger.info("Purged stored data for %s", identity)
        except Exception:
            logger.exception("Could not purge data for %s", identity)
