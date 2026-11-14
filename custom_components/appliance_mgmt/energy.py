"""Energy used by one cycle (2.1.0).

Works with either kind of sensor:

* an energy sensor that counts up (kWh, Wh, MWh): the reading at the end
  minus the reading at the start;
* a power sensor (W, kW): the readings added up over the cycle, sampled on
  every change and at least once a minute (the coordinator's tick).

A sensor that is unavailable for part of the cycle simply adds nothing for
that time; a counter that resets mid-cycle gives no figure rather than a
wrong one.
"""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

ENERGY_UNITS = {"wh": 0.001, "kwh": 1.0, "mwh": 1000.0}
POWER_UNITS = {"w": 0.001, "kw": 1.0}
# Readings further apart than this are not joined (the sensor was away)
MAX_GAP_SECONDS = 15 * 60


def _reading(hass: HomeAssistant, entity_id: str) -> tuple[str, float] | None:
    """('energy', kWh) or ('power', kW) from the sensor, or None."""
    state = hass.states.get(entity_id)
    if state is None:
        return None
    unit = str(state.attributes.get("unit_of_measurement") or "").lower()
    try:
        value = float(state.state)
    except TypeError, ValueError:
        return None
    if unit in ENERGY_UNITS:
        return "energy", value * ENERGY_UNITS[unit]
    if unit in POWER_UNITS:
        return "power", value * POWER_UNITS[unit]
    return None


class EnergyMeter:
    """Counts one cycle's energy. State is saved with the coordinator."""

    def __init__(self, hass: HomeAssistant, entity_id: str) -> None:
        self.hass = hass
        self.entity_id = entity_id
        self.running = False
        self.start_kwh: float | None = None  # energy sensor
        self.kwh = 0.0  # power sensor: added up so far
        self.last: tuple[float, float] | None = None  # (timestamp, kW)

    def start(self) -> None:
        self.running = True
        self.kwh = 0.0
        self.start_kwh = None
        self.last = None
        self.sample()

    def sample(self) -> None:
        if not self.running:
            return
        reading = _reading(self.hass, self.entity_id)
        if reading is None:
            self.last = None
            return
        kind, value = reading
        if kind == "energy":
            if self.start_kwh is None:
                self.start_kwh = value
            return
        now = dt_util.utcnow().timestamp()
        if self.last is not None:
            seconds = now - self.last[0]
            if 0 < seconds <= MAX_GAP_SECONDS:
                self.kwh += max(0.0, self.last[1]) * seconds / 3600
        self.last = (now, value)

    def finish(self) -> float | None:
        """kWh used since start(), or None when it can't be told."""
        if not self.running:
            return None
        self.sample()
        self.running = False
        reading = _reading(self.hass, self.entity_id)
        if self.start_kwh is not None:
            if reading is None or reading[0] != "energy":
                return None
            used = reading[1] - self.start_kwh
            return round(used, 3) if used >= 0 else None
        if self.last is None and self.kwh == 0:
            return None
        return round(self.kwh, 3)

    def to_dict(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "start_kwh": self.start_kwh,
            "kwh": self.kwh,
            "last": list(self.last) if self.last else None,
        }

    def restore(self, data: dict[str, Any] | None) -> None:
        if not isinstance(data, dict):
            return
        self.running = bool(data.get("running"))
        start = data.get("start_kwh")
        self.start_kwh = float(start) if isinstance(start, (int, float)) else None
        self.kwh = float(data.get("kwh") or 0)
        last = data.get("last")
        self.last = (
            (float(last[0]), float(last[1]))
            if isinstance(last, list) and len(last) == 2
            else None
        )
