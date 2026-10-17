"use strict";
const root = document.getElementById("app");
const state = { user: null, csrf: null, setup: false, conversations: [], active: null, messages: [], hasMore: false, peerRead: 0, filter: "all", query: "", mode: "register", stream: null, notice: "", readMarks: {}, drafts: {}, invite: new URLSearchParams(location.search).get("invite") || "" };
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const when = value => value ? new Date(value).toLocaleString() : "";
function notify(message) {
  state.notice = message;
  const el = document.getElementById("notice");
  if (el) el.textContent = message;
  else if (message) alert(message);
}
async function api(path, method = "GET", data) {
  const options = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") {
    options.headers["Content-Type"] = "application/json";
    if (state.csrf) options.headers["X-CSRF-Token"] = state.csrf;
    options.body = JSON.stringify(data || {});
  }
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error("Could not connect to COMA. Check your connection."); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      state.csrf = null;
      state.stream?.close();
      render();
    }
    throw new Error(result.error || "Something went wrong.");
  }
  return result;
}
async function loadSession() {
  const result = await api("/api/session");
  state.user = result.user;
  state.csrf = result.csrf;
  state.setup = result.setup;
  state.mode = state.setup || state.invite ? "register" : "login";
  render();
  if (state.user) { await sync(); connect(); }
}
function authView() {
  const register = state.mode === "register";
  root.innerHTML = '<section class="auth"><div class="card"><div class="brand">COMA</div><p class="hint">A place of your own for your people.</p><h1>' +
    (register ? "Create an account" : "Sign in") + '</h1>' +
    (state.invite ? '<p class="hint">You have a personal invitation.</p>' : "") +
    '<form id="auth-form">' +
    (register ? '<label>Name<input name="name" required minlength="2" maxlength="40" autocomplete="name"></label>' : "") +
    '<label>Username<input name="username" required minlength="3" maxlength="24" autocomplete="username" pattern="[A-Za-z0-9_]+"></label>' +
    '<label>Password<input name="password" required type="password" minlength="' + (register ? "12" : "1") + '" autocomplete="' + (register ? "new-password" : "current-password") + '"></label>' +
    '<p id="auth-error" class="error" role="alert"></p><button class="primary" type="submit">' + (register ? "Create account" : "Sign in") + '</button></form>' +
    (state.setup ? "" : '<p><button id="auth-switch" class="ghost" type="button">' + (register ? "Already have an account? Sign in" : "Have an invitation? Create an account") + '</button></p>') +
    '<p class="small muted">Messages are stored on the server and are not end-to-end encrypted.</p></div></section>';
  document.getElementById("auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    const fields = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    document.getElementById("auth-error").textContent = "";
    try {
      const result = await api(register ? "/api/register" : "/api/login", "POST",
        register ? { ...fields, invite: state.invite || undefined } : fields);
      state.user = result.user;
      state.csrf = result.csrf;
      if (register) clearInvite();
      render();
      await sync();
      connect();
    } catch (error) { document.getElementById("auth-error").textContent = error.message; }
    finally { submit.disabled = false; }
  });
  document.getElementById("auth-switch")?.addEventListener("click", () => {
    state.mode = register ? "login" : "register";
    render();
  });
}
function clearInvite() {
  state.invite = "";
  if (location.search) history.replaceState(null, "", location.pathname);
}
function activeConversation() { return state.conversations.find(c => c.id === state.active); }
function chatView() {
  const c = activeConversation();
  if (!c) return '<div class="empty"><h2>Your conversations</h2><p>Invite someone to start a private chat.</p></div>';
  return '<header class="chat-head"><div><button id="back" class="ghost mobile-back" aria-label="Back to conversations">←</button><h2>' +
    escapeHtml(c.name) + '</h2><span class="muted small">@' + escapeHtml(c.username) + '</span></div><div class="chat-tools">' +
    '<button id="block" class="ghost" type="button">' + (c.blocked_by_me ? "Unblock" : "Block") + '</button>' +
    '<button id="report" class="ghost" type="button">Report</button></div></header>' +
    '<div id="notice" class="notice" role="status">' + escapeHtml(state.notice) + '</div>' +
    '<div id="messages" class="messages" role="log" aria-label="Messages">' +
    (state.hasMore ? '<button id="older" class="ghost" type="button">Load older messages</button>' : "") +
    (state.messages.length ? state.messages.map(m =>
      '<div class="message ' + (m.sender_id === state.user.id ? "mine" : "") + '">' +
      escapeHtml(m.body) + '<time datetime="' + new Date(m.created_at).toISOString() + '">' + escapeHtml(when(m.created_at)) +
      (m.sender_id === state.user.id && m.id <= state.peerRead ? " · Read" : "") + '</time></div>').join("") :
      '<p class="empty">No messages yet. Say hello.</p>') +
    '</div><form id="composer" class="composer"><textarea data-conversation-id="' + escapeHtml(c.id) + '" name="body" aria-label="Message" placeholder="' +
    (c.blocked ? "Messaging is unavailable" : "Write a message") +
    '" maxlength="4000" rows="2" required ' + (c.blocked ? "disabled" : "") + '>' + escapeHtml(state.drafts[c.id] || "") + '</textarea><button class="primary" ' +
    (c.blocked ? "disabled" : "") + '>Send</button></form>';
}
function render() {
  const previousComposer = document.querySelector("#composer textarea");
  if (previousComposer) state.drafts[previousComposer.dataset.conversationId] = previousComposer.value;
  if (!state.user) { authView(); return; }
  const visible = state.conversations.filter(c =>
    (state.filter !== "unread" || c.unread > 0) &&
    (c.name + " " + c.username + " " + (c.last_body || "")).toLowerCase().includes(state.query.toLowerCase()));
  root.innerHTML = '<div class="shell ' + (state.active ? "chat-open" : "") + '"><aside class="sidebar"><div class="sidebar-head">' +
    '<h1>COMA</h1><div class="small muted">Signed in as ' + escapeHtml(state.user.name) + '</div>' +
    '<div class="actions"><button id="invite" type="button">Invite someone</button><button id="profile" type="button">Profile</button>' +
    (state.user.admin ? '<button id="reports" type="button">Reports</button>' : "") +
    '<button id="logout" type="button">Sign out</button></div>' +
    '<input id="search" class="search" type="search" placeholder="Search conversations" aria-label="Search conversations" value="' + escapeHtml(state.query) + '">' +
    '<div class="filters"><button id="filter-all" class="' + (state.filter === "all" ? "active" : "") + '" type="button">All</button>' +
    '<button id="filter-unread" class="' + (state.filter === "unread" ? "active" : "") + '" type="button">Unread</button></div>' +
    (state.invite ? '<button id="accept-invite" class="primary" type="button">Accept invitation</button>' : "") +
    '</div><nav class="conversations" aria-label="Conversations">' +
    (visible.length ? visible.map(c => '<button class="conversation ' + (c.id === state.active ? "active" : "") +
      '" data-id="' + escapeHtml(c.id) + '" type="button"><strong>' + escapeHtml(c.name) +
      (c.unread ? '<span class="badge">' + c.unread + '</span>' : "") + '</strong><span class="preview">' +
      escapeHtml(c.last_body || "No messages yet") + '</span></button>').join("") :
      '<p class="empty">No conversations found.</p>') + '</nav></aside><section class="chat">' + chatView() +
    '</section></div><dialog id="dialog" class="dialog"></dialog>';
  bind();
}
function dialog(title, contents, onSubmit) {
  const el = document.getElementById("dialog");
  el.innerHTML = '<h2>' + escapeHtml(title) + '</h2><form method="dialog" id="dialog-form">' + contents +
    '<p id="dialog-error" class="error" role="alert"></p><menu><button type="button" id="cancel">Cancel</button>' +
    '<button class="primary" type="submit">Save</button></menu></form>';
  el.showModal();
  document.getElementById("cancel").onclick = () => el.close();
  document.getElementById("dialog-form").onsubmit = async event => {
    event.preventDefault();
    const button = el.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await onSubmit(new FormData(event.currentTarget), el); }
    catch (error) { document.getElementById("dialog-error").textContent = error.message; }
    finally { button.disabled = false; }
  };
}
function bind() {
  document.getElementById("search").oninput = event => {
    const pos = event.target.selectionStart;
    state.query = event.target.value;
    render();
    const input = document.getElementById("search");
    input.focus();
    input.setSelectionRange(pos, pos);
  };
  for (const filter of ["all", "unread"]) document.getElementById("filter-" + filter).onclick = () => {
    state.filter = filter; render();
  };
  document.querySelectorAll(".conversation").forEach(button => button.onclick = async () => {
    state.active = button.dataset.id;
    state.messages = []; state.hasMore = false; state.peerRead = 0;
    render();
    try { await loadMessages(); }
    catch (error) { notify(error.message); }
  });
  document.getElementById("back")?.addEventListener("click", () => { state.active = null; render(); });
  document.getElementById("invite").onclick = () => dialog("Invite someone",
    '<label>Note for yourself (optional)<input name="label" maxlength="60"></label>', async (form, el) => {
      const result = await api("/api/invites", "POST", {label: form.get("label")});
      const url = new URL("/", location.origin);
      url.searchParams.set("invite", result.token);
      el.innerHTML = '<h2>Personal invitation</h2><p>Copy this link and share it privately. It works once and expires in seven days.</p>' +
        '<input id="invite-link" readonly aria-label="Invitation link" value="' + escapeHtml(url.href) + '">' +
        '<p><button id="copy-link" class="primary" type="button">Copy link</button> <button id="close-link" type="button">Close</button></p>';
      document.getElementById("copy-link").onclick = async () => {
        try { await navigator.clipboard.writeText(url.href); notify("Invitation link copied."); }
        catch { document.getElementById("invite-link").select(); }
      };
      document.getElementById("close-link").onclick = () => el.close();
    });
  document.getElementById("profile").onclick = () => dialog("Your profile",
    '<label>Display name<input name="name" required minlength="2" maxlength="40" value="' + escapeHtml(state.user.name) + '"></label>',
    async (form, el) => { const result = await api("/api/profile", "PATCH", {name: form.get("name")});
      state.user = result.user; el.close(); render(); });
  document.getElementById("logout").onclick = async () => {
    try { await api("/api/logout", "POST"); } catch (error) { notify(error.message); return; }
    state.stream?.close(); state.stream = null; state.user = null; state.csrf = null;
    state.active = null; state.conversations = []; state.messages = []; render();
  };
  document.getElementById("accept-invite")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/invites/accept", "POST", {token: state.invite});
      clearInvite(); await sync(); state.active = result.conversationId; await loadMessages();
    } catch (error) { notify(error.message); }
  });
  document.getElementById("composer")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = form.elements.body.value.trim();
    if (!body || !state.active) return;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api("/api/conversations/" + state.active + "/messages", "POST", {body, clientId: crypto.randomUUID()});
      form.reset(); state.drafts[state.active] = ""; await sync(); await loadMessages();
    } catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  });
  document.getElementById("older")?.addEventListener("click", async () => {
    const before = state.messages[0]?.id;
    if (!before) return;
    try { await loadMessages(before); } catch (error) { notify(error.message); }
  });
  document.getElementById("block")?.addEventListener("click", async () => {
    const c = activeConversation();
    if (!c) return;
    if (!confirm(c.blocked_by_me ? "Unblock this contact?" : "Block this contact?")) return;
    try { await api("/api/conversations/" + c.id + "/block", "POST", {blocked: !c.blocked_by_me}); await sync(); }
    catch (error) { notify(error.message); }
  });
  document.getElementById("report")?.addEventListener("click", () => {
    const c = activeConversation();
    if (!c) return;
    dialog("Report " + c.name, '<label>What happened?<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label>',
      async (form, el) => { await api("/api/conversations/" + c.id + "/report", "POST", {reason: form.get("reason")});
        el.close(); notify("Report sent to the administrator."); });
  });
  document.getElementById("reports")?.addEventListener("click", async () => {
    try {
      const result = await api("/api/reports");
      const el = document.getElementById("dialog");
      el.innerHTML = '<h2>Reports</h2>' + (result.reports.length ? result.reports.map(r =>
        '<article><p><strong>@' + escapeHtml(r.reporter) + '</strong> reported @' + escapeHtml(r.reported) +
        '</p><p>' + escapeHtml(r.reason) + '</p><p class="small muted">' + escapeHtml(when(r.created_at)) +
        (r.resolved ? " · Resolved" : "") + '</p>' +
        (r.resolved ? "" : '<button class="resolve" data-id="' + escapeHtml(r.id) + '">Mark resolved</button>') + '</article>').join("") :
        '<p>No reports.</p>') + '<button id="close-reports">Close</button>';
      el.showModal();
      document.getElementById("close-reports").onclick = () => el.close();
      el.querySelectorAll(".resolve").forEach(button => button.onclick = async () => {
        try { await api("/api/reports/" + button.dataset.id, "PATCH"); button.replaceWith(document.createTextNode("Resolved")); }
        catch (error) { notify(error.message); }
      });
    } catch (error) { notify(error.message); }
  });
}
async function sync() {
  if (!state.user) return;
  const result = await api("/api/conversations");
  state.conversations = result.conversations;
  if (state.active && !activeConversation()) { state.active = null; state.messages = []; }
  render();
  if (state.active) await loadMessages();
}
async function loadMessages(before) {
  const id = state.active;
  if (!id) return;
  const path = "/api/conversations/" + id + "/messages" + (before ? "?before=" + before : "");
  const result = await api(path);
  if (id !== state.active) return;
  state.messages = before ? result.messages.concat(state.messages) : result.messages;
  state.hasMore = result.hasMore;
  state.peerRead = result.peerRead;
  render();
  const list = document.getElementById("messages");
  if (list && !before) list.scrollTop = list.scrollHeight;
  const lastIncoming = [...state.messages].reverse().find(message => message.sender_id !== state.user.id);
  if (lastIncoming && lastIncoming.id > (state.readMarks[id] || 0)) {
    state.readMarks[id] = lastIncoming.id;
    api("/api/conversations/" + id + "/read", "POST", {lastId: lastIncoming.id})
      .catch(() => { delete state.readMarks[id]; });
  }
}
function connect() {
  state.stream?.close();
  state.stream = new EventSource("/api/events");
  state.stream.addEventListener("sync", () => sync().catch(error => notify(error.message)));
  state.stream.onerror = () => { if (state.user) notify("Reconnecting to live updates…"); };
}
loadSession().catch(error => { root.textContent = error.message; });
