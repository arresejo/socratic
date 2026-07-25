"""LLM client — ollama native API by default (supports `think:false`), with
an OpenAI-compatible fallback path (llama-server, or any /v1 endpoint).

Latency note (measured on gemma4:e4b / ollama 0.32): reasoning burns 1-2k
tokens per call. The native /api/chat honors think:false → ~5x faster.
The OpenAI-compat endpoint ignores it (as of 0.32), so the default SOCRATIC
config uses the native API. Set SOCRATIC_LLM_BASE to a .../v1 URL to switch
to OpenAI-compatible mode (think is then ignored by the server).

Env:
    SOCRATIC_LLM_BASE   default http://localhost:11434 (native ollama)
                        use http://host:port/v1 for OpenAI-compatible mode
    SOCRATIC_LLM_MODEL  default "gemma4:e4b"
"""

import json
import os
import re

import httpx

LLM_BASE = os.environ.get("SOCRATIC_LLM_BASE", "http://localhost:11434").rstrip("/")
LLM_MODEL = os.environ.get("SOCRATIC_LLM_MODEL", "gemma4:e4b")
LLM_TIMEOUT = float(os.environ.get("SOCRATIC_LLM_TIMEOUT", "300"))
NATIVE = "/v1" not in LLM_BASE  # ollama native vs OpenAI-compatible

# Edge story, made measurable: every token processed on this machine is a token
# that never reached a cloud API. Served by GET /api/stats.
STATS = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}


def _chat_once(system: str, user: str, temperature: float, max_tokens: int,
               think: bool) -> tuple[str, str]:
    """Returns (content, finish_reason). finish_reason 'length' = truncated."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    if NATIVE:
        payload = {
            "model": LLM_MODEL,
            "messages": messages,
            "stream": False,
            "think": think,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        r = httpx.post(f"{LLM_BASE}/api/chat", json=payload, timeout=LLM_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        STATS["calls"] += 1
        STATS["prompt_tokens"] += data.get("prompt_eval_count", 0)
        STATS["completion_tokens"] += data.get("eval_count", 0)
        return data.get("message", {}).get("content") or "", data.get("done_reason", "")
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    r = httpx.post(f"{LLM_BASE}/chat/completions", json=payload, timeout=LLM_TIMEOUT)
    r.raise_for_status()
    body = r.json()
    usage = body.get("usage") or {}
    STATS["calls"] += 1
    STATS["prompt_tokens"] += usage.get("prompt_tokens", 0)
    STATS["completion_tokens"] += usage.get("completion_tokens", 0)
    choice = body["choices"][0]
    return choice["message"].get("content") or "", choice.get("finish_reason", "")


def chat(system: str, user: str, temperature: float = 0.2, max_tokens: int = 4096,
         think: bool = False) -> str:
    content, finish = _chat_once(system, user, temperature, max_tokens, think)
    # Reasoning models may burn most of the token budget in chain-of-thought:
    # content comes back empty OR truncated with finish=length. One retry with
    # a much larger budget.
    if finish == "length":
        content, _ = _chat_once(system, user, temperature,
                                max(8192, max_tokens * 4), think)
    if not content.strip():
        raise RuntimeError("LLM returned empty content")
    return content


def extract_json(text: str):
    """Best-effort JSON extraction: raw, fenced, or first {...} / [...] slice."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        raise ValueError("no JSON object found in LLM output")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    if end <= start:
        raise ValueError("unbalanced JSON in LLM output")
    return json.loads(text[start : end + 1])


def chat_json(system: str, user: str, validator, temperature: float = 0.2,
              max_tokens: int = 4096, think: bool = False):
    """Call the LLM expecting JSON; on invalid output, one retry with the error
    message appended (SPEC §2.2). Raises on second failure — callers degrade
    gracefully, never crash the session (SPEC §5)."""
    raw = chat(system, user, temperature=temperature, max_tokens=max_tokens, think=think)
    try:
        return validator(extract_json(raw))
    except Exception as e:  # noqa: BLE001 — json/pydantic errors alike
        retry_user = (
            f"{user}\n\nYour previous output was invalid: {e}\n"
            "Output ONLY valid JSON matching the required schema, nothing else."
        )
        raw = chat(system, retry_user, temperature=temperature, max_tokens=max_tokens, think=think)
        return validator(extract_json(raw))
