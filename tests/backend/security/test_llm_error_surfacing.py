"""Tests for the LLM error text a user actually ends up reading.

Two layers stood between a diagnosis and the browser, and together they turned
every model failure into the words "LLM API error":

* ``classify_llm_error`` replaced the message with a canned one, including for
  errors this codebase wrote itself;
* the analyst attached ``message_code="agent.llmApiError"`` alongside the
  message, and the frontend prefers a translated code over the message it
  came with.

Both are covered here, because a generic error string is the same failure as
no error string: the user cannot tell a missing key from an unreachable host.
"""

from __future__ import annotations

import pytest

from data_formulator.agents.client_utils import EndpointCapabilityError
from data_formulator.analyst.agent import AnalystAgent
from data_formulator.security.sanitize import classify_llm_error

pytestmark = [pytest.mark.backend]


class TestClassifyLlmError:

    def test_our_own_diagnosis_passes_through_whole(self):
        """Re-classifying it would point the user at the wrong thing: this
        message says no key is configured, and the 401 pattern would answer
        "check your API key"."""
        exc = EndpointCapabilityError(
            "The endpoint refused the request for lack of credentials, and "
            "this model is configured without an API key. Add the key to the "
            "model's configuration."
        )
        assert classify_llm_error(exc) == str(exc)

    def test_provider_text_is_still_replaced(self):
        """A third-party exception may quote a URL, a key or a stack frame, so
        it never reaches the client verbatim."""
        exc = RuntimeError("401 Unauthorized for https://gateway/v1 key=sk-abc123")
        message = classify_llm_error(exc)
        assert "sk-abc123" not in message
        assert message == "Authentication failed — please check your API key"

    def test_unknown_errors_fall_back(self):
        assert classify_llm_error(RuntimeError("something odd")) == "Model request failed"

    @pytest.mark.parametrize("raw,expected", [
        ("Read timed out", "Request timed out — please check connectivity and try again"),
        ("model gpt-9 does not exist", "Model not found — please check the model name"),
        ("429 rate limit reached", "Rate limit exceeded — please wait and try again"),
    ])
    def test_known_patterns_keep_their_wording(self, raw, expected):
        assert classify_llm_error(RuntimeError(raw)) == expected


class TestErrorEventCode:
    """The frontend's ``translateBackend`` returns the translation of
    ``message_code`` when one is present, falling back to ``message`` only
    when it is absent. So a generic code must not ride along with a specific
    message."""

    def test_specific_message_travels_without_a_generic_code(self):
        event = AnalystAgent._error_event(
            3, "Request timed out — please check connectivity and try again",
            message_code="",
        )
        assert "message_code" not in event
        assert event["message"].startswith("Request timed out")

    def test_bare_fallback_keeps_its_code(self):
        """With nothing specific to say, the translated label is the best
        available text — and it is translatable, which raw English is not."""
        event = AnalystAgent._error_event(
            3, "LLM API error", message_code="agent.llmApiError",
        )
        assert event["message_code"] == "agent.llmApiError"
