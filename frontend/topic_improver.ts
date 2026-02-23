// web/src/topic_improver.ts
//
// Stable approach: render our own floating UI in document.body.
// No dialog_widget / micromodal assumptions.
//
// Behavior:
// - Batch outgoing stream messages in groups of MIN_MSGS.
// - After each batch, call backend /json/ai/suggest_topic_title with message_ids + current_title.
// - If suggested_title returned, show a bottom-right floating panel with Apply/Dismiss.
// - Apply: rename the entire topic via PATCH /json/messages/{anchor_id} with propagate_mode=change_all.
// - Dismiss: hide; keep listening and start a new batch.
// - Avoid token spam: in_flight + cooldown.
// - Avoid repeated suggestions: suppress if similar to current_topic or same as last suggestion.
//
// Note: This module is invoked from transmit.ts after a message send succeeds.
//
import * as channel from "./channel.ts";
import _ from "lodash";

// ----------------------------
// Tunables
// ----------------------------
const MIN_MSGS = 3; 
const COOLDOWN_MS = 10_000;
const MAX_IDS_SENT = 50;

// Keyword overlap heuristics to suppress requests (client-side)
// If last suggestion is "close enough" to current topic, don't even request.
const SIMILARITY_MIN_WORD_LEN = 3;
const SIMILARITY_STOPWORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "about",
    "your",
    "you",
    "are",
    "was",
    "were",
    "will",
    "just",
    "like",
    "have",
    "has",
    "had",
    "been",
    "but",
    "not",
    "can",
    "could",
    "should",
    "would",
    "what",
    "when",
    "where",
    "why",
    "how",
    "topic",
    "shift",
    "new",
    "changing","focus","solving","question","questions","issue","issues","help",
  "problem","problems","discussion","update","status","working","running",
  "quickly","failed","export"
]);

// ----------------------------
// Local state (resets on reload)
// ----------------------------
let batch_ids: number[] = [];
let in_flight = false;
let last_request_ts = 0;

let last_topic_seen = "";
let last_suggested_title = ""; // last one we showed/applied/dismissed (to avoid repeats)

const DEBUG = true;
function debug_log(...args: unknown[]): void {
    if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}

// ----------------------------
// Helper: current topic in compose box
// ----------------------------
function get_current_stream_topic(): string {
    const topic_input = document.querySelector<HTMLInputElement>("#stream_message_recipient_topic");
    if (!topic_input) {
        return "";
    }
    const value = topic_input.value.trim();
    if (value) {
        return value;
    }
    return (topic_input.getAttribute("placeholder") ?? "").trim();
}

// ----------------------------
// Similarity helper (cheap keyword overlap)
// ----------------------------
function tokenize(s: string): Set<string> {
    const words = (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= SIMILARITY_MIN_WORD_LEN)
        .filter((w) => !SIMILARITY_STOPWORDS.has(w));
    return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) {
        return 1;
    }
    if (a.size === 0 || b.size === 0) {
        return 0;
    }
    let inter = 0;
    for (const w of a) {
        if (b.has(w)) {
            inter += 1;
        }
    }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

// If last suggestion is already basically the current topic, we skip requesting.
function last_suggestion_covers_current_topic(current_topic: string): boolean {
    const s = last_suggested_title.trim();
    const c = current_topic.trim();
    if (!s || !c) {
        return false;
    }
    if (s.toLowerCase() === c.toLowerCase()) {
        return true;
    }
    const s_tokens = tokenize(s);
    const c_tokens = tokenize(c);
    const sim = jaccard(s_tokens, c_tokens);
    // threshold: adjust if needed
    return sim >= 0.8;
}

// ----------------------------
// Rename topic (whole topic)
// ----------------------------
function rename_topic_via_message_id(anchor_id: number, new_topic: string): void {
    const trimmed = new_topic.trim();
    if (!trimmed) {
        return;
    }

    channel.patch({
        url: `/json/messages/${anchor_id}`,
        data: {
            topic: trimmed,
            propagate_mode: "change_all",
        },
        success() {
            last_suggested_title = trimmed;
            batch_ids = [];
            last_topic_seen = trimmed;
            last_request_ts = Date.now();
            hide_floating_ui("apply");
            debug_log("[topic_improver] renamed topic to:", trimmed);
        },
        error(xhr) {
            // eslint-disable-next-line no-console
            console.error("[topic_improver] Failed to rename topic", xhr);
        },
    });
}

// ----------------------------
// Floating UI (bottom-right) - stable
// ----------------------------
type FloatingSuggestion = {
    anchor_id: number;
    current_topic: string;
    suggested_title: string;
};

let floating_el: HTMLElement | null = null;
let floating_state: FloatingSuggestion | null = null;

