import itertools
import json
import logging
import re

import litellm
import os
from types import SimpleNamespace

logger = logging.getLogger(__name__)


def normalize_openai_compatible_base(api_base: str) -> str:
    """Normalize a user-supplied OpenAI-compatible base URL.

    Users paste URLs in many shapes — with a trailing ``/chat/completions``
    (copied from docs), with or without ``/v1``, with trailing slashes.
    The OpenAI client appends ``/chat/completions`` itself, so:

    * strip trailing slashes and a trailing ``/chat/completions`` or
      ``/completions`` path;
    * append ``/v1`` when the URL has no version segment at the end
      (covers hosts pasted bare, e.g. ``https://api.groq.com/openai``),
      leaving URLs that already end in ``/v1``/``/v2``... untouched.

    Works for Azure AI Foundry (``https://<res>.openai.azure.com/openai/v1``),
    Ollama (``http://localhost:11434/v1``), Groq, OpenRouter, LM Studio,
    vLLM, LiteLLM proxies.
    """
    base = api_base.strip().rstrip("/")
    for suffix in ("/chat/completions", "/completions"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            base = base.rstrip("/")
            break
    if not re.search(r"/v\d+$", base):
        base = base + "/v1"
    return base



def _ssl_verify_setting():
    """Return the TLS-verification setting for outbound LLM calls.

    ``True`` (the default) verifies against the system trust store. Operators
    whose endpoint uses an internal CA set one of:

    * ``DF_LLM_CA_BUNDLE=/path/to/internal-ca.pem`` — keeps verification on,
      just against that CA. Preferred.
    * ``DF_LLM_INSECURE_SKIP_VERIFY=1`` — disables verification entirely. This
      accepts any certificate, including an attacker's, so use it only on a
      trusted network when the CA file cannot be obtained.

    Both are server-side env vars: a user cannot weaken TLS from the UI.
    """
    if os.environ.get("DF_LLM_INSECURE_SKIP_VERIFY", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        return False
    ca_bundle = os.environ.get("DF_LLM_CA_BUNDLE", "").strip()
    if ca_bundle:
        return ca_bundle
    return True


def _synthesize_stream(response):
    """Yield LiteLLM-style streaming chunks reconstructed from a *buffered*
    response, so a caller that consumes a stream sees the same data.

    Used whenever the buffered path is the only one that works: an endpoint
    that ignores ``stream: true`` and answers with a single JSON body, or one
    whose streamed tool calls LiteLLM cannot parse. We call it non-streaming
    and replay the result as a stream so the agents keep one code path.
    """
    try:
        choice0 = response.choices[0]
        message = choice0.message
        finish_reason = getattr(choice0, "finish_reason", "stop") or "stop"
    except (AttributeError, IndexError):
        return

    reasoning = getattr(message, "reasoning_content", None)
    if reasoning:
        yield SimpleNamespace(choices=[SimpleNamespace(
            delta=SimpleNamespace(content=None, tool_calls=None,
                                  reasoning_content=reasoning),
            finish_reason=None)])

    content = getattr(message, "content", None)
    if content:
        yield SimpleNamespace(choices=[SimpleNamespace(
            delta=SimpleNamespace(content=content, tool_calls=None,
                                  reasoning_content=None),
            finish_reason=None)])

    for idx, tc in enumerate(getattr(message, "tool_calls", None) or []):
        fn = getattr(tc, "function", None)
        yield SimpleNamespace(choices=[SimpleNamespace(
            delta=SimpleNamespace(
                content=None, reasoning_content=None,
                tool_calls=[SimpleNamespace(
                    index=idx, id=getattr(tc, "id", None) or f"call_{idx}",
                    function=SimpleNamespace(
                        name=getattr(fn, "name", None),
                        arguments=getattr(fn, "arguments", "") or ""))]),
            finish_reason=None)])

    yield SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=None, tool_calls=None,
                              reasoning_content=None),
        finish_reason=finish_reason)])


class EndpointCapabilityError(RuntimeError):
    """The endpoint answered, but cannot do what the request needs.

    Distinct from a transport failure: retrying the same call another way will
    not help, so :meth:`Client._dispatch` re-raises it instead of falling back
    to a buffered request.
    """


