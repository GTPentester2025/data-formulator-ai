"""Local user accounts: storage, password hashing, and admin operations.

A small SQLite table next to the credential vault holds one row per account.
Passwords are stored as salted scrypt hashes — scrypt ships with CPython, so
this adds no dependency and still resists offline cracking far better than a
plain digest.

Roles are deliberately minimal: ``admin`` may manage accounts, ``user`` may
not. Neither can read another account's data — isolation comes from the
per-identity workspace paths, not from a role check.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Matches the identity charset in auth/identity.py, minus ':' and '|' which
# separate the namespace prefix, so a username can never forge one.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@+\-]{3,64}$")

MIN_PASSWORD_LENGTH = 8

ROLE_ADMIN = "admin"
ROLE_USER = "user"

# scrypt parameters: ~100ms per hash on a normal machine, 16 MB of memory.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SALT_BYTES = 16


class UserError(Exception):
    """Raised for user-facing account problems (bad input, duplicates)."""


@dataclass(frozen=True)
class User:
    username: str
    role: str
    created_at: str
    last_login_at: Optional[str]
    must_change_password: bool

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    def to_dict(self) -> dict:
        return {
            "username": self.username,
            "role": self.role,
            "created_at": self.created_at,
            "last_login_at": self.last_login_at,
            "must_change_password": self.must_change_password,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password: str) -> str:
    """Return ``scrypt$<n>$<r>$<p>$<salt_hex>$<hash_hex>``."""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN,
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of *password* against a stored hash."""
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        computed = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(digest_hex)),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(computed.hex(), digest_hex)


def validate_username(username: str) -> str:
    username = (username or "").strip().lower()
    if not USERNAME_RE.match(username):
        raise UserError(
            "Usernames must be 3-64 characters, using letters, digits, "
            "and . _ @ + - only"
        )
    return username


def validate_password(password: str) -> str:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise UserError(f"Passwords must be at least {MIN_PASSWORD_LENGTH} characters")
    return password


