"""Tiny local knowledge base: company docs the answers should rely on.

Deliberately dependency-free (BM25 over paragraphs). Enough for a folder of
markdown/text notes; swap for a vector store when the corpus grows.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

_WORD_RE = re.compile(r"[\w\-]+", re.UNICODE)
_STOP = {
    "и", "в", "во", "на", "с", "со", "по", "к", "ко", "о", "об", "от", "до", "за", "из", "у",
    "не", "что", "как", "это", "а", "но", "или", "ли", "же", "бы", "то", "для", "мы", "вы",
    "я", "он", "она", "они", "его", "ее", "их", "так", "там", "тут", "есть", "был", "была",
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "be", "it",
}
_SUFFIXES = sorted(
    ["ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ах", "ях", "ов", "ев", "ей",
     "ий", "ый", "ой", "ая", "яя", "ое", "ее", "ие", "ые", "ую", "юю", "ам", "ям", "ом",
     "ем", "ть", "ти", "а", "я", "ы", "и", "у", "ю", "е", "о", "s"],
    key=len,
    reverse=True,
)
TEXT_SUFFIXES = {".md", ".txt", ".markdown", ".csv"}


def stem(word: str) -> str:
    """Crude suffix stripping so 'конверсии' and 'конверсия' match."""
    word = word.lower().replace("ё", "е")
    if len(word) <= 4:
        return word
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]
    return word


def tokenize(text: str) -> list[str]:
    return [stem(w) for w in _WORD_RE.findall(text.lower()) if w not in _STOP and len(w) > 1]


@dataclass
class Chunk:
    doc: str
    text: str


class KnowledgeBase:
    def __init__(self, chunks: list[Chunk] | None = None):
        self.chunks: list[Chunk] = []
        self._tf: list[Counter] = []
        self._df: Counter = Counter()
        self._avg_len = 0.0
        for chunk in chunks or []:
            self.add(chunk)

    def __len__(self) -> int:
        return len(self.chunks)

    def add(self, chunk: Chunk) -> None:
        tf = Counter(tokenize(chunk.text))
        if not tf:
            return
        self.chunks.append(chunk)
        self._tf.append(tf)
        self._df.update(tf.keys())
        total = sum(sum(c.values()) for c in self._tf)
        self._avg_len = total / len(self._tf)

    def add_document(self, name: str, text: str, max_chars: int = 1200) -> None:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        buf = ""
        for para in paragraphs:
            if buf and len(buf) + len(para) > max_chars:
                self.add(Chunk(name, buf))
                buf = ""
            buf = f"{buf}\n\n{para}".strip()
        if buf:
            self.add(Chunk(name, buf))

    @classmethod
    def from_dir(cls, path: Path | None) -> "KnowledgeBase":
        kb = cls()
        if not path or not path.is_dir():
            return kb
        for file in sorted(path.rglob("*")):
            if file.is_file() and file.suffix.lower() in TEXT_SUFFIXES:
                kb.add_document(file.relative_to(path).as_posix(), file.read_text("utf-8", errors="replace"))
        return kb

    def search(self, query: str, k: int = 4, k1: float = 1.5, b: float = 0.75) -> list[tuple[Chunk, float]]:
        terms = set(tokenize(query))
        if not terms or not self.chunks:
            return []
        n = len(self.chunks)
        scored = []
        for chunk, tf in zip(self.chunks, self._tf):
            length = sum(tf.values())
            score = 0.0
            for term in terms:
                if term not in tf:
                    continue
                idf = math.log(1 + (n - self._df[term] + 0.5) / (self._df[term] + 0.5))
                freq = tf[term]
                score += idf * freq * (k1 + 1) / (freq + k1 * (1 - b + b * length / self._avg_len))
            if score > 0:
                scored.append((chunk, score))
        scored.sort(key=lambda pair: pair[1], reverse=True)
        return scored[:k]