def _guard_stream(chunks):
    """Pass ``chunks`` through, guaranteeing the caller sees *something*.

    Two endpoint behaviours otherwise end a chat in silence, because the agents
    only forward ``delta.content`` and ``delta.tool_calls``:

    * a reasoning model that streams the whole answer on ``reasoning_content``
      and never emits ``content`` — common on gateways that expose a thinking
      model without the matching answer channel;
    * a stream that carries no deltas at all (empty completion, filtered
      response, upstream cut short).

    In both cases the run loop simply finds nothing and stops, and the user
    sees their message sent with no reply. So we watch what actually goes past
    and, if the stream ends without a single content token or tool call, emit
    the reasoning text — or a plain explanation — as content before the final
    chunk.
    """
    saw_output = False
    reasoning = []
    last_finish = "stop"

    for chunk in chunks:
        choices = getattr(chunk, "choices", None)
        if choices:
            choice0 = choices[0]
            delta = getattr(choice0, "delta", None)
            finish = getattr(choice0, "finish_reason", None)
            if finish:
                last_finish = finish
            if delta is not None:
                if getattr(delta, "content", None) or getattr(delta, "tool_calls", None):
                    saw_output = True
                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    reasoning.append(rc)
        yield chunk

    if saw_output:
        return

    recovered = "".join(reasoning).strip()
    if recovered:
        logger.info("Stream carried only reasoning_content (%d chars); "
                    "surfacing it as the reply", len(recovered))
    else:
        recovered = (
            "The model endpoint returned an empty response. It accepted the "
            "request but sent no answer — check the model name and any "
            "content filter or token limit on the endpoint, then try again."
        )
        logger.warning("Stream ended with no content, tool calls or reasoning")

    yield SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=recovered, tool_calls=None,
                              reasoning_content=None),
        finish_reason=None)])
    yield SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=None, tool_calls=None,
                              reasoning_content=None),
        finish_reason=last_finish)])


def _drain_until_output(chunks):
    """Read *chunks* until the stream shows it is really answering.

    Returns ``(consumed, produced)`` — the chunks read so far, and whether any
    of them carried content, a tool call or reasoning. The caller replays
    ``consumed`` ahead of the rest of the stream, so nothing is lost.

    This exists because an endpoint that ignores ``stream: true`` and replies
    with a single buffered JSON body does not raise: the streaming reader just
    finds no events and ends. Without looking, that is indistinguishable from a
    model with nothing to say, and the chat ends in silence.
    """
    consumed = []
    for chunk in chunks:
        consumed.append(chunk)
        choices = getattr(chunk, "choices", None)
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue
        if (getattr(delta, "content", None)
                or getattr(delta, "tool_calls", None)
                or getattr(delta, "reasoning_content", None)):
            return consumed, True
    return consumed, False


def _is_tool_support_error(error_text: str) -> bool:
    """Whether the endpoint rejected the request because of ``tools``.

    Gateways without function-calling answer 400 naming the parameter, so the
    match stays on that name rather than on any one vendor's wording.
    """
    lowered = error_text.lower()
    if "tool" not in lowered and "function call" not in lowered:
        return False
    return any(marker in lowered for marker in (
        "unsupported", "not supported", "does not support", "unrecognized",
        "unknown parameter", "invalid parameter", "unexpected keyword",
    ))


def _extract_json_objects(text):
    """Return top-level brace-balanced JSON object substrings found in ``text``.

    String-aware (ignores braces inside quoted strings) so it survives code
    payloads that contain ``{`` / ``}``. Used to recover an action that a weak
    model emitted as plain content instead of a native tool call.
    """
    objs = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    objs.append(text[start:i + 1])
                    start = -1
    return objs


