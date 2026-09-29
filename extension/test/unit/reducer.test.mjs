import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardStatus, clearPending, formatClock, initialState, markAssistPending, markRequested, reduceEvents, selectView,
} from "../../lib/reducer.js";

const item = (id, origin, extra = {}) => ({ id, kind: "task", text: `text ${id}`, quote: "", speaker: "Я", start: 3, origin, detector: "x", ...extra });
const answer = (itemId, extra = {}) => ({ item_id: itemId, status: "draft", summary: `ans ${itemId}`, body: "**b**", assumptions: [], sources: [], confidence: "medium", warnings: [], ...extra });
const resp = (events, extra = {}) => ({ events, last: events.length ? Math.max(...events.map((e) => e.seq)) : 0, state: "open", finished: false, ...extra });

test("items are split into my tasks (voice/typed) and heard suggestions, newest first", () => {
  let s = initialState("s1");
  s = reduceEvents(s, resp([
    { seq: 1, type: "item", data: item("a", "voice") },
    { seq: 2, type: "item", data: item("b", "meeting", { kind: "question" }) },
    { seq: 3, type: "item", data: item("c", "user") },
    { seq: 4, type: "item", data: item("d", "meeting") },
  ]));
  const v = selectView(s);
  assert.deepEqual(v.tasks.map((c) => c.id), ["c", "a"]);
  assert.deepEqual(v.heard.map((c) => c.id), ["d", "b"]);
  assert.equal(s.last, 4);
  assert.deepEqual(v.tasks.map((c) => c.status), ["pending", "pending"], "commands are answered automatically");
  assert.deepEqual(v.heard.map((c) => c.status), ["idle", "idle"], "suggestions wait for a click");
});

test("answers attach to their items; status follows the answer status", () => {
  let s = initialState("s1");
  s = reduceEvents(s, resp([
    { seq: 1, type: "item", data: item("a", "voice") },
    { seq: 2, type: "item", data: item("b", "user") },
    { seq: 3, type: "item", data: item("c", "user") },
    { seq: 4, type: "answer", data: answer("a") },
    { seq: 5, type: "answer", data: answer("b", { status: "failed" }) },
    { seq: 6, type: "answer", data: answer("c", { status: "needs_llm" }) },
  ]));
  const v = selectView(s);
  const byId = Object.fromEntries(v.tasks.map((c) => [c.id, c]));
  assert.equal(byId.a.status, "answered");
  assert.equal(byId.a.answer.summary, "ans a");
  assert.equal(byId.b.status, "failed");
  assert.equal(byId.c.status, "needs_llm");
});

test("out-of-order and repeated events: applied once, in seq order", () => {
  let s = initialState("s1");
  s = reduceEvents(s, resp([
    { seq: 2, type: "answer", data: answer("a", { summary: "old" }) },
    { seq: 1, type: "item", data: item("a", "voice") },
    { seq: 3, type: "answer", data: answer("a", { summary: "new" }) },
  ]));
  assert.equal(s.answers.a.summary, "new", "later answer wins");
  const again = reduceEvents(s, resp([{ seq: 2, type: "answer", data: answer("a", { summary: "old" }) }], { last: 3 }));
  assert.equal(again.answers.a.summary, "new", "events at or below `last` are ignored");
  assert.equal(again.order.length, 1);
  // Item events for a known id update it without duplicating or reordering.
  const upd = reduceEvents(s, resp([{ seq: 4, type: "item", data: item("a", "voice", { text: "edited" }) }]));
  assert.equal(upd.order.length, 1);
  assert.equal(upd.items.a.text, "edited");
  assert.equal(upd.seqOf.a, 1);
});

test("reducer is immutable", () => {
  const s0 = initialState("s1");
  const s1 = reduceEvents(s0, resp([{ seq: 1, type: "item", data: item("a", "voice") }]));
  assert.equal(s0.order.length, 0);
  assert.equal(Object.keys(s0.items).length, 0);
  assert.notEqual(s0, s1);
  const s2 = markRequested(s1, "a");
  assert.equal(s1.requested.a, undefined);
  assert.equal(s2.requested.a, true);
});

