"""Evaluate any AI provider on reference meetings, with every call intercepted.

    recapper eval --provider sim-sloppy
    RECAPPER_LLM=openai OPENAI_BASE_URL=... recapper eval

Each scenario (examples/eval/*.json) lists the voice commands and questions
that must be found, things that must NOT become items, and facts the answer
should contain. The report scores detection, answer quality signals and
contract compliance, so a new model can be judged before users see it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings
from .engine import Runtime, process_segments
from .knowledge import KnowledgeBase, tokenize
from .models import AnswerStatus, MeetingReport
from .providers import TracingLLM
from .store import ReportStore
from .transcript import parse_transcript


@dataclass
class Scenario:
    name: str
    transcript: str
    expect_commands: list[list[str]]  # each: keywords that must all appear in one voice-command item
    expect_items: list[list[str]] = field(default_factory=list)  # suggestions (any origin)
    forbid: list[str] = field(default_factory=list)  # keywords that must not appear in any item
    answer_should_mention: list[str] = field(default_factory=list)  # any answer mentions these
    questions: list[str] = field(default_factory=list)
    auto_answer: str = "commands"

    @classmethod
    def load(cls, path: Path) -> "Scenario":
        data = json.loads(path.read_text("utf-8"))
        return cls(**data)


def _matches(text: str, keywords: list[str]) -> bool:
    tokens = set(tokenize(text))
    return all(set(tokenize(k)) <= tokens for k in keywords)


@dataclass
class ScenarioResult:
    name: str
    commands_found: int
    commands_expected: int
    items_found: int
    items_expected: int
    forbidden_hits: list[str]
    answers_draft: int
    answers_total: int
    mentions_missing: list[str]
    contract_issues: list[str]
    calls: int
    errors: int
    seconds: float

    @property
    def passed(self) -> bool:
        hallucinated = any("hallucinated" in i for i in self.contract_issues)
        return (self.commands_found == self.commands_expected and not self.forbidden_hits and not hallucinated
                and self.answers_total > 0 and self.answers_draft == self.answers_total)


def run_scenario(scenario: Scenario, runtime: Runtime) -> tuple[ScenarioResult, MeetingReport]:
    llm = runtime.llm
    before = len(llm.records) if isinstance(llm, TracingLLM) else 0
    start = time.monotonic()
    components = runtime.components(scenario.name, owner=f"eval:{scenario.name}")
    report = process_segments(parse_transcript(scenario.transcript), components, title=scenario.name,
                              questions=scenario.questions, auto_answer=scenario.auto_answer)
    elapsed = time.monotonic() - start
    records = llm.records[before:] if isinstance(llm, TracingLLM) else []
    commands = [i for i in report.items if i.is_command]
    found_cmd = sum(1 for kw in scenario.expect_commands if any(_matches(i.text, kw) for i in commands))
    found_items = sum(1 for kw in scenario.expect_items if any(_matches(i.text, kw) for i in report.items))
    forbidden = [f for f in scenario.forbid if any(set(tokenize(f)) <= set(tokenize(i.text)) for i in report.items)]
    answered = [a for a in report.answers]
    answer_text = " ".join(f"{a.summary} {a.body}" for a in answered)
    missing = [m for m in scenario.answer_should_mention if not set(tokenize(m)) <= set(tokenize(answer_text))]
    issues = [f"{r.task}: {i}" for r in records for i in r.issues]
    return ScenarioResult(
        name=scenario.name, commands_found=found_cmd, commands_expected=len(scenario.expect_commands),
        items_found=found_items, items_expected=len(scenario.expect_items), forbidden_hits=forbidden,
        answers_draft=sum(1 for a in answered if a.status == AnswerStatus.DRAFT), answers_total=len(answered),
        mentions_missing=missing, contract_issues=issues, calls=len(records),
        errors=sum(1 for r in records if r.error), seconds=round(elapsed, 2),
    ), report


def run_eval(settings: Settings, scenarios_dir: Path, kb_dir: Path | None, workdir: Path) -> list[ScenarioResult]:
    workdir.mkdir(parents=True, exist_ok=True)
    settings.trace_path = workdir / "trace.jsonl"
    store = ReportStore(workdir / "eval.db")
    runtime = Runtime(settings, store, kb=KnowledgeBase.from_dir(kb_dir))
    results = []
    for path in sorted(scenarios_dir.glob("*.json")):
        result, _ = run_scenario(Scenario.load(path), runtime)
        results.append(result)
    return results


def format_results(results: list[ScenarioResult], provider: str) -> str:
    lines = [f"# Оценка провайдера ИИ: {provider}", "",
             "| Сценарий | Команды | Подсказки | Лишнее | Ответы | Упоминания | Нарушения формата | Вызовы/ошибки | Время, с | Итог |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append(
            f"| {r.name} | {r.commands_found}/{r.commands_expected} | {r.items_found}/{r.items_expected} | "
            f"{', '.join(r.forbidden_hits) or '—'} | {r.answers_draft}/{r.answers_total} | "
            f"{'—' if not r.mentions_missing else 'нет: ' + ', '.join(r.mentions_missing)} | {len(r.contract_issues)} | "
            f"{r.calls}/{r.errors} | {r.seconds} | {'✅' if r.passed else '❌'} |")
    issues = [f"- {r.name}: {i}" for r in results for i in r.contract_issues]
    if issues:
        lines += ["", "## Нарушения контрактов (перехвачено)", *issues[:100]]
    return "\n".join(lines) + "\n"