def _match_tool_from_obj(obj, tools, _depth=0):
    """Map a parsed JSON object to ``(tool_name, arguments_dict)`` if it matches
    one of ``tools``' schemas, else ``None``.

    Handles three shapes weak models emit instead of a native tool call:
      * nested wrapper — ``{"thought": ..., "action": {"name": "visualize",
        "arguments": {...}}}`` (a key points to an object describing the call);
      * flat explicit wrapper — ``{"name"/"tool"/"action": "visualize",
        "arguments": {...}}`` (the object names the tool directly);
      * bare arguments — ``{"code": ..., "output_variable": ..., "chart": ...}``
        (no tool named; keys matched against each tool's ``required`` params,
        most specific tool wins).
    """
    if not isinstance(obj, dict) or _depth > 4:
        return None

    tool_by_name = {}
    for t in tools or []:
        fn = (t or {}).get("function") or {}
        name = fn.get("name")
        if name:
            tool_by_name[name] = fn

    # Nested wrapper: a key points to an object that itself describes the call
    # (e.g. {"action": {"name": "visualize", "arguments": {...}}}). Recurse.
    for wrap_key in ("action", "tool", "function", "tool_call", "call",
                     "function_call"):
        inner = obj.get(wrap_key)
        if isinstance(inner, dict):
            got = _match_tool_from_obj(inner, tools, _depth + 1)
            if got is not None:
                return got

    # OpenAI tool-call wire format echoed as content: {"tool_calls": [{...}]}.
    tc_list = obj.get("tool_calls")
    if isinstance(tc_list, list) and tc_list:
        got = _match_tool_from_obj(tc_list[0], tools, _depth + 1)
        if got is not None:
            return got

    # Flat explicit wrapper: the object names the tool as a string.
    for name_key in ("name", "tool", "action", "function", "tool_name"):
        cand = obj.get(name_key)
        if isinstance(cand, str) and cand in tool_by_name:
            args = obj.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    args = None
            if not isinstance(args, dict):
                args = obj.get("parameters") if isinstance(obj.get("parameters"), dict) else None
            if not isinstance(args, dict):
                args = obj.get("args") if isinstance(obj.get("args"), dict) else None
            if not isinstance(args, dict):
                args = {k: v for k, v in obj.items()
                        if k not in (name_key, "arguments", "parameters", "args")}
            return cand, args

    # Bare arguments: match by required-key coverage, most specific tool wins.
    keys = set(obj.keys())
    best = None
    best_score = None
    for name, fn in tool_by_name.items():
        params = fn.get("parameters") or {}
        required = set(params.get("required") or [])
        props = set((params.get("properties") or {}).keys())
        if not required or not required.issubset(keys):
            continue
        score = (len(required), len(keys & props), -len(keys - props))
        if best_score is None or score > best_score:
            best_score, best = score, name
    if best is not None:
        return best, dict(obj)
    return None


def salvage_tool_call_from_text(text, tools):
    """Return ``(tool_name, arguments)`` if *text* is really a tool call.

    The streamed counterpart of :func:`_salvage_tool_calls_from_content`: an
    endpoint without native function calling — or a weak model behind one —
    streams the action as a JSON object on the content channel. The agents only
    act on native ``tool_calls``, so without this the user is shown raw JSON
    where an action should have happened.

    Returns ``None`` when the text is ordinary prose, which is the common case,
    so callers can use it as a last resort after a turn produced no tool call.
    """
    if not tools or not isinstance(text, str) or "{" not in text:
        return None
    for blob in _extract_json_objects(text):
        try:
            obj = json.loads(blob)
        except (ValueError, TypeError):
            continue
        matched = _match_tool_from_obj(obj, tools)
        if matched is not None:
            return matched
    return None


def _salvage_tool_calls_from_content(response, tools):
    """If ``response`` carries an action as JSON *content* but no native
    ``tool_calls``, rewrite it into a proper tool call in place.

    Weak / open models under a long system prompt frequently emit the action
    (e.g. ``visualize``/``ask_user``) as a JSON object in the assistant content
    channel rather than as a native function call. This recovers that action so
    the agent — which only consumes native ``tool_calls`` — can proceed."""
    if not tools:
        return response
    try:
        choice0 = response.choices[0]
        message = choice0.message
    except (AttributeError, IndexError):
        return response
    if getattr(message, "tool_calls", None):
        return response
    content = getattr(message, "content", None)
    if not isinstance(content, str) or "{" not in content:
        return response

    for blob in _extract_json_objects(content):
        try:
            obj = json.loads(blob)
        except (ValueError, TypeError):
            continue
        matched = _match_tool_from_obj(obj, tools)
        if matched is None:
            continue
        name, args = matched
        try:
            from litellm.types.utils import ChatCompletionMessageToolCall, Function
            tc = ChatCompletionMessageToolCall(
                function=Function(name=name, arguments=json.dumps(args)),
                id="call_salvage_0", type="function")
        except Exception:
            tc = SimpleNamespace(
                id="call_salvage_0", type="function",
                function=SimpleNamespace(name=name, arguments=json.dumps(args)))
        message.tool_calls = [tc]
        message.content = None
        try:
            choice0.finish_reason = "tool_calls"
        except (AttributeError, TypeError):
            pass
        break
    return response


