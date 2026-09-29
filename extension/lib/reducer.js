/*
 * Turns the server's live event stream (GET /api/live/{sid}/events) into the
 * side panel's UI state. Pure and immutable: every function returns a new
 * state object. No DOM or chrome.* APIs.
 */

const MAX_ERRORS = 5;

export function initialState(sessionId = null) {
  return {
    sessionId,
    last: 0, // highest event seq applied
    serverState: "open", // open | closing | finished
    finished: false,
    items: {}, // id -> Item
    seqOf: {}, // id -> seq of the item event (ordering)
    order: [], // item ids in arrival order
    answers: {}, // item_id -> Answer
    requested: {}, // item_id -> true while an answer is being prepared at the user's request
    limited: {}, // item_id -> message (answer limit reached)
    stages: {}, // item_id -> latest progress stage while answering (understood | memory | docs | web | writing)
    assist: null, // latest Live Assist result {action, title, text, bullets, source, seq}
    assistPending: null, // action id the user clicked, until its result arrives
    errors: [], // latest server-side errors [{seq, message, retry}]
    recap: null,
    doneId: null, // report id once the meeting is finished
  };
}

export const isCommand = (item) => item?.origin === "voice" || item?.origin === "user";

/**
 * Applies one events response. Events already applied (seq <= state.last) are
 * ignored, so overlapping polls are harmless; events are applied in seq order.
 * @param {object} state
 * @param {{events: Array<{seq:number,type:string,data:object}>, last?: number, state?: string, finished?: boolean}} response
 */
export function reduceEvents(state, response) {
  const events = [...(response?.events || [])]
    .filter((e) => e && Number.isFinite(e.seq) && e.seq > state.last)
    .sort((a, b) => a.seq - b.seq);
  const s = {
    ...state,
    items: { ...state.items },
    seqOf: { ...state.seqOf },
    order: [...state.order],
    answers: { ...state.answers },
    requested: { ...state.requested },
    limited: { ...state.limited },
    stages: { ...state.stages },
    errors: [...state.errors],
  };
  for (const ev of events) {
    const d = ev.data || {};
    switch (ev.type) {
      case "item": // also re-sent when its status changes (cancelled / dismissed / active again)
        if (!d.id) break;
        if (!(d.id in s.items)) { s.order.push(d.id); s.seqOf[d.id] = ev.seq; }
        s.items[d.id] = d;
        if (d.status && d.status !== "active") {
          delete s.answers[d.id];
          delete s.requested[d.id];
          delete s.stages[d.id];
        }
        break;
      case "answer":
        if (!d.item_id) break;
        s.answers[d.item_id] = d;
        delete s.requested[d.item_id];
        delete s.limited[d.item_id];
        delete s.stages[d.item_id];
        break;
      case "stage":
        if (d.item_id && d.stage && !s.answers[d.item_id]) s.stages[d.item_id] = String(d.stage);
        break;
      case "limit":
        if (d.item_id) { s.limited[d.item_id] = d.message || "limit"; delete s.requested[d.item_id]; }
        break;
      case "assist":
        s.assist = { ...d, seq: ev.seq };
        if (!s.assistPending || s.assistPending === d.action) s.assistPending = null;
        break;
      case "error":
        s.errors.push({ seq: ev.seq, message: String(d.message || ""), retry: Boolean(d.retry) });
        if (s.errors.length > MAX_ERRORS) s.errors.splice(0, s.errors.length - MAX_ERRORS);
        break;
      case "recap":
        s.recap = d;
        break;
      case "done":
        s.doneId = d.id || s.sessionId;
        s.finished = true;
        s.serverState = "finished";
        break;
      default:
        break; // unknown types are ignored (forward compatibility)
    }
    s.last = Math.max(s.last, ev.seq);
  }
  if (Number.isFinite(response?.last)) s.last = Math.max(s.last, response.last);
  if (response?.state && !s.doneId) s.serverState = response.state;
  if (response?.finished) s.finished = true;
  return s;
}

/** The user asked for an answer to `itemId` (heard suggestion) — show it as in progress. */
export function markRequested(state, itemId) {
  return { ...state, requested: { ...state.requested, [itemId]: true } };
}

/** The user clicked a quick action — show a spinner until its result arrives. */
export function markAssistPending(state, action) {
  return { ...state, assistPending: action };
}

/** A request failed: stop showing it as pending. */
export function clearPending(state, { itemId, assist } = {}) {
  const s = { ...state };
  if (itemId) { s.requested = { ...state.requested }; delete s.requested[itemId]; }
  if (assist) s.assistPending = null;
  return s;
}

/**
 * Card status:
 *  answered | failed | needs_llm — an answer arrived (by its status);
 *  pending — being prepared (voice/typed commands are answered automatically);
 *  limit   — the meeting's answer limit was reached;
 *  unanswered — the meeting finished before an answer arrived;
 *  idle    — a heard suggestion nobody asked to answer yet.
 */
export function cardStatus(state, id) {
  const item = state.items[id];
  const answer = state.answers[id];
  if (answer) return answer.status === "failed" ? "failed" : answer.status === "needs_llm" ? "needs_llm" : "answered";
  if (state.limited[id]) return "limit";
  if (state.requested[id] || isCommand(item)) return state.doneId ? "unanswered" : "pending";
  return "idle";
}

/** Items the user or another client cancelled (false voice trigger) or dismissed are not shown. */
export const isVisible = (item) => !item?.status || item.status === "active";

/** Everything the side panel renders, newest cards first. */
export function selectView(state) {
  const cards = state.order
    .filter((id) => isVisible(state.items[id]))
    .map((id) => ({
      id, item: state.items[id], answer: state.answers[id] || null, status: cardStatus(state, id),
      stage: state.stages[id] || null, seq: state.seqOf[id],
    }))
    .sort((a, b) => b.seq - a.seq);
  return {
    tasks: cards.filter((c) => isCommand(c.item)),
    heard: cards.filter((c) => !isCommand(c.item)),
    assist: state.assist,
    assistPending: state.assistPending,
    errors: state.errors,
    recap: state.recap,
    doneId: state.doneId,
    closing: !state.doneId && state.serverState === "closing",
    finished: Boolean(state.doneId),
  };
}

/** Seconds since the meeting start → "m:ss" / "h:mm:ss" ("" when unknown). */
export function formatClock(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
