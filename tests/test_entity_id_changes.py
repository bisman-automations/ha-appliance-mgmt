"""Changing an entity's ID keeps it running (Home Assistant 2026.11+)."""

from __future__ import annotations

import importlib
import inspect
import pkgutil

import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_mock_service,
)

import custom_components.appliance_mgmt as package
from custom_components.appliance_mgmt.const import DOMAIN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.entity import Entity
from tests.test_v16 import _live, _oven, _probe

LIFECYCLE = (
    "async_prepare_to_add_to_hass",
    "async_added_to_hass",
    "async_will_remove_from_hass",
)


def _entity_classes() -> list[type[Entity]]:
    classes: dict[str, type[Entity]] = {}
    for info in pkgutil.walk_packages(package.__path__, f"{package.__name__}."):
        module = importlib.import_module(info.name)
        for _, cls in inspect.getmembers(module, inspect.isclass):
            if issubclass(cls, Entity) and cls.__module__.startswith(package.__name__):
                classes[f"{cls.__module__}.{cls.__qualname__}"] = cls
    return list(classes.values())


def test_every_entity_with_lifecycle_code_handles_entity_id_changes() -> None:
    """Without the hook, 2026.11 removes and re-adds the entity on a rename."""
    classes = _entity_classes()
    assert classes
    missing = sorted(
        f"{cls.__module__}.{cls.__qualname__}"
        for cls in classes
        if any(name in cls.__dict__ for name in LIFECYCLE)
        and "async_entity_id_changed" not in cls.__dict__
    )
    assert not missing, f"Missing async_entity_id_changed: {', '.join(missing)}"


@pytest.fixture
async def oven_phone(hass: HomeAssistant, enable_custom_integrations):
    entry = MockConfigEntry(domain="mobile_app")
    entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={("mobile_app", "p")},
        name="My Phone",
    )
    ge = MockConfigEntry(domain="ge_home")
    ge.add_to_hass(hass)
    return device, ge, async_mock_service(hass, "notify", "mobile_app_my_phone")


@pytest.mark.skipif(
    not hasattr(Entity, "async_entity_id_changed"),
    reason="Home Assistant before 2026.11 re-adds a renamed entity",
)
async def test_probe_target_and_cycle_event_keep_working_after_rename(
    hass: HomeAssistant, oven_phone
) -> None:
    calls = await _oven(hass, oven_phone)
    registry = er.async_get(hass)
    renames = {
        "number.kitchen_oven_probe_target": "number.renamed_probe_target",
        "event.kitchen_oven_cycle": "event.renamed_cycle",
    }
    for old, new in renames.items():
        assert hass.states.get(old) is not None, old
        registry.async_update_entity(old, new_entity_id=new)
    await hass.async_block_till_done()
    for old, new in renames.items():
        assert hass.states.get(old) is None
        assert hass.states.get(new) is not None

    # The renamed Probe Target still drives the probe Live Activity.
    _probe(hass, 60)
    await hass.async_block_till_done()
    await hass.services.async_call(
        "number",
        "set_value",
        {"entity_id": "number.renamed_probe_target", "value": 145},
        blocking=True,
    )
    await hass.async_block_till_done()
    assert float(hass.states.get("number.renamed_probe_target").state) == 145
    live = _live(calls, "kitchen_oven_probe")
    assert live[-1].data["message"] == "Probe 60°F → 145°F"

    # The renamed cycle event still fires.
    coordinator = hass.config_entries.async_entries(DOMAIN)[0].runtime_data
    coordinator.fire_event("started", {"cycle": "Bake"})
    await hass.async_block_till_done()
    assert hass.states.get("event.renamed_cycle").attributes["event_type"] == "started"
    for old in renames:
        assert hass.states.get(old) is None
