import os

# Privacy: litellm fetches its model-cost map from raw.githubusercontent.com
# the first time it is imported. No user data is sent, but the request leaks
# the machine's IP and a "server started" signal to a third party, and it
# stalls startup by up to 5s with no network. litellm ships the same data as
# model_prices_and_context_window_backup.json, so forcing local use removes
# the request with no loss of function.
#
# Set unconditionally (not setdefault) and here in the package __init__, which
# Python executes before any data_formulator submodule -- and therefore before
# litellm is imported anywhere in this project, including under pytest and
# WSGI servers.
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"


def run_app():
    """Launch the Data Formulator Flask application."""
    # Import app only when actually running to avoid heavy imports at package load
    from data_formulator.app import run_app as _run_app
    return _run_app()

__all__ = [
    "run_app",
]
