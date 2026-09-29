"""Human-readable output: Markdown (files, web) and Telegram HTML."""

from __future__ import annotations

import html

from .models import Answer, AnswerStatus, Item, ItemKind, ItemOrigin, MeetingReport
from .transcript import format_clock

TELEGRAM_LIMIT = 4000  # Telegram hard limit is 4096; keep a margin

_CONFIDENCE = {"high": "высокая", "medium": "средняя", "low": "низкая"}


def _item_label(item: Item) -> str:
    kind = "Вопрос" if item.kind == ItemKind.QUESTION else "Задача"
    if item.origin == ItemOrigin.USER:
        return f"{kind} (от вас)"
    who = f", {item.speaker}" if item.speaker else ""
    when = f", {format_clock(item.start)}" if item.start is not None else ""
    return f"{kind}{who}{when}"


def _status_note(answer: Answer | None) -> str:
    if answer is None:
        return "_готовится…_"
    if answer.status == AnswerStatus.FAILED:
        return "_не удалось подготовить ответ_"
    if answer.status == AnswerStatus.NEEDS_LLM:
        return "_офлайн-режим: собран контекст, черновик не генерировался_"
    return f"_уверенность: {_CONFIDENCE.get(answer.confidence, answer.confidence)}; проверьте перед отправкой_"


def report_to_markdown(report: MeetingReport) -> str:
    out = [f"# {report.title}", ""]
    recap = report.recap
    out += ["## Итог", recap.summary or "—", ""]
    if recap.decisions:
        out += ["## Решения", *[f"- {d}" for d in recap.decisions], ""]
    if recap.action_items:
        out.append("## Поручения")
        for a in recap.action_items:
            meta = ", ".join(x for x in (a.owner, a.due) if x)
            out.append(f"- {a.text}" + (f" ({meta})" if meta else ""))
        out.append("")
    out.append(f"## Вопросы и задачи с ответами ({len(report.items)})")
    if not report.items:
        out.append("Вопросов и задач не найдено.")
    for n, item in enumerate(report.items, 1):
        ans = report.answer_for(item.id)
        out += ["", f"### {n}. {item.text}", f"*{_item_label(item)}*"]
        if item.quote and item.quote != item.text:
            out.append(f"> {item.quote}")
        out += ["", _status_note(ans)]
        if ans:
            if ans.summary:
                out += ["", f"**Коротко:** {ans.summary}"]
            if ans.body:
                out += ["", ans.body]
            if ans.assumptions:
                out += ["", "**Допущения:**", *[f"- {x}" for x in ans.assumptions]]
            if ans.sources:
                out += ["", "**Источники:**"]
                for s in ans.sources:
                    out.append(f"- [{s.title}]({s.ref})" if s.ref.startswith("http") else f"- {s.title} ({s.ref})")
    out += ["", "---", f"_Режим: {report.mode}. Черновики сгенерированы ИИ и требуют проверки._"]
    return "\n".join(out).strip() + "\n"


def _h(text: str) -> str:
    return html.escape(text, quote=False)


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Split on blank lines, then lines, then hard-cut; never exceeds limit."""
    parts: list[str] = []
    buf = ""
    for block in text.split("\n\n"):
        pieces = [block] if len(block) <= limit else _hard_split(block, limit)
        for piece in pieces:
            candidate = f"{buf}\n\n{piece}" if buf else piece
            if len(candidate) <= limit:
                buf = candidate
            else:
                if buf:
                    parts.append(buf)
                buf = piece
    if buf:
        parts.append(buf)
    return parts


def _hard_split(block: str, limit: int) -> list[str]:
    out, buf = [], ""
    for line in block.split("\n"):
        while len(line) > limit:
            if buf:
                out.append(buf)
                buf = ""
            out.append(line[:limit])
            line = line[limit:]
        candidate = f"{buf}\n{line}" if buf else line
        if len(candidate) <= limit:
            buf = candidate
        else:
            out.append(buf)
            buf = line
    if buf:
        out.append(buf)
    return out


def report_to_telegram(report: MeetingReport) -> list[str]:
    """Telegram HTML messages: recap first, then one block per item."""
    r = report.recap
    head = [f"<b>{_h(report.title)}</b>", "", "<b>Итог</b>", _h(r.summary or "—")]
    if r.decisions:
        head += ["", "<b>Решения</b>", *[f"• {_h(d)}" for d in r.decisions]]
    if r.action_items:
        head += ["", "<b>Поручения</b>"]
        for a in r.action_items:
            meta = ", ".join(x for x in (a.owner, a.due) if x)
            head.append(f"• {_h(a.text)}" + (f" <i>({_h(meta)})</i>" if meta else ""))
    head += ["", f"Найдено вопросов и задач: {len(report.items)}"]
    blocks = ["\n".join(head)]
    for n, item in enumerate(report.items, 1):
        blocks.append(item_to_telegram(n, item, report.answer_for(item.id)))
    messages: list[str] = []
    for block in blocks:
        messages.extend(split_message(block))
    return messages


def item_to_telegram(n: int, item: Item, ans: Answer | None) -> str:
    lines = [f"<b>{n}. {_h(item.text)}</b>", f"<i>{_h(_item_label(item))}</i>"]
    if ans is None:
        lines.append("<i>готовится…</i>")
        return "\n".join(lines)
    lines.append(f"<i>{_h(_status_note(ans).strip('_'))}</i>")
    if ans.summary:
        lines += ["", f"<b>Коротко:</b> {_h(ans.summary)}"]
    if ans.body:
        lines += ["", _h(ans.body)]
    if ans.assumptions:
        lines += ["", "<b>Допущения:</b>", *[f"• {_h(x)}" for x in ans.assumptions]]
    if ans.sources:
        lines += ["", "<b>Источники:</b>"]
        for s in ans.sources:
            if s.ref.startswith("http"):
                lines.append(f'• <a href="{html.escape(s.ref, quote=True)}">{_h(s.title)}</a>')
            else:
                lines.append(f"• {_h(s.title)}")
    return "\n".join(lines)
