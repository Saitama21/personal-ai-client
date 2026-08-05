from app.knowledge_base import knowledge_summary, load_knowledge_base, search_knowledge


def test_knowledge_base_summary_and_machine_profile():
    summary = knowledge_summary()
    assert summary["ok"] is True
    assert summary["counts"]["documents"] == 7
    assert summary["counts"]["articles"] >= 17
    assert summary["counts"]["g_codes"] >= 90
    assert summary["counts"]["m_codes"] >= 20
    assert summary["counts"]["total_entries"] >= 130

    machine = load_knowledge_base()["machine"]
    assert "CK52PT-Y" in machine["name"]
    assert machine["control"]["family"] == "SINUMERIK 828D"
    assert "V04.95" in machine["control"]["cnc_software"]
    assert machine["release_policy"]["automatic_mpf"] is False


def test_unverified_tailstock_m_codes_are_hard_blocked():
    results = search_knowledge("M78 задняя бабка", limit=10)
    m78 = next(item for item in results if item["id"] == "mcode:M78")
    assert m78["trust"] == "unverified_oem"
    assert m78["safety"] == "hard_block_unverified"


def test_exact_v495_and_turn_mill_knowledge_is_searchable():
    results = search_knowledge("TRACYL цилиндр", limit=10)
    assert any("TRACYL" in item["title"] for item in results)
    results = search_knowledge("ShopTurn Stock Removal", limit=10)
    assert any(item["category"] == "shopturn" for item in results)
