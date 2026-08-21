"""Account store: hashing, validation, and the rules that keep a server usable.

The invariants worth pinning down are the ones whose failure locks people out
or lets them in: password verification, the last-administrator guards, and the
fact that authentication does not reveal whether an account exists.
"""

from __future__ import annotations

import pytest

from data_formulator.auth.local_users import (
    MIN_PASSWORD_LENGTH,
    ROLE_ADMIN,
    ROLE_USER,
    LocalUserStore,
    UserError,
    hash_password,
    validate_username,
    verify_password,
)

pytestmark = [pytest.mark.backend]


@pytest.fixture()
def store(tmp_path) -> LocalUserStore:
    return LocalUserStore(tmp_path / "users.db")


class TestPasswordHashing:
    def test_hash_verifies_against_its_password(self):
        stored = hash_password("correct horse battery")
        assert verify_password("correct horse battery", stored)

    def test_wrong_password_is_rejected(self):
        assert not verify_password("wrong", hash_password("right-password"))

    def test_hashes_are_salted_so_two_encodings_differ(self):
        a = hash_password("same-password")
        b = hash_password("same-password")
        assert a != b
        assert verify_password("same-password", a)
        assert verify_password("same-password", b)

    def test_password_is_not_recoverable_from_the_hash(self):
        assert "hunter2hunter2" not in hash_password("hunter2hunter2")

    def test_malformed_stored_values_do_not_raise(self):
        for junk in ("", "not-a-hash", "scrypt$bad", "scrypt$1$2$3$zz$zz"):
            assert verify_password("anything", junk) is False


class TestUsernameValidation:
    def test_lowercases_and_trims(self):
        assert validate_username("  Alice  ") == "alice"

    @pytest.mark.parametrize("bad", ["ab", "", "a" * 65, "has space", "colon:name", "pipe|name", "sl/ash"])
    def test_rejects_unusable_names(self, bad):
        # ':' and '|' would let a username forge an identity namespace.
        with pytest.raises(UserError):
            validate_username(bad)


class TestAccounts:
    def test_create_then_authenticate(self, store):
        store.create("alice", "password123", role=ROLE_USER)
        user = store.authenticate("alice", "password123")
        assert user is not None
        assert user.username == "alice"
        assert user.role == ROLE_USER

    def test_authentication_is_case_insensitive_on_username(self, store):
        store.create("alice", "password123")
        assert store.authenticate("ALICE", "password123") is not None

    def test_wrong_password_returns_none(self, store):
        store.create("alice", "password123")
        assert store.authenticate("alice", "nope-nope-nope") is None

    def test_unknown_user_returns_none_rather_than_raising(self, store):
        assert store.authenticate("ghost", "password123") is None

    def test_duplicate_username_is_refused(self, store):
        store.create("alice", "password123")
        with pytest.raises(UserError):
            store.create("alice", "different-password")

    def test_short_passwords_are_refused(self, store):
        with pytest.raises(UserError):
            store.create("alice", "a" * (MIN_PASSWORD_LENGTH - 1))

    def test_login_records_a_timestamp(self, store):
        store.create("alice", "password123")
        assert store.get("alice").last_login_at is None
        store.authenticate("alice", "password123")
        assert store.get("alice").last_login_at is not None

    def test_reset_password_replaces_the_old_one(self, store):
        store.create("alice", "password123")
        store.set_password("alice", "brand-new-password")
        assert store.authenticate("alice", "password123") is None
        assert store.authenticate("alice", "brand-new-password") is not None

    def test_admin_reset_forces_a_change_at_next_sign_in(self, store):
        store.create("alice", "password123")
        store.set_password("alice", "temporary-one", must_change_password=True)
        assert store.get("alice").must_change_password is True

    def test_reset_for_unknown_user_is_refused(self, store):
        with pytest.raises(UserError):
            store.set_password("ghost", "password123")


class TestAdministratorGuards:
    def test_last_admin_cannot_be_deleted(self, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123", role=ROLE_USER)
        with pytest.raises(UserError):
            store.delete("root")

    def test_last_admin_cannot_be_demoted(self, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        with pytest.raises(UserError):
            store.set_role("root", ROLE_USER)

    def test_admin_can_be_removed_once_another_exists(self, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("second", "password123", role=ROLE_ADMIN)
        store.delete("root")
        assert store.get("root") is None
        assert store.admin_count() == 1

    def test_deleting_a_regular_user_is_allowed(self, store):
        store.create("root", "password123", role=ROLE_ADMIN)
        store.create("alice", "password123")
        store.delete("alice")
        assert store.get("alice") is None

    def test_unknown_role_is_refused(self, store):
        with pytest.raises(UserError):
            store.create("alice", "password123", role="superuser")
