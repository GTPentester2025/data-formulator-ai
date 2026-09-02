"""Tests for ModelRegistry: env-var loading, public listing, and credential isolation.

These are the security-critical paths — global model API keys must never
be included in the public listing sent to the frontend.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from data_formulator.model_registry import ENDPOINT, ModelRegistry

pytestmark = [pytest.mark.backend]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_env(providers: dict[str, dict[str, str]]) -> dict[str, str]:
    """Build a flat env-var dict from a nested {provider: {suffix: value}} mapping."""
    env = {}
    for provider, settings in providers.items():
        prefix = provider.upper()
        for suffix, value in settings.items():
            env[f"{prefix}_{suffix.upper()}"] = value
    return env


SAMPLE_ENV = _make_env({
    "openai": {
        "enabled": "true",
        "api_key": "sk-secret-openai-key",
        "api_base": "https://api.openai.com/v1",
        "models": "gpt-4o,gpt-5",
    },
    # A keyless endpoint: an API base is enough to register it.
    "ollama": {
        "enabled": "true",
        "api_base": "http://localhost:11434/v1",
        "models": "qwen3:32b",
    },
    "deepseek": {
        "enabled": "true",
        "api_key": "sk-secret-deepseek-key",
        "api_base": "https://api.deepseek.com/v1",
        "models": "deepseek-chat",
    },
})


# ---------------------------------------------------------------------------
# Tests: discovery & loading
# ---------------------------------------------------------------------------

class TestModelDiscovery:
    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_discovers_all_enabled_providers(self):
        registry = ModelRegistry()
        public = registry.list_public()
        ids = {m["id"] for m in public}

        assert "global-openai-gpt-4o" in ids
        assert "global-openai-gpt-5" in ids
        assert "global-ollama-qwen3:32b" in ids
        assert "global-deepseek-deepseek-chat" in ids

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_total_model_count(self):
        registry = ModelRegistry()
        assert len(registry.list_public()) == 4  # 2 openai + 1 ollama + 1 deepseek

    @patch.dict(os.environ, {}, clear=True)
    def test_empty_env_yields_no_models(self):
        registry = ModelRegistry()
        assert registry.list_public() == []

    @patch.dict(os.environ, {"OPENAI_ENABLED": "true", "OPENAI_API_KEY": "sk-x",
                             "OPENAI_API_BASE": "https://api.openai.com/v1"}, clear=True)
    def test_skips_provider_without_models(self):
        """OPENAI_MODELS not set → no models registered."""
        registry = ModelRegistry()
        assert registry.list_public() == []

    @patch.dict(os.environ, {"OPENAI_ENABLED": "true", "OPENAI_API_KEY": "sk-x",
                             "OPENAI_MODELS": "gpt-4o"}, clear=True)
    def test_skips_provider_without_api_base(self):
        """Every model is a custom endpoint, so there is no default to fall back on."""
        registry = ModelRegistry()
        assert registry.list_public() == []

    @patch.dict(os.environ, {"OPENAI_ENABLED": "false", "OPENAI_API_KEY": "sk-x",
                             "OPENAI_API_BASE": "https://api.openai.com/v1",
                             "OPENAI_MODELS": "gpt-4o"}, clear=True)
    def test_skips_disabled_provider(self):
        registry = ModelRegistry()
        assert registry.list_public() == []


# ---------------------------------------------------------------------------
# Tests: public listing never leaks credentials
# ---------------------------------------------------------------------------

class TestPublicListingSecurity:
    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_no_api_key_in_public_info(self):
        registry = ModelRegistry()
        for model in registry.list_public():
            assert "api_key" not in model, f"api_key leaked for {model['id']}"

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_public_fields_are_complete(self):
        registry = ModelRegistry()
        for model in registry.list_public():
            assert "id" in model
            assert "endpoint" in model
            assert "model" in model
            assert "is_global" in model
            assert model["is_global"] is True

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_full_config_contains_api_key(self):
        """get_config must return credentials for server-side use."""
        registry = ModelRegistry()
        config = registry.get_config("global-openai-gpt-4o")
        assert config is not None
        assert config["api_key"] == "sk-secret-openai-key"


# ---------------------------------------------------------------------------
# Tests: every provider is one custom OpenAI-compatible endpoint
# ---------------------------------------------------------------------------

class TestCustomProvider:
    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_every_model_uses_the_custom_endpoint(self):
        """The provider name is a label; the API base decides where calls go."""
        registry = ModelRegistry()
        for model in registry.list_public():
            assert model["endpoint"] == ENDPOINT

    @patch.dict(os.environ, {
        "MYVENDOR_ENABLED": "true",
        "MYVENDOR_ENDPOINT": "anthropic",
        "MYVENDOR_API_KEY": "key123",
        "MYVENDOR_API_BASE": "https://gateway.internal/v1",
        "MYVENDOR_MODELS": "my-model",
    }, clear=True)
    def test_endpoint_variable_cannot_select_another_provider(self):
        """A leftover _ENDPOINT from an older config must not resurrect a
        hosted provider — there is only one transport now."""
        registry = ModelRegistry()
        config = registry.get_config("global-myvendor-my-model")
        assert config is not None
        assert config["endpoint"] == ENDPOINT

    @patch.dict(os.environ, SAMPLE_ENV, clear=True)
    def test_keyless_endpoint_registers(self):
        registry = ModelRegistry()
        config = registry.get_config("global-ollama-qwen3:32b")
        assert config is not None
        assert config["api_key"] == ""
        assert config["api_base"] == "http://localhost:11434/v1"


