"""Speech-to-text providers.

``faster-whisper`` runs locally (audio never leaves the machine), handles
Russian well on clean audio, and needs no API key. It is an optional
dependency: ``pip install faster-whisper``.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Protocol

from .config import Settings
from .models import Segment

log = logging.getLogger(__name__)


class ASRError(RuntimeError):
    pass


class Transcriber(Protocol):
    def transcribe(self, path: Path) -> list[Segment]: ...


_GPU_HINTS = ("cuda", "cublas", "cudnn", "cufft", "curand", ".dll", ".so", "gpu", "cannot be loaded", "not found")


def _gpu_problem(exc: Exception) -> bool:
    """Missing CUDA/cuDNN libraries (typical on Windows with an NVIDIA card but no CUDA toolkit)."""
    m = str(exc).lower()
    return any(h in m for h in _GPU_HINTS)


class FasterWhisperTranscriber:
    def __init__(self, model_size: str = "large-v3", language: str | None = "ru", device: str = "auto",
                 compute_type: str = "default"):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise ASRError(f"faster-whisper не установлен или не загружается ({exc}); переустановите: pip install faster-whisper") from exc
        self._cls = WhisperModel
        self.model_size = model_size
        self.language = language
        self.device = device
        try:
            self._model = WhisperModel(model_size, device=device, compute_type=compute_type)
        except Exception as exc:
            if device == "cpu":
                raise ASRError(f"не удалось загрузить модель распознавания «{model_size}»: {exc}") from exc
            log.warning("whisper on %s failed (%s); falling back to CPU", device, exc)
            self._to_cpu(exc)

    def _to_cpu(self, cause: Exception) -> None:
        try:
            self._model = self._cls(self.model_size, device="cpu", compute_type="int8")
        except Exception as exc:
            raise ASRError(f"не удалось загрузить модель распознавания «{self.model_size}»: {exc}") from cause
        self.device = "cpu"

    def _run(self, audio) -> list[Segment]:
        segments, _info = self._model.transcribe(audio, language=self.language, vad_filter=True)
        return [  # the generator does the actual work: GPU library errors surface here
            Segment(text=s.text.strip(), start=float(s.start), end=float(s.end))
            for s in segments
            if s.text and s.text.strip()
        ]

    def transcribe(self, path: Path) -> list[Segment]:
        if not Path(path).is_file():
            raise ASRError(f"файл не найден: {path}")
        try:
            audio = decode_audio(path)
            try:
                return self._run(audio)
            except Exception as exc:
                if self.device == "cpu" or not _gpu_problem(exc):
                    raise
                log.warning("whisper GPU libraries missing (%s); switching to CPU", exc)
                self._to_cpu(exc)
                return self._run(audio)
        except ASRError:
            raise
        except Exception as exc:  # decoder errors, corrupt files
            raise ASRError(f"не удалось распознать аудио: {exc}") from exc


_EMPTY_MARKERS = {"", "-", "—", "…", "...", "[тишина]", "(тишина)", "тишина", "[silence]", "(silence)", "silence",
                  "[no speech]", "no speech", "[неразборчиво]", "[музыка]", "[music]"}


class LLMTranscriber:
    """Speech-to-text by the connected OpenAI-compatible AI (e.g. Gemini through a proxy).

    Tries a multimodal chat request (``input_audio``) first and falls back to the
    Whisper-style ``/audio/transcriptions`` endpoint; the mode that works is remembered.
    """

    def __init__(self, base_url: str, api_key: str, model: str, language: str | None = "ru",
                 timeout: float = 120.0, transport=None):
        import httpx

        from .providers import normalize_base_url

        if not base_url:
            raise ASRError("для распознавания через ИИ укажите OpenAI-совместимый сервер в «Настройки → ИИ»")
        self.base_url = normalize_base_url(base_url)
        self.model = model
        self.language = language
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.Client(timeout=timeout, headers=headers, transport=transport)
        self._modes = ["chat", "transcriptions"]

    def _prompt(self) -> str:
        lang = {"ru": "русском", "en": "английском", "uk": "украинском", "kk": "казахском", "de": "немецком",
                "fr": "французском", "es": "испанском"}.get(self.language or "", "")
        where = f" на {lang} языке" if lang else ""
        return ("Сделай дословную расшифровку этой аудиозаписи" + where + ". Верни ТОЛЬКО произнесённый текст, "
                "с пунктуацией, без пояснений, заголовков, таймкодов и кавычек. Ничего не придумывай и не дополняй. "
                "Если речи нет или она неразборчива, верни пустой ответ.")

    def _chat(self, wav: bytes, prompt: str) -> str:
        import base64

        body = {"model": self.model, "temperature": 0, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "input_audio", "input_audio": {"data": base64.b64encode(wav).decode(), "format": "wav"}},
        ]}]}
        resp = self._http.post(f"{self.base_url}/chat/completions", json=body)
        if resp.status_code >= 400:
            raise _ModeError(f"{resp.status_code}: {resp.text[:300]}")
        try:
            return resp.json()["choices"][0]["message"].get("content") or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise _ModeError(f"неожиданный ответ: {resp.text[:200]}") from exc

    def _transcriptions(self, wav: bytes) -> str:
        data = {"model": self.model}
        if self.language:
            data["language"] = self.language
        resp = self._http.post(f"{self.base_url}/audio/transcriptions", data=data,
                               files={"file": ("chunk.wav", wav, "audio/wav")})
        if resp.status_code >= 400:
            raise _ModeError(f"{resp.status_code}: {resp.text[:300]}")
        try:
            return resp.json().get("text") or ""
        except (ValueError, AttributeError) as exc:
            raise _ModeError(f"неожиданный ответ: {resp.text[:200]}") from exc

    def _diarize_prompt(self, context: list[tuple[str, str]]) -> str:
        known = []
        for spk, _ in context:
            if spk and spk not in known:
                known.append(spk)
        ctx = "\n".join(f"{spk}: {text}" for spk, text in context[-8:])
        return (self._prompt() + "\n\nВ записи могут говорить несколько человек. Каждую реплику пиши с новой строки "
                "в формате «Подпись: текст». Если человек назвал себя или к нему обратились по имени — подписывай "
                "его этим именем, иначе «Собеседник 1», «Собеседник 2» и т. д. Одному голосу — всегда одна подпись. Реплики владельца микрофона сюда не попадают — это только собеседники."
                + (f"\nУже известные участники: {', '.join(known)}. Используй те же подписи для тех же людей."
                   if known else "")
                + (f"\nПоследние реплики перед этим фрагментом — они УЖЕ записаны, не повторяй их; начни с первого нового слова в этой записи:\n{ctx}" if ctx else ""))

    WINDOW = 60.0  # long recordings (uploaded files) are sent in pieces of this many seconds

    def transcribe(self, path: Path, diarize: bool = False,
                   context: list[tuple[str, str]] | None = None) -> list[Segment]:
        """``diarize``: label speakers («Собеседник 1», names); ``context``: recent (speaker, text) lines."""
        if not Path(path).is_file():
            raise ASRError(f"файл не найден: {path}")
        try:
            audio = decode_audio(path)
        except Exception as exc:
            raise ASRError(f"не удалось прочитать аудио: {exc}") from exc
        step = int(self.WINDOW * 16000)
        if len(audio) <= step * 1.5:
            return self._piece(audio, diarize, context or [])
        out: list[Segment] = []
        ctx = list(context or [])
        for i in range(0, len(audio), step):
            offset = i / 16000
            for seg in self._piece(audio[i:i + step], diarize, ctx):
                out.append(seg.model_copy(update={"start": round((seg.start or 0) + offset, 2),
                                                  "end": round((seg.end or 0) + offset, 2)}))
                ctx.append((seg.speaker, seg.text))
        return out

    def _piece(self, audio, diarize: bool, context: list[tuple[str, str]]) -> list[Segment]:
        import httpx
        import numpy as np

        duration = len(audio) / 16000
        # Silence: the model would only invent words.
        if duration < 0.3 or float(np.sqrt(np.mean(audio ** 2))) < 0.002:
            return []
        wav = encode_wav(audio)
        errors = []
        for mode in list(self._modes):
            try:
                if mode == "chat":
                    text = self._chat(wav, self._diarize_prompt(context) if diarize else self._prompt())
                else:
                    text = self._transcriptions(wav)
            except httpx.HTTPError as exc:
                raise ASRError(f"сервер ИИ недоступен ({self.base_url}): {exc}") from exc
            except _ModeError as exc:
                errors.append(f"{mode}: {exc}")
                if str(exc).startswith(("401", "403", "429")):
                    break  # key / quota problem, the other mode will fail the same way
                continue
            if self._modes[0] != mode:
                self._modes.remove(mode)
                self._modes.insert(0, mode)
            text = _clean_transcript(text)
            if not text:
                return []
            if diarize and mode == "chat":
                return _drop_repeats(_split_speakers(text, duration), context)
            return [Segment(text=text, start=0.0, end=round(duration, 2))]
        raise ASRError("ИИ не смог распознать звук. Выберите модель, которая понимает аудио (например gemini-2.5-flash), "
                       "или локальное распознавание. Ответ сервера: " + " | ".join(errors))


class _ModeError(Exception):
    pass


def _clean_transcript(text: str) -> str:
    text = (text or "").strip().strip("\"«»“”").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
    return "" if text.lower().rstrip(".") in _EMPTY_MARKERS else text


_SPEAKER_LINE = re.compile(r"^\s*(?:\*\*)?([^:\n*]{1,40}?)(?:\*\*)?\s*:\s*(.+)$")


def _split_speakers(text: str, duration: float) -> list[Segment]:
    """«Собеседник 1: …» lines -> segments; time is split by text length (the chunk has no timestamps)."""
    turns: list[list[str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _SPEAKER_LINE.match(line)
        if m and len(m.group(1).split()) <= 4:
            turns.append([m.group(1).strip(), m.group(2).strip()])
        elif turns:
            turns[-1][1] += " " + line
        else:
            turns.append(["", line])
    turns = [t for t in turns if _clean_transcript(t[1])]
    total = sum(len(t[1]) for t in turns) or 1
    out, pos = [], 0.0
    for spk, words in turns:
        end = pos + duration * len(words) / total
        out.append(Segment(speaker=spk, text=words, start=round(pos, 2), end=round(end, 2)))
        pos = end
    return out


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower().replace("ё", "е"))


def _drop_repeats(segments: list[Segment], context: list[tuple[str, str]]) -> list[Segment]:
    """The model sometimes re-transcribes lines it was given as context: cut that overlap."""
    import difflib

    recent = [_words(t) for _, t in context[-4:]]
    out = []
    for seg in segments:
        words = seg.text.split()
        norm = _words(seg.text)
        cut = 0
        for prev in recent:
            if len(prev) < 3 or not norm:
                continue
            head = norm[: len(prev) + 3]
            m = difflib.SequenceMatcher(None, prev, head, autojunk=False)
            if m.ratio() * (len(prev) + len(head)) / 2 >= 0.8 * len(prev):  # most of prev is repeated at the start
                last = max((b.b + b.size for b in m.get_matching_blocks() if b.size), default=0)
                cut = max(cut, last)
        if cut:
            # map the cut in normalized words back onto the original words
            kept, seen = [], 0
            for w in words:
                n = len(_words(w))
                if seen >= cut:
                    kept.append(w)
                seen += n
            words = kept
        text = " ".join(words)
        if cut:
            text = text.strip(" ,.;:—-")
        if len(_words(text)) >= 1:
            out.append(seg.model_copy(update={"text": text}))
        recent.append(_words(seg.text))
    return out


def encode_wav(audio, sampling_rate: int = 16000) -> bytes:
    """float32 mono -> 16-bit PCM WAV bytes."""
    import io
    import wave

    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sampling_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def decode_audio(path: Path | str, sampling_rate: int = 16000):
    """File -> mono float32 at 16 kHz, like faster_whisper.decode_audio.

    Our own copy: faster-whisper passes ``metadata_errors=`` to ``av.open``, which
    newer PyAV releases no longer accept ("unexpected keyword argument").
    """
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=sampling_rate)
    chunks = []
    with av.open(str(path), mode="r") as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def get_transcriber(settings: Settings) -> Transcriber | None:
    if settings.asr_provider == "none":
        return None
    if settings.asr_provider == "faster-whisper":
        import os

        device = os.environ.get("RECAPPER_WHISPER_DEVICE", "auto")  # auto | cpu | cuda
        return FasterWhisperTranscriber(settings.whisper_model, settings.whisper_language or None, device=device)
    if settings.asr_provider == "ai":
        return LLMTranscriber(settings.openai_base_url, settings.openai_api_key,
                              settings.asr_ai_model or settings.openai_model, settings.whisper_language or None)
    raise ASRError(f"неизвестный ASR-провайдер: {settings.asr_provider}")
