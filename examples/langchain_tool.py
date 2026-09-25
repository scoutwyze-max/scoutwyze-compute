#!/usr/bin/env python3
"""LangChain Tool wrapping ScoutWyze Compute's compute/rank endpoint —
drop this into an agent's toolset so it can look up ranked GPU offers
mid-conversation.

    pip install langchain-core eth_account

By default this wraps the Bearer rail (a human funds an account once,
see python_client.py's rank_via_bearer docstring) since that's the
simpler integration for a LangChain agent that already expects a
single credential in an env var, the same shape as any other API-key
tool. An x402 variant is included too (scoutwyze_rank_x402_tool) for
an agent that holds its own wallet and would rather pay per call with
no signup step at all — see python_client.py's rank_via_x402 for what
that actually does (real on-chain USDC transfer, not a mock).
"""

import os

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from python_client import rank_via_bearer, rank_via_x402

DEFAULT_BASE_URL = "https://scoutwyze-compute.fly.dev"


class RankGpuOffersInput(BaseModel):
    gpuClass: str | None = Field(default=None, description='Filter by GPU model substring, e.g. "H100" (case-insensitive)')
    minVramGb: float | None = Field(default=None, description="Minimum GPU memory in GB")
    region: str | None = Field(default=None, description="Filter by region prefix (case-insensitive)")
    maxPricePerHour: float | None = Field(default=None, description="Maximum vendor hourly price in USD")
    preference: str = Field(default="cheapest", description='Ranking strategy: "cheapest", "fastest", or "balanced"')


def _params_from(input_model: RankGpuOffersInput) -> dict:
    # Only include fields the caller actually set — the server treats
    # an omitted optional field differently from an explicit null in
    # some places (e.g. request-hash binding for receipt reuse), so
    # don't send nulls for fields the model left at their default.
    return {k: v for k, v in input_model.model_dump().items() if v is not None}


def make_bearer_tool(api_key: str | None = None, base_url: str = DEFAULT_BASE_URL) -> StructuredTool:
    """Bearer-rail tool — reads SCOUTWYZE_API_KEY from the environment
    if api_key isn't passed explicitly, the same convention the MCP
    server (mcp-server/) already uses."""
    resolved_key = api_key or os.environ.get("SCOUTWYZE_API_KEY")

    def _run(**kwargs) -> dict:
        if not resolved_key:
            return {"error": "no_api_key", "message": "Set SCOUTWYZE_API_KEY or pass api_key= to make_bearer_tool()."}
        result = rank_via_bearer(base_url, resolved_key, _params_from(RankGpuOffersInput(**kwargs)))
        return result["body"]

    return StructuredTool.from_function(
        func=_run,
        name="scoutwyze_rank",
        description=(
            "Ranks current RunPod GPU offers by price and freshness for a given workload. "
            "Billed per successful match — never charged on a no_match/no_inventory result. "
            "Returns a recommended offer plus alternatives, each with real observed_at/freshness_seconds."
        ),
        args_schema=RankGpuOffersInput,
    )


def make_x402_tool(private_key: str | None = None, base_url: str = DEFAULT_BASE_URL) -> StructuredTool:
    """x402-rail tool — for an agent that holds its own funded Base
    wallet and would rather pay per call than go through a signup
    step. Reads SCOUTWYZE_WALLET_PRIVATE_KEY from the environment if
    private_key isn't passed explicitly. Every call that reaches a
    real match moves real USDC — see python_client.py's rank_via_x402
    docstring for the settle-before-scoring asymmetry this rail has."""
    resolved_key = private_key or os.environ.get("SCOUTWYZE_WALLET_PRIVATE_KEY")

    def _run(**kwargs) -> dict:
        if not resolved_key:
            return {"error": "no_private_key", "message": "Set SCOUTWYZE_WALLET_PRIVATE_KEY or pass private_key= to make_x402_tool()."}
        result = rank_via_x402(base_url, resolved_key, _params_from(RankGpuOffersInput(**kwargs)))
        return result["body"]

    return StructuredTool.from_function(
        func=_run,
        name="scoutwyze_rank_x402",
        description=(
            "Ranks current RunPod GPU offers by price and freshness for a given workload, paid per call "
            "via a real on-chain USDC transfer on Base — no signup, no API key. Settles BEFORE scoring: "
            "a no_match result is still billed, with no refund path (this is an x402 protocol property, "
            "not a bug). Only use this if the calling agent holds a funded Base wallet."
        ),
        args_schema=RankGpuOffersInput,
    )
