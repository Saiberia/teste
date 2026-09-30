"""Speech-to-text providers.

``faster-whisper`` runs locally (audio never leaves the machine), handles
Russian well on clean audio, and needs no API key. It is an optional
dependency: ``pip install faster-whisper``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .config import Settings
from .models import Segment


class ASRError(RuntimeError):
    pass


class Transcriber(Protocol):
    def transcribe(self, path: Path) -> list[Segment]: ...


class FasterWhisperTranscriber:
    def __init__(self, model_size: str = "large-v3", language: str | None = "ru", device: str = "auto",
                 compute_type: str = "default"):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise ASRError("faster-whisper не установлен: pip install faster-whisper") from exc
        self.language = language
        self._model = WhisperModel(model_size, device=device, compute_type=compute_type)

    def transcribe(self, path: Path) -> list[Segment]:
        if not Path(path).is_file():
            raise ASRError(f"файл не найден: {path}")
        try:
            segments, _info = self._model.transcribe(decode_audio(path), language=self.language, vad_filter=True)
            return [
                Segment(text=s.text.strip(), start=float(s.start), end=float(s.end))
                for s in segments
                if s.text and s.text.strip()
            ]
        except Exception as exc:  # decoder errors, corrupt files
            raise ASRError(f"не удалось распознать аудио: {exc}") from exc


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
        return FasterWhisperTranscriber(settings.whisper_model, settings.whisper_language or None)
    raise ASRError(f"неизвестный ASR-провайдер: {settings.asr_provider}")