class Client(object):
    """A LiteLLM client for the one provider this deployment speaks: a
    **custom OpenAI-compatible endpoint** (an internal gateway, LiteLLM proxy,
    vLLM, Ollama's OpenAI shim, Azure AI Foundry's ``/openai/v1`` surface, ...).

    Every model is reached over ``POST <api_base>/chat/completions`` with an
    optional ``Authorization: Bearer <key>``, so there is a single request
    shape to configure, allowlist and debug. The hosted-provider shortcuts
    (``openai``/``azure``/``anthropic``/``gemini``/``ollama``) are gone; point
    ``api_base`` at whichever endpoint you use instead.
    """

    #: The only accepted ``endpoint`` value. Kept as a constant so callers and
    #: tests have one name to reference rather than a bare string literal.
    ENDPOINT = "custom"

    def __init__(self, endpoint, model, api_key=None, api_base=None, api_version=None):
        endpoint = (endpoint or "").strip().lower() or self.ENDPOINT
        if endpoint != self.ENDPOINT:
            raise ValueError(
                f"Unsupported provider {endpoint!r}. This deployment only calls "
                f"custom OpenAI-compatible endpoints; configure the model with "
                f"endpoint='{self.ENDPOINT}' and an API base URL."
            )
        if not api_base:
            raise ValueError(
                "An API base URL is required (e.g. https://your-gateway/v1)."
            )

        self.endpoint = endpoint
        self.params = {}

        # LiteLLM routes on the model prefix; "openai/" selects the plain
        # OpenAI-compatible transport, which is what every such endpoint speaks.
        self.model = model if model.startswith("openai/") else f"openai/{model}"
        self.params["api_base"] = normalize_openai_compatible_base(api_base)

        # A blank key means the endpoint is keyless. Send no Authorization
        # header at all rather than a placeholder: a gateway that requires a
        # key answers a placeholder with "401 Missing Authentication header",
        # which reads like a server fault instead of a missing key. LiteLLM
        # insists on *some* api_key for this transport, so the placeholder
        # survives only for the keyless case, where it is never inspected.
        api_key = (api_key or "").strip()
        self.params["api_key"] = api_key or "not-needed"

        api_version = (api_version or "").strip()
        if api_version:
            self.params["api_version"] = api_version

        ssl_verify = _ssl_verify_setting()
        if ssl_verify is not True:
            # An internal endpoint often presents a self-signed or internal-CA
            # certificate. DF_LLM_CA_BUNDLE trusts that CA (verification stays
            # on); DF_LLM_INSECURE_SKIP_VERIFY turns verification off outright.
            self.params["ssl_verify"] = ssl_verify

    def _strip_image_blocks(self, content):
        """Remove image_url blocks from multimodal content arrays."""
        if isinstance(content, list):
            sanitized = []
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "image_url":
                        continue
                    sanitized.append(item)
                else:
                    sanitized.append(item)
            return sanitized
        return content

    def _strip_images_from_messages(self, messages):
        """Create a copy of messages with image_url blocks removed."""
        sanitized_messages = []
        for msg in messages:
            if isinstance(msg, dict):
                new_msg = dict(msg)
                if "content" in new_msg:
                    new_msg["content"] = self._strip_image_blocks(new_msg["content"])
                sanitized_messages.append(new_msg)
            else:
                sanitized_messages.append(msg)
        return sanitized_messages

    def _messages_contain_images(self, messages) -> bool:
        """Return whether messages contain an image_url content block."""
        return any(
            isinstance(msg, dict)
            and isinstance(msg.get("content"), list)
            and any(
                isinstance(item, dict) and item.get("type") == "image_url"
                for item in msg["content"]
            )
            for msg in messages
        )

    def _is_image_deserialize_error(self, error_text: str, has_images: bool = False) -> bool:
        """Detect provider errors caused by image blocks on text-only models."""
        lowered = error_text.lower()
        return (
            ("image_url" in lowered and "expected `text`" in lowered)
            or "unknown variant `image_url`" in lowered
            or (
                has_images
                and (
                    "upstream request failed" in lowered
                    or ("image" in lowered and ("not support" in lowered or "unsupported" in lowered))
                )
            )
        )

    def _is_reasoning_effort_error(self, error_text: str) -> bool:
        """Detect provider errors caused by an unsupported ``reasoning_effort``
        value (e.g. ``"minimal"`` on a model that only accepts
        ``none/low/medium/high/xhigh``). The provider message reliably
        mentions the parameter name.

        Also covers non-reasoning models behind a gateway that maps
        ``reasoning_effort`` onto its own thinking flag and rejects it with
        ``"<model> does not support thinking"``. Retrying without
        ``reasoning_effort`` lets these models run."""
        lowered = error_text.lower()
        return "reasoning_effort" in lowered or "does not support thinking" in lowered

    @classmethod
    def from_config(cls, model_config: dict[str, str]):
        """
        Create a client instance from model configuration.
        
        Args:
            model_config: Dictionary containing endpoint, model, api_key, api_base, api_version
            
        Returns:
            Client instance for making API calls
        """
        # Strip whitespace from all values
        for key in model_config:
            if isinstance(model_config[key], str):
                model_config[key] = model_config[key].strip()

        return cls(
            model_config["endpoint"],
            model_config["model"],
            model_config.get("api_key"),
            model_config.get("api_base"),
            model_config.get("api_version")
        )

    def ping(self, timeout: int = 10):
        """Lightweight connectivity check: send a minimal completion with
        max_tokens=3 and a short timeout.  Raises on any failure."""
        messages = [{"role": "user", "content": "Reply only 'ok'."}]
        params = self.params.copy()
        params["timeout"] = timeout
        # Through _complete so a keyless-model 401 reads as "add the key"
        # rather than the endpoint's own "Missing Authentication header".
        self._complete(buffered=True, model=self.model, messages=messages,
                       max_tokens=3, drop_params=True, _skip_mcp_handler=True,
                       **params)

    def _dispatch(self, *, messages, stream, params, tools=None, extra=None):
        """Issue the LiteLLM call, absorbing the ways an OpenAI-compatible
        gateway can differ from OpenAI itself.

        Three of those differences used to end a chat with no reply:

        * **Streaming refused.** Some gateways ignore ``stream: true`` and
          answer with one buffered JSON body; the OpenAI client cannot read
          that as a stream and raises a bare "Connection error", which reads
          like the endpoint is down. We retry the same call buffered and replay
          it as a stream, so the agents keep one code path.
        * **Tool calls as content.** A gateway that has no native function
          calling — or a weak model behind one — writes the call as a JSON
          object in ``content``. ``_salvage_tool_calls_from_content`` recovers
          it; it runs over every buffered response.
        * **Tools rejected outright.** Re-raised with wording that names the
          endpoint's missing capability instead of the raw parameter error.
        """
        call_kwargs = dict(model=self.model, messages=messages,
                           drop_params=True,
                           # We never use litellm's built-in MCP gateway. Setting this
                           # skips litellm's proxy/MCP handler import path, which pulls
                           # in fastapi and is not a dependency of this project
                           # (litellm>=1.92 imports it whenever `tools` are passed).
                           _skip_mcp_handler=True,
                           **params, **(extra or {}))
        if tools is not None:
            call_kwargs["tools"] = tools

        if not stream:
            response = self._complete(buffered=True, **call_kwargs)
            return _salvage_tool_calls_from_content(response, tools) if tools else response

        stream_error = None
        head, produced = [], False
        try:
            chunks = self._complete(buffered=False, **call_kwargs)
            head, produced = _drain_until_output(chunks)
        except EndpointCapabilityError:
            # A capability the endpoint lacks; a second attempt cannot supply it.
            raise
        except Exception as e:
            stream_error = e

        if produced:
            return _guard_stream(itertools.chain(head, chunks))

        # Nothing came back on the stream — either the call failed outright, or
        # the endpoint ignored ``stream: true`` and answered with one buffered
        # JSON body that the streaming reader silently reads as empty. Both
        # look identical from here, and both are fixed by asking again without
        # streaming.
        try:
            response = self._complete(buffered=True, **call_kwargs)
        except Exception:
            # The endpoint is genuinely failing. Report why the stream failed
            # if we have it; otherwise let the guard explain the empty answer.
            if stream_error is not None:
                raise stream_error from None
            return _guard_stream(iter(head))

        logger.info("Endpoint returned nothing on the stream (%s); retried "
                    "buffered and replayed the answer as a stream",
                    str(stream_error)[:120] if stream_error else "empty stream")
        if tools:
            response = _salvage_tool_calls_from_content(response, tools)
        return _guard_stream(_synthesize_stream(response))

    def _complete(self, *, buffered, **call_kwargs):
        """Call LiteLLM, translating two endpoint errors into plain wording.

        Left raw, both send the user hunting in the wrong place: a missing key
        surfaces as the endpoint's own "Missing Authentication header" (which
        reads like a server fault), and a gateway without function calling
        surfaces as an opaque parameter error.
        """
        try:
            return litellm.completion(stream=not buffered, **call_kwargs)
        except Exception as e:
            message = str(e)
            if _is_tool_support_error(message):
                raise EndpointCapabilityError(
                    "This endpoint rejected the tool definitions the agent "
                    "needs, so it cannot run the data agents. Point the model "
                    "at an endpoint with OpenAI-style function calling."
                ) from e
            if self._is_missing_key_error(message):
                raise EndpointCapabilityError(
                    "The endpoint refused the request for lack of credentials, "
                    "and this model is configured without an API key. Add the "
                    "key to the model's configuration."
                ) from e
            raise

    def _is_missing_key_error(self, error_text: str) -> bool:
        """Whether a 401 came back on a model configured with no API key.

        ``self.params['api_key']`` is the ``"not-needed"`` placeholder in that
        case (LiteLLM requires the field), so the endpoint saw a nonsense
        bearer token and answered as if none was sent.
        """
        if self.params.get("api_key") != "not-needed":
            return False
        lowered = error_text.lower()
        return ("authenticationerror" in lowered
                or "missing authentication" in lowered
                or "invalid api key" in lowered
                or "401" in lowered)

    def get_completion(self, messages, stream=False, reasoning_effort="low",
                       **kwargs):
        """Send a chat completion request via LiteLLM.

        ``drop_params=True`` ensures parameters the endpoint does not know
        (like ``reasoning_effort`` on a non-reasoning model) are dropped
        rather than causing errors.
        """
        params = self.params.copy()
        params["reasoning_effort"] = reasoning_effort
        params.update(kwargs)
        try:
            return self._dispatch(messages=messages, stream=stream, params=params)
        except Exception as e:
            err = str(e)
            if self._is_reasoning_effort_error(err):
                params.pop("reasoning_effort", None)
                return self._dispatch(messages=messages, stream=stream, params=params)
            if self._is_image_deserialize_error(err, self._messages_contain_images(messages)):
                sanitized = self._strip_images_from_messages(messages)
                return self._dispatch(messages=sanitized, stream=stream, params=params)
            raise

    def get_completion_with_tools(self, messages, tools, stream=False,
                                  reasoning_effort="low", **kwargs):
        """Send a chat completion request with tool definitions via LiteLLM.

        Same as ``get_completion`` but accepts ``tools`` (and optional
        ``tool_choice``, ``parallel_tool_calls``, etc. via ``**kwargs``).
        """
        params = self.params.copy()
        params["reasoning_effort"] = reasoning_effort
        try:
            return self._dispatch(messages=messages, stream=stream,
                                  params=params, tools=tools, extra=kwargs)
        except Exception as e:
            err = str(e)
            if self._is_reasoning_effort_error(err):
                params.pop("reasoning_effort", None)
                return self._dispatch(messages=messages, stream=stream,
                                      params=params, tools=tools, extra=kwargs)
            if self._is_image_deserialize_error(err, self._messages_contain_images(messages)):
                sanitized = self._strip_images_from_messages(messages)
                return self._dispatch(messages=sanitized, stream=stream,
                                      params=params, tools=tools, extra=kwargs)
            raise