import sys
import types
from pathlib import Path

import pytest

from recapper import cli
from recapper.asr import ASRError, FasterWhisperTranscriber, get_transcriber
from recapper.config import Settings
from tests.conftest import EXAMPLES


class _FakeWhisperModel:
    last_init = None

    def __init__(self, size, device, compute_type):
        _FakeWhisperModel.last_init = (size, device, compute_type)

    def transcribe(self, path, language, vad_filter):
        assert vad_filter is True
        if path.endswith("bad.wav"):
            raise RuntimeError("corrupt")
        seg = types.SimpleNamespace
        return iter([seg(text=" Надо посчитать конверсию. ", start=0.0, end=2.5), seg(text="  ", start=3, end=4)]), None


@pytest.fixture
def fake_whisper(monkeypatch):
    module = types.ModuleType("faster_whisper")
    module.WhisperModel = _FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    return module


def test_faster_whisper_adapter(fake_whisper, tmp_path):
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    t = FasterWhisperTranscriber("small", "ru")
    segs = t.transcribe(audio)
    assert _FakeWhisperModel.last_init[0] == "small"
    assert [(s.text, s.start, s.end) for s in segs] == [("Надо посчитать конверсию.", 0.0, 2.5)]
    with pytest.raises(ASRError, match="не найден"):
        t.transcribe(tmp_path / "missing.wav")
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"x")
    with pytest.raises(ASRError, match="распознать"):
        t.transcribe(bad)


def test_faster_whisper_missing_package(monkeypatch):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)  # import raises ImportError
    with pytest.raises(ASRError, match="pip install"):
        FasterWhisperTranscriber()


def test_get_transcriber(fake_whisper):
    assert get_transcriber(Settings(asr_provider="none")) is None
    assert isinstance(get_transcriber(Settings(asr_provider="faster-whisper")), FasterWhisperTranscriber)
    with pytest.raises(ASRError, match="неизвестный"):
        get_transcriber(Settings(asr_provider="magic"))


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("RECAPPER_MODEL", "claude-sonnet-5-5")
    monkeypatch.setenv("RECAPPER_WEB_SEARCH", "no")
    monkeypatch.setenv("RECAPPER_KNOWLEDGE_DIR", str(tmp_path))
    monkeypatch.setenv("RECAPPER_TELEGRAM_ALLOWED_USERS", "1, 2,")
    monkeypatch.setenv("RECAPPER_STORE_SEGMENTS", "false")
    s = Settings.from_env()
    assert s.model == "claude-sonnet-5-5" and s.web_search is False and s.knowledge_dir == tmp_path
    assert s.telegram_allowed_users == {1, 2} and s.store_segments is False and not s.has_claude
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "t")
    assert Settings.from_env().has_claude
    assert Settings().model == "claude-opus-5-5"


def test_cli_process_to_file(tmp_path, capsys):
    out = tmp_path / "r.md"
    code = cli.main(["process", str(EXAMPLES / "meeting_samokat_kuper.txt"), "--kb", str(EXAMPLES / "knowledge"),
                     "--ask", "Какой бюджет на награды?", "--out", str(out), "--no-web"])
    assert code == 0
    text = out.read_text("utf-8")
    assert "Допиши механику монетизации" in text and "Какой бюджет на награды?" in text
    assert "офлайн" in capsys.readouterr().err


def test_cli_stdout_and_errors(tmp_path, capsys):
    assert cli.main(["process", str(EXAMPLES / "meeting_samokat_kuper.txt"), "--title", "T"]) == 0
    assert capsys.readouterr().out.startswith("# T")
    assert cli.main(["process", str(tmp_path / "missing.txt")]) == 2
    empty = tmp_path / "e.txt"
    empty.write_text("", "utf-8")
    assert cli.main(["process", str(empty)]) == 2
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    assert cli.main(["process", str(audio)]) == 2
    assert "RECAPPER_ASR" in capsys.readouterr().err


def test_cli_audio_with_asr(tmp_path, capsys, monkeypatch, fake_whisper):
    monkeypatch.setenv("RECAPPER_ASR", "faster-whisper")
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    assert cli.main(["process", str(audio)]) == 0
    assert "посчитать конверсию" in capsys.readouterr().out


def test_module_entrypoint_runs():
    import subprocess

    root = Path(__file__).resolve().parents[1]
    res = subprocess.run([sys.executable, "-m", "recapper", "process", "examples/meeting_samokat_kuper.txt"],
                         cwd=root, capture_output=True, text=True, timeout=60,
                         env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(root)})
    assert res.returncode == 0, res.stderr
    assert "## Мои задачи ассистенту (2)" in res.stdout and "## Прозвучало на встрече" in res.stdout
