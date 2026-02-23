from django.http import HttpRequest, HttpResponse
from zerver.lib.response import json_success
from zerver.lib.exceptions import JsonableError
from zerver.models import Message
from typing import List
from zerver.models import UserProfile
from zerver.decorator import human_users_only 
from zerver.lib.ai import generate_message_recap

import logging
import json

@human_users_only
def message_recap(request: HttpRequest, user: UserProfile) -> HttpResponse:
    # First, try to get message_ids from form-encoded POST
    raw_ids = request.POST.getlist("message_ids")

    # If empty, try to parse JSON body (client may send JSON)
    if not raw_ids:
        try:
            if request.body:
                payload = json.loads(request.body.decode())
                if isinstance(payload, dict) and "message_ids" in payload and isinstance(payload["message_ids"], list):
                    raw_ids = [str(x) for x in payload["message_ids"]]
        except Exception:
            logger.exception("Failed to parse JSON body for message_recap")

    if not raw_ids:
        raise JsonableError("message_ids is required")

    try:
        message_ids: List[int] = [int(mid) for mid in raw_ids]
    except ValueError:
        raise JsonableError("message_ids must be integers")

    if len(message_ids) > 200:
        raise JsonableError("Too many messages requested (max 200)")

    msgs_map = {
        m.id: m
        for m in Message.objects.filter(id__in=message_ids).only("id", "content")
    }
    ordered_msgs = [msgs_map[mid] for mid in message_ids if mid in msgs_map]

    texts = [m.content or "" for m in ordered_msgs]
    ordered_ids = [m.id for m in ordered_msgs]

    try:
        recap_html = generate_message_recap(texts, ordered_ids, max_tokens=800)
    except Exception:
        logger.exception("generate_message_recap failed")
        raise JsonableError("Recap generation failed; check server logs")

    message_refs = [
        {
            "message_id": m.id,
            "anchor": f"/#narrow/near/{m.id}",
            "snippet": (m.content or "")[:300].replace("\n", " "),
        }
        for m in ordered_msgs
    ]
    # Return actual recap_html & refs
    #return json_success({
    #    "recap_html": recap_html,
    #    "message_refs": message_refs,
    #})
    return json_success(request, {"recap_html": recap_html, "message_refs": message_refs})