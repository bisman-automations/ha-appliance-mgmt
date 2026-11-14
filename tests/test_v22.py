"""v2.2.0: pick how each appliance is drawn."""

from __future__ import annotations

from custom_components.appliance_mgmt import panel
from custom_components.appliance_mgmt.const import DOMAIN
from custom_components.appliance_mgmt.dashboard import DRAWINGS, default_drawing
from homeassistant.core import HomeAssistant

from .test_panel import _setup as _setup_dishwasher, _ws


def test_default_drawing():
    assert default_drawing("washer", "Laundry Washer", ()) == "front_load"
    assert default_drawing("refrigerator", "Kitchen Fridge", ("fridge", "freezer")) == (
        "french_door"
    )
    assert default_drawing("refrigerator", "Garage Freezer", ()) == "upright_freezer"
    assert default_drawing("refrigerator", "Basement Chest Freezer", ()) == (
        "chest_freezer"
    )
    assert default_drawing("refrigerator", "Garage", ("freezer",)) == "upright_freezer"
    assert default_drawing("refrigerator", "Fridge and Freezer", ()) == "french_door"
    assert default_drawing("refrigerator", "Office Mini", ("fridge",)) == "mini_fridge"
    assert default_drawing("door", "Garage Door", ()) == "garage_door"
    assert default_drawing("oven", "Kitchen Oven", ()) == "range"
    assert default_drawing("something_new", "X", ()) == "door"
    assert all(styles for styles in DRAWINGS.values())


async def test_pick_a_drawing(
    hass: HomeAssistant, enable_custom_integrations, hass_ws_client
):
    entry = await _setup_dishwasher(hass)
    summary = panel.appliance_summary(hass, entry)
    assert summary["drawing"] == "built_in"
    assert summary["drawing_picked"] is False
    assert summary["drawings"] == ["built_in", "drawers"]

    client = await hass_ws_client(hass)
    res = await _ws(
        client, type=f"{DOMAIN}/drawing", entry_id=entry.entry_id, drawing="drawers"
    )
    assert res["success"]
    summary = panel.appliance_summary(hass, entry)
    assert summary["drawing"] == "drawers" and summary["drawing_picked"] is True

    # Not a dishwasher drawing, or no such appliance.
    res = await _ws(
        client, type=f"{DOMAIN}/drawing", entry_id=entry.entry_id, drawing="top_load"
    )
    assert res["error"]["code"] == "not_found"
    res = await _ws(client, type=f"{DOMAIN}/drawing", entry_id="nope", drawing=None)
    assert res["error"]["code"] == "not_found"

    # Back to the default; kept over a reload.
    await _ws(client, type=f"{DOMAIN}/drawing", entry_id=entry.entry_id, drawing=None)
    assert panel.appliance_summary(hass, entry)["drawing_picked"] is False
    await _ws(
        client, type=f"{DOMAIN}/drawing", entry_id=entry.entry_id, drawing="drawers"
    )
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert panel.appliance_summary(hass, entry)["drawing"] == "drawers"
