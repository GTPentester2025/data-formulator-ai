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
    """One provider, one request shape: ``GET <normalized base>/models``."""

    def test_normalizes_base_and_sends_both_auth_headers(self):
        (url, headers), = _model_list_requests("custom", "sk-x", "https://host/openai", "")
        assert url == "https://host/openai/v1/models"
        # Azure-style gateways read `api-key`; everyone else reads Bearer.
        assert headers["Authorization"] == "Bearer sk-x"
        assert headers["api-key"] == "sk-x"

    def test_existing_version_segment_is_kept(self):
        (url, _), = _model_list_requests("custom", "sk-x", "https://host/v1", "")
        assert url == "https://host/v1/models"

    def test_blank_key_sends_no_auth_header(self):
        """A keyless endpoint must not be handed an empty bearer token."""
        (_, headers), = _model_list_requests("custom", "", "http://localhost:11434/v1", "")
        assert headers == {}

    def test_base_url_is_required(self):
        """There is no public default to fall back on: without a base URL there
        is nowhere to ask."""
        with pytest.raises(AppError):
            _model_list_requests("custom", "k", "", "")
