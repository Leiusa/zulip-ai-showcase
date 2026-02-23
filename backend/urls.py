from django.urls import path

from zerver.lib.rest import rest_dispatch
from zerver.views.message_recap import message_recap
from zerver.views.topic_improver import suggest_topic_title_backend

urlpatterns = [
    path("json/ai/message_recap", message_recap, name="message_recap"),
    path(
        "json/ai/suggest_topic_title",
        rest_dispatch,
        {"POST": suggest_topic_title_backend},
    ),
]