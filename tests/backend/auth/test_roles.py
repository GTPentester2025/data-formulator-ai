"""Tests for who may configure the models this server calls.

The rule is deliberately conservative: an ``api_base`` is an outbound
destination and an ``api_key`` is a credential the server spends on everyone's
behalf, so anything that is not an administrator falls back to "no". These
tests pin the fallback down, because a helper that opened up on a
misconfiguration would hand a shared deployment's outbound access to any
signed-in user.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from data_formulator.auth import roles
from data_formulator.errors import AppError, ErrorCode

pytestmark = [pytest.mark.backend]


def _no_local_account():
    return patch.object(roles, "_current_local_user", return_value=None)


def _local_account(username: str, is_admin: bool):
    user = type("User", (), {"username": username, "is_admin": is_admin})()
    return patch.object(roles, "_current_local_user", return_value=user)


class TestIsAdmin:

    def test_local_admin_account_is_an_admin(self, monkeypatch):
        monkeypatch.delenv("DF_ADMIN_USERS", raising=False)
        with _local_account("root", is_admin=True):
            assert roles.is_admin() is True

    def test_local_ordinary_account_is_not(self, monkeypatch):
        monkeypatch.delenv("DF_ADMIN_USERS", raising=False)
        with _local_account("alice", is_admin=False):
            assert roles.is_admin() is False

    def test_named_admin_overrides_the_account_role(self, monkeypatch):
        """DF_ADMIN_USERS is how an operator grants access when the account
        store is not where roles are decided."""
        monkeypatch.setenv("DF_ADMIN_USERS", "alice, bob")
        with _local_account("ALICE", is_admin=False):
            assert roles.is_admin() is True

    def test_single_user_localhost_is_an_admin(self, monkeypatch):
        """The app, the environment file and the browser belong to one person."""
        monkeypatch.delenv("DF_ADMIN_USERS", raising=False)
        with _no_local_account(), \
                patch("data_formulator.auth.identity.is_local_mode", return_value=True):
            assert roles.is_admin() is True

    def test_shared_server_without_named_admins_grants_nobody(self, monkeypatch):
        """No role to read from an SSO token, and promoting every signed-in user
        would defeat the point of the restriction."""
        monkeypatch.delenv("DF_ADMIN_USERS", raising=False)
        with _no_local_account(), \
                patch("data_formulator.auth.identity.is_local_mode", return_value=False):
            assert roles.is_admin() is False

    def test_sso_identity_can_be_named(self, monkeypatch):
        """Identities are namespaced ("user:alice"); operators name the account."""
        monkeypatch.setenv("DF_ADMIN_USERS", "alice")
        with _no_local_account(), \
                patch("data_formulator.auth.identity.get_identity_id",
                      return_value="user:Alice"), \
                patch("data_formulator.auth.identity.is_local_mode", return_value=False):
            assert roles.is_admin() is True

    def test_unnamed_sso_identity_is_not_an_admin(self, monkeypatch):
        monkeypatch.setenv("DF_ADMIN_USERS", "alice")
        with _no_local_account(), \
                patch("data_formulator.auth.identity.get_identity_id",
                      return_value="user:mallory"), \
                patch("data_formulator.auth.identity.is_local_mode", return_value=False):
            assert roles.is_admin() is False

    def test_a_broken_account_lookup_closes_the_door(self, monkeypatch):
        """A misconfiguration must not read as a promotion."""
        monkeypatch.delenv("DF_ADMIN_USERS", raising=False)
        with patch.object(roles, "_current_local_user",
                          side_effect=RuntimeError("account store unavailable")), \
                patch("data_formulator.auth.identity.is_local_mode", return_value=False):
            assert roles.is_admin() is False


class TestRequireAdmin:

    def test_passes_for_an_admin(self):
        with patch.object(roles, "is_admin", return_value=True):
            roles.require_admin()  # does not raise

    def test_raises_access_denied_otherwise(self):
        with patch.object(roles, "is_admin", return_value=False):
            with pytest.raises(AppError) as exc:
                roles.require_admin("test a model configuration")

        assert exc.value.code == ErrorCode.ACCESS_DENIED
        assert exc.value.get_http_status() == 403
        assert "test a model configuration" in str(exc.value)
