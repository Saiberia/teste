"""HTTP API tests (FastAPI TestClient, simulated AI providers, fake speech recognition).

Background work (batch processing, finishing a meeting, answers) runs in threads,
so tests poll ``/api/live/{sid}/events`` until the expected event shows up.
Tests marked ``xfail(strict=True, reason="BUG: ...")`` document real app bugs.
"""

from __future__ import annotations

import asyncio
import io
import threading
import time
import zipfile
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import recapper.web.app as webapp
from recapper.asr import ASRError
from recapper.assist import ASSIST_ACTIONS, TEMPLATES
from recapper.bot.telegram_bot import BotService
from recapper.config import Settings
from recapper.detect import CommandDetector
from recapper.engine import Runtime
from recapper.models import MeetingReport, Segment
from recapper.prefs import FIELDS
from recapper.store import ReportStore
from recapper.transcript import parse_transcript
from recapper.web.app import STATIC, create_app
from tests.fakes import FakeLLM

TOKEN = "secret"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

VOICE = "Ассистент, посчитай бюджет на награды для игры при среднем чеке 1900 рублей."
VOICE_TEXT = "Посчитай бюджет на награды для игры при среднем чеке 1900 рублей"
QUESTION = "Как мы будем считать конверсию покупки из Самоката в Купер?"
MEETING = (
    "Аня: Сегодня обсуждаем игру внутри приложения Самоката.\n"
    f"Аня: {VOICE}\n"
    f"Макс: {QUESTION}\n"
    "Лена: Ладно, решили: награда в игре — это промокод на первый заказ в Купере.\n"
    "Аня: Макс, подготовь схему атрибуции до пятницы."
)


# --- test doubles & helpers -----------------------------------------------------------------


class TextTranscriber:
    """Fake speech recognition: the uploaded "audio" is UTF-8 text, one segment per line,
    5 seconds apart (start 0, 5, 10 ...). ``!asr-error`` simulates a decoder failure."""

    def __init__(self) -> None:
        self.paths: list[Path] = []

    def transcribe(self, path: Path) -> list[Segment]:
        self.paths.append(Path(path))
        text = Path(path).read_bytes().decode("utf-8")
        if text.startswith("!asr-error"):
            raise ASRError("не удалось распознать аудио: битый файл")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        return [Segment(text=ln, start=i * 5.0, end=i * 5.0 + 4.0) for i, ln in enumerate(lines)]


_DEFAULT = object()


def make_app(tmp_path: Path, provider: str = "sim-good", transcriber=_DEFAULT, db_name: str = "t.db", **settings):
    s = Settings(db_path=tmp_path / db_name, llm_provider=provider, **settings)
    return create_app(s, api_token=TOKEN, transcriber=TextTranscriber() if transcriber is _DEFAULT else transcriber)


@pytest.fixture
def make_client(tmp_path):
    def _make(provider: str = "sim-good", raise_server_exceptions: bool = True, **kw) -> TestClient:
        return TestClient(make_app(tmp_path, provider, **kw), headers=AUTH,
                          raise_server_exceptions=raise_server_exceptions)

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


def has_type(type_: str):
    return lambda events: any(e["type"] == type_ for e in events)


def has_answers_for(*item_ids: str):
    return lambda events: set(item_ids) <= {e["data"]["item_id"] for e in events if e["type"] == "answer"}


def wait_events(client: TestClient, sid: str, until, timeout: float = 10.0) -> list[dict]:
    deadline = time.monotonic() + timeout
    while True:
        r = client.get(f"/api/live/{sid}/events")
        assert r.status_code == 200, r.text
        events = r.json()["events"]
        if until(events):
            return events
        if time.monotonic() > deadline:
            raise AssertionError(f"condition not met within {timeout}s; events: {[e['type'] for e in events]}")
        time.sleep(0.02)


def wait_report(client: TestClient, report_id: str, timeout: float = 10.0) -> dict:
    # "done" is emitted before the report is written (see the xfail test below), so poll.
    deadline = time.monotonic() + timeout
    while True:
        r = client.get(f"/api/meetings/{report_id}")
        if r.status_code == 200:
            return r.json()
        assert r.status_code == 404, r.text
        if time.monotonic() > deadline:
            raise AssertionError(f"report {report_id} was not saved within {timeout}s")
        time.sleep(0.02)


def new_session(client: TestClient, **body) -> str:
    r = client.post("/api/live", json={"title": "Игра", **body})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def post_text(client: TestClient, sid: str, text: str, flush: bool = True) -> dict:
    r = client.post(f"/api/live/{sid}/segments", json={"text": text, "flush": flush})
    assert r.status_code == 200, r.text
    return r.json()


def finish(client: TestClient, sid: str) -> tuple[list[dict], dict]:
    r = client.post(f"/api/live/{sid}/finish")
    assert r.status_code == 200, r.text
    events = wait_events(client, sid, has_type("done"))
    return events, wait_report(client, sid)


def run_batch(client: TestClient, files=None, **form) -> tuple[str, list[dict], dict]:
    r = client.post("/api/meetings", data=form, files=files)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "processing"
    sid = r.json()["id"]
    events = wait_events(client, sid, has_type("done"))
    return sid, events, wait_report(client, sid)


