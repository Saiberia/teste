from recapper.knowledge import Chunk, KnowledgeBase, stem, tokenize


def test_stem_matches_word_forms():
    assert stem("конверсии") == stem("конверсия") == stem("конверсию")
    assert stem("кот") == "кот"


def test_tokenize_drops_stopwords():
    assert "и" not in tokenize("и конверсия в Купер")


def test_search_ranks_relevant_doc_first(kb):
    assert len(kb) >= 2
    hits = kb.search("промокод конверсия Купер")
    assert hits and hits[0][0].doc == "kuper_crosssell.md"
    hits = kb.search("награды игрокам в игре")
    assert hits[0][0].doc == "game_metrics.md"


def test_search_no_match_and_empty():
    kb = KnowledgeBase([Chunk("a.md", "яблоки груши")])
    assert kb.search("самолёт") == []
    assert kb.search("") == []
    assert KnowledgeBase().search("что угодно") == []


def test_from_dir_missing(tmp_path):
    assert len(KnowledgeBase.from_dir(tmp_path / "nope")) == 0
    assert len(KnowledgeBase.from_dir(None)) == 0


def test_chunking_long_document():
    kb = KnowledgeBase()
    kb.add_document("big.md", "\n\n".join(f"абзац номер {i} " + "текст " * 50 for i in range(20)), max_chars=500)
    assert len(kb) > 5
    assert all(len(c.text) <= 800 for c in kb.chunks)


def test_ignores_non_text_files(tmp_path):
    (tmp_path / "a.md").write_text("конверсия", "utf-8")
    (tmp_path / "b.bin").write_bytes(b"\x00\x01")
    kb = KnowledgeBase.from_dir(tmp_path)
    assert [c.doc for c in kb.chunks] == ["a.md"]