test("a clicked suggestion is pending until its answer arrives; failures clear it", () => {
  let s = reduceEvents(initialState("s1"), resp([{ seq: 1, type: "item", data: item("q", "meeting") }]));
  assert.equal(cardStatus(s, "q"), "idle");
  s = markRequested(s, "q");
  assert.equal(cardStatus(s, "q"), "pending");
  assert.equal(cardStatus(clearPending(s, { itemId: "q" }), "q"), "idle");
  s = reduceEvents(s, resp([
    { seq: 2, type: "stage", data: { item_id: "q", stage: "memory", count: 0 } },
  ]));
  assert.equal(selectView(s).heard[0].stage, "memory", "progress stage is exposed");
  s = reduceEvents(s, resp([{ seq: 3, type: "answer", data: answer("q") }]));
  assert.equal(cardStatus(s, "q"), "answered");
  assert.equal(s.requested.q, undefined);
  assert.equal(s.stages.q, undefined);
});

test("limit, assist, error, recap and done events", () => {
  let s = reduceEvents(initialState("s1"), resp([{ seq: 1, type: "item", data: item("a", "voice") }]));
  s = markAssistPending(s, "summary");
  assert.equal(selectView(s).assistPending, "summary");
  s = reduceEvents(s, resp([
    { seq: 2, type: "limit", data: { item_id: "a", message: "достигнут лимит 30 ответов" } },
    { seq: 3, type: "assist", data: { action: "summary", title: "Итог на текущий момент", text: "t", bullets: ["x"], source: "ai" } },
    { seq: 4, type: "error", data: { message: "поиск вопросов: boom", retry: true } },
    { seq: 5, type: "unknown-future-type", data: {} },
  ]));
  let v = selectView(s);
  assert.equal(v.tasks[0].status, "limit");
  assert.equal(v.assist.title, "Итог на текущий момент");
  assert.equal(v.assistPending, null);
  assert.deepEqual(v.errors, [{ seq: 4, message: "поиск вопросов: boom", retry: true }]);
  assert.equal(v.finished, false);

  s = reduceEvents(s, { events: [], last: 5, state: "closing", finished: false });
  assert.equal(selectView(s).closing, true);
  s = reduceEvents(s, resp([
    { seq: 6, type: "recap", data: { summary: "Итог", sections: [], decisions: ["d"], action_items: [] } },
    { seq: 7, type: "done", data: { id: "s1" } },
  ], { state: "finished", finished: true }));
  v = selectView(s);
  assert.equal(v.finished, true);
  assert.equal(v.closing, false);
  assert.equal(v.doneId, "s1");
  assert.equal(v.recap.summary, "Итог");
  assert.equal(s.last, 7);
});

test("done without an answer marks commands unanswered; errors are capped", () => {
  let s = reduceEvents(initialState("s1"), resp([
    { seq: 1, type: "item", data: item("a", "voice") },
    ...Array.from({ length: 8 }, (_, i) => ({ seq: 2 + i, type: "error", data: { message: `e${i}` } })),
    { seq: 10, type: "done", data: { id: "s1" } },
  ]));
  assert.equal(cardStatus(s, "a"), "unanswered");
  assert.equal(s.errors.length, 5);
  assert.equal(s.errors.at(-1).message, "e7");
});

test("cancelled / dismissed items are hidden and lose their answers", () => {
  let s = reduceEvents(initialState("s1"), resp([
    { seq: 1, type: "item", data: item("a", "voice", { status: "active" }) },
    { seq: 2, type: "item", data: item("b", "meeting", { status: "active" }) },
    { seq: 3, type: "answer", data: answer("a") },
  ]));
  s = reduceEvents(s, resp([
    { seq: 4, type: "item", data: item("a", "voice", { status: "cancelled" }) },
    { seq: 5, type: "item", data: item("b", "meeting", { status: "dismissed" }) },
  ]));
  const v = selectView(s);
  assert.equal(v.tasks.length, 0);
  assert.equal(v.heard.length, 0);
  assert.equal(s.answers.a, undefined);
  s = reduceEvents(s, resp([{ seq: 6, type: "item", data: item("b", "meeting", { status: "active" }) }]));
  assert.equal(selectView(s).heard.length, 1, "restored");
});

test("formatClock", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65.7), "1:05");
  assert.equal(formatClock(3723), "1:02:03");
  assert.equal(formatClock(null), "");
  assert.equal(formatClock(undefined), "");
  assert.equal(formatClock("x"), "");
});
