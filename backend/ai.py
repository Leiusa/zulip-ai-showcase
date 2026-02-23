import logging
from typing import List, Optional

import requests
from django.conf import settings
from django.utils.html import escape

logger = logging.getLogger(__name__)

def generate_message_recap(messages: List[str], message_ids: List[int], max_tokens: int = 800) -> str:
    """
    Generate a concise HTML recap for the provided message texts, in the order of message_ids.
    Returns a (mostly) safe HTML string.
    """
    if not messages:
        return "<p>(no messages)</p>"

    # Config
    api_key: Optional[str] = getattr(settings, "LLM_API_KEY", None)
    provider: str = getattr(settings, "LLM_PROVIDER", "openai")
    model: str = getattr(settings, "LLM_MODEL", "gpt-4o-mini")

    # Bound prompt size (avoid huge prompts)
    labelled: List[str] = []
    for mid, text in zip(message_ids, messages):
        labelled.append(text[:3000])
    labelled = labelled[:200]

    if not api_key:
        logger.warning("LLM_API_KEY not configured; returning fallback recap")
        joined = "\n\n---\n\n".join(labelled[:10])
        # fallback: show first N messages
        return "<p><strong>Recap (fallback):</strong></p><pre>{}</pre>".format(escape(joined[:4000]))

    prompt_system = (
        "You are a concise assistant.\n"
        "Return ONLY valid HTML.\n"
        "DO NOT use Markdown.\n"
        "DO NOT wrap output in ``` or ```html.\n"
        "DO NOT include message IDs like MSG 12.\n"
        "Use <p>, <ul>, <li>, <strong> only.\n"
    )
    prompt_user = "Messages:\n\n" + "\n\n---\n\n".join(labelled)

    try:
        if provider != "openai":
            raise RuntimeError(f"Unsupported LLM_PROVIDER: {provider}")

        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": prompt_system},
                {"role": "user", "content": prompt_user},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }

        resp = requests.post(url, headers=headers, json=payload, timeout=20)
        resp.raise_for_status()
        logger.warning("LLM status=%s", resp.status_code)
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            return "<p>(empty recap)</p>"
        logger.warning("LLM content len=%s head=%r", len(content), content[:200])

    except Exception:
        logger.exception("LLM request failed; returning fallback recap")
        joined = "\n\n---\n\n".join(labelled[:10])
        return "<p><strong>Recap (fallback):</strong></p><pre>{}</pre>".format(escape(joined[:4000]))

    import bleach

    ALLOWED_TAGS = [
        "div","p","br","strong","em","ul","ol","li","a","code","pre","blockquote",
        "h1","h2","h3","h4","h5","h6","span"
    ]
    ALLOWED_ATTRS = {
        "a": ["href", "title", "target", "rel"],
        "span": ["class"],
        "div": ["class"],
    }
    
    clean = bleach.clean(content, tags=ALLOWED_TAGS, attributes=ALLOWED_ATTRS, strip=True)
    def strip_code_fence(s: str) -> str:
        s = s.strip()
        if s.startswith("```"):
            s = s.split("\n", 1)[1]
            s = s.rsplit("```", 1)[0]
        return s.strip()
    
    content = strip_code_fence(content)
    return f"<div class='ai-recap'>{clean}</div>"

# New: low-cost topic title suggestion optimized for scale
def suggest_topic_title(messages: List[str], current_title: Optional[str] = None, max_tokens: int = 64) -> str:
    """
    Suggest a concise single-line topic/title for the conversation represented by `messages`.
    Uses a cheaper model and tight token limits to be cost/latency conscious.
    Returns a plain string (no HTML). Always returns a short, cleaned fallback if the LLM call fails.
    """
    # Defensive truncation: keep recent context, but bound input size
    if not messages:
        return ""

    api_key: Optional[str] = getattr(settings, "LLM_API_KEY", None)
    provider: str = getattr(settings, "LLM_PROVIDER", "openai")
    model: str = getattr(settings, "LLM_TOPIC_MODEL", "gpt-3.5-turbo")  # default cheaper model
    try:
        labelled = []
        # Prefer the most recent messages to detect "drift" quickly
        recent = messages[-30:]  # cap number of messages to include
        for text in recent:
            labelled.append(text[:800])  # cap per-message length
        prompt_system = (
            "You generate short Zulip topic titles.\n"
            "Return ONLY the title text (no quotes, no markdown).\n"
            "Keep it <= 60 characters.\n"
            "Do NOT reuse boilerplate prefixes from the current topic (e.g., 'Changing focus to', 'Topic shift:', 'New topic:', 'Discussion:').\n"
            "Write the title as a neutral noun phrase describing the subject.\n"
            "If the current topic is still accurate, return an empty string."
        )

        user_parts = [
            f"Current topic: {current_title}",
            "",
            "Recent messages:",
            *messages,
            "",
            "Suggest a better topic title if the discussion focus has changed."
        ]
        if current_title:
            user_parts.append(f"Current title: {current_title}\n")
        user_parts.append("Recent messages:\n")
        user_parts.append("\n\n---\n\n".join(labelled))
        prompt_user = "\n".join(user_parts)

        if not api_key:
            # Fallback: try to heuristically craft a title from first sentence of the latest message(s)
            candidate = labelled[-1].split("\n", 1)[0].strip()[:60]
            return candidate or (current_title or "")

        if provider != "openai":
            raise RuntimeError(f"Unsupported LLM_PROVIDER: {provider}")

        url = "https://api.openai.com/v1/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": prompt_system},
                {"role": "user", "content": prompt_user},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
        }

        resp = requests.post(url, headers=headers, json=payload, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
        suggestion = content.strip().splitlines()[0][:60]
        # final sanity: remove angle brackets / excessive whitespace
        suggestion = suggestion.replace("\n", " ").strip()
        return suggestion
    except Exception:
        logger.exception("Topic suggestion LLM failed; using fallback heuristic")
        candidate = (messages[-1].split("\n", 1)[0].strip()[:60]) if messages else ""
        return candidate or (current_title or "")