def answers_by_item(events: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for e in events:
        if e["type"] == "answer":
            out.setdefault(e["data"]["item_id"], []).append(e["data"])
    return out


def answer_of(report: dict, item_id: str) -> dict | None:
    return next((a for a in report["answers"] if a["item_id"] == item_id), None)


def capture_sessions(app, hook=None) -> list:
    """Record LiveSession objects the app creates (for white-box race tests); ``hook``
    runs on each new session before any background thread can touch it."""
    runtime = app.state.runtime
    created: list = []
    original = runtime.session

    def session(*args, **kwargs):
        sess = original(*args, **kwargs)
        if hook:
            hook(sess)
        created.append(sess)
        return sess

    runtime.session = session
    return created


def api_routes(app) -> list[tuple[str, str]]:
    out = []
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api"):
            out += [(method, route.path) for method in sorted(route.methods)]
    return out


# --- auth ------------------------------------------------------------------------------------


def _concrete(path: str) -> str:
    return path.replace("{sid}", "abc").replace("{report_id}", "abc").replace("{item_id}", "i1").replace("{name}", "x.md")


def test_every_api_route_except_health_requires_token(tmp_path):
    app = make_app(tmp_path)
    anon = TestClient(app)
    routes = api_routes(app)
    assert ("GET", "/api/live") in routes and ("POST", "/api/meetings") in routes  # sanity: routes discovered
    for method, path in routes:
        if path == "/api/health":
            continue
        url = _concrete(path)
        assert anon.request(method, url).status_code == 401, (method, path)
        for bad in ("Bearer wrong", f"Bearer {TOKEN}x", f"bearer {TOKEN}", f"Basic {TOKEN}", TOKEN, "Bearer "):
            assert anon.request(method, url, headers={"Authorization": bad}).status_code == 401, (method, path, bad)


def test_health_index_and_static_are_public(tmp_path):
    anon = TestClient(make_app(tmp_path))
    health = anon.get("/api/health")
    assert health.status_code == 200 and health.json()["status"] == "ok" and health.json()["auth"] is True
    index = anon.get("/")
    assert index.status_code == 200 and "text/html" in index.headers["content-type"]
    assert index.headers["cache-control"] == "no-store"
    static_file = next(p for p in sorted(STATIC.iterdir()) if p.is_file())
    assert anon.get(f"/static/{static_file.name}").status_code == 200
    assert anon.get("/static/definitely-missing.js").status_code == 404


def test_correct_token_is_accepted(client):
    assert client.get("/api/meta").status_code == 200
    assert client.get("/api/meetings").json() == []


def test_random_token_generated_when_none_given(tmp_path, monkeypatch):
    monkeypatch.delenv("RECAPPER_ALLOW_NO_AUTH", raising=False)
    s1 = Settings(db_path=tmp_path / "a.db", llm_provider="none")
    s2 = Settings(db_path=tmp_path / "b.db", llm_provider="none")
    app1, app2 = create_app(s1, api_token=None, allow_no_auth=False), create_app(s2)
    token = app1.state.token
    assert len(token) >= 20 and token != app2.state.token
    anon = TestClient(app1)
    assert anon.get("/api/meta").status_code == 401
    assert anon.get("/api/meta", headers={"Authorization": "Bearer "}).status_code == 401
    assert anon.get("/api/meta", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert anon.get("/api/health").json()["auth"] is True


def test_token_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("RECAPPER_API_TOKEN", "from-env")
    app = create_app(Settings(db_path=tmp_path / "t.db", llm_provider="none"))
    anon = TestClient(app)
    assert app.state.token == "from-env"
    assert anon.get("/api/meta", headers={"Authorization": "Bearer from-env"}).status_code == 200
    assert anon.get("/api/meta").status_code == 401


@pytest.mark.parametrize("via_env", [False, True])
def test_allow_no_auth_disables_auth(tmp_path, monkeypatch, via_env):
    s = Settings(db_path=tmp_path / "t.db", llm_provider="none")
    if via_env:
        monkeypatch.setenv("RECAPPER_ALLOW_NO_AUTH", "1")
        app = create_app(s, api_token="")
    else:
        app = create_app(s, api_token="", allow_no_auth=True)
    anon = TestClient(app)
    assert app.state.token == ""
    assert anon.get("/api/health").json()["auth"] is False
    assert anon.get("/api/meta").status_code == 200
    assert anon.post("/api/live", json={"title": "x"}).status_code == 200


# --- meta ------------------------------------------------------------------------------------


def test_meta_lists_templates_and_assist_actions(client):
    meta = client.get("/api/meta").json()
    assert len(meta["templates"]) == 11
    assert [t["id"] for t in meta["templates"]] == list(TEMPLATES)
    assert all(t["name"] and isinstance(t["sections"], list) for t in meta["templates"])
    assert {a["id"]: a["title"] for a in meta["assist_actions"]} == ASSIST_ACTIONS


def test_health_reports_mode_and_asr(client):
    h = client.get("/api/health").json()
    assert h["mode"] == "sim-good" and h["llm_error"] == "" and h["asr"] == "none" and h["version"]


# --- settings --------------------------------------------------------------------------------


def test_get_settings_returns_values_and_schema(client):
    body = client.get("/api/settings").json()
    keys = [f.key for f in FIELDS]
    assert set(body["values"]) == set(keys) | {"has_claude_env_key"}
    assert [f["key"] for f in body["schema"]] == keys
    by_key = {f["key"]: f for f in body["schema"]}
    assert {o["value"] for o in by_key["llm_provider"]["options"]} >= {"none", "sim-good", "sim-sloppy", "sim-broken"}
    assert len(by_key["default_template"]["options"]) == 11
    assert by_key["asr_provider"]["restart"] is True and by_key["max_answers"]["min"] == 1
    assert body["values"]["llm_provider"] == "sim-good" and body["values"]["me_label"] == "Я"
    for f in FIELDS:
        if f.type == "secret":
            assert body["values"][f.key] == {"set": False}


def test_secrets_are_write_only(client):
    secret_a, secret_o = "sk-ant-SUPER-SECRET-111", "sk-openai-SUPER-SECRET-222"
    r = client.put("/api/settings", json={"values": {"anthropic_api_key": secret_a, "openai_api_key": secret_o}})
    assert r.status_code == 200
    assert r.json()["values"]["anthropic_api_key"] == {"set": True}
    assert r.json()["values"]["openai_api_key"] == {"set": True}
    got = client.get("/api/settings")
    assert got.json()["values"]["anthropic_api_key"] == {"set": True}
    for resp in (r, got, client.get("/api/health"), client.get("/api/meta"), client.get("/api/traces")):
        assert "SUPER-SECRET" not in resp.text
    # Clearing a secret with null.
    r = client.put("/api/settings", json={"values": {"anthropic_api_key": None}})
    assert r.json()["values"]["anthropic_api_key"] == {"set": False}


BAD_SETTINGS = [
    {"no_such_setting": 1},
    {"web_search": "yes"},
    {"web_search": 1},
    {"max_answers": "10"},
    {"max_answers": True},
    {"me_label": 5},
    {"me_label": "x" * 501},
    {"assist_actions": "summary"},
    {"assist_actions": ["summary", "dance"]},
    {"max_answers": 0},
    {"max_answers": 201},
    {"detect_min_chars": 99},
    {"retention_days": -1},
    {"web_search_max_uses": 21},
    {"capture_silence_threshold": 0.5},
    {"capture_silence_threshold": -0.01},
    {"llm_provider": "gpt-5"},
    {"ui_language": "fr"},
    {"default_template": "nope"},
    {"theme": "neon"},
    {"wake_words": ""},
    {"wake_words": " , ,  "},
    {"openai_base_url": "ftp://example.com"},
    {"max_answers": 5, "no_such_setting": 1},  # one bad key rejects the whole update
    {"max_answers": 5, "wake_words": ""},
]


@pytest.mark.parametrize("values", BAD_SETTINGS, ids=lambda v: ",".join(f"{k}={v[k]!r}"[:40] for k in v))
def test_put_settings_validation(client, values):
    before = client.get("/api/settings").json()["values"]
    r = client.put("/api/settings", json={"values": values})
    assert r.status_code == 422, r.text
    assert isinstance(r.json()["detail"], str) and r.json()["detail"]
    assert client.get("/api/settings").json()["values"] == before  # nothing partially applied


@pytest.mark.parametrize("body", [{}, {"values": []}, {"values": "x"}])
def test_put_settings_malformed_body(client, body):
    assert client.put("/api/settings", json=body).status_code == 422


@pytest.mark.parametrize("raw", [
    '{"values": {"max_answers": NaN}}',
    '{"values": {"max_answers": Infinity}}',
    '{"values": {"retention_days": -Infinity}}',
])
def test_put_settings_non_finite_int_is_rejected(make_client, raw):
    client = make_client(raise_server_exceptions=False)
    r = client.put("/api/settings", content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_put_settings_nan_float_is_rejected(client):
    r = client.put("/api/settings", content='{"values": {"capture_silence_threshold": NaN}}',
                   headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert client.get("/api/settings").json()["values"]["capture_silence_threshold"] == 0.004


def test_put_settings_fractional_int_is_rejected(client):
    r = client.put("/api/settings", json={"values": {"retention_days": 0.9}})
    assert r.status_code == 422


def test_put_settings_accepts_valid_values_and_normalises(client):
    r = client.put("/api/settings", json={"values": {
        "max_answers": 200, "detect_min_chars": 100, "web_search": False, "me_label": "  Я-ведущий  ",
        "assist_actions": ["summary", "summary", "topics"], "default_template": "retro",
        "capture_silence_threshold": 0.1, "theme": "dark", "openai_base_url": "http://localhost:11434/v1",
    }})
    assert r.status_code == 200, r.text
    v = r.json()["values"]
    assert v["max_answers"] == 200 and v["web_search"] is False and v["me_label"] == "Я-ведущий"
    assert v["assist_actions"] == ["summary", "topics"] and v["default_template"] == "retro"
    assert r.json()["mode"] == "sim-good"
    sid = new_session(client)
    assert client.get(f"/api/live/{sid}").json()["report"]["template"] == "retro"


def test_put_settings_persists_across_app_instances(tmp_path):
    c1 = TestClient(make_app(tmp_path), headers=AUTH)
    assert c1.put("/api/settings", json={"values": {"max_answers": 7, "me_label": "Ведущий",
                                                    "llm_provider": "sim-sloppy"}}).status_code == 200
    c2 = TestClient(make_app(tmp_path), headers=AUTH)  # same database, fresh process state
    values = c2.get("/api/settings").json()["values"]
    assert values["max_answers"] == 7 and values["me_label"] == "Ведущий" and values["llm_provider"] == "sim-sloppy"
    assert c2.get("/api/health").json()["mode"] == "sim-sloppy"


def test_switching_provider_changes_mode_live(client):
    old = new_session(client)
    assert client.get("/api/health").json()["mode"] == "sim-good"
    r = client.put("/api/settings", json={"values": {"llm_provider": "sim-sloppy"}})
    assert r.json()["mode"] == "sim-sloppy"
    assert client.get("/api/health").json()["mode"] == "sim-sloppy"
    assert client.post("/api/live", json={}).json()["mode"] == "sim-sloppy"
    client.put("/api/settings", json={"values": {"llm_provider": "none"}})
    assert client.get("/api/health").json()["mode"] == "offline"
    # "openai" without a URL can't be built: the app stays up, offline, and says why.
    r = client.put("/api/settings", json={"values": {"llm_provider": "openai"}})
    assert r.status_code == 200 and r.json()["mode"] == "offline" and r.json()["llm_error"]
    assert client.get("/api/health").json()["llm_error"]
    # A session started earlier keeps the provider it started with.
    assert client.get(f"/api/live/{old}").json()["report"]["mode"] == "sim-good"


def test_null_resets_setting_to_default(client):
    client.put("/api/settings", json={"values": {"max_answers": 5, "me_label": "Ведущий"}})
    r = client.put("/api/settings", json={"values": {"max_answers": None}})
    assert r.status_code == 200
    v = client.get("/api/settings").json()["values"]
    assert v["max_answers"] == 30 and v["me_label"] == "Ведущий"


def test_wake_words_setting_changes_command_detection(client):
    before = new_session(client)
    assert client.put("/api/settings", json={"values": {"wake_words": "бот"}}).status_code == 200
    sid = new_session(client)
    r = post_text(client, sid, "Аня: Бот, посчитай бюджет на награды для игры.\n"
                               "Макс: Ассистент, придумай название для игры про корзину.", flush=False)
    voice = [i for i in r["new_items"] if i["origin"] == "voice"]
    assert [i["text"] for i in voice] == ["Посчитай бюджет на награды для игры"]
    assert voice[0]["speaker"] == "Аня" and voice[0]["detector"] == "command"
    # A session started before the change keeps its wake words.
    r = post_text(client, before, "Макс: Ассистент, придумай название для игры про корзину.", flush=False)
    assert [i["text"] for i in r["new_items"]] == ["Придумай название для игры про корзину"]


# --- live sessions ---------------------------------------------------------------------------------


def test_live_voice_command_answered_suggestion_not(client):
    created = client.post("/api/live", json={"title": "Игра"}).json()
    assert created["mode"] == "sim-good" and created["template"] == "general"
    sid = created["id"]
    r = post_text(client, sid, MEETING)
    assert r["added"] == 5
    voice = [i for i in r["new_items"] if i["origin"] == "voice"]
    heard = [i for i in r["new_items"] if i["origin"] == "meeting"]
    assert len(voice) == 1 and voice[0]["text"] == VOICE_TEXT and voice[0]["kind"] == "task"
    assert voice[0]["speaker"] == "Аня" and voice[0]["quote"] == VOICE and voice[0]["detector"] == "command"
    suggestion = next(i for i in heard if i["text"] == QUESTION)
    assert suggestion["kind"] == "question" and suggestion["speaker"] == "Макс"

    events = wait_events(client, sid, has_answers_for(voice[0]["id"]))
    answer = answers_by_item(events)[voice[0]["id"]][0]
    assert answer["status"] == "draft" and VOICE_TEXT in answer["summary"] and answer["body"]
    assert answer["confidence"] == "medium" and answer["warnings"] == []
    items = [e["data"] for e in events if e["type"] == "item"]
    assert {i["id"] for i in items} >= {voice[0]["id"], suggestion["id"]}
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))

    events, report = finish(client, sid)
    assert suggestion["id"] not in answers_by_item(events)  # never answered automatically
    assert answer_of(report, suggestion["id"]) is None
    assert answer_of(report, voice[0]["id"])["status"] == "draft"


def test_live_answer_on_request_and_typed_questions(client):
    sid = new_session(client)
    r = post_text(client, sid, MEETING)
    suggestion = next(i for i in r["new_items"] if i["origin"] == "meeting" and i["text"] == QUESTION)
    req = client.post(f"/api/live/{sid}/items/{suggestion['id']}/answer")
    assert req.status_code == 200 and req.json()["id"] == suggestion["id"]
    events = wait_events(client, sid, has_answers_for(suggestion["id"]))
    assert answers_by_item(events)[suggestion["id"]][0]["status"] == "draft"
    # Asking again once the answer is ready retries it (a new answer replaces the old one).
    assert client.post(f"/api/live/{sid}/items/{suggestion['id']}/answer").status_code == 200
    wait_events(client, sid, lambda evs: len(answers_by_item(evs).get(suggestion["id"], [])) == 2)
    assert client.post(f"/api/live/{sid}/items/nope/answer").status_code == 404

    asked = client.post(f"/api/live/{sid}/ask", json={"question": "  Какой лимит бюджета на награды?  "})
    assert asked.status_code == 200
    item = asked.json()
    assert item["origin"] == "user" and item["detector"] == "user" and item["text"] == "Какой лимит бюджета на награды?"
    events = wait_events(client, sid, has_answers_for(item["id"]))
    assert answers_by_item(events)[item["id"]][0]["status"] == "draft"
    for bad in ({"question": "?"}, {"question": "x" * 2001}, {}):
        assert client.post(f"/api/live/{sid}/ask", json=bad).status_code == 422

    events, report = finish(client, sid)
    assert len(answers_by_item(events)[suggestion["id"]]) == 2
    assert [a["item_id"] for a in report["answers"]].count(suggestion["id"]) == 1
    assert answer_of(report, item["id"])["status"] == "draft"


def gate_answers(gate: threading.Event, finished: threading.Event | None = None):
    """Session hook: every answer waits for ``gate`` (to hold answers "in flight")."""

    def hook(sess):
        original = sess.c.answerer.answer

        def slow(item, segments, progress=None):
            gate.wait(5)
            try:
                return original(item, segments, progress=progress)
            finally:
                if finished is not None:
                    finished.set()

        sess.c.answerer.answer = slow

    return hook


def test_double_click_on_pending_answer_is_deduplicated(client):
    gate = threading.Event()
    capture_sessions(client.app, hook=gate_answers(gate))
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    for _ in range(3):  # impatient clicks while the answer is still being written
        assert client.post(f"/api/live/{sid}/items/{voice['id']}/answer").status_code == 200
    gate.set()
    events, report = finish(client, sid)
    assert len(answers_by_item(events)[voice["id"]]) == 1
    assert answer_of(report, voice["id"])["status"] == "draft"


def test_stage_events_precede_each_answer(make_client):
    for provider, web_search, expected in (("sim-good", True, ["understood", "memory", "docs", "web"]),
                                           ("sim-good", False, ["understood", "memory", "docs", "writing"]),
                                           ("none", True, ["understood", "memory"])):
        client = make_client(provider=provider, web_search=web_search, db_name=f"{provider}-{web_search}.db")
        sid = new_session(client)
        voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
        events = wait_events(client, sid, has_answers_for(voice["id"]))
        mine = [e for e in events if e["data"].get("item_id") == voice["id"]]
        stages = [e["data"] for e in mine if e["type"] == "stage"]
        assert [s["stage"] for s in stages] == expected, provider
        assert all(isinstance(s["count"], int) for s in stages if s["stage"] in ("memory", "docs"))
        assert mine[-1]["type"] == "answer"  # every stage comes before the answer


def test_live_consent_is_recorded(client):
    sid = new_session(client, consent=True)
    assert client.get(f"/api/live/{sid}").json()["report"]["consent_noted"] is True
    _, report = finish(client, sid)
    assert report["consent_noted"] is True
    other = new_session(client)
    assert client.get(f"/api/live/{other}").json()["report"]["consent_noted"] is False
    assert client.post("/api/live", json={"consent": "maybe"}).status_code == 422


# --- item status (false voice triggers, dismissed suggestions) and refinements -----------------------------


def item_status(client, sid, item_id, status):
    return client.post(f"/api/live/{sid}/items/{item_id}/status", json={"status": status})


def test_cancel_voice_command_removes_its_answer(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    wait_events(client, sid, has_answers_for(voice["id"]))
    r = item_status(client, sid, voice["id"], "cancelled")
    assert r.status_code == 200 and r.json()["status"] == "cancelled" and r.json()["id"] == voice["id"]
    live = client.get(f"/api/live/{sid}").json()["report"]
    assert answer_of(live, voice["id"]) is None
    events = client.get(f"/api/live/{sid}/events").json()["events"]
    assert events[-1]["type"] == "item" and events[-1]["data"]["status"] == "cancelled"
    _, report = finish(client, sid)
    assert report["items"][0]["status"] == "cancelled" and answer_of(report, voice["id"]) is None


def test_cancel_discards_a_late_answer(client):
    gate, done = threading.Event(), threading.Event()
    capture_sessions(client.app, hook=gate_answers(gate, done))
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    assert item_status(client, sid, voice["id"], "cancelled").status_code == 200
    gate.set()
    assert done.wait(5)
    time.sleep(0.2)  # the worker only has to take the lock and drop the answer
    events, report = finish(client, sid)
    assert voice["id"] not in answers_by_item(events)
    assert answer_of(report, voice["id"]) is None and report["items"][0]["status"] == "cancelled"


def test_cancelled_command_can_be_restored_by_requesting_an_answer(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    wait_events(client, sid, has_answers_for(voice["id"]))
    item_status(client, sid, voice["id"], "cancelled")
    r = client.post(f"/api/live/{sid}/items/{voice['id']}/answer")
    assert r.status_code == 200 and r.json()["status"] == "active"
    wait_events(client, sid, lambda evs: len(answers_by_item(evs).get(voice["id"], [])) == 2)
    _, report = finish(client, sid)
    assert report["items"][0]["status"] == "active" and answer_of(report, voice["id"])["status"] == "draft"


def test_restoring_cancelled_command_via_status_answers_it(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    wait_events(client, sid, has_answers_for(voice["id"]))
    item_status(client, sid, voice["id"], "cancelled")
    assert item_status(client, sid, voice["id"], "active").json()["status"] == "active"
    _, report = finish(client, sid)
    assert answer_of(report, voice["id"]) is not None
    assert "готовится" not in client.get(f"/api/meetings/{sid}/markdown").text


def test_dismiss_suggestion(client):
    sid = new_session(client)
    items = post_text(client, sid, MEETING)["new_items"]
    suggestion = next(i for i in items if i["text"] == QUESTION)
    assert item_status(client, sid, suggestion["id"], "dismissed").json()["status"] == "dismissed"
    _, report = finish(client, sid)
    stored_item = next(i for i in report["items"] if i["id"] == suggestion["id"])
    assert stored_item["status"] == "dismissed" and answer_of(report, suggestion["id"]) is None


def test_item_status_validation(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    for bad in ("deleted", "", "ACTIVE", None):
        assert item_status(client, sid, voice["id"], bad).status_code == 422, bad
    assert client.post(f"/api/live/{sid}/items/{voice['id']}/status", json={}).status_code == 422
    assert item_status(client, sid, "nope", "cancelled").status_code == 404
    assert item_status(client, "unknown", voice["id"], "cancelled").status_code == 404


def test_item_status_after_finish_is_rejected_or_persisted(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    finish(client, sid)
    r = item_status(client, sid, voice["id"], "cancelled")
    stored_status = client.get(f"/api/meetings/{sid}").json()["items"][0]["status"]
    assert r.status_code == 409 or stored_status == "cancelled"


def test_refine_answered_item(client):
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    events = wait_events(client, sid, has_answers_for(voice["id"]))
    previous = answers_by_item(events)[voice["id"]][0]["summary"]
    r = client.post(f"/api/live/{sid}/items/{voice['id']}/refine", json={"question": "  А если средний чек 2500?  "})
    assert r.status_code == 200
    child = r.json()
    assert child["parent_id"] == voice["id"] and child["origin"] == "user" and child["kind"] == "question"
    assert child["text"] == "А если средний чек 2500?"
    assert VOICE_TEXT in child["quote"] and previous in child["quote"]
    task = client.post(f"/api/live/{sid}/items/{voice['id']}/refine", json={"question": "Добавь расчёт на квартал"})
    assert task.json()["kind"] == "task"
    events = wait_events(client, sid, has_answers_for(child["id"], task.json()["id"]))
    assert answers_by_item(events)[child["id"]][0]["status"] == "draft"
    assert client.post(f"/api/live/{sid}/items/nope/refine", json={"question": "Ещё?"}).status_code == 404
    assert client.post(f"/api/live/{sid}/items/{voice['id']}/refine", json={"question": "?"}).status_code == 422
    _, report = finish(client, sid)
    assert {i["parent_id"] for i in report["items"]} == {None, voice["id"]}
    assert client.post(f"/api/live/{sid}/items/{voice['id']}/refine", json={"question": "Ещё?"}).status_code == 409


# --- editing stored reports ------------------------------------------------------------------------------


def test_patch_meeting(client):
    sid, _, _ = run_batch(client, transcript=MEETING, title="Черновик")
    r = client.patch(f"/api/meetings/{sid}", json={"title": "Игра: итог", "reviewed": True, "recap": {
        "summary": "Итог вручную", "decisions": ["Решение 1", "   ", " Решение 2 "],
        "action_items": [{"text": "Сделать экран награды", "owner": "Лена", "due": "среда", "done": True},
                         {"text": "Схема атрибуции"}]}})
    assert r.status_code == 200, r.text
    for report in (r.json(), client.get(f"/api/meetings/{sid}").json()):
        assert report["title"] == "Игра: итог" and report["reviewed"] is True
        assert report["recap"]["summary"] == "Итог вручную"
        assert report["recap"]["decisions"] == ["Решение 1", "Решение 2"]
        assert report["recap"]["action_items"] == [
            {"text": "Сделать экран награды", "owner": "Лена", "due": "среда", "done": True},
            {"text": "Схема атрибуции", "owner": "", "due": "", "done": False}]
    assert client.get("/api/meetings").json()[0]["title"] == "Игра: итог"
    assert client.get(f"/api/meetings/{sid}/markdown").text.startswith("# Игра: итог")
    # A partial patch leaves everything else alone.
    r = client.patch(f"/api/meetings/{sid}", json={"reviewed": False})
    assert r.json()["reviewed"] is False and r.json()["title"] == "Игра: итог"
    assert r.json()["recap"]["summary"] == "Итог вручную" and len(r.json()["recap"]["action_items"]) == 2


@pytest.mark.parametrize("body", [
    {"title": ""}, {"title": "x" * 201}, {"reviewed": "maybe"},
    {"recap": {"action_items": [{"text": ""}]}},
    {"recap": {"action_items": [{"owner": "Лена"}]}},
    {"recap": {"decisions": ["d"] * 201}},
    {"recap": {"summary": "x" * 20_001}},
])
def test_patch_meeting_validation(client, body):
    sid, _, before = run_batch(client, transcript=MEETING, title="Встреча")
    assert client.patch(f"/api/meetings/{sid}", json=body).status_code == 422
    after = client.get(f"/api/meetings/{sid}").json()
    assert after["title"] == before["title"] and after["recap"] == before["recap"]


def test_patch_unknown_meeting(client):
    assert client.patch("/api/meetings/nope", json={"title": "x"}).status_code == 404


def test_rebuild_with_another_template(client):
    sid, _, _ = run_batch(client, transcript=MEETING, title="Встреча")
    client.patch(f"/api/meetings/{sid}", json={"reviewed": True})
    r = client.post(f"/api/meetings/{sid}/rebuild", json={"template": "retro"})
    assert r.status_code == 200, r.text
    stored = client.get(f"/api/meetings/{sid}").json()
    for report in (r.json(), stored):
        assert report["template"] == "retro" and report["reviewed"] is False
        assert report["recap"]["summary"].startswith("Симуляция:")
    assert len(stored["answers"]) == len(r.json()["answers"]) > 0  # answers are kept
    assert client.post(f"/api/meetings/{sid}/rebuild", json={"template": "nope"}).status_code == 422
    assert client.post(f"/api/meetings/{sid}/rebuild", json={}).status_code == 422
    assert client.post("/api/meetings/nope/rebuild", json={"template": "retro"}).status_code == 404


def test_rebuild_without_stored_transcript_is_409(make_client):
    client = make_client(store_segments=False)
    sid, _, report = run_batch(client, transcript=MEETING, title="Встреча")
    assert report["segments"] == []
    assert client.post(f"/api/meetings/{sid}/rebuild", json={"template": "retro"}).status_code == 409


def test_stored_item_status(client):
    sid, _, report = run_batch(client, transcript=MEETING, title="Встреча")
    suggestion = next(i for i in report["items"] if i["origin"] == "meeting")
    url = f"/api/meetings/{sid}/items/{suggestion['id']}/status"
    r = client.post(url, json={"status": "dismissed"})
    assert r.status_code == 200 and r.json()["status"] == "dismissed"
    stored = client.get(f"/api/meetings/{sid}").json()
    assert next(i for i in stored["items"] if i["id"] == suggestion["id"])["status"] == "dismissed"
    assert client.post(url, json={"status": "gone"}).status_code == 422
    assert client.post(f"/api/meetings/{sid}/items/nope/status", json={"status": "dismissed"}).status_code == 404
    assert client.post("/api/meetings/nope/items/x/status", json={"status": "dismissed"}).status_code == 404


@pytest.mark.parametrize("action", list(ASSIST_ACTIONS))
def test_live_assist_actions(client, action):
    meta_ids = [a["id"] for a in client.get("/api/meta").json()["assist_actions"]]
    assert action in meta_ids
    sid = new_session(client)
    post_text(client, sid, MEETING, flush=False)
    r = client.post(f"/api/live/{sid}/assist", json={"action": action, "minutes": 2})
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["title"] == ASSIST_ACTIONS[action] and result["source"] == "ai"
    assert isinstance(result["text"], str) and isinstance(result["bullets"], list)
    events = wait_events(client, sid, has_type("assist"))
    assert next(e for e in events if e["type"] == "assist")["data"]["action"] == action


def test_live_assist_validation_and_empty_session(client):
    sid = new_session(client)
    empty = client.post(f"/api/live/{sid}/assist", json={"action": "summary"})
    assert empty.status_code == 200 and empty.json()["source"] == "none"
    assert client.post(f"/api/live/{sid}/assist", json={"action": "dance"}).status_code == 422
    assert client.post(f"/api/live/{sid}/assist", json={"action": "summary", "minutes": 0.1}).status_code == 422
    assert client.post(f"/api/live/{sid}/assist", json={"action": "summary", "minutes": 31}).status_code == 422
    assert client.post("/api/live/unknown/assist", json={"action": "summary"}).status_code == 404


def test_live_finish_saves_report_exports_and_delete(client):
    sid = new_session(client, title="Игра в Самокате")
    items = post_text(client, sid, MEETING)["new_items"]
    voice = next(i for i in items if i["origin"] == "voice")
    events, report = finish(client, sid)
    types = [e["type"] for e in events]
    assert "recap" in types and types[-1] == "done" and types.index("recap") < types.index("done")
    assert next(e for e in events if e["type"] == "done")["data"] == {"id": sid}
    recap = next(e for e in events if e["type"] == "recap")["data"]
    assert recap["summary"].startswith("Симуляция:")
    state = client.get(f"/api/live/{sid}").json()
    assert state["state"] == "finished" and state["report"]["id"] == sid

    assert report["title"] == "Игра в Самокате" and report["mode"] == "sim-good" and len(report["segments"]) == 5
    assert answer_of(report, voice["id"])["status"] == "draft"
    assert report["recap"]["decisions"] and report["recap"]["action_items"][0]["owner"] == "Макс"
    listed = client.get("/api/meetings").json()
    assert [m["id"] for m in listed] == [sid] and listed[0]["title"] == "Игра в Самокате"

    md = client.get(f"/api/meetings/{sid}/markdown")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/plain")
    assert md.text.startswith("# Игра в Самокате") and VOICE_TEXT in md.text and QUESTION in md.text
    docx = client.get(f"/api/meetings/{sid}/docx")
    assert docx.status_code == 200 and docx.content.startswith(b"PK")
    assert "wordprocessingml" in docx.headers["content-type"]
    assert f'recapper-{sid}.docx' in docx.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(docx.content)) as z:
        assert "word/document.xml" in z.namelist()
        assert "Игра в Самокате" in z.read("word/document.xml").decode("utf-8")

    assert client.delete(f"/api/meetings/{sid}").json() == {"deleted": sid}
    assert client.get("/api/meetings").json() == []
    for method, url in (("GET", f"/api/meetings/{sid}"), ("GET", f"/api/meetings/{sid}/markdown"),
                        ("GET", f"/api/meetings/{sid}/docx"), ("DELETE", f"/api/meetings/{sid}")):
        assert client.request(method, url).status_code == 404, url
    assert client.post(f"/api/meetings/{sid}/chat", json={"question": "Что решили?"}).status_code == 404
    assert client.post(f"/api/meetings/{sid}/speakers", json={"old": "Аня", "new": "Анна"}).status_code == 404
    assert client.post(f"/api/meetings/{sid}/items/{voice['id']}/answer").status_code == 404


def test_report_is_fetchable_as_soon_as_done_is_emitted(client):
    store = client.app.state.runtime.store
    original = store.save

    def slow_save(report, owner=""):
        time.sleep(1.0)  # widen the (normally millisecond) window deterministically
        original(report, owner=owner)

    store.save = slow_save
    sid = new_session(client)
    post_text(client, sid, MEETING, flush=False)
    client.post(f"/api/live/{sid}/finish")
    wait_events(client, sid, has_type("done"))
    assert client.get(f"/api/meetings/{sid}").status_code == 200


def test_answer_stored_suggestion_after_meeting(client):
    sid = new_session(client)
    items = post_text(client, sid, MEETING)["new_items"]
    suggestion = next(i for i in items if i["text"] == QUESTION)
    finish(client, sid)
    r = client.post(f"/api/meetings/{sid}/items/{suggestion['id']}/answer")
    assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["item_id"] == suggestion["id"]
    stored = client.get(f"/api/meetings/{sid}").json()
    assert [a["item_id"] for a in stored["answers"]].count(suggestion["id"]) == 1
    # Re-answering replaces, never duplicates.
    client.post(f"/api/meetings/{sid}/items/{suggestion['id']}/answer")
    stored = client.get(f"/api/meetings/{sid}").json()
    assert [a["item_id"] for a in stored["answers"]].count(suggestion["id"]) == 1
    assert client.post(f"/api/meetings/{sid}/items/nope/answer").status_code == 404


@pytest.mark.parametrize("how", ["request", "settings"])
def test_auto_answer_all_answers_suggestions(client, how):
    if how == "settings":
        client.put("/api/settings", json={"values": {"auto_answer": "all"}})
        sid = new_session(client)
    else:
        sid = new_session(client, auto_answer="all")
    items = post_text(client, sid, MEETING)["new_items"]
    suggestion = next(i for i in items if i["text"] == QUESTION)
    voice = next(i for i in items if i["origin"] == "voice")
    events = wait_events(client, sid, has_answers_for(suggestion["id"], voice["id"]))
    assert answers_by_item(events)[suggestion["id"]][0]["status"] == "draft"


def test_live_create_validation(client):
    assert client.post("/api/live", json={"template": "nope"}).status_code == 422
    assert client.post("/api/live", json={"auto_answer": "everything"}).status_code == 422
    assert client.post("/api/live", json={"title": "x" * 201}).status_code == 422
    r = client.post("/api/live", json={"template": "product"})
    assert r.status_code == 200 and r.json()["template"] == "product"
    assert client.post("/api/live", json={}).status_code == 200  # all fields optional


def test_segments_validation(client):
    sid = new_session(client)
    assert client.post(f"/api/live/{sid}/segments", json={}).status_code == 422  # nothing to add
    assert client.post(f"/api/live/{sid}/segments", json={"text": "   "}).status_code == 422
    assert client.post(f"/api/live/{sid}/segments", json={"text": "x" * 100_001}).status_code == 422
    many = [{"text": f"реплика {i}"} for i in range(501)]
    assert client.post(f"/api/live/{sid}/segments", json={"segments": many}).status_code == 422
    assert client.post(f"/api/live/{sid}/segments", json={"flush": True}).json() == {"added": 0, "new_items": []}
    r = client.post(f"/api/live/{sid}/segments", json={
        "segments": [{"speaker": "Аня", "text": VOICE, "start": 12.5}], "text": "Макс: А это из текста."})
    assert r.status_code == 200 and r.json()["added"] == 2
    item = r.json()["new_items"][0]
    assert item["start"] == 12.5 and item["speaker"] == "Аня"
    assert client.post("/api/live/unknown/segments", json={"text": "Аня: привет"}).status_code == 404


def test_session_segment_cap(client, monkeypatch):
    monkeypatch.setattr(webapp, "MAX_SESSION_SEGMENTS", 3)
    sid = new_session(client)
    post_text(client, sid, "Аня: раз\nМакс: два", flush=False)
    r = client.post(f"/api/live/{sid}/segments", json={"text": "Аня: три\nМакс: четыре"})
    assert r.status_code == 413


def test_live_session_limit(client, monkeypatch):
    monkeypatch.setattr(webapp, "MAX_LIVE_SESSIONS", 2)
    a, _ = new_session(client), new_session(client)
    assert client.post("/api/live", json={}).status_code == 429
    assert client.post("/api/meetings", data={"transcript": MEETING}).status_code == 429
    finish(client, a)  # a finished session frees a slot
    assert client.post("/api/live", json={}).status_code == 200


def test_events_since_and_unknown_session(client):
    sid = new_session(client)
    post_text(client, sid, MEETING, flush=False)
    first = client.get(f"/api/live/{sid}/events").json()
    assert first["state"] == "open" and first["finished"] is False and first["events"]
    last = first["last"]
    assert last == first["events"][-1]["seq"]
    later = client.get(f"/api/live/{sid}/events", params={"since": last}).json()
    assert all(e["seq"] > last for e in later["events"])
    assert client.get(f"/api/live/{sid}/events", params={"since": 10_000}).json() == {
        "events": [], "last": 10_000, "state": "open", "finished": False}
    assert client.get(f"/api/live/{sid}/events", params={"since": -1}).status_code == 422
    assert client.get("/api/live/unknown/events").status_code == 404
    assert client.get("/api/live/unknown").status_code == 404
    assert client.post("/api/live/unknown/finish").status_code == 404


def test_finished_session_rejects_input(client, monkeypatch):
    sid = new_session(client)
    items = post_text(client, sid, MEETING)["new_items"]
    finish(client, sid)
    assert client.post(f"/api/live/{sid}/segments", json={"text": "Аня: ещё реплика"}).status_code == 409
    assert client.post(f"/api/live/{sid}/segments", json={"flush": True}).status_code == 409
    assert client.post(f"/api/live/{sid}/ask", json={"question": "Что ещё?"}).status_code == 409
    assert client.post(f"/api/live/{sid}/items/{items[0]['id']}/answer").status_code == 409
    assert client.post(f"/api/live/{sid}/items/{items[0]['id']}/refine", json={"question": "Ещё?"}).status_code == 409
    audio = client.post(f"/api/live/{sid}/audio", files={"file": ("a.wav", VOICE.encode(), "audio/wav")})
    assert audio.status_code == 409
    # Finishing twice is fine and idempotent.
    for _ in range(2):
        r = client.post(f"/api/live/{sid}/finish")
        assert r.status_code == 200 and r.json() == {"id": sid, "state": "finished"}
    events = client.get(f"/api/live/{sid}/events").json()
    assert [e["type"] for e in events["events"]].count("done") == 1 and events["finished"] is True
    assert len(client.get("/api/meetings").json()) == 1
    # Once the finished session is cleaned up it is simply gone.
    monkeypatch.setattr(webapp, "DONE_TTL", -1)
    assert client.get(f"/api/live/{sid}/events").status_code == 404
    assert client.post(f"/api/live/{sid}/segments", json={"text": "Аня: ещё"}).status_code == 404
    assert client.post(f"/api/live/{sid}/ask", json={"question": "Что ещё?"}).status_code == 404
    assert client.get(f"/api/meetings/{sid}").status_code == 200  # the report itself stays


def test_finish_twice_immediately(client):
    sid = new_session(client)
    post_text(client, sid, MEETING)
    r1, r2 = client.post(f"/api/live/{sid}/finish"), client.post(f"/api/live/{sid}/finish")
    assert r1.status_code == r2.status_code == 200
    assert r2.json()["state"] in ("closing", "finished")
    events = wait_events(client, sid, has_type("done"))
    time.sleep(0.1)
    events = client.get(f"/api/live/{sid}/events").json()["events"]
    assert [e["type"] for e in events].count("done") == 1 and [e["type"] for e in events].count("recap") == 1
    assert len(client.get("/api/meetings").json()) == 1


def test_idle_open_session_is_dropped(client, monkeypatch):
    sid = new_session(client)
    monkeypatch.setattr(webapp, "LIVE_IDLE_TTL", -1)
    assert client.get(f"/api/live/{sid}").status_code == 404


# --- GET /api/live (open sessions) -------------------------------------------------------------------


class _Clock:
    """Stand-in for ``datetime`` in recapper.models, handing out preset timestamps."""

    def __init__(self, *moments: datetime) -> None:
        self._moments = iter(moments)

    def now(self, tz=None) -> datetime:
        return next(self._moments)


T0 = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)


def test_live_list_shows_open_sessions_until_finished(client):
    assert client.get("/api/live").json() == []
    sid = new_session(client, title="Планёрка", template="standup")
    listed = client.get("/api/live").json()
    assert len(listed) == 1
    entry = listed[0]
    assert set(entry) == {"id", "title", "state", "created_at", "template"}
    assert entry["id"] == sid and entry["title"] == "Планёрка" and entry["state"] == "open"
    assert entry["template"] == "standup" and datetime.fromisoformat(entry["created_at"])
    other = new_session(client)
    assert {s["id"] for s in client.get("/api/live").json()} == {sid, other}
    finish(client, sid)
    assert [s["id"] for s in client.get("/api/live").json()] == [other]
    assert TestClient(client.app).get("/api/live").status_code == 401


def test_live_list_newest_first(client, monkeypatch):
    monkeypatch.setattr("recapper.models.datetime", _Clock(T0, T0 + timedelta(seconds=1), T0 + timedelta(seconds=2)))
    ids = [new_session(client, title=t) for t in ("A", "B", "C")]
    assert [s["id"] for s in client.get("/api/live").json()] == ids[::-1]


def test_live_list_newest_first_within_same_second(client, monkeypatch):
    monkeypatch.setattr("recapper.models.datetime", _Clock(T0, T0))
    first, second = new_session(client, title="Старая"), new_session(client, title="Новая")
    assert [s["id"] for s in client.get("/api/live").json()] == [second, first]


def test_live_list_includes_batch_while_processing(client):
    gate = threading.Event()

    def hold(sess):  # keep the batch "processing" until the test has looked at the list
        original = sess.add_segments
        sess.add_segments = lambda *a, **k: (gate.wait(5), original(*a, **k))[1]

    capture_sessions(client.app, hook=hold)
    r = client.post("/api/meetings", data={"transcript": MEETING, "title": "Пакет"})
    sid = r.json()["id"]
    try:
        listed = client.get("/api/live").json()
        assert [s["id"] for s in listed] == [sid] and listed[0]["title"] == "Пакет"
    finally:
        gate.set()
    wait_events(client, sid, has_type("done"))
    assert client.get("/api/live").json() == []


# --- batch -------------------------------------------------------------------------------------------


def test_batch_transcript_with_questions(client, meeting_text):
    segments = parse_transcript(meeting_text)
    expected_commands = [i.text for i in CommandDetector().detect(segments, [], [])]
    assert any(t.startswith("Допиши механику монетизации") for t in expected_commands)
    sid, events, report = run_batch(client, transcript=meeting_text, title="Самокат × Купер",
                                    questions="Какой бюджет на награды?\n\n  \nКто делает дизайн экрана награды?")
    assert report["title"] == "Самокат × Купер" and len(report["segments"]) == len(segments)
    voice = [i for i in report["items"] if i["origin"] == "voice"]
    typed = [i for i in report["items"] if i["origin"] == "user"]
    assert [i["text"] for i in voice] == expected_commands
    assert [i["text"] for i in typed] == ["Какой бюджет на награды?", "Кто делает дизайн экрана награды?"]
    for item in voice + typed:
        assert answer_of(report, item["id"])["status"] == "draft"
    heard = [i for i in report["items"] if i["origin"] == "meeting"]
    assert heard and all(answer_of(report, i["id"]) is None for i in heard)
    assert report["recap"]["summary"].startswith("Симуляция:")
    assert not [e for e in events if e["type"] == "error"]
    assert sid in [m["id"] for m in client.get("/api/meetings").json()]


def test_batch_file_upload_template_and_auto_answer(client, meeting_text):
    _, _, report = run_batch(client, files={"file": ("meeting.txt", meeting_text.encode(), "text/plain")},
                             template="product", auto_answer="all", transcript="ignored when a file is sent")
    assert len(report["segments"]) == len(parse_transcript(meeting_text)) and report["template"] == "product"
    assert {a["item_id"] for a in report["answers"]} == {i["id"] for i in report["items"]}


def test_batch_caps_questions(client):
    questions = "\n".join(f"Вопрос номер {i} про бюджет?" for i in range(25))
    _, _, report = run_batch(client, transcript="Аня: Обсуждаем бюджет.", questions=questions)
    assert len([i for i in report["items"] if i["origin"] == "user"]) == 20


@pytest.mark.parametrize("form,files", [
    ({"transcript": ""}, None),
    ({"transcript": "   \n\t\n"}, None),
    ({}, None),
    ({}, {"file": ("empty.txt", b"", "text/plain")}),
    ({}, {"file": ("blank.txt", b"\n\n   \n", "text/plain")}),
])
def test_batch_rejects_empty_transcript(client, form, files):
    r = client.post("/api/meetings", data=form, files=files)
    assert r.status_code == 422
    assert client.get("/api/live").json() == []  # no session left behind


@pytest.mark.parametrize("payload", [
    b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n",  # an export of a meeting with no speech
    b"WEBVTT\n",
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06",  # binary uploaded by mistake
], ids=["empty-vtt-cue", "vtt-header-only", "png-bytes"])
def test_batch_rejects_garbage_transcript(client, payload):
    r = client.post("/api/meetings", files={"file": ("export.vtt", payload, "text/plain")})
    assert r.status_code == 422


def test_batch_unknown_template(client):
    r = client.post("/api/meetings", data={"transcript": MEETING, "template": "nope"})
    assert r.status_code == 422 and "nope" in r.json()["detail"]
    r = client.post("/api/meetings", data={"transcript": MEETING, "title": "x" * 201})
    assert r.status_code == 422


def test_batch_oversized(client, monkeypatch):
    monkeypatch.setattr(webapp, "MAX_TRANSCRIPT_BYTES", 200)
    big = ("Аня: " + "слово " * 60).encode()
    assert len(big) > 200
    assert client.post("/api/meetings", data={"transcript": big.decode()}).status_code == 413
    assert client.post("/api/meetings", files={"file": ("m.txt", big, "text/plain")}).status_code == 413
    exact = "Аня: " + "я" * ((200 - len("Аня: ".encode())) // 2)
    assert len(exact.encode()) <= 200
    assert client.post("/api/meetings", files={"file": ("m.txt", exact.encode(), "text/plain")}).status_code == 200


def test_batch_accepts_pasted_transcript_between_1_and_5_mb(client, monkeypatch):
    sessions = capture_sessions(client.app)
    text = "Аня: " + "а" * 1_100_000  # one long utterance, cheap to process
    assert len(text.encode()) < webapp.MAX_TRANSCRIPT_BYTES
    r = client.post("/api/meetings", data={"transcript": text})
    for sess in sessions:
        sess.close()
    assert r.status_code == 200, r.text


# --- audio -------------------------------------------------------------------------------------------


def upload(client, sid, text: str, **form):
    return client.post(f"/api/live/{sid}/audio", files={"file": ("chunk.wav", text.encode("utf-8"), "audio/wav")},
                       data={k: str(v) for k, v in form.items()})


def test_live_audio_mic_and_system_speakers_and_offsets(client):
    sid = new_session(client)
    mic = upload(client, sid, f"{VOICE}\nЭто вторая фраза.", source="mic", offset=30)
    assert mic.status_code == 200, mic.text
    body = mic.json()
    assert body["added"] == 2
    assert [(s["speaker"], s["start"], s["end"]) for s in body["segments"]] == [("Я", 30.0, 34.0), ("Я", 35.0, 39.0)]
    assert len(body["new_items"]) == 1 and body["new_items"][0]["origin"] == "voice"
    assert body["new_items"][0]["speaker"] == "Я" and body["new_items"][0]["start"] == 30.0

    system = upload(client, sid, "Как считать конверсию?", source="system", offset=60.5).json()
    assert [(s["speaker"], s["start"]) for s in system["segments"]] == [("Собеседники", 60.5)]
    default = upload(client, sid, "Фраза без параметров.").json()
    assert default["segments"][0]["speaker"] == "Я" and default["segments"][0]["start"] == 0.0
    negative = upload(client, sid, "Отрицательный сдвиг.", offset=-10).json()
    assert negative["segments"][0]["start"] == 0.0

    report = client.get(f"/api/live/{sid}").json()["report"]
    assert [s["speaker"] for s in report["segments"]] == ["Я", "Я", "Собеседники", "Я", "Я"]
    events = wait_events(client, sid, has_answers_for(body["new_items"][0]["id"]))
    assert answers_by_item(events)[body["new_items"][0]["id"]][0]["status"] == "draft"


def test_live_audio_uses_configured_labels(client):
    client.put("/api/settings", json={"values": {"me_label": "Ведущий", "others_label": "Клиент"}})
    sid = new_session(client)
    assert upload(client, sid, "Раз.", source="mic").json()["segments"][0]["speaker"] == "Ведущий"
    assert upload(client, sid, "Два.", source="system").json()["segments"][0]["speaker"] == "Клиент"


def test_live_audio_errors(make_client):
    client = make_client()
    sid = new_session(client)
    assert upload(client, sid, "Фраза.", source="speaker").status_code == 422
    assert upload(client, sid, "Фраза.", offset="abc").status_code == 422
    r = upload(client, sid, "!asr-error")
    assert r.status_code == 422 and "распознать" in r.json()["detail"]
    silent = upload(client, sid, "   \n")
    assert silent.status_code == 200 and silent.json() == {"added": 0, "segments": [], "new_items": []}
    assert client.post(f"/api/live/{sid}/audio").status_code == 422  # no file
    assert upload(client, "unknown", "Фраза.").status_code == 404


def test_live_audio_deletes_temp_file(make_client):
    transcriber = TextTranscriber()
    client = make_client(transcriber=transcriber)
    sid = new_session(client)
    assert upload(client, sid, "Фраза.").status_code == 200
    assert transcriber.paths and not transcriber.paths[-1].exists()


def test_audio_without_asr_is_503(make_client):
    client = make_client(transcriber=None)  # asr_provider defaults to "none"
    assert client.get("/api/health").json()["asr"] == "none"
    sid = new_session(client)
    r = upload(client, sid, VOICE)
    assert r.status_code == 503 and r.json()["detail"]
    r = client.post("/api/meetings/audio", files={"file": ("m.wav", b"x", "audio/wav")}, data={"consent": "true"})
    assert r.status_code == 503
    # Invalid source is still rejected first.
    assert upload(client, sid, VOICE, source="x").status_code == 422


def test_meeting_audio_requires_consent(client):
    for data in ({}, {"consent": "false"}, {"consent": "0"}):
        r = client.post("/api/meetings/audio", files={"file": ("m.wav", VOICE.encode(), "audio/wav")}, data=data)
        assert r.status_code == 400 and "consent" in r.json()["detail"]
    assert client.get("/api/live").json() == []


def test_meeting_audio_full_flow(make_client):
    transcriber = TextTranscriber()
    client = make_client(transcriber=transcriber)
    r = client.post("/api/meetings/audio", files={"file": ("call.m4a", f"Всем привет.\n{VOICE}".encode(), "audio/mp4")},
                    data={"consent": "true", "title": "Созвон", "questions": "Какой бюджет на награды?"})
    assert r.status_code == 200 and r.json()["state"] == "processing"
    sid = r.json()["id"]
    wait_events(client, sid, has_type("done"))
    report = wait_report(client, sid)
    assert report["title"] == "Созвон" and [s["start"] for s in report["segments"]] == [0.0, 5.0]
    assert transcriber.paths[-1].suffix == ".m4a" and not transcriber.paths[-1].exists()
    kinds = sorted(i["origin"] for i in report["items"])
    assert kinds == ["user", "voice"] and all(a["status"] == "draft" for a in report["answers"])


def test_meeting_audio_errors(client):
    def post(payload: str):
        return client.post("/api/meetings/audio", files={"file": ("m.wav", payload.encode(), "audio/wav")},
                           data={"consent": "true"})

    assert post("   ").status_code == 422  # no speech recognised
    assert post("!asr-error").status_code == 422
    assert client.post("/api/meetings/audio", data={"consent": "true"}).status_code == 422  # no file
    assert client.get("/api/live").json() == []


# --- speakers ----------------------------------------------------------------------------------------


def test_rename_speaker(client):
    sid = new_session(client)
    post_text(client, sid, MEETING)
    finish(client, sid)
    r = client.post(f"/api/meetings/{sid}/speakers", json={"old": "Аня", "new": "Анна"})
    # 3 utterances + the item and action item she owns: everything is renamed, and counted.
    assert r.status_code == 200 and r.json()["renamed"] >= 3
    report = client.get(f"/api/meetings/{sid}").json()
    speakers = [s["speaker"] for s in report["segments"]]
    assert "Аня" not in speakers and speakers.count("Анна") == 3
    assert all(i["speaker"] != "Аня" for i in report["items"])
    assert any(i["speaker"] == "Анна" and i["origin"] == "voice" for i in report["items"])
    r = client.post(f"/api/meetings/{sid}/speakers", json={"old": "Макс", "new": "Максим"})
    assert r.json()["renamed"] >= 2  # his utterance + the action item he owns (+ items he voiced)
    report = client.get(f"/api/meetings/{sid}").json()
    assert report["recap"]["action_items"][0]["owner"] == "Максим"
    assert client.post(f"/api/meetings/{sid}/speakers", json={"old": "Аня", "new": "X"}).status_code == 404
    assert client.post(f"/api/meetings/{sid}/speakers", json={"old": "Нет", "new": "X"}).status_code == 404
    assert client.post(f"/api/meetings/{sid}/speakers", json={"old": "Анна", "new": ""}).status_code == 422
    assert client.post("/api/meetings/nope/speakers", json={"old": "Анна", "new": "X"}).status_code == 404


def test_rename_speaker_without_stored_segments(make_client):
    client = make_client(store_segments=False)
    sid = new_session(client)
    post_text(client, sid, MEETING)
    _, report = finish(client, sid)
    assert report["segments"] == [] and any(i["speaker"] == "Аня" for i in report["items"])
    r = client.post(f"/api/meetings/{sid}/speakers", json={"old": "Аня", "new": "Анна"})
    assert r.status_code == 200
    assert all(i["speaker"] != "Аня" for i in client.get(f"/api/meetings/{sid}").json()["items"])


# --- chat, memory, /api/ask --------------------------------------------------------------------------


ATTRIBUTION = ("Аня: Обсуждаем атрибуцию заказов в Купере.\n"
               "Лена: Решили считать атрибуцию промокодов по уникальному промокоду на пользователя.\n"
               "Макс: Глубокие ссылки с UTM-метками тоже подключим.")
DESIGN = ("Аня: Обсуждаем дизайн экрана награды.\n"
          "Лена: Нужны яркие цвета и анимация конфетти.")


def test_chat_offline_returns_answer_and_three_suggestions(make_client):
    client = make_client(provider="none")
    sid, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    r = client.post(f"/api/meetings/{sid}/chat", json={"question": "Как решили считать атрибуцию?"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "offline" and "атрибуц" in body["answer"].lower()
    assert len(body["suggestions"]) == 3 and all(isinstance(s, str) and s for s in body["suggestions"])
    assert client.post(f"/api/meetings/{sid}/chat", json={"question": "?"}).status_code == 422
    assert client.post("/api/meetings/nope/chat", json={"question": "Что решили?"}).status_code == 404


def test_chat_sim_good_returns_answer_and_three_suggestions(client):
    sid, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    body = client.post(f"/api/meetings/{sid}/chat", json={"question": "Как решили считать атрибуцию?"}).json()
    assert body["source"] == "ai" and body["answer"]
    assert len(body["suggestions"]) == 3 and all(isinstance(s, str) and s for s in body["suggestions"])


class ChatLLM(FakeLLM):
    """A schema-valid model that ignores the "exactly 3 suggestions" instruction."""

    def __init__(self, suggestions: list[str]):
        super().__init__()
        self.suggestions = suggestions

    def json(self, system, prompt, schema, effort):
        if "suggestions" in schema.get("properties", {}):
            return {"answer": "Решили считать по уникальному промокоду.", "suggestions": list(self.suggestions)}
        return super().json(system, prompt, schema, effort)


def chat_client(tmp_path, suggestions: list[str]) -> tuple[TestClient, str]:
    settings = Settings(db_path=tmp_path / "chat.db", llm_provider="none")
    runtime = Runtime(settings, ReportStore(settings.db_path), llm=ChatLLM(suggestions))
    client = TestClient(create_app(settings, runtime=runtime, api_token=TOKEN), headers=AUTH)
    report = MeetingReport(title="Атрибуция", segments=parse_transcript(ATTRIBUTION))
    runtime.store.save(report, owner="web")
    return client, report.id


def test_chat_trims_extra_model_suggestions(tmp_path):
    client, rid = chat_client(tmp_path, [f"Вопрос {i}?" for i in range(5)])
    body = client.post(f"/api/meetings/{rid}/chat", json={"question": "Как решили считать атрибуцию?"}).json()
    assert body["source"] == "ai" and body["suggestions"] == ["Вопрос 0?", "Вопрос 1?", "Вопрос 2?"]


def test_chat_always_returns_three_suggestions(tmp_path):
    client, rid = chat_client(tmp_path, ["Кто отвечает за атрибуцию?"])
    body = client.post(f"/api/meetings/{rid}/chat", json={"question": "Как решили считать атрибуцию?"}).json()
    assert body["source"] == "ai" and len(body["suggestions"]) == 3


def test_memory_search_finds_earlier_meeting(make_client):
    client = make_client(provider="none")
    first, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    second, _, _ = run_batch(client, transcript=DESIGN, title="Дизайн")
    hits = client.get("/api/memory/search", params={"q": "атрибуция промокодов"}).json()
    assert hits and hits[0]["meeting_id"] == first and hits[0]["title"] == "Атрибуция"
    assert second not in {h["meeting_id"] for h in hits}
    assert set(hits[0]) == {"meeting_id", "title", "date", "text", "score"} and hits[0]["score"] > 0
    design_hits = client.get("/api/memory/search", params={"q": "анимация конфетти"}).json()
    assert design_hits[0]["meeting_id"] == second
    assert client.get("/api/memory/search", params={"q": "ыыыыы"}).json() == []
    assert client.get("/api/memory/search", params={"q": "a"}).status_code == 422
    assert client.get("/api/memory/search").status_code == 422


def test_voice_command_gets_past_meeting_source_offline(make_client):
    client = make_client(provider="none")
    first, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    other, _, _ = run_batch(client, transcript=DESIGN, title="Дизайн")
    sid = new_session(client, title="Новая встреча")
    items = post_text(client, sid, "Аня: Ассистент, напомни, как мы решили считать атрибуцию промокодов.")["new_items"]
    voice = next(i for i in items if i["origin"] == "voice")
    _, report = finish(client, sid)
    answer = answer_of(report, voice["id"])
    assert answer["status"] == "needs_llm" and "Из прошлых встреч" in answer["body"]
    refs = {s["ref"] for s in answer["sources"]}
    assert f"meeting:{first}" in refs and f"meeting:{other}" not in refs


def test_ask_all_meetings(make_client):
    client = make_client(provider="none")
    first, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    r = client.post("/api/ask", json={"question": "Что мы решили про атрибуцию промокодов?"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] and len(body["suggestions"]) == 3 and body["source"] == "offline"
    assert "Из прошлых встреч" in body["answer"]
    source = next(s for s in body["sources"] if s["ref"] == f"meeting:{first}")
    assert source["title"].startswith("Встреча «Атрибуция»")
    assert client.post("/api/ask", json={"question": "x"}).status_code == 422


def test_ask_all_meetings_sim_good(client):
    first, _, _ = run_batch(client, transcript=ATTRIBUTION, title="Атрибуция")
    body = client.post("/api/ask", json={"question": "Что мы решили про атрибуцию промокодов?"}).json()
    assert body["answer"] and body["suggestions"] and body["source"] == "ai"
    assert f"meeting:{first}" in {s["ref"] for s in body["sources"]}


# --- knowledge base ----------------------------------------------------------------------------------


KB_DOC = ("# Правила промо\n\n"
          "Бюджет на награды для игры ограничен: не больше 55 рублей за заказ.\n\n"
          "Награды за заказ согласует финансовый отдел.").encode()


def test_knowledge_upload_used_in_answers_and_delete(client):
    assert client.get("/api/knowledge").json() == []
    r = client.post("/api/knowledge", files={"file": ("promo_rules.md", KB_DOC, "text/markdown")})
    assert r.status_code == 200 and r.json()["name"] == "promo_rules.md" and r.json()["chunks"] >= 1
    assert client.get("/api/knowledge").json() == [{"name": "promo_rules.md", "size": len(KB_DOC)}]

    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    events = wait_events(client, sid, has_answers_for(voice["id"]))
    answer = answers_by_item(events)[voice["id"]][0]
    assert {"title": "promo_rules.md", "ref": "doc:promo_rules.md"} in answer["sources"]
    assert "[doc:promo_rules.md]" in answer["summary"]

    r = client.delete("/api/knowledge/promo_rules.md")
    assert r.status_code == 200 and r.json() == {"deleted": "promo_rules.md", "chunks": 0}
    assert client.get("/api/knowledge").json() == []
    assert client.delete("/api/knowledge/promo_rules.md").status_code == 404
    sid = new_session(client)
    voice = post_text(client, sid, f"Аня: {VOICE}", flush=False)["new_items"][0]
    events = wait_events(client, sid, has_answers_for(voice["id"]))
    assert answers_by_item(events)[voice["id"]][0]["sources"] == []


def test_knowledge_reupload_overwrites(client):
    client.post("/api/knowledge", files={"file": ("a.txt", b"first version text", "text/plain")})
    client.post("/api/knowledge", files={"file": ("a.txt", b"second", "text/plain")})
    assert client.get("/api/knowledge").json() == [{"name": "a.txt", "size": 6}]


@pytest.mark.parametrize("name", ["a.exe", "notes", "x.md;ls", "..", ".md", "файл.pdf", "a" * 121 + ".md",
                                  "evil\\..\\x.md", "x.md "])
def test_knowledge_rejects_bad_names(client, name):
    r = client.post("/api/knowledge", files={"file": (name, b"text", "text/plain")})
    assert r.status_code == 422, name
    assert client.get("/api/knowledge").json() == []


@pytest.mark.parametrize("name", ["../x.md", "../../x.md", "/tmp/x.md", "sub/x.md"])
def test_knowledge_upload_never_escapes_kb_dir(client, tmp_path, name):
    client.post("/api/knowledge", files={"file": (name, b"# x\n\ntext", "text/markdown")})
    kb_dir = tmp_path / "knowledge"
    written = [p for p in tmp_path.rglob("x.md")]
    assert all(p.parent == kb_dir for p in written)


def test_knowledge_rejects_path_traversal_names(client):
    r = client.post("/api/knowledge", files={"file": ("../x.md", b"# x\n\ntext", "text/markdown")})
    assert r.status_code == 422


def test_knowledge_size_limit(client, monkeypatch):
    big = b"a" * (2 * 1024 * 1024 + 1)
    assert client.post("/api/knowledge", files={"file": ("big.md", big, "text/markdown")}).status_code == 413
    monkeypatch.setattr(webapp, "MAX_KB_FILE_BYTES", 100)
    assert client.post("/api/knowledge", files={"file": ("ok.md", b"b" * 100, "text/markdown")}).status_code == 200
    assert client.post("/api/knowledge", files={"file": ("no.md", b"b" * 101, "text/markdown")}).status_code == 413
    assert [f["name"] for f in client.get("/api/knowledge").json()] == ["ok.md"]


# --- traces (interception) ---------------------------------------------------------------------------


def _session_with_everything(client) -> str:
    sid = new_session(client)
    post_text(client, sid, MEETING)
    client.post(f"/api/live/{sid}/assist", json={"action": "summary"})
    finish(client, sid)
    return sid


def test_traces_sim_good(client):
    _session_with_everything(client)
    body = client.get("/api/traces").json()
    assert body["provider"] == "sim-good" and body["issues"] == 0
    records = body["records"]
    assert records and all(r["provider"] == "sim-good" and r["error"] is None for r in records)
    assert {r["task"] for r in records} >= {"detect", "answer", "recap"}
    assert {r["method"] for r in records} == {"json", "research"}
    assert all(r["prompt"] and r["latency_ms"] >= 0 for r in records)
    assert len(client.get("/api/traces", params={"limit": 1}).json()["records"]) == 1
    assert client.get("/api/traces", params={"limit": 0}).status_code == 422


def test_traces_sim_sloppy_reports_contract_issues(client):
    client.put("/api/settings", json={"values": {"llm_provider": "sim-sloppy"}})
    sid = _session_with_everything(client)
    body = client.get("/api/traces").json()
    assert body["provider"] == "sim-sloppy" and body["issues"] > 0
    issues = [i for r in body["records"] for i in r["issues"]]
    assert any("unexpected field" in i for i in issues)
    assert any("hallucinated" in i and "secret_roadmap.md" in i for i in issues)
    report = client.get(f"/api/meetings/{sid}").json()
    assert any("secret_roadmap.md" in w for a in report["answers"] for w in a["warnings"])
    assert report["answers"][0]["confidence"] == "medium"  # "средняя" parsed despite the sloppy format


def test_traces_offline(make_client):
    client = make_client(provider="none")
    _session_with_everything(client)
    assert client.get("/api/traces").json() == {"provider": "offline", "records": []}


# --- robustness: a broken AI provider ----------------------------------------------------------------


def test_sim_broken_provider_never_breaks_the_meeting(make_client):
    client = make_client(provider="sim-broken", raise_server_exceptions=False)
    sid = new_session(client)
    items = post_text(client, sid, MEETING + "\nЛена: Ассистент, придумай название для игры про корзину.")["new_items"]
    voice = [i for i in items if i["origin"] == "voice"]
    assert len(voice) == 2  # voice commands don't need the AI
    for action in ASSIST_ACTIONS:
        r = client.post(f"/api/live/{sid}/assist", json={"action": action})
        assert r.status_code == 200 and r.json()["source"] == "offline"
    asked = client.post(f"/api/live/{sid}/ask", json={"question": "Сколько стоит одна награда?"}).json()
    events, report = finish(client, sid)

    assert any(e["type"] == "error" and e["data"]["message"] for e in events)
    assert report["recap"]["summary"]  # heuristic fallback
    expected = {i["id"] for i in voice} | {asked["id"]}
    assert expected <= {a["item_id"] for a in report["answers"]}
    for a in report["answers"]:
        assert a["status"] in ("draft", "failed") and a["summary"]
    # Which calls fail depends on thread timing (the simulator's call counter is shared), so
    # compare with what the interception log saw: every bad AI answer must surface as "failed".
    research = [r for r in client.get("/api/traces").json()["records"] if r["method"] == "research"]
    assert len(research) == len(expected)
    bad_calls = sum(1 for r in research if r["error"] or not r["output"]["text"].strip())
    assert sum(1 for a in report["answers"] if a["status"] == "failed") == bad_calls
    md = client.get(f"/api/meetings/{sid}/markdown").text
    assert ("не удалось подготовить ответ" in md) == (bad_calls > 0)

    checks = [
        client.get("/api/meetings"), client.get(f"/api/meetings/{sid}"), client.get(f"/api/meetings/{sid}/docx"),
        client.post(f"/api/meetings/{sid}/chat", json={"question": "Что решили?"}),
        client.post(f"/api/meetings/{sid}/items/{voice[0]['id']}/answer"),
        client.post("/api/ask", json={"question": "Что решили про награды?"}),
        client.get("/api/memory/search", params={"q": "награда"}), client.get("/api/traces"),
        client.get("/api/health"), client.get("/api/settings"),
    ]
    assert all(r.status_code == 200 for r in checks), [(r.request.url.path, r.status_code) for r in checks]
    _, _, batch = run_batch(client, transcript=MEETING, questions="Какой бюджет?")
    assert batch["recap"]["summary"]


# --- owner isolation -----------------------------------------------------------------------------------


def test_bot_reports_are_invisible_to_web(client):
    runtime = client.app.state.runtime
    asyncio.run(BotService(runtime).process_text(1, "Аня: Обсуждаем секретный зефирный проект.\n"
                                                    "Макс: Ассистент, посчитай зефирный бюджет проекта.",
                                                 title="Зефир"))
    bot_reports = runtime.store.list(owner="tg:1")
    assert len(bot_reports) == 1
    rid = bot_reports[0]["id"]
    item_id = runtime.store.get(rid).items[0].id
    assert client.get("/api/meetings").json() == []
    for method, url, body in (
        ("GET", f"/api/meetings/{rid}", None), ("GET", f"/api/meetings/{rid}/markdown", None),
        ("GET", f"/api/meetings/{rid}/docx", None), ("DELETE", f"/api/meetings/{rid}", None),
        ("POST", f"/api/meetings/{rid}/speakers", {"old": "Аня", "new": "X"}),
        ("POST", f"/api/meetings/{rid}/chat", {"question": "Что решили?"}),
        ("POST", f"/api/meetings/{rid}/items/{item_id}/answer", None),
        ("PATCH", f"/api/meetings/{rid}", {"title": "Взлом"}),
        ("POST", f"/api/meetings/{rid}/rebuild", {"template": "retro"}),
        ("POST", f"/api/meetings/{rid}/items/{item_id}/status", {"status": "dismissed"}),
    ):
        assert client.request(method, url, json=body).status_code == 404, url
    assert client.get("/api/memory/search", params={"q": "зефирный проект"}).json() == []
    assert client.post("/api/ask", json={"question": "Что с зефирным проектом?"}).json()["sources"] == []
    bot_report = runtime.store.get(rid, owner="tg:1")
    assert bot_report is not None  # untouched by the web DELETE/PATCH/rename/rebuild
    assert bot_report.title == "Зефир" and bot_report.template == "general"
    assert bot_report.segments[0].speaker == "Аня" and bot_report.items[0].status == "active"


# --- concurrency -------------------------------------------------------------------------------------


TOPIC_WORDS = ["аналитику", "бюджет", "воронку", "гипотезы", "дизайн", "метрики", "отток", "пуш", "релиз", "риски",
               "сегменты", "тексты", "удержание", "финансы", "юристов", "лидерборд", "подарки", "партнёров",
               "нагрузку", "перевод", "конкурентов", "промокоды", "атрибуцию", "поддержку"]


def test_concurrent_producers_and_poller(make_client):
    client = make_client(max_answers=200)
    app = client.app
    sid = new_session(client)
    n_threads, per_thread = 6, 4
    errors: list[str] = []
    stop = threading.Event()
    seen: list[int] = []

    def producer(k: int) -> None:
        c = TestClient(app, headers=AUTH)
        for j in range(per_thread):
            word = TOPIC_WORDS[k * per_thread + j]
            r = c.post(f"/api/live/{sid}/segments",
                       json={"segments": [{"speaker": f"S{k}", "text": f"Ассистент, подготовь справку про {word}."}]})
            if r.status_code != 200:
                errors.append(f"producer {k}: {r.status_code} {r.text}")

    def poller() -> None:
        c = TestClient(app, headers=AUTH)
        since = 0
        while not stop.is_set():
            r = c.get(f"/api/live/{sid}/events", params={"since": since})
            if r.status_code != 200:
                errors.append(f"poller: {r.status_code}")
                return
            body = r.json()
            seqs = [e["seq"] for e in body["events"]]
            if seqs and seqs != list(range(since + 1, since + 1 + len(seqs))):
                errors.append(f"poller: non-contiguous seqs after {since}: {seqs}")
            seen.extend(seqs)
            since = body["last"]
            time.sleep(0.002)

    threads = [threading.Thread(target=producer, args=(k,)) for k in range(n_threads)]
    watcher = threading.Thread(target=poller)
    watcher.start()
    for t in threads:
        t.start()
    for t in threads:
        t.join(20)
    events, report = finish(client, sid)
    stop.set()
    watcher.join(5)

    assert not errors, errors
    assert len(report["segments"]) == n_threads * per_thread
    commands = [i for i in report["items"] if i["origin"] == "voice"]
    assert len(commands) == n_threads * per_thread
    answer_counts = Counter(a["item_id"] for a in report["answers"])
    assert all(answer_counts[i["id"]] == 1 for i in commands)
    assert all(answer_of(report, i["id"])["status"] == "draft" for i in commands)
    event_answers = answers_by_item(events)
    assert all(len(event_answers[i["id"]]) == 1 for i in commands)
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert seen == sorted(set(seen))


def test_command_racing_with_finish_is_not_lost(make_client):
    client = make_client(raise_server_exceptions=False)
    sessions = capture_sessions(client.app)
    sid = new_session(client)
    sess = sessions[-1]
    entered, release = threading.Event(), threading.Event()
    detect = sess.c.commands.detect

    def slow_detect(*args, **kwargs):  # e.g. a long ASR chunk: widen the window deterministically
        found = detect(*args, **kwargs)
        entered.set()
        release.wait(5)
        return found

    sess.c.commands.detect = slow_detect
    result: dict = {}
    t = threading.Thread(target=lambda: result.update(r=client.post(
        f"/api/live/{sid}/segments", json={"text": f"Аня: {VOICE}"})))
    t.start()
    assert entered.wait(5)
    client.post(f"/api/live/{sid}/finish")
    wait_events(client, sid, has_type("done"))
    release.set()
    t.join(5)
    status = result["r"].status_code
    assert status in (200, 409), status
    report = wait_report(client, sid)
    if status == 200:  # accepted -> the command must be in the report, answered
        voice = [i for i in report["items"] if i["origin"] == "voice"]
        assert voice and all(answer_of(report, i["id"]) for i in voice)


# --- answer limit ---------------------------------------------------------------------------------------


def test_answer_limit_emits_limit_event(make_client):
    client = make_client(max_answers=1)
    sid = new_session(client)
    items = post_text(client, sid, f"Аня: {VOICE}\nАня: Ассистент, придумай название для игры про корзину.",
                      flush=False)["new_items"]
    events, report = finish(client, sid)
    limits = [e["data"] for e in events if e["type"] == "limit"]
    assert [x["item_id"] for x in limits] == [items[1]["id"]] and "лимит" in limits[0]["message"]
    assert answer_of(report, items[0]["id"])["status"] == "draft"


def test_answer_limit_is_visible_in_final_report(make_client):
    client = make_client(max_answers=1)
    sid = new_session(client)
    post_text(client, sid, f"Аня: {VOICE}\nАня: Ассистент, придумай название для игры про корзину.", flush=False)
    _, report = finish(client, sid)
    assert "готовится" not in client.get(f"/api/meetings/{sid}/markdown").text
    assert all(answer_of(report, i["id"]) for i in report["items"] if i["origin"] == "voice")


# --- settings UX: provider-dependent fields and the connection test ------------


def test_schema_marks_provider_specific_fields(client):
    rows = {f["key"]: f for f in client.get("/api/settings").json()["schema"]}
    assert rows["anthropic_api_key"]["show_if"] == {"key": "llm_provider", "values": ["auto", "claude"]}
    assert rows["openai_api_key"]["show_if"] == {"key": "llm_provider", "values": ["auto", "openai"]}
    assert rows["whisper_model"]["show_if"]["key"] == "asr_provider"
    assert rows["llm_provider"]["show_if"] is None
    # Labels of the OpenAI-compatible fields no longer name a single vendor.
    assert "Anthropic" not in rows["openai_api_key"]["label"]["ru"]


def test_ai_test_endpoint_uses_form_values(client, monkeypatch):
    import httpx

    from recapper.providers import OpenAICompatLLM

    calls = []

    def handler(request):
        calls.append((str(request.url), request.headers.get("authorization")))
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "gemini-2.5-flash"}]})
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}, "finish_reason": "stop"}]})

    monkeypatch.setattr(webapp, "OpenAICompatLLM",
                        lambda *a, **kw: OpenAICompatLLM(*a, transport=httpx.MockTransport(handler), **kw))
    r = client.post("/api/ai/test", json={"base_url": "http://127.0.0.1:8045", "api_key": "sk-x", "model": "gemini-2.5-flash"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["reply"] == "OK" and body["models"] == ["gemini-2.5-flash"]
    assert body["base_url"] == "http://127.0.0.1:8045/v1"
    assert calls[0] == ("http://127.0.0.1:8045/v1/models", "Bearer sk-x")

    bad = client.post("/api/ai/test", json={"base_url": "http://127.0.0.1:8045", "model": "nope"}).json()
    assert not bad["ok"] and "nope" in bad["error"]


def test_ai_test_reports_unreachable_server(client):
    body = client.post("/api/ai/test", json={"base_url": "http://127.0.0.1:9", "model": "m"}).json()
    assert not body["ok"] and body["models_error"] and body["error"]


def test_ai_test_requires_auth(client):
    assert client.post("/api/ai/test", json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401
