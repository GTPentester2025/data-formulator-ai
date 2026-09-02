"""Tests for the endpoint behaviours that used to end a chat in silence.

A custom OpenAI-compatible gateway is not OpenAI. Three of the ways one can
differ produced the same symptom — the user sends a message and no reply ever
arrives — because the agents forward only ``delta.content`` and
``delta.tool_calls``, and an empty stream simply ends the run loop:

* the gateway ignores ``stream: true`` and answers with a buffered JSON body;
* the model streams its whole answer on ``reasoning_content``;
* the stream carries nothing at all.

Each is covered here at the client boundary, where the fix lives, so both the
data-loading agent and the analyst inherit it.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from data_formulator.agents.client_utils import Client

pytestmark = [pytest.mark.backend]


# ---------------------------------------------------------------------------
# Helpers: minimal stand-ins for LiteLLM's streamed and buffered shapes
# ---------------------------------------------------------------------------

def _delta(content=None, tool_calls=None, reasoning_content=None):
    return SimpleNamespace(content=content, tool_calls=tool_calls,
                           reasoning_content=reasoning_content)


def _chunk(delta, finish_reason=None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta,
                                                    finish_reason=finish_reason)])


def _buffered(content=None, tool_calls=None, finish_reason="stop"):
    message = SimpleNamespace(content=content, tool_calls=tool_calls,
                              reasoning_content=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message,
                                                    finish_reason=finish_reason)])


def _client():
    return Client("custom", "m", api_key="k", api_base="https://gateway.internal/v1")


def _text_of(chunks):
    """Concatenate the content the agents would have forwarded to the user."""
    parts = []
    for chunk in chunks:
        delta = chunk.choices[0].delta
        if getattr(delta, "content", None):
            parts.append(delta.content)
    return "".join(parts)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestStreamAlwaysProducesAReply:

    def test_streamed_content_passes_through_unchanged(self):
        streamed = [_chunk(_delta(content="Hello ")),
                    _chunk(_delta(content="world")),
                    _chunk(_delta(), finish_reason="stop")]

        with patch("litellm.completion", return_value=iter(streamed)) as completion:
            out = list(_client().get_completion([{"role": "user", "content": "hi"}],
                                                stream=True))

        assert _text_of(out) == "Hello world"
        assert completion.call_count == 1  # a working stream is never retried

    def test_gateway_that_ignores_stream_is_retried_buffered(self):
        """The streaming reader finds no events and raises nothing, so the only
        way to tell this apart from a silent model is to ask again."""
        calls = []

        def fake_completion(**kwargs):
            calls.append(kwargs.get("stream"))
            if kwargs.get("stream"):
                return iter(())          # no events: the body was not a stream
            return _buffered(content="Hello from the gateway.")

        with patch("litellm.completion", side_effect=fake_completion):
            out = list(_client().get_completion([{"role": "user", "content": "hi"}],
                                                stream=True))

        assert calls == [True, False]
        assert _text_of(out) == "Hello from the gateway."

    def test_reasoning_only_stream_is_surfaced_as_the_reply(self):
        """A model that answers on reasoning_content has said something; show it
        rather than ending the turn with a blank message."""
        streamed = [_chunk(_delta(reasoning_content="thinking ")),
                    _chunk(_delta(reasoning_content="out loud")),
                    _chunk(_delta(), finish_reason="stop")]

        with patch("litellm.completion", return_value=iter(streamed)) as completion:
            out = list(_client().get_completion([{"role": "user", "content": "hi"}],
                                                stream=True))

        assert _text_of(out) == "thinking out loud"
        assert completion.call_count == 1  # reasoning counts as output

    def test_empty_response_explains_itself(self):
        """When there is genuinely nothing, say so — an empty bubble reads as a
        broken app."""
        def fake_completion(**kwargs):
            if kwargs.get("stream"):
                return iter(())
            return _buffered(content=None)

        with patch("litellm.completion", side_effect=fake_completion):
            out = list(_client().get_completion([{"role": "user", "content": "hi"}],
                                                stream=True))

        assert "empty response" in _text_of(out)

    def test_original_error_is_reported_when_the_endpoint_is_down(self):
        """A failed stream plus a failed retry means the endpoint is genuinely
        unreachable; the stream error is the one worth showing."""
        def fake_completion(**kwargs):
            raise RuntimeError("connection refused")

        with patch("litellm.completion", side_effect=fake_completion):
            with pytest.raises(RuntimeError, match="connection refused"):
                list(_client().get_completion([{"role": "user", "content": "hi"}],
                                              stream=True))


class TestToolSupportErrors:

    def test_rejected_tools_are_explained_not_retried(self):
        """Retrying without tools would leave the agent unable to act, so say
        plainly what the endpoint is missing."""
        def fake_completion(**kwargs):
            raise RuntimeError("Unsupported parameter: 'tools' is not supported")

        tools = [{"type": "function", "function": {"name": "noop", "parameters": {}}}]
        with patch("litellm.completion", side_effect=fake_completion) as completion:
            with pytest.raises(RuntimeError, match="function calling"):
                _client().get_completion_with_tools(
                    [{"role": "user", "content": "hi"}], tools, stream=True)

        assert completion.call_count == 1  # no buffered retry for this one


class TestMissingKeyErrors:

    def test_401_on_a_keyless_model_names_the_missing_key(self):
        keyless = Client("custom", "m", api_base="https://gateway.internal/v1")

        def fake_completion(**kwargs):
            raise RuntimeError("AuthenticationError: Missing Authentication header")

        with patch("litellm.completion", side_effect=fake_completion):
            with pytest.raises(RuntimeError, match="configured without an API key"):
                keyless.get_completion([{"role": "user", "content": "hi"}])

    def test_401_on_a_keyed_model_is_left_alone(self):
        def fake_completion(**kwargs):
            raise RuntimeError("AuthenticationError: invalid api key")

        with patch("litellm.completion", side_effect=fake_completion):
            with pytest.raises(RuntimeError, match="invalid api key"):
                _client().get_completion([{"role": "user", "content": "hi"}])


class TestBufferedToolSalvage:

    def test_json_content_becomes_a_tool_call(self):
        """A gateway without native function calling writes the call into
        content; the agents only act on tool_calls."""
        tools = [{"type": "function", "function": {
            "name": "list_data",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }}]

        with patch("litellm.completion",
                   return_value=_buffered(content='{"name": "list_data", "arguments": {}}')):
            response = _client().get_completion_with_tools(
                [{"role": "user", "content": "hi"}], tools, stream=False)

        tool_calls = response.choices[0].message.tool_calls
        assert tool_calls and tool_calls[0].function.name == "list_data"
