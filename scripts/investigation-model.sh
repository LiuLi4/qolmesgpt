#!/usr/bin/env bash
# Resolve one provider as a unit, so unrelated inherited credentials cannot override it.
resolve_investigation_model() {
  if [[ -n "${YUANXI_BASE_URL:-}${YUANXI_API_KEY:-}${YUANXI_MODEL:-}" ]]; then
    if [[ -z "${YUANXI_BASE_URL:-}" || -z "${YUANXI_API_KEY:-}" || -z "${YUANXI_MODEL:-}" ]]; then
      echo "Set YUANXI_BASE_URL, YUANXI_API_KEY and YUANXI_MODEL together in the local model environment file" >&2
      return 1
    fi
    API_BASE="${YUANXI_BASE_URL%/}"
    if [[ "$API_BASE" != https://*/v1 || "$API_BASE" == *'?'* || "$API_BASE" == *'#'* || "$API_BASE" == *'@'* ]]; then
      echo "YUANXI_BASE_URL must be an HTTPS base URL ending in /v1, without credentials, query or fragment" >&2
      return 1
    fi
    # YUANXI_MODEL is the wire model ID, even when it contains a provider prefix.
    MODEL="openai/$YUANXI_MODEL"
    API_KEY="$YUANXI_API_KEY"
  else
    if [[ -z "${MODEL:-}" ]]; then
      echo "Set MODEL or configure the company YUANXI_* variables" >&2
      return 1
    fi
    if [[ -z "${API_KEY:-}" ]]; then
      case "$MODEL" in
        openrouter/*)
          if [[ -n "${API_BASE:-}" && "$API_BASE" != https://openrouter.ai/api/v1 ]]; then
            echo "Set API_KEY explicitly for a custom API_BASE" >&2
            return 1
          fi
          API_KEY="${OPENROUTER_API_KEY:-}"
          API_BASE="${API_BASE:-https://openrouter.ai/api/v1}"
          ;;
        anthropic/*) API_KEY="${ANTHROPIC_API_KEY:-}" ;;
        *)
          API_KEY="${OPENAI_API_KEY:-}"
          # Preserve the original OpenRouter-only setup, but never pair its key
          # with a custom base URL or override an explicit key.
          if [[ -z "$API_KEY" && -z "${API_BASE:-}" && -n "${OPENROUTER_API_KEY:-}" ]]; then
            API_KEY="$OPENROUTER_API_KEY"
            API_BASE="https://openrouter.ai/api/v1"
          fi
          ;;
      esac
    fi
    if [[ -z "${API_KEY:-}" ]]; then
      echo "Configure the selected model provider's API key locally" >&2
      return 1
    fi
  fi
  export MODEL API_KEY API_BASE
}
