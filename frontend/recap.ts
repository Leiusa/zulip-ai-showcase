import * as channel from "./channel.ts";
import * as dialog_widget from "./dialog_widget.ts";
import * as unread from "./unread.ts";

/**
 * Insert recap entry under VIEWS list in the left sidebar.
 * Then clicking it triggers show_unread_recap().
 *
 * Key rules:
 * - DO NOT use fetch() directly (CSRF + Zulip conventions)
 * - DO NOT manually manage CSRF tokens
 * - Use channel.post() so Zulip handles CSRF + error handling
 */

const RECAP_BTN_ID = "recap-inbox-btn";
const RECAP_PANEL_ID = "recap-main-view";

function unlock_page_scroll(): void {
    document.querySelector(".modal__overlay")?.remove();
    document.querySelector(".micromodal.modal--open")?.remove();

    // 2) 清理 body/html 上的滚动锁
    document.body.classList.remove("micromodal-open");
    document.documentElement.classList.remove("micromodal-open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    // 有些实现会用 overflowY / position 锁滚动
    (document.body.style as any).overflowY = "";
    (document.documentElement.style as any).overflowY = "";
    document.body.style.position = "";
    document.body.style.top = "";
}

function in_inbox_view(): boolean {
    return window.location.hash.startsWith("#inbox");
}

function get_inbox_main(): HTMLElement | null {
    const el = document.querySelector("#inbox-main");
    return el instanceof HTMLElement ? el : null;
}

function get_inbox_list(): HTMLElement | null {
    const el = document.querySelector("#inbox-list");
    return el instanceof HTMLElement ? el : null;
}

function remove_recap_ui(): void {
    document.getElementById(RECAP_PANEL_ID)?.remove();
    document.getElementById(RECAP_BTN_ID)?.remove();
}

function ensure_inbox_button(): void {
    if (!in_inbox_view()) {
        remove_recap_ui();
        return;
    }

    if (document.getElementById(RECAP_BTN_ID)) return;

    const inboxMain = get_inbox_main();
    if (!inboxMain) return;

    const btn = document.createElement("button");
    btn.id = RECAP_BTN_ID;
    btn.className = "button button-small";
    btn.textContent = "Unread recap";

    // 放在 Inbox 主界面右上角，不影响布局
    btn.style.position = "absolute";
    btn.style.top = "10px";
    btn.style.right = "10px";
    btn.style.zIndex = "20";

    // 确保父容器能作为定位参照
    const computed = window.getComputedStyle(inboxMain);
    if (computed.position === "static") {
        inboxMain.style.position = "relative";
    }

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        show_unread_recap();
    });

    inboxMain.appendChild(btn);
}

function setup_inbox_only_behavior(): void {
    const update = () => {
        ensure_inbox_button();
        if (!in_inbox_view()) {
            remove_recap_ui();
        }
        unlock_page_scroll();
    };

    window.addEventListener("hashchange", update);
    update();

    // Zulip 有时会重绘 DOM，不一定触发 hashchange，加 observer 兜底
    const obs = new MutationObserver(update);
    obs.observe(document.body, {childList: true, subtree: true});
}

window.addEventListener("load", setup_inbox_only_behavior);


export function show_unread_recap(): void {
    // unread.get_all_msg_ids() returns unread message ids across the realm.
    // Keep the request bounded.
    const ids = unread.get_all_msg_ids().slice(0, 200);

    if (ids.length === 0) {
        dialog_widget.launch({
            html_heading: "Unread recap",
            html_body: "<p>No unread messages.</p>",
            html_submit_button: "Close",
            close_on_submit: true,
        });
        return;
    }

    // Optional: show a quick loading dialog (you can remove if you dislike it)
    dialog_widget.launch({
    html_heading: "Unread recap",
    html_body: "<p>Generating recap…</p>",
    html_submit_button: "Close",
    close_on_submit: true,
    });

    channel.post({
        url: "/json/ai/message_recap",
        data: {message_ids: ids},
        traditional: true,
        success(data: any) {
            console.log("recap: raw response data:", data);
            const recap_html: string = data?.recap_html ?? "<p>(no recap)</p>";
            const refs = (data?.message_refs ?? []) as Array<{
                message_id: number;
                anchor: string;
                snippet: string;
            }>;
            document.querySelector(".modal__overlay")?.remove();
            document.querySelector(".micromodal.modal--open")?.remove();
            render_recap_panel(recap_html, refs);
        },
        error(xhr) {

            // Print detailed failure info to console for debugging
            // channel.xhr_error_message exists, but we can still show status code.
            console.error("recap request failed:", {
                status: xhr.status,
                responseText: xhr.responseText,
            });

            dialog_widget.launch({
              html_heading: "Unread recap",
              html_body: `<div id="unread-recap-loading"><p>Generating recap...</p></div>`,
              html_submit_button: "Close",
              close_on_submit: true,
            });
        },
    });
}

/* --------------------------- Panel rendering --------------------------- */