class LocalUserStore:
    """SQLite-backed account store. Safe for concurrent Flask threads."""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',
                    created_at TEXT NOT NULL,
                    last_login_at TEXT,
                    must_change_password INTEGER NOT NULL DEFAULT 0
                )
                """
            )

    # --- queries -------------------------------------------------------

    def _row_to_user(self, row: sqlite3.Row) -> User:
        return User(
            username=row["username"],
            role=row["role"],
            created_at=row["created_at"],
            last_login_at=row["last_login_at"],
            must_change_password=bool(row["must_change_password"]),
        )

    def get(self, username: str) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username = ?", (username.lower(),),
            ).fetchone()
        return self._row_to_user(row) if row else None

    def list_users(self) -> list[User]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM users ORDER BY username").fetchall()
        return [self._row_to_user(r) for r in rows]

    def count(self) -> int:
        with self._connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def admin_count(self) -> int:
        with self._connect() as conn:
            return int(conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = ?", (ROLE_ADMIN,),
            ).fetchone()[0])

    # --- mutations -----------------------------------------------------

    def create(self, username: str, password: str, role: str = ROLE_USER,
               must_change_password: bool = False) -> User:
        username = validate_username(username)
        validate_password(password)
        if role not in (ROLE_ADMIN, ROLE_USER):
            raise UserError(f"Unknown role '{role}'")

        with self._lock, self._connect() as conn:
            existing = conn.execute(
                "SELECT 1 FROM users WHERE username = ?", (username,),
            ).fetchone()
            if existing:
                raise UserError(f"User '{username}' already exists")
            conn.execute(
                "INSERT INTO users (username, password_hash, role, created_at, "
                "must_change_password) VALUES (?, ?, ?, ?, ?)",
                (username, hash_password(password), role, _now(),
                 1 if must_change_password else 0),
            )
        logger.info("Created %s account '%s'", role, username)
        return self.get(username)      # type: ignore[return-value]

    def set_password(self, username: str, password: str,
                     must_change_password: bool = False) -> None:
        validate_password(password)
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ?, must_change_password = ? "
                "WHERE username = ?",
                (hash_password(password), 1 if must_change_password else 0,
                 username.lower()),
            )
            if cursor.rowcount == 0:
                raise UserError(f"User '{username}' not found")
        logger.info("Password changed for '%s'", username.lower())

    def set_role(self, username: str, role: str) -> None:
        if role not in (ROLE_ADMIN, ROLE_USER):
            raise UserError(f"Unknown role '{role}'")
        username = username.lower()
        with self._lock, self._connect() as conn:
            current = conn.execute(
                "SELECT role FROM users WHERE username = ?", (username,),
            ).fetchone()
            if current is None:
                raise UserError(f"User '{username}' not found")
            # Refuse to remove the last admin, which would lock everyone out
            # of account management with no way back in.
            if current["role"] == ROLE_ADMIN and role != ROLE_ADMIN:
                admins = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = ?", (ROLE_ADMIN,),
                ).fetchone()[0]
                if admins <= 1:
                    raise UserError("Cannot demote the only administrator")
            conn.execute(
                "UPDATE users SET role = ? WHERE username = ?", (role, username),
            )

    def delete(self, username: str) -> None:
        username = username.lower()
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT role FROM users WHERE username = ?", (username,),
            ).fetchone()
            if row is None:
                raise UserError(f"User '{username}' not found")
            if row["role"] == ROLE_ADMIN:
                admins = conn.execute(
                    "SELECT COUNT(*) FROM users WHERE role = ?", (ROLE_ADMIN,),
                ).fetchone()[0]
                if admins <= 1:
                    raise UserError("Cannot delete the only administrator")
            conn.execute("DELETE FROM users WHERE username = ?", (username,))
        logger.info("Deleted account '%s'", username)

    def authenticate(self, username: str, password: str) -> Optional[User]:
        """Return the user when the password matches, else ``None``.

        Runs the hash even for unknown usernames so a missing account and a
        wrong password take the same time to answer.
        """
        username = (username or "").strip().lower()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username = ?", (username,),
            ).fetchone()

        if row is None:
            verify_password(password or "", hash_password("dummy-password"))
            return None
        if not verify_password(password or "", row["password_hash"]):
            return None

        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ? WHERE username = ?",
                (_now(), username),
            )
        return self._row_to_user(row)


_store: Optional[LocalUserStore] = None
_store_lock = threading.Lock()


def get_user_store() -> LocalUserStore:
    """Process-wide account store, created on first use."""
    global _store
    with _store_lock:
        if _store is None:
            from data_formulator.datalake.workspace import get_data_formulator_home
            _store = LocalUserStore(Path(get_data_formulator_home()) / "users.db")
        return _store


def reset_user_store_for_tests(store: Optional[LocalUserStore] = None) -> None:
    global _store
    with _store_lock:
        _store = store


def ensure_bootstrap_admin() -> Optional[str]:
    """Make sure an administrator exists, so a fresh install is usable.

    Uses ``DF_ADMIN_USERNAME`` / ``DF_ADMIN_PASSWORD`` when supplied. With no
    password configured, one is generated and returned for the caller to log —
    it is the only time it can be read, and it must be changed on first login.
    Returns the generated password, or ``None`` when nothing was created.
    """
    store = get_user_store()
    if store.admin_count() > 0:
        return None

    username = (os.environ.get("DF_ADMIN_USERNAME") or "admin").strip().lower()
    configured = os.environ.get("DF_ADMIN_PASSWORD")
    password = configured or secrets.token_urlsafe(12)

    try:
        store.create(username, password, role=ROLE_ADMIN,
                     must_change_password=not configured)
    except UserError as e:
        logger.error("Could not create the bootstrap administrator: %s", e)
        return None

    return None if configured else password
