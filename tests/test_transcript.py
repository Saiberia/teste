from recapper.transcript import format_clock, parse_transcript, segments_to_text


def test_plain_with_timestamps(meeting_text):
    segs = parse_transcript(meeting_text)
    assert len(segs) == 14
    assert segs[0].speaker == "Аня" and segs[0].start == 5.0
    assert segs[3].speaker == "Макс" and segs[3].start == 40.0
    assert "конверсию" in segs[3].text


def test_plain_without_timestamps_and_continuation():
    segs = parse_transcript("Аня: первая мысль\nпродолжение мысли\nМакс: ответ")
    assert [s.speaker for s in segs] == ["Аня", "Макс"]
    assert segs[0].text == "первая мысль продолжение мысли"
    assert segs[0].start is None


def test_plain_short_clock_and_no_speaker():
    segs = parse_transcript("01:15 просто текст без спикера")
    assert segs[0].start == 75.0 and segs[0].speaker == "" and segs[0].text == "просто текст без спикера"


def test_url_is_not_speaker():
    segs = parse_transcript("https://example.com/path это ссылка")
    assert segs[0].speaker == ""


def test_webvtt_with_voice_tags_and_multiline():
    vtt = (
        "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\n<v Аня>Надо посчитать\nконверсию</v>\n\n"
        "00:01:02.250 --> 00:01:05.000\nМакс: Согласен\n"
    )
    segs = parse_transcript(vtt)
    assert len(segs) == 2
    assert segs[0].speaker == "Аня" and segs[0].text == "Надо посчитать конверсию"
    assert segs[0].start == 1.0 and segs[0].end == 4.5
    assert segs[1].speaker == "Макс" and segs[1].start == 62.25


def test_srt():
    srt = "1\n00:00:01,000 --> 00:00:02,000\nЛена: Привет\n\n2\n01:00:00,500 --> 01:00:02,000\nКак дела?\n"
    segs = parse_transcript(srt)
    assert [s.speaker for s in segs] == ["Лена", ""]
    assert segs[1].start == 3600.5


def test_empty_and_bom():
    assert parse_transcript("") == []
    assert parse_transcript("   \n\n") == []
    assert parse_transcript("﻿Аня: текст")[0].speaker == "Аня"


def test_roundtrip_text(meeting_text):
    text = segments_to_text(parse_transcript(meeting_text))
    again = parse_transcript(text)
    assert [s.text for s in again] == [s.text for s in parse_transcript(meeting_text)]


def test_format_clock():
    assert format_clock(None) == ""
    assert format_clock(65) == "01:05"
    assert format_clock(3725) == "1:02:05"
