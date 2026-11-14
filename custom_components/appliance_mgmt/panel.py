"""The Appliance Mgmt sidebar dashboard.

Registered once from ``async_setup`` for the whole Home Assistant run — not
once per config entry, and not removed when the last appliance unloads.
Home Assistant raises ``ValueError: Overwriting panel appliances owned by
custom`` if the same panel is registered again, which used to abort setup of
every appliance after the first. Removing it with the last entry (1.14.1)
then left the page missing after a reload, because nothing registered it a
second time.

The panel reads live states (Status, Time Left, …) from the frontend's own
connection. This module adds what states don't carry: which entities belong
to which appliance, recent cycles, maintenance alerts, upkeep, energy and
whether it's muted. The websocket command lists every appliance that is set
up, not the entry that happened to register the page.

Each appliance is drawn by the panel itself (2.1.0). Pictures uploaded
before 2.1.0 are deleted once, at startup.
"""

from __future__ import annotations

from datetime import timedelta
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, DOOR_TYPES
from .dashboard import DATA_DASHBOARD, DRAWINGS, DashboardStore, default_drawing

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "appliances"
PANEL_COMPONENT = "appliance-mgmt-panel"
PANEL_TITLE = "Appliance Mgmt"
PANEL_ICON = "mdi:washing-machine"
STATIC_URL = f"/{DOMAIN}_static"
FRONTEND_DIR = Path(__file__).parent / "frontend"
# True once this run has claimed the sidebar panel. Set before the await so
# a second caller cannot register it too.
DATA_PANEL = f"{DOMAIN}_panel"
# True once the panel's JavaScript path is registered. Independent of
# DATA_PANEL so a failed panel registration can be retried without
# registering the same static path twice.
DATA_STATIC = f"{DOMAIN}_static"
# True once the websocket commands are registered for this run.
DATA_API = f"{DOMAIN}_panel_api"
# Pictures uploaded before 2.1.0 (config entry id -> image upload id)
IMAGES_STORE = f"{DOMAIN}.images"
# Cycles listed: the last week's, and at least this many
RECENT_CYCLES = 10
RECENT_CYCLES_MAX = 50
WEEK_DAYS = 7

# Our entities, by the key in their unique id (``<entry_id>_<key>``).
ENTITY_KEYS = {
    "status": "sensor",
    "progress": "sensor",
    "time_left": "sensor",
    "finishes_at": "sensor",
    "cycles_week": "sensor",
    "average_cycle": "sensor",
    "power": "switch",
    "event": "event",
    "update_live_activity": "button",
    "probe_target": "number",
}


async def async_setup_panel_backend(hass: HomeAssistant) -> None:
    """Load the dashboard store and register the websocket commands, once per run.

    ``websocket_api.async_register_command`` raises if the same command is
    registered again, so a second call (a retried ``async_setup``) must not
    reach it. The claim is synchronous, before the storage load, so two
    callers cannot both pass the check.
    """
    if hass.data.get(DATA_API):
        return
    hass.data[DATA_API] = True
    try:
        store = DashboardStore(hass)
        await store.async_load()
    except Exception:
        # Leave the commands unregistered and let a retry start over.
        hass.data[DATA_API] = False
        raise
    hass.data[DATA_DASHBOARD] = store
    websocket_api.async_register_command(hass, websocket_appliances)
    websocket_api.async_register_command(hass, websocket_mute)
    websocket_api.async_register_command(hass, websocket_upkeep_done)
    websocket_api.async_register_command(hass, websocket_drawing)
    async_at_started(hass, async_remove_old_pictures)


