# AI Features Showcase (Zulip)

## Project Goal
This showcase includes two AI features I implemented in a Zulip environment:

1. Automatic recap of unread messages (Unread Recap)
2. Automatic topic title suggestion when a channel discussion drifts (Topic Title Improver)

The goal is to improve information retrieval and discussion clarity while keeping model cost and latency under control.

## Implementation Approach

### 1) Unread Message Recap
- The frontend mounts an `Unread recap` entry in Inbox and sends unread message IDs to the backend.
- The backend fetches message content in the same order and calls an LLM to generate an HTML recap.
- The response also includes per-message references (message id + anchor + snippet), so users can jump back to source messages.
- Input size is bounded (max 200 messages) to avoid oversized requests.
- If LLM is unavailable or API key is missing, the feature falls back to a readable non-LLM response.

### 2) Topic Title Improver
- After each stream message send succeeds, the frontend batches message IDs (default: trigger every 3 messages).
- Before requesting the backend, client-side guards reduce noise:
  - cooldown window
  - similarity checks to suppress repeated suggestions
- The backend runs lightweight heuristics first (message count, average length, overlap with current title) and only calls the LLM when topic drift is likely.
- If a suggestion is returned, the frontend shows a non-blocking floating panel with `Apply` / `Dismiss`.
- `Apply` renames the whole topic using message edit API with `propagate_mode=change_all`.

## Technical Highlights
- Cost-aware design: batching + cooldown + server-side heuristics to reduce unnecessary LLM calls.
- Robustness: graceful fallback paths on both frontend and backend.
- Safety: recap HTML is sanitized before rendering (bleach).
- End-to-end delivery: implemented across send flow, backend routes, LLM integration, and user interaction.

## Directory Guide
- `frontend/recap.ts`: unread recap entry + rendering UI
- `frontend/topic_improver.ts`: trigger logic, dedupe/throttle, floating suggestion UI, apply action
- `backend/message_recap.py`: unread recap endpoint
- `backend/topic_improver.py`: topic suggestion endpoint + heuristics
- `backend/ai.py`: LLM calls and fallback logic (recap + title suggestion)
- `backend/urls.py`: API route wiring
