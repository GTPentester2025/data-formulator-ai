"""Login, session, and account-administration routes.

These tests exercise the boundary that matters on a shared server: a signed-in
user may manage only their own password, and only an administrator may touch
accounts at all.
"""

from __future__ import annotations

import flask
import pytest

from data_formulator.auth.gateways.local_auth_gateway import _FAILURES, local_auth_bp
from data_formulator.auth.local_users import (
    ROLE_ADMIN,
    ROLE_USER,
    LocalUserStore,
    reset_user_store_for_tests,
)
from data_formulator.error_handler import register_error_handlers

pytestmark = [pytest.mark.backend, pytest.mark.auth]


@pytest.fixture(autouse=True)
def _clear_login_throttle():
    """The failure counter is process-global, so it would leak between tests."""
    _FAILURES.clear()
    yield
    _FAILURES.clear()


@pytest.fixture()
def store(tmp_path):
    s = LocalUserStore(tmp_path / "users.db")
    reset_user_store_for_tests(s)
    yield s
    reset_user_store_for_tests(None)


@pytest.fixture()
def client(store):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    app.secret_key = "test-secret-key"
    app.register_blueprint(local_auth_bp)
    try:
        register_error_handlers(app)
    except Exception:      # handler registration is optional for these routes
        pass
    return app.test_client()


def _login(client, username, password):
    return client.post("/api/auth/local/login",
                       json={"username": username, "password": password})


class TestSignIn:
    def test_valid_credentials_sign_in(self, client, store):
        store.create("alice", "password123")
        response = _login(client, "alice", "password123")
        assert response.status_code == 200
        assert response.get_json()["data"]["user"]["username"] == "alice"

    def test_wrong_password_is_refused(self, client, store):
        store.create("alice", "password123")
        assert _login(client, "alice", "wrong-password").status_code == 401

    def test_unknown_and_wrong_password_are_indistinguishable(self, client, store):
        store.create("alice", "password123")
        unknown = _login(client, "ghost", "password123")
        wrong = _login(client, "alice", "wrong-password")
        assert unknown.status_code == wrong.status_code == 401
        assert (unknown.get_json()["error"]["message"]
                == wrong.get_json()["error"]["message"])

    def test_status_reports_signed_out_before_login(self, client):
        assert client.get("/api/auth/local/status").get_json()["data"]["authenticated"] is False

    def test_status_reports_the_signed_in_account(self, client, store):
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        data = client.get("/api/auth/local/status").get_json()["data"]
        assert data["authenticated"] is True
        assert data["user"]["username"] == "alice"

    def test_logout_ends_the_session(self, client, store):
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        client.post("/api/auth/local/logout")
        assert client.get("/api/auth/local/status").get_json()["data"]["authenticated"] is False

    def test_deleted_account_cannot_keep_using_its_session(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        store.delete("alice")
        assert client.get("/api/auth/local/status").get_json()["data"]["authenticated"] is False

    def test_repeated_failures_are_throttled(self, client, store):
        store.create("alice", "password123")
        codes = {_login(client, "alice", "wrong-password").status_code for _ in range(12)}
        # Throttling answers 403 once the failure budget is spent.
        assert 403 in codes


class TestOwnPassword:
    def test_user_can_change_their_own_password(self, client, store):
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        response = client.post("/api/auth/local/change-password",
                               json={"current_password": "password123",
                                     "new_password": "a-new-password"})
        assert response.status_code == 200
        assert store.authenticate("alice", "a-new-password") is not None

    def test_wrong_current_password_is_refused(self, client, store):
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        response = client.post("/api/auth/local/change-password",
                               json={"current_password": "not-it",
                                     "new_password": "a-new-password"})
        assert response.status_code == 403

    def test_signed_out_visitor_cannot_change_a_password(self, client, store):
        store.create("alice", "password123")
        response = client.post("/api/auth/local/change-password",
                               json={"current_password": "password123",
                                     "new_password": "a-new-password"})
        assert response.status_code == 401


class TestAdministration:
    def _login_admin(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        _login(client, "root", "password123")

    def test_admin_can_list_create_and_delete_users(self, client, store):
        self._login_admin(client, store)

        created = client.post("/api/auth/local/users",
                              json={"username": "bob", "password": "password123"})
        assert created.status_code == 200
        assert created.get_json()["data"]["user"]["role"] == ROLE_USER

        listed = client.get("/api/auth/local/users").get_json()["data"]["users"]
        assert {u["username"] for u in listed} == {"root", "bob"}

        assert client.delete("/api/auth/local/users/bob").status_code == 200
        assert store.get("bob") is None

    def test_admin_created_accounts_must_change_password(self, client, store):
        self._login_admin(client, store)
        client.post("/api/auth/local/users",
                    json={"username": "bob", "password": "password123"})
        assert store.get("bob").must_change_password is True

    def test_admin_can_reset_another_users_password(self, client, store):
        self._login_admin(client, store)
        store.create("bob", "password123")
        response = client.post("/api/auth/local/users/bob/password",
                               json={"password": "reset-password"})
        assert response.status_code == 200
        assert store.authenticate("bob", "reset-password") is not None

    def test_admin_cannot_delete_their_own_account(self, client, store):
        self._login_admin(client, store)
        # Non-auth failures travel in the envelope with HTTP 200, so the
        # status alone would not reveal the refusal.
        response = client.delete("/api/auth/local/users/root")
        assert response.get_json()["status"] == "error"
        assert store.get("root") is not None

    def test_regular_user_cannot_list_accounts(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        assert client.get("/api/auth/local/users").status_code == 403

    def test_regular_user_cannot_create_accounts(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123")
        _login(client, "alice", "password123")
        response = client.post("/api/auth/local/users",
                               json={"username": "mallory", "password": "password123"})
        assert response.status_code == 403
        assert store.get("mallory") is None

    def test_regular_user_cannot_reset_another_password(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123")
        store.create("bob", "password123")
        _login(client, "alice", "password123")
        response = client.post("/api/auth/local/users/bob/password",
                               json={"password": "taken-over"})
        assert response.status_code == 403
        assert store.authenticate("bob", "password123") is not None

    def test_signed_out_visitor_cannot_reach_administration(self, client, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        assert client.get("/api/auth/local/users").status_code == 401
