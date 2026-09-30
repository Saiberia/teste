"""Speech-to-text providers.

``faster-whisper`` runs locally (audio never leaves the machine), handles
Russian well on clean audio, and needs no API key. It is an optional
dependency: ``pip install faster-whisper``.
"""

from __future__ import annotations

import logging
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
    raise ASRError(f"неизвестный ASR-провайдер: {settings.asr_provider}")