async def async_remove_old_pictures(hass: HomeAssistant) -> None:
    """Delete the pictures uploaded before 2.1.0, once.

    They were kept by Home Assistant's image upload; only their ids were
    stored here. Whatever can't be deleted (image upload not loaded) is left
    alone, and the list is forgotten either way.
    """
    store: Store[dict[str, Any]] = Store(hass, 1, IMAGES_STORE)
    try:
        stored = await store.async_load()
    except Exception:  # noqa: BLE001 - a bad file must not stop the dashboard
        _LOGGER.debug("Couldn't read the old pictures list", exc_info=True)
        return
    if stored is None:
        return
    uploads = hass.data.get("image_upload")
    for image_id in (stored.get("images") or {}).values():
        if uploads is None or not isinstance(image_id, str):
            continue
        try:
            await uploads.async_delete_item(image_id)
        except Exception:  # noqa: BLE001 - already gone, or a newer image upload
            _LOGGER.debug("Couldn't delete old picture %s", image_id, exc_info=True)
    await store.async_remove()


def _panel_already_registered(err: BaseException) -> bool:
    """Home Assistant's error when this panel is already in the sidebar."""
    return isinstance(err, ValueError) and "Overwriting panel" in str(err)


async def async_register_panel(hass: HomeAssistant, version: str | None) -> None:
    """Show the Appliances panel in the sidebar, once per Home Assistant run.

    Called from ``async_setup``. The panel stays for the whole run, including
    after the last appliance is removed, and shows an empty state then. It is
    not registered from ``async_setup_entry``: doing that once per appliance
    raises, and only the first appliance loads.

    No-op when this run already registered it. No-op without a frontend
    (tests, or a headless setup); the flag is left unset so a later call can
    still register. An "already registered" error from Home Assistant is the
    outcome we want and is not raised — a failed or repeated setup must not
    take the integration down or hide the other appliances.
    """
    if hass.data.get(DATA_PANEL):
        return
    if "frontend" not in hass.config.components or hass.http is None:
        _LOGGER.debug("Frontend not loaded; skipping the Appliances panel")
        return

    # Claim before the first await. Check and set are synchronous, so a
    # second task cannot pass the check above while this one is waiting.
    hass.data[DATA_PANEL] = True
    try:
        await _async_register_panel_and_static(hass, version)
    except Exception as err:
        if _panel_already_registered(err):
            _LOGGER.debug("Appliances panel is already registered: %s", err)
            return
        # Static path may already be recorded. Clearing only the panel claim
        # lets a retry register the panel without registering the path twice.
        hass.data[DATA_PANEL] = False
        raise


async def _async_register_panel_and_static(
    hass: HomeAssistant, version: str | None
) -> None:
    """Register the script path, then the sidebar panel."""
    from homeassistant.components import panel_custom  # noqa: PLC0415
    from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

    if not hass.data.get(DATA_STATIC):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
        )
        hass.data[DATA_STATIC] = True
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        # The version busts the browser cache after an update.
        module_url=f"{STATIC_URL}/appliance-mgmt-panel.js?v={version or 'dev'}",
        require_admin=False,
        config={},
    )


def _alerts(coordinator) -> list[str]:
    """Maintenance problems that states alone don't show."""
    from .maintenance import CLEAN_FILTER_STATES  # noqa: PLC0415

    alerts: list[str] = []
    supplies = getattr(coordinator, "supplies", None)
    if supplies is not None:
        alerts += [text for _entity_id, text in supplies.low_supplies()]
    filter_monitor = getattr(coordinator, "filter", None)
    if filter_monitor is not None:
        status = filter_monitor.status
        if coordinator.appliance_type == "dishwasher":
            if status in CLEAN_FILTER_STATES:
                alerts.append("Filter needs cleaning")
        elif text := {
            "replace": "Replace the water filter",
            "expired": "The water filter has expired",
            "leak detected": "The water filter reports a leak",
        }.get(status):
            alerts.append(text)
    fridge = getattr(coordinator, "fridge", None)
    if fridge is not None:
        alerts += [f"{zone.capitalize()} is too warm" for zone in fridge.too_warm]
    return alerts


def _iso(timestamp: float | None) -> str | None:
    return dt_util.utc_from_timestamp(timestamp).isoformat() if timestamp else None


