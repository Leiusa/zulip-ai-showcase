# zerver/views/topic_improver.py
from __future__ import annotations

import logging
from typing import List, Optional

from django.http import HttpRequest, HttpResponse
from django.views.decorators.http import require_POST

from zerver.lib.exceptions import JsonableError
from zerver.lib.response import json_success
from zerver.models import Message, UserProfile
import re
from zerver.lib.ai import suggest_topic_title
logger = logging.getLogger(__name__)
from django.conf import settings
logger.info("LLM_API_KEY present? %s", bool(getattr(settings, "LLM_API_KEY", None)))
logger.info("LLM_PROVIDER=%r LLM_TOPIC_MODEL=%r",
            getattr(settings, "LLM_PROVIDER", None),
            getattr(settings, "LLM_TOPIC_MODEL", None))

def _parse_int(value: Optional[str], field: str) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise JsonableError(f"{field} is not an integer")


def _parse_int_list_from_post(request: HttpRequest, key: str) -> List[int]:
    raw_list = request.POST.getlist(f"{key}[]")
    if not raw_list:
        raw_list = request.POST.getlist(key)

    out: List[int] = []
    for item in raw_list:
        if item == "":
            continue
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            raise JsonableError(f"{key} contains non-integer value")
    return out

@require_POST
def suggest_topic_title_backend(request: HttpRequest, user_profile: UserProfile) -> HttpResponse:
    current_title = request.POST.get("current_title", "") or ""
    message_id = _parse_int(request.POST.get("message_id"), "message_id")
    message_ids = _parse_int_list_from_post(request, "message_ids")

    logger.info(
        "topic_improver: received message_id=%s message_ids=%s current_title=%r POST_keys=%s",
        message_id,
        message_ids[-5:] if message_ids else [],
        current_title,
        sorted(request.POST.keys()),
    )

    if message_id is None and not message_ids:
        raise JsonableError("message_id or message_ids is required")

    # 1) anchor_id is used later for the "rename whole topic" PATCH (/json/messages/{id})
    anchor_id = message_id if message_id is not None else message_ids[-1]

    # 2) Core behavior: prioritize message_ids (current batch only), do not fetch extra history.
    texts: list[str] = []
    if message_ids:
        if len(message_ids) > 50:
            raise JsonableError("Too many messages requested (max 50)")

        msgs = list(Message.objects.filter(id__in=message_ids).only("id", "content"))
        msg_map = {m.id: (m.content or "").strip() for m in msgs}
        # Preserve frontend order.
        texts = [msg_map[mid] for mid in message_ids if mid in msg_map and msg_map[mid]]
    else:
        # Fallback: only message_id was provided.
        try:
            anchor = Message.objects.only("id", "content", "subject").get(id=anchor_id)
        except Message.DoesNotExist:
            raise JsonableError("anchor message not found")
        texts = [(anchor.content or "").strip()] if (anchor.content or "").strip() else []

    # ---- heuristics (restore) ----
    MIN_MSGS = 2
    MIN_AVG_LEN = 20
    TITLE_MATCH_RATIO = 0.6

    if len(texts) < MIN_MSGS:
        return json_success(request, {"suggested_title": "", "anchor_id": anchor_id})

    avg_len = sum(len(t) for t in texts) / len(texts)
    if avg_len < MIN_AVG_LEN:
        return json_success(request, {"suggested_title": "", "anchor_id": anchor_id})

    title_words = set(re.findall(r"\w{3,}", current_title.lower()))
    if title_words:
        matches = sum(1 for t in texts if any(w in t.lower() for w in title_words))
        if matches / len(texts) > TITLE_MATCH_RATIO:
            return json_success(request, {"suggested_title": "", "anchor_id": anchor_id})

    # 3) call LLM
    try:
        suggested = suggest_topic_title(messages=texts, current_title=current_title, max_tokens=40)
    except Exception:
        logger.exception("suggest_topic_title failed")
        suggested = ""

    return json_success(
        request,
        {
            "suggested_title": (suggested or "").strip(),
            "anchor_id": anchor_id,  # Required by frontend to rename the whole topic.
        },
    )
