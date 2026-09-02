import os
from typing import Optional, Dict, List

#: The single provider type every configured model uses. Kept in step with
#: :attr:`data_formulator.agents.client_utils.Client.ENDPOINT`.
ENDPOINT = "custom"


class ModelRegistry:
    """
    Load the server's model configurations from environment variables.

    Every model is a **custom OpenAI-compatible endpoint** — an internal
    gateway, a LiteLLM proxy, vLLM, Ollama's OpenAI shim, Azure AI Foundry's
    ``/openai/v1`` surface. There are no hosted-provider shortcuts: the name
    you choose is only a label, and the base URL decides where calls go.

    For each provider, set:
        {PROVIDER}_ENABLED=true
        {PROVIDER}_API_BASE=<url>         # required, e.g. https://gateway/v1
        {PROVIDER}_API_KEY=<key>          # optional; omit for a keyless endpoint
        {PROVIDER}_API_VERSION=<ver>      # optional
        {PROVIDER}_MODELS=model-a,model-b

    These variables are the only way to publish a model: the UI cannot add one,
    so the endpoints and keys a deployment will ever call are fixed by whoever
    controls the server's environment. API keys stay server-side; the public
    information returned to the frontend contains no sensitive fields.
    """

    def __init__(self) -> None:
        self._models: Dict[str, dict] = {}
        self._reload()

    @staticmethod
    def make_id(provider: str, model: str) -> str:
        return f"global-{provider}-{model}"

    def _discover_providers(self) -> List[str]:
        """
        Return the lowercase names of all enabled providers by scanning
        every environment variable that ends with _ENABLED=true.
        """
        providers: List[str] = []
        for key, val in os.environ.items():
            if key.upper().endswith("_ENABLED") and val.strip().lower() == "true":
                prefix = key[: -len("_ENABLED")].lower()
                providers.append(prefix)
        return providers

    def _reload(self) -> None:
        self._models = {}
        for provider in self._discover_providers():
            env = provider.upper()

            api_key = os.getenv(f"{env}_API_KEY", "").strip()
            api_base = os.getenv(f"{env}_API_BASE", "").strip()
            api_version = os.getenv(f"{env}_API_VERSION", "").strip()
            models_str = os.getenv(f"{env}_MODELS", "").strip()

            # No base URL means there is nowhere to send the request: every
            # model here is a custom endpoint, and none of them have a default.
            if not api_base or not models_str:
                continue

            for model_name in models_str.split(","):
                model_name = model_name.strip()
                if not model_name:
                    continue

                model_id = self.make_id(provider, model_name)
                self._models[model_id] = {
                    "id": model_id,
                    "endpoint": ENDPOINT,
                    "model": model_name,
                    "api_key": api_key,
                    "api_base": api_base,
                    "api_version": api_version,
                    "provider_display": provider,
                }

    def get_config(self, model_id: str) -> Optional[dict]:
        """Return the full config (including credentials) for a global model."""
        return self._models.get(model_id)

    def list_public(self) -> list:
        """
        Return public info for all globally configured models.
        Sensitive fields (api_key) are intentionally excluded.
        """
        return [
            {
                "id": m["id"],
                "endpoint": m["endpoint"],
                "model": m["model"],
                "api_base": m["api_base"],
                "api_version": m["api_version"],
                "auth_mode": "key",
                "is_global": True,
            }
            for m in self._models.values()
        ]

    def is_global(self, model_id: str) -> bool:
        return model_id in self._models


model_registry = ModelRegistry()
