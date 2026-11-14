"""What the Appliance Mgmt dashboard keeps for each appliance (2.1.0).

One Store for every appliance, keyed by config entry id, so it works the
same for appliances with cycles and for doors (whose coordinator keeps no
store of its own):

* ``muted_until``: "Mute for today". No regular alerts or Live Activity
  updates until local midnight. Critical alerts (a water leak, a door or
  cooktop left open, a blocked vent) still come through.
* ``upkeep``: when each upkeep task was last done (see ``UPKEEP``).
* ``drawing``: which drawing the dashboard shows (see ``DRAWINGS``), picked
  from the card's menu. None: ``default_drawing``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN

DATA_DASHBOARD = f"{DOMAIN}_dashboard"
DASHBOARD_STORE = f"{DOMAIN}.dashboard"
# "Due soon" once this share of the interval has passed
DUE_SOON = 0.85


@dataclass(frozen=True)
class UpkeepTask:
    """A recurring job, due after ``days`` or ``cycles``, whichever is first."""

    key: str
    label: str
    days: int | None = None
    cycles: int | None = None


UPKEEP: dict[str, tuple[UpkeepTask, ...]] = {
    "washer": (UpkeepTask("tub_clean", "Run a tub clean", days=60, cycles=30),),
    "dryer": (UpkeepTask("vent", "Clean the dryer vent", days=365),),
    "dishwasher": (UpkeepTask("filter", "Clean the filter", days=30),),
    "oven": (UpkeepTask("clean", "Clean the oven", days=90),),
    "refrigerator": (
        UpkeepTask("water_filter", "Replace the water filter", days=180),
        UpkeepTask("coils", "Clean the coils", days=365),
    ),
}


# The drawings the dashboard has for each type, the usual one first.
DRAWINGS: dict[str, tuple[str, ...]] = {
    "washer": ("front_load", "top_load"),
    "dryer": ("front_load", "stacked"),
    "dishwasher": ("built_in", "drawers"),
    "oven": ("range", "wall_oven", "double_wall_oven"),
    "refrigerator": (
        "french_door",
        "side_by_side",
        "top_freezer",
        "bottom_freezer",
        "fridge_only",
        "upright_freezer",
        "chest_freezer",
        "mini_fridge",
    ),
    "door": ("door", "garage_door", "sliding_door"),
}


def default_drawing(appliance_type: str, name: str, zones: tuple[str, ...]) -> str:
    """The drawing to use when none was picked.

    A fridge that is really a freezer (its name says so, or it only has a
    freezer temperature) is drawn as an upright freezer, or a chest freezer
    when its name says chest; a door called a garage door as one.
    """
    styles = DRAWINGS.get(appliance_type) or ("door",)
    lowered = name.lower()
    if appliance_type == "refrigerator":
        if "chest" in lowered:
            return "chest_freezer"
        if (
            "freezer" in lowered
            and "fridge" not in lowered
            and "refrigerator" not in lowered
        ):
            return "upright_freezer"
        if zones and "fridge" not in zones:
            return "upright_freezer"
        if "mini" in lowered:
            return "mini_fridge"
    if appliance_type == "door" and "garage" in lowered:
        return "garage_door"
    return styles[0]


def next_midnight(now: datetime | None = None) -> datetime:
    """The next local midnight, as an aware datetime."""
    local = dt_util.as_local(now or dt_util.utcnow())
    return dt_util.start_of_local_day(local.date() + timedelta(days=1))


class DashboardStore:
    """Mute and upkeep for every appliance."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, 1, DASHBOARD_STORE)
        self.data: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        stored = await self._store.async_load() or {}
        self.data = {
            k: dict(v)
            for k, v in (stored.get("appliances") or {}).items()
            if isinstance(v, dict)
        }

    @callback
    def _save(self) -> None:
        self._store.async_delay_save(lambda: {"appliances": self.data}, 1)

    def _get(self, entry_id: str) -> dict[str, Any]:
        return self.data.setdefault(entry_id, {})

    # -------------------------------------------------------------- mute
    def muted_until(self, entry_id: str) -> float | None:
        until = self.data.get(entry_id, {}).get("muted_until")
        if isinstance(until, (int, float)) and until > dt_util.utcnow().timestamp():
            return float(until)
        return None

    @callback
    def set_muted(self, entry_id: str, muted: bool) -> float | None:
        """Mute until midnight, or unmute. Returns the new muted-until."""
        item = self._get(entry_id)
        if muted:
            item["muted_until"] = next_midnight().timestamp()
        else:
            item.pop("muted_until", None)
        self._save()
        return self.muted_until(entry_id)

    # ----------------------------------------------------------- drawing
    def drawing(self, entry_id: str) -> str | None:
        style = self.data.get(entry_id, {}).get("drawing")
        return style if isinstance(style, str) else None

    @callback
    def set_drawing(
        self, entry_id: str, appliance_type: str, style: str | None
    ) -> bool:
        """Pick a drawing, or None for the default. False: not one for this type."""
        if style is not None and style not in DRAWINGS.get(appliance_type, ()):
            return False
        item = self._get(entry_id)
        if style is None:
            item.pop("drawing", None)
        else:
            item["drawing"] = style
        self._save()
        return True

    # ------------------------------------------------------------ upkeep
    @callback
    def upkeep(
        self, entry_id: str, appliance_type: str, history, skip: tuple[str, ...] = ()
    ) -> list[dict]:
        """Each upkeep task with how close it is to due.

        A task never marked done counts from the first time the dashboard
        saw it, so a new install isn't told everything is overdue.
        """
        tasks = [t for t in UPKEEP.get(appliance_type, ()) if t.key not in skip]
        if not tasks:
            return []
        item = self._get(entry_id)
        done: dict[str, Any] = item.setdefault("upkeep", {})
        now = dt_util.utcnow().timestamp()
        changed = False
        result = []
        for task in tasks:
            if not isinstance(done.get(task.key), (int, float)):
                done[task.key] = now
                changed = True
            since = float(done[task.key])
            ratio = 0.0
            days_left = cycles_left = None
            if task.days:
                days = (now - since) / 86400
                ratio = max(ratio, days / task.days)
                days_left = task.days - days
            if task.cycles:
                cycles = sum(1 for h in history if h and h[0] >= since)
                ratio = max(ratio, cycles / task.cycles)
                cycles_left = task.cycles - cycles
            status = "due" if ratio >= 1 else "soon" if ratio >= DUE_SOON else "ok"
            result.append(
                {
                    "key": task.key,
                    "label": task.label,
                    "status": status,
                    "done": dt_util.utc_from_timestamp(since).isoformat(),
                    "days_left": None if days_left is None else round(days_left),
                    "cycles_left": cycles_left,
                }
            )
        if changed:
            self._save()
        return result

    @callback
    def upkeep_done(self, entry_id: str, appliance_type: str, key: str) -> bool:
        if not any(t.key == key for t in UPKEEP.get(appliance_type, ())):
            return False
        self._get(entry_id).setdefault("upkeep", {})[key] = dt_util.utcnow().timestamp()
        self._save()
        return True

    @callback
    def forget(self, entry_id: str) -> None:
        if self.data.pop(entry_id, None) is not None:
            self._save()


def dashboard_store(hass: HomeAssistant) -> DashboardStore | None:
    return hass.data.get(DATA_DASHBOARD)


def is_muted(hass: HomeAssistant, entry_id: str) -> bool:
    store = dashboard_store(hass)
    return store is not None and store.muted_until(entry_id) is not None