function ensure_floating_ui(): void {
    if (floating_el) {
        return;
    }

    const el = document.createElement("div");
    el.id = "topic_improver_floating";
    el.style.position = "fixed";
    el.style.right = "16px";
    el.style.bottom = "16px";
    el.style.zIndex = "9999";
    el.style.maxWidth = "380px";
    el.style.padding = "12px";
    el.style.borderRadius = "10px";
    el.style.boxShadow = "0 6px 24px rgba(0,0,0,0.35)";
    el.style.background = "rgba(30,30,30,0.95)";
    el.style.color = "#fff";
    el.style.fontSize = "13px";
    el.style.display = "none";

    el.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <div style="font-weight:700;">Topic suggestion</div>
        <button type="button" data-ti-close
          style="background:transparent;border:none;color:#bbb;font-size:16px;cursor:pointer;line-height:1;">
          ×
        </button>
      </div>

      <div style="margin-top:8px;">
        <div style="opacity:0.75;">Current</div>
        <div data-ti-current style="margin-top:2px; font-weight:600; word-break:break-word;"></div>
      </div>

      <div style="margin-top:8px;">
        <div style="opacity:0.75;">Suggestion</div>
        <div data-ti-suggested style="margin-top:2px; font-weight:800; word-break:break-word;"></div>
      </div>

      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:10px;">
        <button type="button" data-ti-dismiss
          style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);
                 background:transparent;color:#fff;cursor:pointer;">
          Dismiss
        </button>
        <button type="button" data-ti-apply
          style="padding:6px 10px;border-radius:8px;border:none;
                 background:#6CFF9A;color:#111;font-weight:800;cursor:pointer;">
          Apply
        </button>
      </div>
    `;

    document.body.appendChild(el);
    floating_el = el;

    const close_btn = el.querySelector<HTMLButtonElement>("[data-ti-close]");
    const dismiss_btn = el.querySelector<HTMLButtonElement>("[data-ti-dismiss]");
    const apply_btn = el.querySelector<HTMLButtonElement>("[data-ti-apply]");

    close_btn?.addEventListener("click", () => hide_floating_ui("close"));

    dismiss_btn?.addEventListener("click", () => {
        if (floating_state?.suggested_title) {
            // record so we don't show the same suggestion again immediately
            last_suggested_title = floating_state.suggested_title;
        }
        hide_floating_ui("dismiss");
    });

    apply_btn?.addEventListener("click", () => {
        if (!floating_state) {
            return;
        }
        rename_topic_via_message_id(floating_state.anchor_id, floating_state.suggested_title);
    });
}

function show_floating_ui(s: FloatingSuggestion): void {
    ensure_floating_ui();
    if (!floating_el) {
        return;
    }
    floating_state = s;

    const current_el = floating_el.querySelector<HTMLElement>("[data-ti-current]");
    const suggested_el = floating_el.querySelector<HTMLElement>("[data-ti-suggested]");
    if (!current_el || !suggested_el) {
        return;
    }

    current_el.innerHTML = _.escape(s.current_topic);
    suggested_el.innerHTML = _.escape(s.suggested_title);

    floating_el.style.display = "block";
}

function hide_floating_ui(_reason: "dismiss" | "apply" | "close"): void {
    if (!floating_el) {
        return;
    }
    floating_el.style.display = "none";
    floating_state = null;
}

// ----------------------------
// Backend response type
// ----------------------------
type TopicSuggestionResponse = {
    suggested_title?: string;
    msg?: string;
    result?: string;
};

// ----------------------------
// Public API: called after message send success
// ----------------------------
export function maybe_request_topic_suggestion(message_ids: number[]): void {
    if (!message_ids || message_ids.length === 0) {
        return;
    }

    const current_topic = get_current_stream_topic();
    if (!current_topic) {
        return;
    }

    // Reset batching when user switched compose topic manually
    if (last_topic_seen && current_topic !== last_topic_seen) {
        batch_ids = [];
    }
    last_topic_seen = current_topic;

    // If last suggestion already matches current topic well, we don't even request.
    if (last_suggestion_covers_current_topic(current_topic)) {
        debug_log("[topic_improver] skip request: last suggestion covers current topic");
        // Still clear local batch to avoid immediate re-fire loops
        batch_ids = [];
        return;
    }

    for (const id of message_ids) {
        batch_ids.push(id);
    }

    debug_log("[topic_improver] state", {
        current_topic,
        batch_len: batch_ids.length,
        in_flight,
        last_suggested_title,
    });

    // Only fire when we collected MIN_MSGS
    if (batch_ids.length < MIN_MSGS) {
        return;
    }

    // “3条一包，不重叠”：用最后 MIN_MSGS 条，然后立即清空
    const ids_for_server = batch_ids.slice(-MIN_MSGS).slice(-MAX_IDS_SENT);
    batch_ids = [];

    if (in_flight) {
        return;
    }

    const now = Date.now();
    if (now - last_request_ts < COOLDOWN_MS) {
        debug_log("[topic_improver] cooldown active, skip");
        return;
    }

    const anchor_id = ids_for_server.at(-1);
    if (anchor_id === undefined) {
        return;
    }

    in_flight = true;
    last_request_ts = now;

    channel.post({
        url: "/json/ai/suggest_topic_title",
        data: {
            message_ids: ids_for_server,
            current_title: current_topic,
        },
        traditional: true,

        success(raw: unknown) {
            in_flight = false;
            const data = raw as TopicSuggestionResponse;
            const suggested_title = (data.suggested_title ?? "").trim();

            debug_log("[topic_improver] response", data);

            if (!suggested_title) {
                return;
            }

            // Suppress if identical to the last suggested/applied/dismissed title
            if (suggested_title.toLowerCase() === last_suggested_title.trim().toLowerCase()) {
                return;
            }

            // Also suppress if suggestion is basically same as current topic (cheap overlap)
            const sim = jaccard(tokenize(suggested_title), tokenize(current_topic));
            if (sim >= 0.7) {
                debug_log("[topic_improver] suppress: suggestion too similar to current topic", sim);
                last_suggested_title = suggested_title; // optional: record it
                return;
            }

            // Show stable floating UI
            show_floating_ui({
                anchor_id,
                current_topic,
                suggested_title,
            });
        },

        error(xhr) {
            in_flight = false;
            // eslint-disable-next-line no-console
            console.error("[topic_improver] request failed", xhr);
        },
    });
}