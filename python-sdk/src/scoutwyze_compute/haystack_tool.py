"""Haystack Tool wrapping ScoutWyze Compute's compute/rank endpoint —
drop this into an Agent's toolset so it can look up ranked GPU offers
mid-pipeline.

    pip install "scoutwyze-compute[haystack]"

By default this wraps the Bearer rail (a human funds an account once,
see client.py's rank_via_bearer docstring) since that's the simpler
integration for an Agent that already expects a single credential in
an env var, the same shape as any other API-key tool. An x402 variant
is included too (make_x402_tool) for an agent that holds its own
wallet and would rather pay per call with no signup step at all — see
client.py's rank_via_x402 for what that actually does (real on-chain
USDC transfer, not a mock).
"""

import os
from typing import Annotated, Optional

from haystack.tools import Tool, create_tool_from_function

from .client import DEFAULT_BASE_URL, rank_via_bearer, rank_via_x402

RANK_DESCRIPTION = (
    "Ranks current RunPod GPU offers by price and freshness for a given workload. "
    "Billed per successful match — never charged on a no_match/no_inventory result. "
    "Returns a recommended offer plus alternatives, each with real observed_at/freshness_seconds."
)

X402_RANK_DESCRIPTION = (
    "Ranks current RunPod GPU offers by price and freshness for a given workload, paid per call "
    "via a real on-chain USDC transfer on Base — no signup, no API key. Settles BEFORE scoring: "
    "a no_match result is still billed, with no refund path (this is an x402 protocol property, "
    "not a bug). Only use this if the calling agent holds a funded Base wallet."
)


def _rank_params(
    gpuClass: Optional[str],
    minVramGb: Optional[float],
    region: Optional[str],
    maxPricePerHour: Optional[float],
    preference: str,
) -> dict:
    # Only include fields the caller actually set — the server treats
    # an omitted optional field differently from an explicit null in
    # some places (e.g. request-hash binding for receipt reuse), so
    # don't send nulls for fields left at their default.
    raw = {
        "gpuClass": gpuClass,
        "minVramGb": minVramGb,
        "region": region,
        "maxPricePerHour": maxPricePerHour,
        "preference": preference,
    }
    return {k: v for k, v in raw.items() if v is not None}


def make_bearer_tool(api_key: Optional[str] = None, base_url: str = DEFAULT_BASE_URL) -> Tool:
    """Bearer-rail tool — reads SCOUTWYZE_API_KEY from the environment
    if api_key isn't passed explicitly, the same convention the MCP
    server (@scoutwyze/compute-mcp) already uses."""
    resolved_key = api_key or os.environ.get("SCOUTWYZE_API_KEY")

    def scoutwyze_rank(
        gpuClass: Annotated[Optional[str], "Filter by GPU model substring, e.g. H100 (case-insensitive)"] = None,
        minVramGb: Annotated[Optional[float], "Minimum GPU memory in GB"] = None,
        region: Annotated[Optional[str], "Filter by region prefix (case-insensitive)"] = None,
        maxPricePerHour: Annotated[Optional[float], "Maximum vendor hourly price in USD"] = None,
        preference: Annotated[str, 'Ranking strategy: "cheapest", "fastest", or "balanced"'] = "cheapest",
    ) -> dict:
        if not resolved_key:
            return {"error": "no_api_key", "message": "Set SCOUTWYZE_API_KEY or pass api_key= to make_bearer_tool()."}
        params = _rank_params(gpuClass, minVramGb, region, maxPricePerHour, preference)
        result = rank_via_bearer(base_url, resolved_key, params)
        return result["body"]

    return create_tool_from_function(scoutwyze_rank, name="scoutwyze_rank", description=RANK_DESCRIPTION)


def make_x402_tool(private_key: Optional[str] = None, base_url: str = DEFAULT_BASE_URL) -> Tool:
    """x402-rail tool — for an agent that holds its own funded Base
    wallet and would rather pay per call than go through a signup
    step. Reads SCOUTWYZE_WALLET_PRIVATE_KEY from the environment if
    private_key isn't passed explicitly. Every call that reaches a
    real match moves real USDC — see client.py's rank_via_x402
    docstring for the settle-before-scoring asymmetry this rail has."""
    resolved_key = private_key or os.environ.get("SCOUTWYZE_WALLET_PRIVATE_KEY")

    def scoutwyze_rank_x402(
        gpuClass: Annotated[Optional[str], "Filter by GPU model substring, e.g. H100 (case-insensitive)"] = None,
        minVramGb: Annotated[Optional[float], "Minimum GPU memory in GB"] = None,
        region: Annotated[Optional[str], "Filter by region prefix (case-insensitive)"] = None,
        maxPricePerHour: Annotated[Optional[float], "Maximum vendor hourly price in USD"] = None,
        preference: Annotated[str, 'Ranking strategy: "cheapest", "fastest", or "balanced"'] = "cheapest",
    ) -> dict:
        if not resolved_key:
            return {"error": "no_private_key", "message": "Set SCOUTWYZE_WALLET_PRIVATE_KEY or pass private_key= to make_x402_tool()."}
        params = _rank_params(gpuClass, minVramGb, region, maxPricePerHour, preference)
        result = rank_via_x402(base_url, resolved_key, params)
        return result["body"]

    return create_tool_from_function(scoutwyze_rank_x402, name="scoutwyze_rank_x402", description=X402_RANK_DESCRIPTION)