function render_recap_panel(recap_html: string, refs: Array<{message_id: number; anchor: string; snippet: string}>): void {
    // Remove existing panel if present
    document.getElementById(RECAP_PANEL_ID)?.remove();

    const panel = document.createElement("div");
    panel.id = RECAP_PANEL_ID;
    panel.className = "recap-main-view";
    panel.style.maxWidth = "min(980px, 100%)";
    panel.style.overflowWrap = "anywhere";  
    panel.style.padding = "16px";
    panel.style.boxSizing = "border-box";

    // Header
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.marginBottom = "12px";

    const title = document.createElement("h2");
    title.textContent = "Unread recap";
    title.style.margin = "0";
    title.style.fontSize = "18px";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.className = "button button-small";
    closeBtn.addEventListener("click", () => panel.remove());

    header.append(title, closeBtn);

    // Body
    const body = document.createElement("div");
    body.className = "recap-body";

    const recapWrapper = document.createElement("div");
    recapWrapper.className = "recap-html";
    // Assume server-side sanitized
    recapWrapper.innerHTML = recap_html;

    const refsWrapper = document.createElement("div");
    refsWrapper.className = "recap-refs";
    refsWrapper.style.marginTop = "16px";

    const refsTitle = document.createElement("h4");
    refsTitle.textContent = "References";
    refsTitle.style.margin = "0 0 8px 0";
    refsWrapper.appendChild(refsTitle);

    for (const r of refs) {
        const item = document.createElement("div");
        item.style.margin = "6px 0";

        const a = document.createElement("a");
        a.href = r.anchor;
        a.textContent = r.snippet || `Message ${r.message_id}`;

        // Close panel when user navigates
        a.addEventListener("click", () => {
    // 让跳转照常发生，但先把 recap panel 关掉
            panel.remove();

            // 下一帧/跳转后把滚动锁解除（关键）
            window.setTimeout(unlock_page_scroll, 0);
        });

        item.appendChild(a);
        refsWrapper.appendChild(item);
    }

    body.appendChild(recapWrapper);
    body.appendChild(refsWrapper);

    panel.appendChild(header);
    panel.appendChild(body);

    // 插入到 Inbox 未读列表下方（只在 Inbox）
    const inboxList = get_inbox_list();
    if (inboxList && inboxList.parentElement) {
        inboxList.parentElement.insertBefore(panel, inboxList.nextSibling);
        panel.scrollIntoView({behavior: "smooth", block: "start"});
        return;
    }

    // 如果没找到 inboxList，就退化插到 inboxMain 底部
    const inboxMain = get_inbox_main();
    if (inboxMain) {
        inboxMain.appendChild(panel);
        panel.scrollIntoView({behavior: "smooth", block: "start"});
        return;
    }

    // 最后兜底
    document.body.appendChild(panel);
    panel.scrollIntoView({behavior: "smooth"});
/*
    // Insert into center content area.
    // In Zulip, the center column is typically inside #home (or .app-main).
    const feed_container =
        document.querySelector<HTMLElement>("#message_feed_container") ||
        document.querySelector<HTMLElement>(".message-feed-container") ||
        document.querySelector<HTMLElement>("#main_div");

    if (feed_container) {
        // Put it at the very top of the feed container so it doesn't cover sidebar
        feed_container.prepend(panel);
        panel.scrollIntoView({behavior: "smooth", block: "start"});
        return;
    }

    // Fallback: try inside #home (NOT parentElement)
    const home = document.querySelector<HTMLElement>("#home");
    if (home) {
        home.prepend(panel);
        panel.scrollIntoView({behavior: "smooth", block: "start"});
        return;
    }

    // Last resort
    document.body.appendChild(panel);
    panel.scrollIntoView({behavior: "smooth", block: "start"});
}


export function mount_recap_button(): void {
    // Left sidebar root
    const sidebarRoot = document.querySelector("#left-sidebar-container") || document.querySelector("#left-sidebar");
    if (!sidebarRoot) {
        return;
    }

    // Remove existing entry to avoid duplicates during hot reload
    document.getElementById(RECAP_ENTRY_ID)?.remove();

    // Find the "Inbox" label; its closest <ul> is the VIEWS list we want
    const inboxLabel = Array.from(sidebarRoot.querySelectorAll("span.left-sidebar-navigation-label")).find(
        (s) => (s.textContent || "").trim() === "Inbox",
    );

    const viewsUl = inboxLabel?.closest("ul");
    if (!viewsUl) {
        console.warn("Could not find VIEWS list (Inbox label ul).");
        return;
    }

    const li = document.createElement("li");
    li.id = RECAP_ENTRY_ID;

    const a = document.createElement("a");
    a.href = "#";
    a.className = "left-sidebar-navigation-link";
    a.setAttribute("role", "button");

    // Keep the same markup style: label span only (no emoji)
    const label = document.createElement("span");
    label.className = "left-sidebar-navigation-label";
    label.textContent = "Recap messages";

    a.appendChild(label);
    li.appendChild(a);

    a.addEventListener("click", (e) => {
        e.preventDefault();
        show_unread_recap();
    });

    // Insert at end of VIEWS list (or use appendChild/insertBefore as you prefer)
    viewsUl.appendChild(li);
}

function mount_when_sidebar_ready(): void {
    const try_mount = (): boolean => {
        const sidebar = document.querySelector("#left-sidebar");
        if (!sidebar) {
            return false;
        }
        mount_recap_button();
        return true;
    };

    if (try_mount()) {
        return;
    }

    // Retry a few times (Zulip initializes asynchronously)
    let attempts = 0;
    const max_attempts = 100;
    const timer = window.setInterval(() => {
        attempts += 1;
        if (try_mount() || attempts >= max_attempts) {
            window.clearInterval(timer);
            if (attempts >= max_attempts) {
                console.warn("left sidebar never appeared; giving up");
            }
        }
    }, 100);

    // Also observe DOM changes
    const observer = new MutationObserver(() => {
        if (try_mount()) {
            observer.disconnect();
        }
    });
    observer.observe(document.body, {childList: true, subtree: true});
}

// Use load to ensure DOM + initial render is done
window.addEventListener("load", mount_when_sidebar_ready);
*/
}