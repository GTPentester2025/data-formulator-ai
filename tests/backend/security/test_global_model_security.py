"""Tests for global model security: credential resolution and error sanitization.

These verify two critical security properties:
1. get_client() resolves real credentials from the registry for global models.
2. test_model error messages never leak API keys for global models.
"""
from __future__ import annotations

import os
from unittest.mock import patch, MagicMock

import pytest

from data_formulator.errors import AppError, ErrorCode
from data_formulator.model_registry import ModelRegistry

pytestmark = [pytest.mark.backend]


SAMPLE_ENV = {
    "OPENAI_ENABLED": "true",
    "OPENAI_API_KEY": "sk-secret-key-12345",
    "OPENAI_API_BASE": "https://api.openai.com/v1",
    "OPENAI_MODELS": "gpt-4o",
}


def _as_admin():
    # Configuring a model the server does not already publish is an
    # administrator action, so tests that pass a caller-supplied config have to
    # say which caller they mean.
    return patch("data_formulator.auth.roles.is_admin", return_value=True)


def _as_ordinary_user():
    return patch("data_formulator.auth.roles.is_admin", return_value=False)


# ---------------------------------------------------------------------------
# get_client: global model credential resolution
# ---------------------------------------------------------------------------

class TestGetClientGlobalResolution:
    """get_client() must resolve real credentials from model_registry for a
    model the server publishes, and refuse anything else from a non-admin."""

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_global_model_gets_real_api_key(self):
        """A model named in the registry resolves to the full server-side
        config, key included -- and needs no special privilege to use."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry):
            from data_formulator.routes.agents import get_client

            client = get_client({
                "id": "global-openai-gpt-4o",
                "endpoint": "custom",
                "model": "gpt-4o",
                "is_global": True,
            })

            assert client.params.get("api_key") == "sk-secret-key-12345"

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_registry_config_wins_over_the_request_body(self):
        """The id identifies a server model; a request must not be able to keep
        the id and swap the endpoint underneath it."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry):
            from data_formulator.routes.agents import get_client

            client = get_client({
                "id": "global-openai-gpt-4o",
                "endpoint": "custom",
                "model": "gpt-4o",
                "api_key": "sk-attacker",
                "api_base": "https://attacker-listener.example/v1",
            })

            assert client.params.get("api_key") == "sk-secret-key-12345"
            assert client.params.get("api_base") == "https://api.openai.com/v1"

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_admin_model_keeps_own_credentials(self):
        """An administrator may still point at an endpoint of their choosing."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry), _as_admin():
            from data_formulator.routes.agents import get_client

            client = get_client({
                "id": "user-custom-model",
                "endpoint": "custom",
                "model": "gpt-4o",
                "api_key": "sk-user-own-key",
                "api_base": "https://gateway.internal/v1",
                "api_version": "",
            })

            assert client.params.get("api_key") == "sk-user-own-key"

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_non_admin_cannot_name_an_unconfigured_endpoint(self):
        """Model configuration is an operator decision: a non-admin request
        carrying its own api_base and key is refused, so nobody can spend the
        server's outbound access on an endpoint of their choosing."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry), _as_ordinary_user():
            from data_formulator.routes.agents import get_client

            with pytest.raises(AppError, match="administrator") as exc:
                get_client({
                    "id": "user-custom-model",
                    "endpoint": "custom",
                    "model": "gpt-4o",
                    "api_key": "sk-user-own-key",
                    "api_base": "https://gateway.internal/v1",
                })

            assert exc.value.code == ErrorCode.ACCESS_DENIED
            assert exc.value.get_http_status() == 403

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_global_claim_for_unregistered_id_is_rejected(self):
        """An is_global claim naming an id the registry does not know must be
        rejected outright.

        Falling through to the caller's own config would grant it the trust it
        just failed to prove -- in particular the allowlist exemption below,
        which turned api_base into an SSRF sink that the server signs with its
        own credentials.
        """
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry):
            from data_formulator.routes.agents import get_client

            with pytest.raises(AppError, match="Unknown global model") as exc:
                get_client({
                    "id": "global-nonexistent-model",
                    "endpoint": "custom",
                    "model": "nonexistent",
                    "api_key": "sk-fallback",
                    "api_base": "https://gateway.internal/v1",
                    "api_version": "",
                    "is_global": True,
                })

            assert exc.value.code == ErrorCode.ACCESS_DENIED
            assert exc.value.get_http_status() == 403

    @patch.dict(
        os.environ,
        {**SAMPLE_ENV, "DF_ALLOWED_API_BASES": "https://api.openai.com/*"},
        clear=True,
    )
    def test_global_claim_cannot_bypass_the_api_base_allowlist(self):
        """The reported vulnerability: is_global + an unregistered id skipped
        validate_api_base entirely, so an attacker-controlled api_base was
        accepted even with the allowlist enforced."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry), _as_admin():
            from data_formulator.routes.agents import get_client

            with pytest.raises(AppError) as exc:
                get_client({
                    "id": "nonexistent-xyz",
                    "endpoint": "custom",
                    "model": "gpt-4",
                    "api_key": "",
                    "api_base": "https://attacker-listener.example/",
                    "is_global": True,
                })

            assert exc.value.code == ErrorCode.ACCESS_DENIED

    @patch.dict(
        os.environ,
        {**SAMPLE_ENV, "DF_ALLOWED_API_BASES": "https://api.openai.com/*"},
        clear=True,
    )
    def test_admin_model_api_base_is_still_validated(self):
        """The allowlist binds administrators too: it is the operator's own
        statement about where this server may connect."""
        registry = ModelRegistry()

        with patch("data_formulator.routes.agents.model_registry", registry), _as_admin():
            from data_formulator.routes.agents import get_client

            with pytest.raises(AppError, match="allowlist") as exc:
                get_client({
                    "id": "user-custom-model",
                    "endpoint": "custom",
                    "model": "gpt-4",
                    "api_key": "",
                    "api_base": "https://attacker-listener.example/",
                })

            assert exc.value.get_http_status() == 403

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_resolving_a_global_model_does_not_mutate_the_registry(self):
        """get_client normalises strings in place; it must copy first so the
        process-wide registry config is not edited by a request."""
        registry = ModelRegistry()
        stored = registry.get_config("global-openai-gpt-4o")
        before = dict(stored)

        with patch("data_formulator.routes.agents.model_registry", registry):
            from data_formulator.routes.agents import get_client

            get_client({
                "id": "global-openai-gpt-4o",
                "endpoint": "custom",
                "model": "gpt-4o",
                "is_global": True,
            })

        assert registry.get_config("global-openai-gpt-4o") == before


# ---------------------------------------------------------------------------
# Error sanitization (shared sanitize module)
# ---------------------------------------------------------------------------

class TestSharedErrorSanitization:
    """The shared sanitize_error_message function must strip sensitive data."""

    def test_sanitize_redacts_api_key_patterns(self):
        from data_formulator.security.sanitize import sanitize_error_message

        raw = "Connection failed: api_key=sk-secret-key-12345 is invalid"
        sanitized = sanitize_error_message(raw)

        assert "sk-secret-key-12345" not in sanitized
        assert "<redacted>" in sanitized

    def test_sanitize_truncates_long_messages(self):
        from data_formulator.security.sanitize import sanitize_error_message

        raw = "x" * 1000
        sanitized = sanitize_error_message(raw)

        assert len(sanitized) <= 503  # 500 + "..."
        assert sanitized.endswith("...")

    def test_sanitize_escapes_html(self):
        from data_formulator.security.sanitize import sanitize_error_message

        raw = '<script>alert("xss")</script>'
        sanitized = sanitize_error_message(raw)

        assert "<script>" not in sanitized
        assert "&lt;script&gt;" in sanitized


# ---------------------------------------------------------------------------
# classify_llm_error: pattern-based safe message classification
# ---------------------------------------------------------------------------

class TestClassifyLlmError:
    """classify_llm_error returns pre-defined safe messages based on error patterns."""

    def test_auth_error_401(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("Error code: 401 - Unauthorized"))
        assert "Authentication failed" in msg
        assert "401" not in msg

    def test_auth_error_invalid_key(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("Invalid API key provided: sk-secret..."))
        assert "Authentication failed" in msg
        assert "sk-secret" not in msg

    def test_rate_limit_429(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("Error code: 429 - Rate limit exceeded"))
        assert "Rate limit" in msg

    def test_context_length(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("maximum context length is 8192 tokens"))
        assert "too long" in msg.lower() or "reduce" in msg.lower()

    def test_model_not_found(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("The model 'gpt-5' does not exist"))
        assert "Model not found" in msg

    def test_timeout(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("Connection timed out"))
        assert "timed out" in msg.lower() or "timeout" in msg.lower()

    def test_unknown_error_generic_fallback(self):
        from data_formulator.security.sanitize import classify_llm_error

        msg = classify_llm_error(RuntimeError("some completely unknown error xyz"))
        assert msg == "Model request failed"
        assert "unknown error xyz" not in msg

    def test_never_includes_raw_exception_text(self):
        from data_formulator.security.sanitize import classify_llm_error

        secret = "my-super-secret-api-key-12345"
        msg = classify_llm_error(RuntimeError(f"Failed with api_key={secret}"))
        assert secret not in msg
