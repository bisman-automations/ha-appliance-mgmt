"""v2.1.0: dashboard drawings replace pictures; mute, upkeep, energy, week."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_mock_service,
)

from custom_components.appliance_mgmt import panel
from custom_components.appliance_mgmt.const import DOMAIN
from custom_components.appliance_mgmt.dashboard import DATA_DASHBOARD
from custom_components.appliance_mgmt.energy import EnergyMeter
from custom_components.appliance_mgmt.notify import async_deliver
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .test_panel import _setup as _setup_dishwasher, _ws
from .test_v18 import WASHER, _ge_device, _phone, _set, _setup, _tick

PLUG = "sensor.washer_plug_power"


@pytest.fixture
async def env(hass: HomeAssistant, enable_custom_integrations):
    mobile = MockConfigEntry(domain="mobile_app")
    mobile.add_to_hass(hass)
    ge = MockConfigEntry(domain="ge_home")
    ge.add_to_hass(hass)
    return mobile, ge


async def _washer(hass, env, **options):
    mobile, ge = env
    me = _phone(hass, mobile, "a", "My Phone")
    calls = async_mock_service(hass, "notify", "mobile_app_my_phone")
    device = await _ge_device(hass, ge, "washer", "Laundry Room Washer", WASHER)
    await _setup(hass, device.id, {"devices": [me.id]})
    (entry,) = hass.config_entries.async_entries(DOMAIN)
    if options:
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, **options}
        )
        await hass.config_entries.async_reload(entry.entry_id)
        await hass.async_block_till_done()
    return entry, calls


async def _run(hass, freezer, minutes=60, step=5):
    prefix = "laundry_room_washer"
    _set(hass, f"binary_sensor.{prefix}_end_of_cycle", "off")
    _set(
        hass,
        f"sensor.{prefix}_time_remaining",
        str(minutes),
        {"unit_of_measurement": "min"},
    )
    _set(hass, f"sensor.{prefix}_state", "Run")
    await hass.async_block_till_done()
    for _ in range(minutes // step):
        await _tick(hass, freezer, timedelta(minutes=step))
    _set(hass, f"sensor.{prefix}_time_remaining", "0", {"unit_of_measurement": "min"})
    _set(hass, f"binary_sensor.{prefix}_end_of_cycle", "on")
    _set(hass, f"sensor.{prefix}_state", "Finished")
    await hass.async_block_till_done()


# ------------------------------------------------------------------ pictures
async def test_no_picture_command(
    hass: HomeAssistant, enable_custom_integrations, hass_ws_client
):
    entry = await _setup_dishwasher(hass)
    client = await hass_ws_client(hass)
    res = await _ws(
        client, type=f"{DOMAIN}/image", entry_id=entry.entry_id, image_id="abc"
    )
    assert res["error"]["code"] == "unknown_command"


async def test_old_pictures_are_deleted_once(
    hass: HomeAssistant, enable_custom_integrations, hass_storage
):
    hass_storage[panel.IMAGES_STORE] = {
        "version": 1,
        "key": panel.IMAGES_STORE,
        "data": {"images": {"one": "img1", "two": "img2"}},
    }
    uploads = AsyncMock()
    hass.data["image_upload"] = uploads
    await _setup_dishwasher(hass)
    await hass.async_block_till_done()
    deleted = sorted(c.args[0] for c in uploads.async_delete_item.await_args_list)
    assert deleted == ["img1", "img2"]
    assert panel.IMAGES_STORE not in hass_storage


async def test_old_pictures_without_image_upload(
    hass: HomeAssistant, enable_custom_integrations, hass_storage
):
    hass_storage[panel.IMAGES_STORE] = {
        "version": 1,
        "key": panel.IMAGES_STORE,
        "data": {"images": {"one": "img1"}},
    }
    await _setup_dishwasher(hass)
    await hass.async_block_till_done()
    assert panel.IMAGES_STORE not in hass_storage


# ---------------------------------------------------------------------- mute
async def test_mute_for_today(
    hass: HomeAssistant, enable_custom_integrations, hass_ws_client, freezer
):
    await hass.config.async_set_time_zone("UTC")
    entry = await _setup_dishwasher(hass)
    coordinator = entry.runtime_data
    client = await hass_ws_client(hass)
    res = await _ws(client, type=f"{DOMAIN}/mute", entry_id=entry.entry_id, muted=True)
    assert res["success"]
    midnight = dt_util.parse_datetime(res["result"]["muted_until"])
    assert midnight == dt_util.start_of_local_day() + timedelta(days=1)
    assert coordinator.muted
    summary = panel.appliance_summary(hass, entry)
    assert summary["muted_until"] == res["result"]["muted_until"]

    calls = async_mock_service(hass, "notify", "mobile_app_my_phone")
    with patch(
        "custom_components.appliance_mgmt.notify.notify_services_for_device",
        return_value=["mobile_app_my_phone"],
    ):
        regular = {"title": "Done", "message": "Dishes are clean"}
        await async_deliver(hass, coordinator, regular, ["phone"])
        critical = {
            "title": "Leak",
            "message": "Water!",
            "data": {"push": {"interruption-level": "critical"}},
        }
        await async_deliver(hass, coordinator, critical, ["phone"])
        clear = {"message": "clear_notification", "data": {"tag": "x"}}
        await async_deliver(hass, coordinator, clear, ["phone"])
        await hass.async_block_till_done()
        assert [c.data.get("title") for c in calls] == ["Leak", None]

        # Unmuted at midnight
        freezer.move_to(midnight + timedelta(seconds=5))
        await _tick(hass, freezer, timedelta(seconds=1))
        assert not coordinator.muted
        await async_deliver(hass, coordinator, regular, ["phone"])
        await hass.async_block_till_done()
        assert calls[-1].data["title"] == "Done"

    res = await _ws(client, type=f"{DOMAIN}/mute", entry_id=entry.entry_id, muted=True)
    res = await _ws(client, type=f"{DOMAIN}/mute", entry_id=entry.entry_id, muted=False)
    assert res["result"]["muted_until"] is None
    assert not coordinator.muted
    res = await _ws(client, type=f"{DOMAIN}/mute", entry_id="nope", muted=True)
    assert res["error"]["code"] == "not_found"


async def test_mute_survives_a_restart(
    hass: HomeAssistant, enable_custom_integrations, hass_storage, freezer
):
    freezer.move_to("2026-11-14 15:00:00+00:00")
    entry = await _setup_dishwasher(hass)
    store = hass.data[DATA_DASHBOARD]
    store.set_muted(entry.entry_id, True)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.muted
    assert entry.runtime_data._unmute_cancel is not None


# -------------------------------------------------------------------- upkeep
async def test_upkeep_due_and_done(
    hass: HomeAssistant, enable_custom_integrations, hass_ws_client, freezer
):
    entry = await _setup_dishwasher(hass)
    client = await hass_ws_client(hass)
    (task,) = panel.appliance_summary(hass, entry)["upkeep"]
    assert task["key"] == "filter"
    assert task["status"] == "ok"
    assert task["days_left"] == 30

    freezer.tick(timedelta(days=26))
    assert panel.appliance_summary(hass, entry)["upkeep"][0]["status"] == "soon"
    freezer.tick(timedelta(days=5))
    assert panel.appliance_summary(hass, entry)["upkeep"][0]["status"] == "due"

    res = await _ws(
        client, type=f"{DOMAIN}/upkeep_done", entry_id=entry.entry_id, key="filter"
    )
    assert res["success"]
    task = panel.appliance_summary(hass, entry)["upkeep"][0]
    assert task["status"] == "ok" and task["days_left"] == 30
    res = await _ws(
        client, type=f"{DOMAIN}/upkeep_done", entry_id=entry.entry_id, key="nope"
    )
    assert res["error"]["code"] == "not_found"


async def test_upkeep_by_cycles_and_filter_sensor(
    hass: HomeAssistant, enable_custom_integrations, freezer
):
    freezer.move_to("2026-01-01 12:00:00+00:00")
    entry = await _setup_dishwasher(hass)
    coordinator = entry.runtime_data
    coordinator.appliance_type = "washer"
    panel.appliance_summary(hass, entry)  # starts counting now
    now = dt_util.utcnow().timestamp()
    coordinator._history = [[now + i, 50.0] for i in range(1, 27)]
    (task,) = panel.appliance_summary(hass, entry)["upkeep"]
    assert task["key"] == "tub_clean"
    assert task["cycles_left"] == 4
    assert task["status"] == "soon"

    # A dishwasher that reports its own filter gets no filter reminder
    coordinator.appliance_type = "dishwasher"
    coordinator.filter = object()
    assert panel.appliance_summary(hass, entry)["upkeep"] == []


# --------------------------------------------------------------- week, cycles
async def test_week_and_waiting(
    hass: HomeAssistant, enable_custom_integrations, freezer
):
    freezer.move_to("2026-11-14 18:00:00+00:00")
    await hass.config.async_set_time_zone("UTC")
    entry = await _setup_dishwasher(hass)
    coordinator = entry.runtime_data
    now = dt_util.utcnow().timestamp()
    day = 86400
    coordinator._history = [
        [now - 20 * day, 80.0],  # older than a week
        [now - 2 * day, 90.0, 1.2],
        [now - 3600, 85.0, 1.0],
        [now - 60, 88.0],
    ]
    coordinator.energy_price = 0.25
    summary = panel.appliance_summary(hass, entry)
    days = summary["days"]
    assert len(days) == 7
    assert days[-1]["date"] == "2026-11-14"
    assert [d["count"] for d in days] == [0, 0, 0, 0, 1, 0, 2]
    assert days[-1]["kwh"] == 1.0
    recent = summary["recent_cycles"]
    # Fewer than 10 this week: older ones fill the list
    assert [c["minutes"] for c in recent] == [88.0, 85.0, 90.0, 80.0]
    assert recent[1]["kwh"] == 1.0 and recent[1]["cost"] == 0.25
    assert recent[0]["kwh"] is None and recent[0]["cost"] is None
    assert summary["waiting"] is None

    coordinator.appliance_type = "washer"
    coordinator._move_since = now - 600
    assert summary_waiting(hass, entry)["text"] == "Done, still full"
    coordinator.combine_laundry = True
    assert summary_waiting(hass, entry)["text"] == "Move it to the dryer"


def summary_waiting(hass, entry):
    return panel.appliance_summary(hass, entry)["waiting"]


# -------------------------------------------------------------------- energy
async def test_energy_from_a_power_sensor(hass: HomeAssistant, env, freezer):
    hass.states.async_set(PLUG, "500", {"unit_of_measurement": "W"})
    entry, _ = await _washer(hass, env, energy_entity=PLUG, energy_price=0.3)
    await _run(hass, freezer, minutes=60)
    coordinator = entry.runtime_data
    assert coordinator._history[-1][1] == 60.0
    assert abs(coordinator._history[-1][2] - 0.5) < 0.01
    summary = panel.appliance_summary(hass, entry)
    assert summary["energy"] is True
    assert abs(summary["recent_cycles"][0]["cost"] - 0.15) < 0.01


async def test_energy_from_an_energy_total(hass: HomeAssistant, env, freezer):
    meter = "sensor.washer_plug_energy"
    hass.states.async_set(meter, "100.0", {"unit_of_measurement": "kWh"})
    entry, _ = await _washer(hass, env, energy_entity=meter)
    prefix = "laundry_room_washer"
    _set(hass, f"sensor.{prefix}_time_remaining", "30", {"unit_of_measurement": "min"})
    _set(hass, f"sensor.{prefix}_state", "Run")
    await hass.async_block_till_done()
    await _tick(hass, freezer, timedelta(minutes=30))
    hass.states.async_set(meter, "100.8", {"unit_of_measurement": "kWh"})
    await hass.async_block_till_done()
    _set(hass, f"sensor.{prefix}_time_remaining", "0", {"unit_of_measurement": "min"})
    _set(hass, f"binary_sensor.{prefix}_end_of_cycle", "on")
    _set(hass, f"sensor.{prefix}_state", "Finished")
    await hass.async_block_till_done()
    assert entry.runtime_data._history[-1][2] == 0.8


async def test_energy_meter_edge_cases(hass: HomeAssistant, freezer):
    meter = EnergyMeter(hass, "sensor.counter")
    assert meter.finish() is None  # never started
    hass.states.async_set("sensor.counter", "5", {"unit_of_measurement": "kWh"})
    meter.start()
    hass.states.async_set("sensor.counter", "1", {"unit_of_measurement": "kWh"})
    assert meter.finish() is None  # counter reset

    hass.states.async_set("sensor.counter", "unavailable")
    meter.start()
    assert meter.finish() is None  # nothing read

    hass.states.async_set("sensor.counter", "2", {"unit_of_measurement": "kW"})
    meter.start()
    freezer.tick(timedelta(minutes=10))
    meter.sample()
    saved = meter.to_dict()
    again = EnergyMeter(hass, "sensor.counter")
    again.restore(saved)
    freezer.tick(timedelta(minutes=10))
    assert again.finish() == 0.667
    # A long gap (sensor away) adds nothing
    meter.start()
    freezer.tick(timedelta(hours=2))
    assert meter.finish() == 0.0


async def test_energy_option_only_for_cycles(hass: HomeAssistant, env):
    entry, _ = await _washer(hass, env)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert "energy" in result["data_schema"].schema
