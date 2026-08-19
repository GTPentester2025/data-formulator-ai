"""Unit tests for the provider model-listing helpers.

The model picker calls one endpoint for every provider, so the two pure
helpers behind it — payload parsing and per-provider URL/header choice —
carry the compatibility burden and are worth pinning down.
"""

from __future__ import annotations

import pytest

from data_formulator.routes.agents import _model_list_requests, _parse_model_list
from data_formulator.errors import AppError

pytestmark = [pytest.mark.backend]


class TestParseModelList:
    def test_openai_shape(self):
        payload = {"object": "list", "data": [{"id": "gpt-4.1"}, {"id": "gpt-4o"}]}
        assert _parse_model_list(payload) == ["gpt-4.1", "gpt-4o"]

    def test_ollama_shape(self):
        payload = {"models": [{"name": "llama3"}, {"name": "mistral"}]}
        assert _parse_model_list(payload) == ["llama3", "mistral"]

    def test_bare_array_of_objects(self):
        assert _parse_model_list([{"id": "a"}, {"model": "b"}]) == ["a", "b"]

    def test_bare_array_of_strings(self):
        assert _parse_model_list(["z", "a"]) == ["a", "z"]

    def test_deduplicates_and_sorts(self):
        payload = {"data": [{"id": "b"}, {"id": "a"}, {"id": "b"}]}
        assert _parse_model_list(payload) == ["a", "b"]

    def test_ignores_entries_without_a_name(self):
        payload = {"data": [{"id": "a"}, {"owned_by": "x"}, {"id": ""}, 42]}
        assert _parse_model_list(payload) == ["a"]

    def test_unknown_shapes_yield_nothing(self):
        assert _parse_model_list({"unexpected": 1}) == []
        assert _parse_model_list("nonsense") == []
        assert _parse_model_list(None) == []


class TestModelListRequests:
    def test_custom_normalizes_base_and_sends_both_auth_headers(self):
        (url, headers), = _model_list_requests("custom", "sk-x", "https://host/openai", "")
        assert url == "https://host/openai/v1/models"
        # Azure-style gateways read `api-key`; everyone else reads Bearer.
        assert headers["Authorization"] == "Bearer sk-x"
        assert headers["api-key"] == "sk-x"

    def test_openai_defaults_to_the_public_endpoint(self):
        (url, _), = _model_list_requests("openai", "sk-x", "", "")
        assert url == "https://api.openai.com/v1/models"

    def test_ollama_tries_native_then_openai_compatible(self):
        attempts = _model_list_requests("ollama", "", "http://localhost:11434/api", "")
        assert [u for u, _ in attempts] == [
            "http://localhost:11434/api/tags",
            "http://localhost:11434/v1/models",
        ]

    def test_anthropic_uses_its_own_auth_headers(self):
        (url, headers), = _model_list_requests("anthropic", "sk-ant", "", "")
        assert url == "https://api.anthropic.com/v1/models"
        assert headers["x-api-key"] == "sk-ant"
        assert "anthropic-version" in headers

    def test_gemini_passes_the_key_as_a_query_parameter(self):
        (url, _), = _model_list_requests("gemini", "key123", "", "")
        assert url.endswith("key=key123")

    def test_azure_requires_a_base_url(self):
        with pytest.raises(AppError):
            _model_list_requests("azure", "k", "", "")

    def test_azure_uses_the_supplied_api_version(self):
        attempts = _model_list_requests("azure", "k", "https://res.openai.azure.com", "2025-01-01")
        assert attempts[0][0] == "https://res.openai.azure.com/openai/models?api-version=2025-01-01"
        assert attempts[0][1]["api-key"] == "k"

    def test_unknown_provider_is_rejected(self):
        with pytest.raises(AppError):
            _model_list_requests("bogus", "k", "", "")
