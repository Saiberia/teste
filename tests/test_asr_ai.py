"""Speech recognition by the connected AI (OpenAI-compatible server, e.g. a Gemini proxy)."""

import json
import wave

import httpx
import numpy as np
import pytest

from recapper.asr import ASRError, LLMTranscriber, _split_speakers, get_transcriber
from recapper.config import Settings


def write_wav(path, seconds=3.0, amp=0.3):
    t = np.arange(int(16000 * seconds)) / 16000
    pcm = (np.sin(2 * np.pi * 220 * t) * amp * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    return path


def chat_reply(text):
    return httpx.Response(200, json={"choices": [{"message": {"content": text}, "finish_reason": "stop"}]})


def make(handler, **kw):
    return LLMTranscriber("http://127.0.0.1:8045", "sk-x", "gemini-2.5-flash", "ru",
                          transport=httpx.MockTransport(handler), **kw)


def test_chat_mode_sends_wav_and_returns_text(tmp_path):
    seen = {}

    def handler(request):
        body = json.loads(request.content)
        seen["url"] = str(request.url)
        seen["parts"] = body["messages"][0]["content"]
        return chat_reply("«Надо посчитать конверсию в Купер.»")

    segs = make(handler).transcribe(write_wav(tmp_path / "a.wav"))
    assert seen["url"] == "http://127.0.0.1:8045/v1/chat/completions"
    audio = seen["parts"][1]["input_audio"]
    assert audio["format"] == "wav" and len(audio["data"]) > 1000
    assert "русском" in seen["parts"][0]["text"]
    assert [(s.text, s.start, s.end) for s in segs] == [("Надо посчитать конверсию в Купер.", 0.0, 3.0)]


def test_silence_is_not_sent(tmp_path):
    def handler(request):
        raise AssertionError("silence must not reach the model")

    assert make(handler).transcribe(write_wav(tmp_path / "s.wav", amp=0.0)) == []


@pytest.mark.parametrize("reply", ["", "[тишина]", "(silence).", "…"])
def test_empty_markers_give_no_segments(tmp_path, reply):
    assert make(lambda r: chat_reply(reply)).transcribe(write_wav(tmp_path / "a.wav")) == []


def test_falls_back_to_transcriptions_endpoint_and_remembers(tmp_path):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(400, text="input_audio is not supported")
        assert b"chunk.wav" in request.content
        return httpx.Response(200, json={"text": "Привет"})

    t = make(handler)
    path = write_wav(tmp_path / "a.wav")
    assert [s.text for s in t.transcribe(path)] == ["Привет"]
    assert [s.text for s in t.transcribe(path)] == ["Привет"]
    assert calls == ["/v1/chat/completions", "/v1/audio/transcriptions", "/v1/audio/transcriptions"]


def test_clear_error_when_model_cannot_hear(tmp_path):
    t = make(lambda r: httpx.Response(400, text="model does not support audio"))
    with pytest.raises(ASRError, match="понимает аудио"):
        t.transcribe(write_wav(tmp_path / "a.wav"))


def test_auth_error_does_not_try_other_mode(tmp_path):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(401, text="bad key")

    with pytest.raises(ASRError, match="401"):
        make(handler).transcribe(write_wav(tmp_path / "a.wav"))
    assert len(calls) == 1


def test_unreachable_server(tmp_path):
    t = LLMTranscriber("http://127.0.0.1:9", "", "m", "ru", timeout=2)
    with pytest.raises(ASRError, match="недоступен"):
        t.transcribe(write_wav(tmp_path / "a.wav"))


def test_diarize_labels_speakers_and_passes_context(tmp_path):
    prompts = []

    def handler(request):
        prompts.append(json.loads(request.content)["messages"][0]["content"][0]["text"])
        return chat_reply("Собеседник 1: Давайте начнём.\n**Мария**: Согласна, начинаем\nс конверсии.")

    segs = make(handler).transcribe(write_wav(tmp_path / "a.wav", seconds=4), diarize=True,
                                    context=[("Мария", "Всем привет"), ("Собеседник 1", "Привет")])
    assert [(s.speaker, s.text) for s in segs] == [("Собеседник 1", "Давайте начнём."),
                                                   ("Мария", "Согласна, начинаем с конверсии.")]
    assert segs[0].start == 0.0 and segs[-1].end == pytest.approx(4.0) and segs[0].end == segs[1].start
    assert "Мария, Собеседник 1" in prompts[0] and "Всем привет" in prompts[0]


def test_split_speakers_keeps_unlabelled_text_and_ignores_long_prefixes():
    segs = _split_speakers("просто текст\nВ итоге мы решили так: делаем", 2.0)
    assert [(s.speaker, s.text) for s in segs] == [("", "просто текст В итоге мы решили так: делаем")]


def test_long_recording_is_sent_in_windows_with_offsets(tmp_path):
    prompts = []

    def handler(request):
        prompts.append(json.loads(request.content)["messages"][0]["content"][0]["text"])
        return chat_reply(f"Собеседник 1: часть {len(prompts)}")

    t = make(handler)
    t.WINDOW = 2.0
    segs = t.transcribe(write_wav(tmp_path / "long.wav", seconds=5), diarize=True)
    assert [s.text for s in segs] == ["часть 1", "часть 2", "часть 3"]
    assert [s.start for s in segs] == [0.0, 2.0, 4.0]
    assert "часть 1" in prompts[1]  # the next window knows who spoke before


def test_get_transcriber_ai_uses_ai_settings():
    s = Settings(asr_provider="ai", openai_base_url="http://127.0.0.1:8045", openai_model="gemini-2.5-flash")
    t = get_transcriber(s)
    assert isinstance(t, LLMTranscriber) and t.model == "gemini-2.5-flash" and t.base_url.endswith("/v1")
    s.asr_ai_model = "gemini-2.5-flash-lite"
    assert get_transcriber(s).model == "gemini-2.5-flash-lite"
    with pytest.raises(ASRError, match="Настройки"):
        get_transcriber(Settings(asr_provider="ai"))


def test_repeated_context_line_is_cut():
    from recapper.asr import _drop_repeats
    from recapper.models import Segment

    ctx = [("Собеседник 1", "Ну, смотрите, Артём, вчера, как говорила, я работала с видеосервисами. Единственное, что не смогла "
                            "зайти в Mail.ru, потому что те, что доступы есть, ни на YouTube, ни на Mail.ru написано, что")]
    new = [Segment(speaker="Собеседник 1", text="Ну смотрите, Артем, вчера как говорила, я работала с видеосервисами. "
                   "Единственное, что не смогла зайти в Mail.ru, потому что те, что доступы есть, ни на YouTube, "
                   "ни на Mail.ru, написано, что поменены пароли."),
           Segment(speaker="Собеседник 2", text="М-м. Я на YouTube сейчас тебе доступ сброшу")]
    out = _drop_repeats(new, ctx)
    assert [s.text for s in out] == ["поменены пароли", "М-м. Я на YouTube сейчас тебе доступ сброшу"]
    assert _drop_repeats(new[1:], ctx)[0].text == new[1].text  # unrelated lines stay intact


def test_fragment_of_previous_line_is_dropped():
    from recapper.asr import _drop_repeats
    from recapper.models import Segment

    ctx = [("Собеседник 2", "Ну, смотрите, Артём, вчера я, как говорила, я работала с видеосервисами. Единственное что")]
    new = [Segment(speaker="Собеседник 2", text="вчера я, как говорила, я работала."),
           Segment(speaker="Собеседник 2", text="Но, смотрите, Артём, вчера"),
           Segment(speaker="Собеседник 1", text="Артём, не пускает.")]
    assert [s.text for s in _drop_repeats(new, ctx)] == ["Артём, не пускает."]


@pytest.fixture(autouse=True)
def _energy_vad(monkeypatch):
    """Test tones are not human speech for Silero VAD: use the energy estimate in unit tests."""
    import recapper.asr

    monkeypatch.setattr(recapper.asr, "speech_regions", lambda audio, rate=16000: None)


def test_noise_and_phantom_phrases_on_the_mic_are_dropped(tmp_path):
    from recapper.asr import is_echo, voiced_seconds

    quiet = np.random.default_rng(0).normal(0, 0.004, 16000 * 5).astype(np.float32)  # room noise
    assert voiced_seconds(quiet) < 0.5
    t = make(lambda r: (_ for _ in ()).throw(AssertionError("noise must not reach the model")))
    path = tmp_path / "noise.wav"
    import wave
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((quiet * 32767).astype("<i2").tobytes())
    assert t.transcribe(path, solo=True) == []
    # a short burst of sound + a typical invented phrase -> dropped
    burst = write_wav(tmp_path / "b.wav", seconds=1.0)
    assert make(lambda r: chat_reply("Абонент временно недоступен.")).transcribe(burst) == []
    assert make(lambda r: chat_reply("Здравствуйте.")).transcribe(burst) == []
    assert [s.text for s in make(lambda r: chat_reply("Посчитай конверсию в Купер")).transcribe(burst)] == ["Посчитай конверсию в Купер"]
    # the mic heard the speakers
    assert is_echo("вчера я работала с видеосервисами", ["Ну смотрите Артём, вчера я работала с видеосервисами. Единственное"])
    assert not is_echo("Ассистент, посчитай конверсию", ["вчера я работала с видеосервисами"])


def test_mic_solo_mode_is_stricter(tmp_path):
    from recapper.asr import voiced_seconds

    rng = np.random.default_rng(1)
    noise = rng.normal(0, 0.02, 16000 * 6).astype(np.float32)  # loud room noise after auto-gain
    assert voiced_seconds(noise) < 0.5  # adaptive floor: steady noise is not speech
    burst = write_wav(tmp_path / "b.wav", seconds=1.5)
    prompts = []

    def handler(r):
        prompts.append(json.loads(r.content)["messages"][0]["content"][0]["text"])
        return chat_reply("Привет.")

    assert make(handler).transcribe(burst, solo=True) == []
    assert "наушниках" in prompts[0]


def test_mic_text_longer_than_heard_voice_is_dropped(tmp_path):
    """0.9 s of voice cannot carry a 6-word sentence: the model invented it."""
    t = np.arange(int(16000 * 6)) / 16000
    audio = np.where(t < 0.9, np.sin(2 * np.pi * 200 * t) * 0.3, 0).astype(np.float32)
    path = tmp_path / "m.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((audio * 32767).astype("<i2").tobytes())
    assert make(lambda r: chat_reply("Ну давайте тогда обсудим вчерашние дела")).transcribe(path, solo=True) == []
    assert make(lambda r: chat_reply("Пожалуйста, подождите.")).transcribe(path, solo=True) == []
    assert [s.text for s in make(lambda r: chat_reply("Посчитай конверсию")).transcribe(path, solo=True)] == ["Посчитай конверсию"]


def test_other_participants_are_not_over_filtered(tmp_path):
    """Quiet call audio and short real answers from others must survive."""
    quiet = write_wav(tmp_path / "q.wav", seconds=3.0, amp=0.02)  # a quiet but real voice in the call
    assert [s.text for s in make(lambda r: chat_reply("Да.")).transcribe(quiet)] == ["Да."]
    assert make(lambda r: chat_reply("Абонент временно недоступен")).transcribe(quiet) == []


def test_notes_and_timecodes_are_not_speech():
    from recapper.asr import _strip_notes

    assert _strip_notes("(Звуки печати на клавиатуре)") == ""
    assert _strip_notes("00:10.871 - 00:11.831 Здравствуйте.") == "Здравствуйте"
