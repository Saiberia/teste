"""Output contracts every AI provider must satisfy.

Used in two places:
- to parse model output robustly (``extract_json``), whatever the provider;
- to audit intercepted outputs (``validate_schema``, ``check_answer_text``),
  so swapping the model shows immediately what it gets wrong.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> Any:
    """Parse JSON even when a model wraps it in prose or ``` fences."""
    text = (text or "").strip().lstrip("﻿")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for block in _FENCE_RE.findall(text):
        try:
            return json.loads(block.strip())
        except json.JSONDecodeError:
            continue
    # First balanced {...} or [...] outside of strings.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        while start != -1:
            depth, in_str, esc = 0, False, False
            for i in range(start, len(text)):
                ch = text[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                elif ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[start:i + 1])
                        except json.JSONDecodeError:
                            break
            start = text.find(opener, start + 1)
    raise ValueError("no JSON object found in model output")


_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}


def validate_schema(data: Any, schema: dict, path: str = "$") -> list[str]:
    """Minimal JSON Schema check (type, required, enum, properties, items, additionalProperties)."""
    issues: list[str] = []
    expected = schema.get("type")
    if expected == "integer":
        ok = isinstance(data, int) and not isinstance(data, bool)
    elif expected == "number":
        ok = isinstance(data, (int, float)) and not isinstance(data, bool)
    elif expected in _TYPES:
        ok = isinstance(data, _TYPES[expected])
    else:
        ok = True
    if not ok:
        return [f"{path}: expected {expected}, got {type(data).__name__}"]
    if "enum" in schema and data not in schema["enum"]:
        issues.append(f"{path}: {data!r} not in {schema['enum']}")
    if isinstance(data, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in data:
                issues.append(f"{path}.{key}: missing")
        for key, value in data.items():
            if key in props:
                issues.extend(validate_schema(value, props[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                issues.append(f"{path}.{key}: unexpected field")
    if isinstance(data, list) and "items" in schema:
        for i, value in enumerate(data):
            issues.extend(validate_schema(value, schema["items"], f"{path}[{i}]"))
    return issues


ANSWER_SECTIONS = ("Коротко", "Черновик", "Допущения", "Уверенность")
_DOC_REF = re.compile(r"\[doc:([^\]]+)\]")


def check_answer_text(text: str, prompt: str = "") -> list[str]:
    """Audit a draft answer: format, confidence value, grounded doc references."""
    issues: list[str] = []
    if not text.strip():
        return ["empty answer"]
    for section in ANSWER_SECTIONS:
        if not re.search(rf"^##\s*{section}\s*$", text, re.MULTILINE | re.IGNORECASE):
            issues.append(f"missing section '## {section}'")
    conf = re.search(r"^##\s*Уверенность\s*$\s*(\S+)", text, re.MULTILINE | re.IGNORECASE)
    if conf and conf.group(1).strip("*_.").lower() not in {"low", "medium", "high"}:
        issues.append(f"confidence must be low/medium/high, got {conf.group(1)!r}")
    offered = set(_DOC_REF.findall(prompt))
    for ref in set(_DOC_REF.findall(text)):
        if ref not in offered:
            issues.append(f"cites unknown document [doc:{ref}] (hallucinated source)")
    return issues
