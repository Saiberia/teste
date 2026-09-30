"""Parse transcripts exported by meeting tools into segments.

Supported inputs:
- WebVTT (Zoom, Meet, Teams, Телемост exports), including ``<v Speaker>`` tags
- SRT, including ``- Speaker: text`` dash lines
- Google Meet / Телемост block export: ``Имя`` / ``00:00:05`` / ``текст``
- Plain text: ``Speaker: text``, optionally prefixed with ``[hh:mm:ss(.ms)]``
"""

from __future__ import annotations

import re

from .models import Segment

_TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?"
_CUE_RE = re.compile(rf"^\s*{_TS}\s*-->\s*{_TS}", re.MULTILINE)
_PLAIN_TS_RE = re.compile(r"^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s*[-–—]?\s*")
_CLOCK_LINE_RE = re.compile(r"^\s*\(?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\)?\s*$")
_SPEAKER_RE = re.compile(r"^[-–—]?\s*([^:\n]{1,40}?):\s+(.+)$")
_VOICE_RE = re.compile(r"^<v(?:\.[^ >]+)?\s+([^>]+)>(.*?)(?:</v>)?$")
# Words that end with ":" in speech but are not people ("Задача: посчитать ...").
_NOT_SPEAKERS = {
    "задача", "вопрос", "итого", "итог", "решение", "примечание", "важно", "внимание", "цель",
    "проблема", "идея", "план", "пример", "пункт", "тема", "повестка", "вывод", "ответ", "то есть",
    "кстати", "например", "короче", "во-первых", "во-вторых", "note", "question", "task", "todo",
}


def _to_seconds(h: str | None, m: str, s: str, ms: str | None) -> float:
    total = int(h or 0) * 3600 + int(m) * 60 + int(s)
    if ms:
        total += int(ms.ljust(3, "0")) / 1000
    return float(total)


def _clock_to_seconds(clock: str) -> float:
    clock = clock.replace(",", ".")
    main, _, frac = clock.partition(".")
    parts = [int(p) for p in main.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts
    return float(h * 3600 + m * 60 + s) + (int(frac.ljust(3, "0")) / 1000 if frac else 0.0)


def is_name_like(candidate: str) -> bool:
    """A speaker label looks like a name, not like 'Вопрос к Максу'."""
    c = candidate.strip()
    if not c or c.lower().startswith(("http", "www")) or c.lower() in _NOT_SPEAKERS:
        return False
    words = c.split()
    if len(words) > 4 or any(ch.isdigit() for ch in c):
        return False
    first = words[0]
    if first.lower() in _NOT_SPEAKERS:
        return False
    # Names start with a capital letter ("Аня", "Speaker 1" excluded above by digit rule is fine: allow it).
    return first[:1].isupper()


def _split_speaker(text: str, known: set[str] | None = None) -> tuple[str, str]:
    voice = _VOICE_RE.match(text)
    if voice:
        return voice.group(1).strip(), voice.group(2).strip()
    match = _SPEAKER_RE.match(text)
    if match:
        name = match.group(1).strip()
        if (known and name in known) or is_name_like(name) or re.fullmatch(r"(Speaker|Спикер|Участник|Собеседник) ?\d{1,2}", name):
            return name, match.group(2).strip()
    return "", text.strip()


def _parse_cues(text: str) -> list[Segment]:
    segments: list[Segment] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        cue = _CUE_RE.match(lines[i])
        if not cue:
            i += 1
            continue
        g = cue.groups()
        start = _to_seconds(g[0], g[1], g[2], g[3])
        end = _to_seconds(g[4], g[5], g[6], g[7])
        i += 1
        body: list[str] = []
        while i < len(lines) and lines[i].strip():
            body.append(lines[i].strip())
            i += 1
        # SRT dialogue: "- Аня: ...", "- Макс: ..." inside one cue become separate segments.
        current_speaker = ""
        current: list[str] = []

        def flush() -> None:
            content = re.sub(r"</?[^>]+>", "", " ".join(current)).strip()
            if content:
                segments.append(Segment(speaker=current_speaker, text=content, start=start, end=end))

        for line in body:
            speaker, content = _split_speaker(line)
            if speaker and current:
                flush()
                current = []
            if speaker:
                current_speaker = speaker
            current.append(content)
        flush()
    return segments


def _parse_blocks(lines: list[str]) -> list[Segment] | None:
    """Google Meet / Телемост export: name line, clock line, text lines, blank line."""
    segments: list[Segment] = []
    i, hits = 0, 0
    while i < len(lines):
        if i + 1 < len(lines) and lines[i].strip() and _CLOCK_LINE_RE.match(lines[i + 1]) and \
                is_name_like(lines[i].strip()) and not _CLOCK_LINE_RE.match(lines[i]):
            speaker = lines[i].strip()
            start = _clock_to_seconds(_CLOCK_LINE_RE.match(lines[i + 1]).group(1))
            i += 2
            body: list[str] = []
            while i < len(lines) and lines[i].strip() and not (
                i + 1 < len(lines) and _CLOCK_LINE_RE.match(lines[i + 1]) and is_name_like(lines[i].strip())
            ):
                body.append(lines[i].strip())
                i += 1
            if body:
                segments.append(Segment(speaker=speaker, text=" ".join(body), start=start))
                hits += 1
            continue
        i += 1
    return segments if hits >= 1 else None


def _parse_plain(text: str) -> list[Segment]:
    segments: list[Segment] = []
    known: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        start = None
        ts = _PLAIN_TS_RE.match(line)
        if ts and ":" in ts.group(1) and ts.end() < len(line):
            start = _clock_to_seconds(ts.group(1))
            line = line[ts.end():].strip()
        speaker, content = _split_speaker(line, known)
        if not content:
            continue
        if speaker:
            known.add(speaker)
        # A line without a speaker continues the previous utterance.
        if not speaker and segments and start is None:
            segments[-1].text = f"{segments[-1].text} {content}"
            continue
        segments.append(Segment(speaker=speaker, text=content, start=start))
    return segments


def _looks_binary(text: str) -> bool:
    sample = text[:4096]
    bad = sum(1 for ch in sample if ch == "\ufffd" or (ord(ch) < 32 and ch not in "\n\t"))
    return "\x00" in sample or bad > max(3, len(sample) // 50)


def parse_transcript(text: str) -> list[Segment]:
    """Parse any supported transcript format; never raises on odd input."""
    text = (text or "").lstrip("\ufeff").replace("\r\n", "\n")
    if not text.strip() or _looks_binary(text):
        return []
    if _CUE_RE.search(text) is not None or text.lstrip().startswith("WEBVTT"):
        return _parse_cues(text)  # a subtitle file with no speech is empty, not "WEBVTT" as speech
    lines = text.splitlines()
    if sum(1 for ln in lines if _CLOCK_LINE_RE.match(ln)) >= 1:
        blocks = _parse_blocks(lines)
        if blocks:
            return blocks
    return _parse_plain(text)


def format_clock(seconds: float | None) -> str:
    if seconds is None:
        return ""
    seconds = int(seconds)
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def segments_to_text(segments: list[Segment]) -> str:
    lines = []
    for seg in segments:
        clock = format_clock(seg.start)
        prefix = f"[{clock}] " if clock else ""
        who = f"{seg.speaker}: " if seg.speaker else ""
        lines.append(f"{prefix}{who}{seg.text}")
    return "\n".join(lines)