def _waiting(coordinator) -> dict[str, Any] | None:
    """A finished load still inside, when the appliance knows it."""
    if coordinator.appliance_type in DOOR_TYPES:
        return None
    move_since = getattr(coordinator, "_move_since", None)
    if move_since:
        to_dryer = coordinator.dryer_entity or coordinator.combine_laundry
        return {
            "text": "Move it to the dryer" if to_dryer else "Done, still full",
            "since": _iso(move_since),
        }
    if coordinator.appliance_type == "dishwasher" and coordinator._clean_inside():
        history = coordinator._history
        return {
            "text": "Clean dishes inside",
            "since": _iso(history[-1][0]) if history else None,
        }
    return None


def _cycles(coordinator) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(recent cycles newest first, cycles per day for the last week)."""
    price = coordinator.energy_price
    history = list(getattr(coordinator, "_history", []))
    today = dt_util.as_local(dt_util.utcnow()).date()
    first_day = today - timedelta(days=WEEK_DAYS - 1)
    days: dict[str, dict[str, Any]] = {}
    for offset in range(WEEK_DAYS):
        day = (first_day + timedelta(days=offset)).isoformat()
        days[day] = {"date": day, "count": 0, "kwh": None}
    recent: list[dict[str, Any]] = []
    for item in reversed(history):
        finished, minutes = item[0], item[1]
        kwh = item[2] if len(item) > 2 else None
        local = dt_util.as_local(dt_util.utc_from_timestamp(finished)).date()
        if (day := days.get(local.isoformat())) is not None:
            day["count"] += 1
            if kwh is not None:
                day["kwh"] = round((day["kwh"] or 0) + kwh, 3)
        if len(recent) < RECENT_CYCLES_MAX and (
            local >= first_day or len(recent) < RECENT_CYCLES
        ):
            recent.append(
                {
                    "finished": _iso(finished),
                    "minutes": minutes,
                    "kwh": kwh,
                    "cost": round(kwh * price, 2)
                    if kwh is not None and price
                    else None,
                }
            )
    return recent, list(days.values())


@callback
def appliance_summary(hass: HomeAssistant, entry) -> dict[str, Any]:
    """Everything the panel needs about one appliance."""
    from .device import appliance_device_id, own_device  # noqa: PLC0415

    coordinator = entry.runtime_data
    registry = er.async_get(hass)
    entities = {
        key: entity_id
        for key, platform in ENTITY_KEYS.items()
        if (
            entity_id := registry.async_get_entity_id(
                platform, DOMAIN, f"{entry.entry_id}_{key}"
            )
        )
    }
    own = own_device(hass, entry)
    fridge = getattr(coordinator, "fridge", None)
    try:
        alerts = _alerts(coordinator)
    except Exception:  # a monitor must never break the dashboard
        _LOGGER.exception("Couldn't read %s's maintenance alerts", coordinator.name)
        alerts = []
    store: DashboardStore | None = hass.data.get(DATA_DASHBOARD)
    history = list(getattr(coordinator, "_history", []))
    try:
        waiting = _waiting(coordinator)
    except Exception:
        _LOGGER.exception("Couldn't tell whether %s is still full", coordinator.name)
        waiting = None
    recent, days = _cycles(coordinator)
    # The fridge or dishwasher reports its own filter: no reminder for it
    skip = ("water_filter", "filter") if getattr(coordinator, "filter", None) else ()
    zones = tuple(fridge.zones) if fridge is not None else ()
    picked = store.drawing(entry.entry_id) if store else None
    return {
        "entry_id": entry.entry_id,
        "name": coordinator.display_title,
        "type": coordinator.appliance_type,
        "type_name": coordinator.definition.display_name,
        "door": coordinator.appliance_type in DOOR_TYPES,
        "icon": coordinator.icon,
        "color": coordinator.icon_color,
        # Which drawing (2.2.0): picked from the card's menu, else a default
        # from the type and name.
        "drawing": picked
        or default_drawing(
            coordinator.appliance_type, coordinator.display_title, zones
        ),
        "drawing_picked": picked is not None,
        "drawings": list(DRAWINGS.get(coordinator.appliance_type, ("door",))),
        "link": coordinator.tap_path(),
        "device_id": own.id if own else None,
        "appliance_device_id": appliance_device_id(hass, coordinator),
        "entities": entities,
        "temperatures": (
            [
                {"zone": zone, "entity_id": entity_id, "limit": limit}
                for zone, (entity_id, limit) in fridge.zones.items()
            ]
            if fridge is not None
            else []
        ),
        # The doors (fridge, freezer, a plain door), for opens today
        "door_entities": list(getattr(coordinator, "doors", []) or []),
        "door_entity": getattr(coordinator, "door_entity", None),
        # The oven's own temperature and set temperature, for the drawing
        "temperature_entity": getattr(coordinator, "temperature_entity", None),
        "target_entity": getattr(coordinator, "target_entity", None),
        "alerts": alerts,
        "waiting": waiting,
        "muted_until": _iso(store.muted_until(entry.entry_id)) if store else None,
        "upkeep": (
            store.upkeep(entry.entry_id, coordinator.appliance_type, history, skip)
            if store
            else []
        ),
        "energy": bool(coordinator.energy_entity),
        "currency": hass.config.currency if coordinator.energy_price else None,
        # Newest first: when each cycle finished, how long it ran, energy
        "recent_cycles": recent,
        "days": days,
    }


def dashboard_appliances(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Every appliance that is set up, for the dashboard.

    The sidebar page is registered once for the whole run, so this is every
    loaded config entry — whichever entry was set up first does not own the
    list. An entry that failed setup has no coordinator and is left out. One
    appliance whose summary raises is skipped so the others still show.
    """
    summaries: list[dict[str, Any]] = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is not ConfigEntryState.LOADED:
            continue
        try:
            summaries.append(appliance_summary(hass, entry))
        except Exception:
            _LOGGER.exception(
                "Couldn't describe %s for the Appliances dashboard",
                getattr(entry, "title", None) or entry.entry_id,
            )
    return summaries


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/appliances"})
@callback
def websocket_appliances(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Every set-up appliance, for the dashboard."""
    connection.send_result(
        msg["id"],
        {
            "appliances": dashboard_appliances(hass),
            "is_admin": connection.user.is_admin if connection.user else False,
        },
    )


def _entry(hass: HomeAssistant, entry_id: str):
    entry = hass.config_entries.async_get_entry(entry_id)
    if (
        entry is None
        or entry.domain != DOMAIN
        or entry.state is not ConfigEntryState.LOADED
    ):
        return None
    return entry


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/mute",
        vol.Required("entry_id"): str,
        vol.Required("muted"): bool,
    }
)
@websocket_api.async_response
async def websocket_mute(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Mute an appliance until midnight, or unmute it."""
    entry = _entry(hass, msg["entry_id"])
    if entry is None:
        connection.send_error(msg["id"], "not_found", "No such appliance")
        return
    store: DashboardStore = hass.data[DATA_DASHBOARD]
    until = store.set_muted(entry.entry_id, msg["muted"])
    await entry.runtime_data.async_mute_changed(until)
    connection.send_result(msg["id"], {"muted_until": _iso(until)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/upkeep_done",
        vol.Required("entry_id"): str,
        vol.Required("key"): str,
    }
)
@callback
def websocket_upkeep_done(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """An upkeep task was done just now."""
    entry = _entry(hass, msg["entry_id"])
    store: DashboardStore = hass.data[DATA_DASHBOARD]
    if entry is None or not store.upkeep_done(
        entry.entry_id, entry.runtime_data.appliance_type, msg["key"]
    ):
        connection.send_error(msg["id"], "not_found", "No such appliance or task")
        return
    connection.send_result(msg["id"], {"done": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/drawing",
        vol.Required("entry_id"): str,
        vol.Required("drawing"): vol.Any(None, str),
    }
)
@callback
def websocket_drawing(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Pick how an appliance is drawn (None: the default)."""
    entry = _entry(hass, msg["entry_id"])
    store: DashboardStore = hass.data[DATA_DASHBOARD]
    if entry is None or not store.set_drawing(
        entry.entry_id, entry.runtime_data.appliance_type, msg["drawing"]
    ):
        connection.send_error(msg["id"], "not_found", "No such appliance or drawing")
        return
    connection.send_result(msg["id"], {"drawing": msg["drawing"]})
