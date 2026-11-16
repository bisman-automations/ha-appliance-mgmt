/*
 * Appliance Mgmt sidebar dashboard.
 *
 * One plain web component, no build step. The backend sends each appliance's
 * entities, recent cycles, cycles per day, upkeep, maintenance alerts and
 * whether it's muted (appliance_mgmt/appliances); everything live (status,
 * time left, progress, temperatures, doors) comes straight from hass.states.
 * Each appliance is drawn here as an animated picture that follows its state
 * (2.1.0; uploaded pictures were removed). Fridge temperatures over the last
 * day and door opens today come from Home Assistant's history.
 */

const DOMAIN = "appliance_mgmt";
const DASH_KEY = "appliance-live-activity-dashboard"; // kept from before 2.0.0 so saved layouts stay
const OPEN_KEY = "appliance-live-activity-open";
const REFRESH_MS = 60000;
const TRENDS_MS = 5 * 60000;
const ACTIVE = ["running", "paused", "delayed"];
const LOAD_TYPES = ["washer", "dryer", "dishwasher"];

const SHOWS = [
  { id: "all", label: "All appliances" },
  { id: "active", label: "Running now" },
  { id: "attention", label: "Needs attention" },
  { id: "idle", label: "Not running" },
];
const SORTS = [
  { id: "activity", label: "Running, then recent" },
  { id: "name", label: "Name" },
  { id: "type", label: "Type" },
];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const minutesText = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

const shortMinutes = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

const clockText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const whenText = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const time = clockText(iso);
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

const sinceText = (iso) => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "" : minutesText((Date.now() - t) / 60000);
};

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const dayLabel = (date, style = "short") => {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  if (date === localDay(new Date())) return style === "short" ? "Today" : "Today";
  return style === "short"
    ? day.toLocaleDateString([], { weekday: "short" })
    : day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

const usable = (state) => state && !["unknown", "unavailable", ""].includes(state.state);

const kwhText = (kwh) => (kwh == null ? "" : `${Number(kwh) < 10 ? Number(kwh).toFixed(2) : Number(kwh).toFixed(1)} kWh`);

const moneyText = (value, currency) => {
  if (value == null || !currency) return "";
  try {
    return new Intl.NumberFormat([], { style: "currency", currency }).format(value);
  } catch (err) {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
};

// ------------------------------------------------------------------ drawings
// Each appliance is a small SVG (viewBox 200x150) that follows its state:
// the drum turns while a washer runs, the oven window glows, a fridge door
// swings open. Readings sit on the picture (time left on the display, the
// oven's temperature on the glass, fridge and freezer on their doors).

const screen = (x, y, w, text) =>
  `<rect class="screen" x="${x}" y="${y}" width="${w}" height="13" rx="3"/>
   <text class="screen-text" x="${x + w / 2}" y="${y + 10}" text-anchor="middle">${esc(text)}</text>`;

const DRAW = {
  washer(v) {
    return `
      <rect class="body" x="56" y="8" width="88" height="134" rx="10"/>
      <line class="seam" x1="56" y1="34" x2="144" y2="34"/>
      ${screen(63, 14, 40, v.display)}
      <circle class="knob" cx="128" cy="21" r="6"/>
      <g class="door${v.doorOpen ? " open" : ""}">
        <circle class="rim" cx="100" cy="88" r="38"/>
        <circle class="glass" cx="100" cy="88" r="30"/>
        ${v.running ? `<path class="water" d="M71 96 q7.25 -6 14.5 0 t14.5 0 t14.5 0 t14.5 0 a30 30 0 0 1 -58 0z"/>` : ""}
        <g class="${v.running ? "spin" : ""}">
          <circle class="cloth a" cx="90" cy="78" r="8"/>
          <circle class="cloth b" cx="111" cy="94" r="9"/>
          <circle class="cloth c" cx="104" cy="72" r="5"/>
        </g>
        <path class="shine" d="M80 70 a26 26 0 0 1 16 -10"/>
      </g>`;
  },
  dryer(v) {
    return `
      ${v.running ? `<g class="heat"><path d="M84 6 q4 -4 0 -8"/><path d="M100 6 q4 -4 0 -8"/><path d="M116 6 q4 -4 0 -8"/></g>` : ""}
      <rect class="body" x="56" y="8" width="88" height="134" rx="10"/>
      <line class="seam" x1="56" y1="34" x2="144" y2="34"/>
      ${screen(63, 14, 40, v.display)}
      <circle class="knob" cx="128" cy="21" r="6"/>
      <g class="door${v.doorOpen ? " open" : ""}">
        <circle class="rim" cx="100" cy="88" r="38"/>
        <circle class="glass" cx="100" cy="88" r="30"/>
        <g class="${v.running ? "spin slow" : ""}">
          <circle class="cloth a" cx="88" cy="100" r="9"/>
          <circle class="cloth b" cx="112" cy="98" r="8"/>
          <circle class="cloth c" cx="100" cy="68" r="7"/>
          <circle class="cloth a" cx="114" cy="78" r="5"/>
        </g>
        <path class="shine" d="M80 70 a26 26 0 0 1 16 -10"/>
      </g>`;
  },
  dishwasher(v) {
    const bubbles = v.running
      ? `<g class="bubbles">${[70, 88, 104, 122, 132].map((x, i) => `<circle cx="${x}" cy="40" r="${2 + (i % 3)}" style="animation-delay:${i * 0.45}s"/>`).join("")}</g>`
      : "";
    if (v.doorOpen) {
      return `
        <rect class="body" x="56" y="8" width="88" height="104" rx="8"/>
        <rect class="inside" x="62" y="14" width="76" height="94" rx="4"/>
        <g class="rack"><line x1="64" y1="46" x2="136" y2="46"/><line x1="64" y1="86" x2="136" y2="86"/>
          ${[70, 80, 90, 100, 110, 120, 130].map((x) => `<line x1="${x}" y1="86" x2="${x}" y2="72"/>`).join("")}
          ${[74, 90, 106, 122].map((x) => `<circle cx="${x}" cy="38" r="6"/>`).join("")}</g>
        <path class="body" d="M56 112 h88 l14 30 h-116z"/>
        <line class="seam" x1="60" y1="118" x2="140" y2="118"/>`;
    }
    return `
      <rect class="body" x="56" y="8" width="88" height="134" rx="8"/>
      <rect class="panel" x="56" y="8" width="88" height="22" rx="8"/>
      ${screen(63, 12, 40, v.display)}
      <circle class="knob small" cx="118" cy="19" r="3.5"/><circle class="knob small" cx="130" cy="19" r="3.5"/>
      <rect class="handle" x="80" y="38" width="40" height="5" rx="2.5"/>
      <rect class="door-panel" x="64" y="52" width="72" height="82" rx="4"/>
      ${bubbles}`;
  },
  oven(v) {
    const burner = (cx, cy, r) => `<ellipse class="burner${v.cooktopOn ? " hot" : ""}" cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.35}"/>`;
    return `
      <rect class="body" x="42" y="6" width="116" height="20" rx="5"/>
      ${[60, 76, 124, 140].map((x) => `<circle class="knob small" cx="${x}" cy="16" r="4"/>`).join("")}
      ${screen(86, 10, 28, v.display)}
      <rect class="top" x="38" y="26" width="124" height="16" rx="3"/>
      ${burner(70, 34, 13)}${burner(130, 34, 13)}
      <rect class="body" x="42" y="42" width="116" height="102" rx="6"/>
      <rect class="handle" x="62" y="50" width="76" height="5" rx="2.5"/>
      <g class="door${v.doorOpen ? " open" : ""}">
        <rect class="glass" x="58" y="62" width="84" height="56" rx="6"/>
        <rect class="glow${v.running ? " on" : ""}${v.preheating ? " pulse" : ""}" x="58" y="62" width="84" height="56" rx="6"/>
        ${v.running ? `<line class="element" x1="66" y1="112" x2="134" y2="112"/>` : ""}
        ${v.ovenTemp ? `<text class="reading" x="100" y="96" text-anchor="middle">${esc(v.ovenTemp)}</text>` : ""}
      </g>
      <rect class="drawer" x="50" y="124" width="100" height="14" rx="3"/>`;
  },
  refrigerator(v) {
    const open = v.doorOpen;
    const fridge = v.temps.fridge;
    const freezer = v.temps.freezer;
    return `
      <rect class="inside" x="58" y="6" width="84" height="88" rx="6"/>
      ${open ? `<g class="lit"><rect x="62" y="10" width="38" height="80" rx="3"/><line x1="62" y1="36" x2="100" y2="36"/><line x1="62" y1="62" x2="100" y2="62"/></g>` : ""}
      <g class="swing${open ? " open" : ""}">
        <rect class="body${fridge?.warm ? " warn" : ""}" x="58" y="6" width="42" height="88" rx="6"/>
        <rect class="handle" x="92" y="62" width="4" height="22" rx="2"/>
      </g>
      <rect class="body${fridge?.warm ? " warn" : ""}" x="100" y="6" width="42" height="88" rx="6"/>
      <rect class="handle" x="104" y="62" width="4" height="22" rx="2"/>
      ${fridge ? `<text class="reading small" x="124" y="52" text-anchor="middle">${esc(fridge.text)}</text>` : ""}
      <rect class="body${freezer?.warm ? " warn" : ""}" x="58" y="96" width="84" height="48" rx="6"/>
      <rect class="handle" x="80" y="104" width="40" height="4" rx="2"/>
      ${freezer ? `<text class="reading small" x="100" y="130" text-anchor="middle">${esc(freezer.text)}</text>` : ""}`;
  },
  door(v) {
    return `
      <rect class="frame" x="64" y="8" width="72" height="136" rx="3"/>
      <rect class="inside" x="70" y="14" width="60" height="130"/>
      <g class="swing${v.doorOpen ? " open wide" : ""}">
        <rect class="body" x="70" y="14" width="60" height="130" rx="2"/>
        <rect class="door-panel" x="78" y="24" width="44" height="46" rx="2"/>
        <rect class="door-panel" x="78" y="80" width="44" height="54" rx="2"/>
        <circle class="knob" cx="122" cy="80" r="4"/>
      </g>`;
  },
};

// The fridge or freezer temperature to show on a one-zone drawing.
const oneTemp = (v, freezer = true) => (freezer ? v.temps.freezer || v.temps.fridge : v.temps.fridge || v.temps.freezer);
const reading = (x, y, t) => (t ? `<text class="reading small" x="${x}" y="${y}" text-anchor="middle">${esc(t.text)}</text>` : "");
const warn = (t) => (t?.warm ? " warn" : "");

Object.assign(DRAW, {
  front_load: DRAW.washer,
  built_in: DRAW.dishwasher,
  range: DRAW.oven,
  french_door: DRAW.refrigerator,
  // A top-loading washer seen from a little above: a glass lid shows the drum.
  top_load(v) {
    const open = v.doorOpen;
    return `
      <rect class="panel" x="54" y="10" width="92" height="22" rx="5"/>
      ${screen(62, 15, 38, v.display)}
      <circle class="knob" cx="128" cy="21" r="6"/>
      <path class="top" d="M50 32 h100 l-6 18 h-88z"/>
      <rect class="body" x="56" y="50" width="88" height="92" rx="6"/>
      <line class="seam" x1="56" y1="132" x2="144" y2="132"/>
      ${open
        ? `<ellipse class="inside" cx="100" cy="41" rx="34" ry="7"/><path class="rim" d="M66 40 q34 -46 68 0" fill="none"/>
           <path class="glass lid-up" d="M70 39 q30 -38 60 0z"/>`
        : `<ellipse class="rim" cx="100" cy="41" rx="38" ry="8"/><ellipse class="glass" cx="100" cy="41" rx="32" ry="6"/>
           <g transform="translate(100 41) scale(1 .2) translate(-100 -41)"><g class="${v.running ? "spin top" : ""}">
             <circle class="cloth a" cx="88" cy="36" r="9"/><circle class="cloth b" cx="112" cy="46" r="10"/><circle class="cloth c" cx="102" cy="26" r="7"/></g></g>`}`;
  },
  // A washer with a dryer on top: the dryer's drum turns while it runs.
  stacked(v) {
    const drum = (cy, cls) => `<circle class="rim" cx="100" cy="${cy}" r="22"/><circle class="glass" cx="100" cy="${cy}" r="17"/>
      <g class="${cls}" style="transform-origin:100px ${cy}px"><circle class="cloth a" cx="94" cy="${cy + 5}" r="5"/><circle class="cloth b" cx="106" cy="${cy + 4}" r="5"/><circle class="cloth c" cx="100" cy="${cy - 7}" r="4"/></g>`;
    return `
      <rect class="body" x="64" y="4" width="72" height="70" rx="6"/>
      ${screen(70, 8, 34, v.display)}
      <g class="door${v.doorOpen ? " open" : ""}" style="transform-origin:78px 46px">${drum(46, v.running ? "spin slow" : "")}</g>
      <rect class="body" x="64" y="76" width="72" height="68" rx="6"/>
      <circle class="knob small" cx="124" cy="84" r="4"/>
      <circle class="rim" cx="100" cy="114" r="22"/><circle class="glass" cx="100" cy="114" r="17"/>`;
  },
  // Two dishwasher drawers; the top one slides out when open.
  drawers(v) {
    const bubbles = v.running
      ? `<g class="bubbles">${[76, 96, 116, 128].map((x, i) => `<circle cx="${x}" cy="30" r="${2 + (i % 2)}" style="animation-delay:${i * 0.5}s"/>`).join("")}</g>`
      : "";
    return `
      <rect class="frame" x="50" y="36" width="100" height="106" rx="4"/>
      <g class="slide${v.doorOpen ? " out" : ""}">
        <rect class="body" x="54" y="40" width="92" height="48" rx="5"/>
        <rect class="handle" x="78" y="46" width="44" height="5" rx="2.5"/>
        ${screen(80, 66, 40, v.display)}
      </g>
      <rect class="body" x="54" y="90" width="92" height="48" rx="5"/>
      <rect class="handle" x="78" y="96" width="44" height="5" rx="2.5"/>
      ${bubbles}`;
  },
  wall_oven(v) {
    return `
      <rect class="frame" x="48" y="4" width="104" height="140" rx="4"/>
      <rect class="panel" x="54" y="10" width="92" height="20" rx="4"/>
      ${screen(84, 13, 32, v.display)}
      <rect class="body" x="54" y="34" width="92" height="104" rx="5"/>
      <rect class="handle" x="68" y="42" width="64" height="5" rx="2.5"/>
      <g class="door${v.doorOpen ? " open" : ""}">
        <rect class="glass" x="66" y="56" width="68" height="70" rx="6"/>
        <rect class="glow${v.running ? " on" : ""}${v.preheating ? " pulse" : ""}" x="66" y="56" width="68" height="70" rx="6"/>
        ${v.running ? `<line class="element" x1="72" y1="120" x2="128" y2="120"/>` : ""}
        ${v.ovenTemp ? `<text class="reading" x="100" y="96" text-anchor="middle">${esc(v.ovenTemp)}</text>` : ""}
      </g>`;
  },
  // Two ovens; the top one shows what the appliance reports.
  double_wall_oven(v) {
    const oven = (y, lit) => `
      <rect class="body" x="54" y="${y}" width="92" height="56" rx="5"/>
      <rect class="handle" x="68" y="${y + 5}" width="64" height="4" rx="2"/>
      <rect class="glass" x="66" y="${y + 14}" width="68" height="36" rx="5"/>
      ${lit ? `<rect class="glow on${v.preheating ? " pulse" : ""}" x="66" y="${y + 14}" width="68" height="36" rx="5"/>` : ""}`;
    return `
      <rect class="frame" x="48" y="2" width="104" height="146" rx="4"/>
      <rect class="panel" x="54" y="6" width="92" height="20" rx="4"/>
      ${screen(84, 9, 32, v.display)}
      ${oven(28, v.running)}
      ${v.ovenTemp ? `<text class="reading" x="100" y="68" text-anchor="middle">${esc(v.ovenTemp)}</text>` : ""}
      ${oven(88, false)}`;
  },
  side_by_side(v) {
    const open = v.doorOpen;
    return `
      <rect class="inside" x="56" y="6" width="88" height="138" rx="6"/>
      ${open ? `<g class="lit"><rect x="104" y="12" width="36" height="126" rx="3"/><line x1="104" y1="48" x2="140" y2="48"/><line x1="104" y1="84" x2="140" y2="84"/><line x1="104" y1="116" x2="140" y2="116"/></g>` : ""}
      <rect class="body${warn(v.temps.freezer)}" x="56" y="6" width="42" height="138" rx="6"/>
      <rect class="dispenser" x="64" y="30" width="26" height="30" rx="3"/>
      <rect class="handle" x="92" y="64" width="4" height="40" rx="2"/>
      ${reading(77, 80, v.temps.freezer)}
      <g class="swing right${open ? " open" : ""}">
        <rect class="body${warn(v.temps.fridge)}" x="102" y="6" width="42" height="138" rx="6"/>
        <rect class="handle" x="104" y="64" width="4" height="40" rx="2"/>
        ${open ? "" : reading(124, 80, v.temps.fridge)}
      </g>`;
  },
  top_freezer(v) {
    const open = v.doorOpen;
    return `
      <rect class="inside" x="62" y="50" width="76" height="94" rx="6"/>
      ${open ? `<g class="lit"><rect x="66" y="54" width="68" height="86" rx="3"/><line x1="66" y1="82" x2="134" y2="82"/><line x1="66" y1="110" x2="134" y2="110"/></g>` : ""}
      <rect class="body${warn(v.temps.freezer)}" x="62" y="6" width="76" height="42" rx="6"/>
      <rect class="handle" x="68" y="30" width="4" height="14" rx="2"/>
      ${reading(104, 32, v.temps.freezer)}
      <g class="swing${open ? " open" : ""}" style="transform-origin:62px 96px">
        <rect class="body${warn(v.temps.fridge)}" x="62" y="50" width="76" height="94" rx="6"/>
        <rect class="handle" x="68" y="56" width="4" height="26" rx="2"/>
        ${reading(104, 100, v.temps.fridge)}
      </g>`;
  },
  bottom_freezer(v) {
    const open = v.doorOpen;
    return `
      <rect class="inside" x="62" y="6" width="76" height="90" rx="6"/>
      ${open ? `<g class="lit"><rect x="66" y="10" width="68" height="82" rx="3"/><line x1="66" y1="38" x2="134" y2="38"/><line x1="66" y1="64" x2="134" y2="64"/></g>` : ""}
      <g class="swing${open ? " open" : ""}" style="transform-origin:62px 50px">
        <rect class="body${warn(v.temps.fridge)}" x="62" y="6" width="76" height="90" rx="6"/>
        <rect class="handle" x="128" y="50" width="4" height="34" rx="2"/>
        ${reading(100, 54, v.temps.fridge)}
      </g>
      <rect class="body${warn(v.temps.freezer)}" x="62" y="98" width="76" height="46" rx="6"/>
      <rect class="handle" x="82" y="104" width="36" height="4" rx="2"/>
      ${reading(100, 130, v.temps.freezer)}`;
  },
  fridge_only(v) {
    return DRAW.upright_freezer(v, false);
  },
  // A tall single door; frost lines inside when it's a freezer.
  upright_freezer(v, frosty = true) {
    const open = v.doorOpen;
    const t = oneTemp(v, frosty);
    return `
      <rect class="inside${frosty ? " frost" : ""}" x="64" y="6" width="72" height="138" rx="6"/>
      ${open ? `<g class="${frosty ? "frosty" : "lit"}"><rect x="68" y="10" width="64" height="130" rx="3"/>${[38, 66, 94, 120].map((y) => `<line x1="68" y1="${y}" x2="132" y2="${y}"/>`).join("")}</g>` : ""}
      <g class="swing${open ? " open" : ""}" style="transform-origin:64px 75px">
        <rect class="body${warn(t)}" x="64" y="6" width="72" height="138" rx="6"/>
        <rect class="handle" x="126" y="44" width="4" height="40" rx="2"/>
        ${frosty ? `<path class="snow" d="M100 26 v12 M95 29 l10 6 M105 29 l-10 6"/>` : ""}
        ${reading(100, 78, t)}
      </g>`;
  },
  // A low, wide chest; the lid lifts when it's open.
  chest_freezer(v) {
    const open = v.doorOpen;
    const t = oneTemp(v);
    return `
      ${open ? `<g class="frosty"><rect x="34" y="66" width="132" height="12" rx="2"/></g>` : ""}
      <rect class="body${warn(t)}" x="30" y="70" width="140" height="70" rx="6"/>
      <g class="lid${open ? " open" : ""}"><rect class="body" x="28" y="58" width="144" height="14" rx="4"/><rect class="handle" x="84" y="66" width="32" height="4" rx="2"/></g>
      <rect class="vent" x="140" y="118" width="22" height="14" rx="2"/>
      ${reading(100, 112, t)}`;
  },
  mini_fridge(v) {
    const open = v.doorOpen;
    const t = oneTemp(v, false);
    return `
      <rect class="inside" x="66" y="56" width="68" height="86" rx="6"/>
      ${open ? `<g class="lit"><rect x="70" y="60" width="60" height="78" rx="3"/><line x1="70" y1="98" x2="130" y2="98"/></g>` : ""}
      <g class="swing${open ? " open" : ""}" style="transform-origin:66px 100px">
        <rect class="body${warn(t)}" x="66" y="56" width="68" height="86" rx="6"/>
        <rect class="handle" x="124" y="74" width="4" height="24" rx="2"/>
        ${reading(98, 104, t)}
      </g>`;
  },
  garage_door(v) {
    const open = v.doorOpen;
    return `
      <path class="frame" d="M30 54 L100 12 L170 54 V144 H30z"/>
      <rect class="inside" x="46" y="66" width="108" height="78"/>
      <g class="roll${open ? " open" : ""}">
        ${[66, 86, 106, 126].map((y) => `<rect class="body" x="46" y="${y}" width="108" height="19" rx="1"/>`).join("")}
        <rect class="glass" x="54" y="70" width="92" height="10" rx="1"/>
      </g>`;
  },
  sliding_door(v) {
    const open = v.doorOpen;
    return `
      <rect class="frame" x="34" y="14" width="132" height="130" rx="3"/>
      <rect class="inside" x="40" y="20" width="120" height="118"/>
      <rect class="pane" x="102" y="22" width="56" height="114" rx="2"/>
      <g class="slide-left${open ? " open" : ""}"><rect class="pane" x="42" y="22" width="58" height="114" rx="2"/><rect class="handle" x="92" y="70" width="4" height="22" rx="2"/></g>`;
  },
});

// Names for the drawing picker.
const DRAWING_NAMES = {
  washer: "Front load", front_load: "Front load", top_load: "Top load", stacked: "Washer and dryer stacked",
  dryer: "Front load", built_in: "Built-in", drawers: "Drawers", range: "Range", wall_oven: "Wall oven",
  double_wall_oven: "Double wall oven", french_door: "French door", side_by_side: "Side by side",
  top_freezer: "Top freezer", bottom_freezer: "Bottom freezer", fridge_only: "Fridge only",
  upright_freezer: "Upright freezer", chest_freezer: "Chest freezer", mini_fridge: "Mini fridge",
  door: "Door", garage_door: "Garage door", sliding_door: "Sliding door",
};

const ART_STYLES = `
  .art { width: 100%; height: 150px; overflow: visible; }
  .art.mini { width: 72px; height: 54px; }
  .art * { transform-box: view-box; }
  .art .body, .art .frame { fill: color-mix(in srgb, var(--c) 10%, var(--ala-card)); stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 2; }
  .art .body.warn { stroke: var(--error-color, #db4437); stroke-width: 2.5; }
  .art .panel, .art .top { fill: color-mix(in srgb, var(--c) 22%, var(--ala-card)); stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 2; }
  .art .rack line { stroke: #9aa5ad; stroke-width: 1.5; }
  .art .rack circle { fill: none; stroke: #9aa5ad; stroke-width: 1.5; }
  .art .seam { stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 1.5; }
  .art .screen { fill: #1d2429; }
  .art .screen-text { fill: #8ef0b0; font: 600 9px/1 ui-monospace, Menlo, monospace; }
  .art .knob { fill: color-mix(in srgb, var(--c) 35%, var(--ala-card)); stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 1.5; }
  .art .handle { fill: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); }
  .art .door-panel, .art .drawer { fill: none; stroke: color-mix(in srgb, var(--c) 30%, var(--ala-card)); stroke-width: 1.5; }
  .art .rim { fill: color-mix(in srgb, var(--c) 30%, var(--ala-card)); stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 2; }
  .art .glass { fill: color-mix(in srgb, var(--c) 18%, #26323a); }
  .art .water { fill: color-mix(in srgb, #4fc3f7 70%, transparent); }
  .art .cloth.a { fill: color-mix(in srgb, var(--c) 70%, #fff); }
  .art .cloth.b { fill: #ffb74d; }
  .art .cloth.c { fill: #e57373; }
  .art .shine { fill: none; stroke: rgba(255,255,255,.45); stroke-width: 3; stroke-linecap: round; }
  .art .inside { fill: color-mix(in srgb, var(--c) 6%, #2b3238); }
  .art .lit rect { fill: #fff8dc; }
  .art .lit line { stroke: #d6cfb4; stroke-width: 2; }
  .art .reading { fill: #fff; font: 600 15px/1 var(--ha-font-family-body, Roboto, sans-serif); paint-order: stroke; stroke: rgba(0,0,0,.35); stroke-width: 3px; }
  .art .body + .reading, .art .reading.small { font-size: 11px; fill: var(--primary-text-color, #212121); stroke: none; }
  .art .burner { fill: none; stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 2; }
  .art .burner.hot { stroke: #ff5722; filter: drop-shadow(0 0 3px #ff7043); animation: pulse 1.6s ease-in-out infinite; }
  .art .glow { fill: #ff8f00; opacity: 0; transition: opacity .6s; }
  .art .glow.on { opacity: .55; }
  .art .glow.pulse { animation: glow 2s ease-in-out infinite; }
  .art .element { stroke: #ff3d00; stroke-width: 3; stroke-linecap: round; }
  .art .spin { animation: spin 1.4s linear infinite; transform-origin: 100px 88px; }
  .art .spin.slow { animation-duration: 3s; }
  .art .door { transition: transform .5s ease; transform-origin: 62px 88px; }
  .art .door.open { transform: scaleX(.22); }
  .art .swing { transition: transform .5s ease; transform-origin: 58px 50px; }
  .art .swing.open { transform: scaleX(.18); }
  .art .swing.wide { transform-origin: 70px 80px; }
  .art .heat path { fill: none; stroke: #ff8a65; stroke-width: 2; stroke-linecap: round; animation: rise 1.8s ease-in-out infinite; }
  .art .heat path:nth-child(2) { animation-delay: .6s; }
  .art .heat path:nth-child(3) { animation-delay: 1.2s; }
  .art .bubbles circle { fill: color-mix(in srgb, #4fc3f7 60%, transparent); animation: bubble 2.4s ease-in infinite; opacity: 0; }
  .art .spin.top { transform-origin: 100px 41px; }
  .art .lid-up { opacity: .7; }
  .art .dispenser { fill: color-mix(in srgb, var(--c) 25%, #26323a); }
  .art .frost, .art .frosty rect { fill: #e8f4fb; }
  .art .frosty line { stroke: #b9d7e8; stroke-width: 2; }
  .art .snow { stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 1.5; stroke-linecap: round; fill: none; }
  .art .vent { fill: none; stroke: color-mix(in srgb, var(--c) 30%, var(--ala-card)); stroke-width: 1.5; }
  .art .pane { fill: color-mix(in srgb, #9ad0f5 35%, var(--ala-card)); stroke: color-mix(in srgb, var(--c) 45%, var(--primary-text-color, #212121)); stroke-width: 2; }
  .art .swing.right { transform-origin: 144px 75px; }
  .art .slide, .art .roll, .art .slide-left, .art .lid { transition: transform .5s ease; }
  .art .slide.out { transform: translateY(-26px); }
  .art .roll { transform-origin: 100px 66px; }
  .art .roll.open { transform: scaleY(.12); }
  .art .slide-left.open { transform: translateX(58px); }
  .art .lid { transform-origin: 28px 65px; }
  .art .lid.open { transform: rotate(-38deg); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes glow { 0%, 100% { opacity: .25; } 50% { opacity: .7; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
  @keyframes rise { 0% { transform: translateY(6px); opacity: 0; } 50% { opacity: 1; } 100% { transform: translateY(-4px); opacity: 0; } }
  @keyframes bubble { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(-34px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .art .spin, .art .glow.pulse, .art .burner.hot, .art .heat path, .art .bubbles circle { animation: none; }
    .art .bubbles circle, .art .heat path { opacity: .8; }
  }
`;

const STYLES = `
  :host {
    display: block; min-height: 100%;
    background: var(--primary-background-color, #fafafa);
    color: var(--primary-text-color, #212121);
    font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, sans-serif));
    --ala-card: var(--card-background-color, #fff);
    --ala-divider: var(--divider-color, #e0e0e0);
    --ala-muted: var(--secondary-text-color, #727272);
    --ala-radius: var(--ha-card-border-radius, 12px);
  }
  .toolbar {
    display: flex; align-items: center; gap: 4px;
    height: var(--header-height, 56px); padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, var(--text-primary-color, #fff));
    position: sticky; top: 0; z-index: 2;
  }
  .title { font-size: 20px; font-weight: 400; margin-left: 4px; }
  main { max-width: 1200px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
  .tools { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 16px; }
  .tools[hidden] { display: none; }
  .tools label { display: inline-flex; align-items: center; gap: 8px; }
  input[type="text"], select {
    font: inherit; font-size: 15px; padding: 9px 12px; min-height: 42px; box-sizing: border-box;
    border-radius: 8px; border: 1px solid var(--ala-divider);
    background: var(--ala-card); color: inherit;
  }
  #search { flex: 1; min-width: 200px; max-width: 420px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .card {
    background: var(--ala-card); border: 1px solid var(--ala-divider); border-radius: var(--ala-radius);
    box-shadow: var(--ha-card-box-shadow, none); display: flex; flex-direction: column; position: relative;
  }
  .pic {
    position: relative; height: 170px; display: flex; align-items: center; justify-content: center;
    border-radius: var(--ala-radius) var(--ala-radius) 0 0; overflow: hidden;
    background: linear-gradient(135deg, color-mix(in srgb, var(--c) 24%, var(--ala-card)), color-mix(in srgb, var(--c) 6%, var(--ala-card)));
  }
  .chip, .badge {
    position: absolute; top: 10px; padding: 4px 10px; border-radius: 999px;
    font-size: 13px; font-weight: 500; background: rgba(0,0,0,.62); color: #fff;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .chip { left: 10px; }
  .badge { right: 10px; }
  .badge.alarm { background: var(--error-color, #db4437); }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: #9e9e9e; }
  .chip.running .dot { background: #4caf50; }
  .chip.paused .dot, .chip.delayed .dot { background: #ff9800; }
  .chip.complete .dot { background: #03a9f4; }
  .chip.open .dot { background: #ff9800; }
  .body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .head .who { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
  .name { font-size: 18px; font-weight: 500; color: inherit; text-decoration: none; }
  .name:hover { text-decoration: underline; }
  .type { font-size: 13px; color: var(--ala-muted); white-space: nowrap; }
  .more { min-height: 36px; min-width: 36px; padding: 0; border: none; font-size: 22px; line-height: 1; border-radius: 50%; }
  .menu-pop {
    position: absolute; right: 12px; top: 214px; z-index: 3; min-width: 210px;
    background: var(--ala-card); border: 1px solid var(--ala-divider); border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 6px; display: flex; flex-direction: column;
  }
  .menu-pop button { border: none; border-radius: 6px; text-align: left; min-height: 40px; }
  .menu-pop .pick { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; padding: 4px; max-width: 300px; }
  .menu-pop .pick button { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; min-height: 0; font-size: 12px; text-align: center; border: 1px solid var(--ala-divider); }
  .menu-pop .pick button.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); }
  .menu-pop .pick svg { width: 72px; height: 54px; }
  .menu-pop button:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
  .now { font-size: 15px; }
  .waiting {
    font-size: 14px; padding: 8px 10px; border-radius: 8px; display: flex; justify-content: space-between; gap: 8px;
    background: color-mix(in srgb, var(--info-color, #03a9f4) 14%, transparent);
  }
  .waiting span:last-child { color: var(--ala-muted); white-space: nowrap; }
  .bar { height: 8px; border-radius: 4px; background: var(--ala-divider); overflow: hidden; }
  .bar > div { height: 100%; background: var(--c); transition: width .6s ease; }
  .times { display: flex; justify-content: space-between; font-size: 13px; color: var(--ala-muted); }
  .alerts { display: flex; flex-direction: column; gap: 6px; }
  .alert {
    font-size: 14px; padding: 8px 10px; border-radius: 8px;
    background: color-mix(in srgb, var(--warning-color, #ff9800) 14%, transparent);
  }
  .alert.bad { background: color-mix(in srgb, var(--error-color, #db4437) 16%, transparent); }
  .upkeep { display: flex; flex-wrap: wrap; gap: 6px; }
  .task {
    display: inline-flex; align-items: center; gap: 8px; font-size: 13px; padding: 3px 4px 3px 10px; border-radius: 999px;
    background: color-mix(in srgb, var(--warning-color, #ff9800) 14%, transparent);
  }
  .task.due { background: color-mix(in srgb, var(--error-color, #db4437) 16%, transparent); }
  .task button { min-height: 28px; padding: 2px 10px; font-size: 13px; background: var(--ala-card); }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .fact { font-size: 12px; color: var(--ala-muted); }
  .fact b { display: block; font-size: 15px; font-weight: 500; color: var(--primary-text-color); margin-top: 2px; }
  .section-title { font-size: 12px; color: var(--ala-muted); display: flex; justify-content: space-between; }
  .trend { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 8px; font-size: 13px; }
  .trend svg { width: 100%; height: 34px; }
  .trend .line { fill: none; stroke: var(--c); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .trend .limit { stroke: var(--error-color, #db4437); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .trend .range { color: var(--ala-muted); white-space: nowrap; }
  .week { display: flex; gap: 6px; align-items: flex-end; height: 74px; }
  .week button {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 3px;
    height: 100%; min-height: 0; padding: 0; border: none; border-radius: 6px; font-size: 11px; color: var(--ala-muted);
  }
  .week button .n { font-size: 11px; color: var(--primary-text-color); min-height: 13px; }
  .week button .col { width: 70%; max-width: 26px; border-radius: 4px 4px 2px 2px; background: color-mix(in srgb, var(--c) 70%, transparent); }
  .week button .col.zero { background: var(--ala-divider); }
  .week button.on { background: color-mix(in srgb, var(--c) 12%, transparent); color: var(--primary-text-color); font-weight: 500; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 4px; }
  button {
    font: inherit; font-size: 14px; cursor: pointer; min-height: 38px; padding: 6px 14px;
    border-radius: 19px; border: 1px solid var(--ala-divider); background: transparent; color: inherit;
  }
  button:hover:not(:disabled) { border-color: var(--primary-color); }
  button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  .cycles { margin: 0; padding: 0; list-style: none; font-size: 14px; }
  .cycles li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-top: 1px solid var(--ala-divider); }
  .cycles li span:last-child { color: var(--ala-muted); text-align: right; }
  .note { font-size: 13px; min-height: 18px; }
  .note.error { color: var(--error-color, #db4437); }
  .empty { max-width: 520px; margin: 48px auto; text-align: center; color: var(--ala-muted); line-height: 1.5; }
  .error-box { color: var(--error-color, #db4437); margin-bottom: 12px; }
  @media (max-width: 420px) {
    main { padding: 12px; }
    .grid { grid-template-columns: 1fr; }
  }
  ${ART_STYLES}
`;


// Whether the page can't be seen (another tab, or a screen that's off).
function pageHidden() {
  return typeof document !== "undefined" && Boolean(document.hidden);
}

// Every entity id an appliance list mentions, for watching their states.
function entityIds(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^[a-z_]+\.[a-z0-9_]+$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => entityIds(v, found));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => entityIds(v, found));
  }
  return [...found];
}

class ApplianceMgmtPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._appliances = null;
    this._isAdmin = false;
    this._error = "";
    this._notes = {};
    this._busy = new Set();
    this._lastGrid = "";
    this._statusKey = "";
    this._dash = { show: "all", sort: "activity", query: "" };
    this._open = new Set();
    this._day = {}; // entry id -> picked day in the week chart
    this._menu = null; // entry id whose ⋯ menu is open
    this._trends = {}; // entry id -> { zones: {entity_id: [[t, v]]}, doors: {opens, seconds} }
    try {
      const saved = JSON.parse(localStorage.getItem(DASH_KEY) || "{}");
      if (SHOWS.some((o) => o.id === saved.show)) this._dash.show = saved.show;
      if (SORTS.some((o) => o.id === saved.sort)) this._dash.sort = saved.sort;
      this._open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"));
    } catch (err) {
      /* storage unavailable: the defaults */
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._build();
    if (first) this._load();
    const button = this.shadowRoot.querySelector(".menu ha-menu-button");
    if (button) button.hass = hass;
    // Home Assistant sends a new hass on every state change in the house;
    // the cards are drawn again only when one of their own entities changed.
    if (!first && !this._ownChanged()) return;
    this._watchStatuses();
    this._render();
  }

  // Whether a state the cards show changed since the last look (or nobody
  // can see the page: it's drawn once when seen again).
  _ownChanged() {
    if (pageHidden()) {
      this._staleView = true;
      this._whenVisible();
      return false;
    }
    if (!this._appliances) return true;
    if (!this._ownIds) this._ownIds = entityIds(this._appliances);
    const states = this._hass.states;
    const now = this._ownIds.map((id) => states[id]);
    const before = this._ownStates;
    this._ownStates = now;
    const changed = this._staleView || !before || before.length !== now.length || now.some((s, i) => s !== before[i]);
    this._staleView = false;
    return changed;
  }

  // Catch up once when a hidden page is seen again.
  _whenVisible() {
    if (this._onVisible) return;
    this._onVisible = () => {
      if (pageHidden()) return;
      if (this._staleLoad) this._load();
      if (this._staleView) {
        this._staleView = false;
        this._watchStatuses();
        this._render();
      }
    };
    document.addEventListener("visibilitychange", this._onVisible);
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._render(true);
  }

  set panel(panel) {
    this._panel = panel;
  }

  connectedCallback() {
    this._timer = setInterval(() => this._load(), REFRESH_MS);
    this._trendTimer = setInterval(() => this._loadTrends(), TRENDS_MS);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearInterval(this._trendTimer);
    if (this._onVisible) {
      document.removeEventListener("visibilitychange", this._onVisible);
      this._onVisible = null;
    }
  }

  async _load() {
    if (!this._hass) return;
    if (pageHidden()) {
      // Nobody's looking: load (and read history) once when seen again.
      this._staleLoad = true;
      this._whenVisible();
      return;
    }
    this._staleLoad = false;
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/appliances` });
      const firstLoad = this._appliances === null;
      this._appliances = res.appliances;
      this._ownIds = null; // the entities to watch come from the list
      this._isAdmin = !!res.is_admin;
      this._error = "";
      if (firstLoad || this._trendsStale) {
        this._trendsStale = false;
        this._loadTrends();
      }
    } catch (err) {
      this._error = `Couldn't load the appliances: ${err?.message || err}`;
    }
    this._render(true);
  }

  // Fridge temperatures over the last day and door opens today, from history.
  async _loadTrends() {
    if (!this._hass || !this._appliances) return;
    if (pageHidden()) {
      this._trendsStale = true; // read once the page is seen and loaded again
      return;
    }
    const wanted = this._appliances.filter((a) => a.temperatures.length || a.door_entities.length);
    if (!wanted.length) return;
    const now = new Date();
    const start = new Date(now.getTime() - 86400000);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const ids = [...new Set(wanted.flatMap((a) => [...a.temperatures.map((t) => t.entity_id), ...a.door_entities]))];
    let history;
    try {
      history = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
    } catch (err) {
      return; // history not available (recorder off): the card just leaves trends out
    }
    const points = (id) =>
      (history?.[id] || [])
        .map((p) => [Number(p.lu ?? p.lc), p.s])
        .filter(([t]) => Number.isFinite(t));
    for (const a of wanted) {
      const zones = {};
      for (const t of a.temperatures) {
        zones[t.entity_id] = points(t.entity_id)
          .map(([time, s]) => [time, Number(s)])
          .filter(([, v]) => Number.isFinite(v));
      }
      let opens = 0;
      let seconds = 0;
      for (const id of a.door_entities) {
        const list = points(id);
        list.forEach(([time, s], i) => {
          if (s !== "on") return;
          const end = i + 1 < list.length ? list[i + 1][0] : now.getTime() / 1000;
          if (end <= midnight) return;
          const prev = i > 0 ? list[i - 1][1] : null;
          if (time >= midnight && prev !== "on") opens += 1;
          seconds += end - Math.max(time, midnight);
        });
      }
      this._trends[a.entry_id] = { zones, opens, seconds };
    }
    this._render(true);
  }

  // A cycle starting or ending changes recent cycles and alerts: reload them.
  _watchStatuses() {
    if (!this._appliances) return;
    const key = this._appliances.map((a) => this._hass.states[a.entities.status]?.state).join("|");
    if (this._statusKey && key !== this._statusKey) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = setTimeout(() => this._load(), 1500);
    }
    this._statusKey = key;
  }

  _saveDash() {
    try {
      localStorage.setItem(DASH_KEY, JSON.stringify({ show: this._dash.show, sort: this._dash.sort }));
      localStorage.setItem(OPEN_KEY, JSON.stringify([...this._open]));
    } catch (err) {
      /* not remembered, still works */
    }
  }

  _build() {
    if (this._built) return;
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="toolbar"><div class="menu"></div><div class="title">Appliance Mgmt</div></div>
      <main>
        <div class="error-box" role="alert"></div>
        <div class="tools" hidden>
          <input type="text" id="search" placeholder="Search appliances" aria-label="Search appliances" autocomplete="off">
          <label>Show <select id="show">${SHOWS.map((o) => `<option value="${o.id}">${o.label}</option>`).join("")}</select></label>
          <label>Sort by <select id="sort">${SORTS.map((o) => `<option value="${o.id}">${o.label}</option>`).join("")}</select></label>
        </div>
        <div class="list"></div>
      </main>`;
    const root = this.shadowRoot;
    root.getElementById("show").value = this._dash.show;
    root.getElementById("sort").value = this._dash.sort;
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("change", (ev) => this._onChange(ev));
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this._menu) {
        this._menu = null;
        this._render(true);
      }
    });
    root.getElementById("search").addEventListener("input", (ev) => {
      this._dash.query = ev.target.value.trim();
      this._render(true);
    });
  }

  // ------------------------------------------------------------- state

  _status(a) {
    return this._hass.states[a.entities.status]?.state || "idle";
  }

  _attrs(a) {
    return this._hass.states[a.entities.status]?.attributes || {};
  }

  _isActive(a) {
    return ACTIVE.includes(this._status(a));
  }

  _doorOpen(a) {
    if (a.door) return this._status(a) === "running";
    return a.door_entity ? this._hass.states[a.door_entity]?.state === "on" : false;
  }

  _waiting(a) {
    if (a.waiting) return a.waiting;
    if (LOAD_TYPES.includes(a.type) && this._status(a) === "complete") {
      return { text: "Done, still full", since: a.recent_cycles[0]?.finished || null };
    }
    return null;
  }

  // Door open, a leak or other alert, a finished load waiting, upkeep due.
  _needsAttention(a) {
    const attrs = this._attrs(a);
    return a.alerts.length > 0 || attrs.leak_detected || attrs.vent_blocked || attrs.cooktop_on
      || (a.door && this._status(a) === "running") || !!this._waiting(a)
      || a.upkeep.some((t) => t.status === "due");
  }

  _lastFinished(a) {
    return a.recent_cycles[0] ? new Date(a.recent_cycles[0].finished).getTime() : 0;
  }

  _shown() {
    const d = this._dash;
    const q = d.query.toLowerCase();
    const shows = {
      all: () => true,
      active: (a) => this._isActive(a) || (a.door && this._status(a) === "running"),
      attention: (a) => this._needsAttention(a),
      idle: (a) => !this._isActive(a),
    };
    const byName = (x, y) => x.name.localeCompare(y.name);
    const rank = (a) => (this._isActive(a) && !a.door ? 0 : this._needsAttention(a) ? 1 : 2);
    const sorts = {
      activity: (x, y) => rank(x) - rank(y) || this._lastFinished(y) - this._lastFinished(x) || byName(x, y),
      name: byName,
      type: (x, y) => x.type_name.localeCompare(y.type_name) || byName(x, y),
    };
    return this._appliances
      .filter((a) => (shows[d.show] || shows.all)(a))
      .filter((a) => !q || [a.name, a.type_name].some((v) => String(v).toLowerCase().includes(q)))
      .sort(sorts[d.sort] || sorts.activity);
  }

  _number(entityId) {
    const s = entityId && this._hass.states[entityId];
    if (!usable(s)) return null;
    const value = Number(s.state);
    return Number.isFinite(value) ? value : null;
  }

  // The oven's set temperature: a number or sensor's state, or a
  // thermostat-like entity's temperature attribute.
  _target(a) {
    const s = a.target_entity && this._hass.states[a.target_entity];
    if (!s) return null;
    const value = Number(s.attributes?.temperature ?? s.state);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  _temp(entityId, limit) {
    const s = this._hass.states[entityId];
    if (!usable(s)) return null;
    const value = Number(s.state);
    if (!Number.isFinite(value)) return null;
    const unit = s.attributes.unit_of_measurement || "°";
    return { value, unit, text: `${Math.round(value)}${unit}`, warm: limit != null && value > limit };
  }

  // What the drawing shows.
  _view(a) {
    const st = this._hass.states;
    const status = this._status(a);
    const attrs = this._attrs(a);
    const running = status === "running" && !a.door;
    const left = st[a.entities.time_left];
    let display = "--";
    if (status === "running" || status === "paused") {
      display = usable(left) && Number(left.state) > 0 ? shortMinutes(left.state) : status === "paused" ? "Pause" : "On";
    } else if (status === "delayed") display = "Delay";
    else if (status === "complete") display = "Done";
    const temps = {};
    for (const t of a.temperatures) temps[t.zone] = this._temp(t.entity_id, t.limit);
    let ovenTemp = "";
    if (a.type === "oven" && (status === "running" || status === "paused")) {
      const temp = this._number(a.temperature_entity) ?? this._target(a);
      if (temp != null && temp > 0) ovenTemp = `${Math.round(temp)}°`;
    }
    return {
      status,
      running,
      display,
      doorOpen: this._doorOpen(a),
      temps,
      ovenTemp,
      preheating: String(attrs.phase || "").toLowerCase() === "preheating",
      cooktopOn: !!attrs.cooktop_on,
    };
  }

  _drawing(a, v) {
    const style = a.drawing || a.type;
    // The dryer's "front_load" is its own drawing, not the washer's.
    const draw = (a.type === "dryer" && style === "front_load" ? DRAW.dryer : DRAW[style]) || DRAW[a.type] || DRAW.door;
    return `<svg class="art" viewBox="0 0 200 150" role="img" aria-label="${esc(`${a.type_name}: ${v.doorOpen ? "door open" : v.status}`)}">${draw(v)}</svg>`;
  }

  // ------------------------------------------------------------- render

  _render(force = false) {
    if (!this._built || !this._hass) return;
    const menu = this.shadowRoot.querySelector(".menu");
    let button = menu.querySelector("ha-menu-button");
    if (!button) {
      button = document.createElement("ha-menu-button");
      menu.appendChild(button);
    }
    button.hass = this._hass;
    button.narrow = this._narrow;

    this.shadowRoot.querySelector(".error-box").textContent = this._error;
    const list = this.shadowRoot.querySelector(".list");
    const tools = this.shadowRoot.querySelector(".tools");
    let html;
    if (this._appliances === null) {
      html = this._error ? "" : `<div class="empty">Loading your appliances…</div>`;
    } else if (!this._appliances.length) {
      html = `<div class="empty"><h2>No appliances yet</h2><p>Add an appliance under Settings → Devices &amp; services → Appliance Mgmt.</p></div>`;
    } else {
      const shown = this._shown();
      html = shown.length
        ? `<div class="grid">${shown.map((a) => this._card(a)).join("")}</div>`
        : `<div class="empty"><h2>No appliances match</h2><p><button data-reset>Show all appliances</button></p></div>`;
    }
    tools.hidden = !this._appliances || this._appliances.length < 2;
    // Redraw only when something shown changed, so buttons and animations don't flicker.
    if (force || html !== this._lastGrid) {
      this._lastGrid = html;
      list.innerHTML = html;
    }
  }

  _statusLine(a) {
    const status = this._status(a);
    const attrs = this._attrs(a);
    if (a.door) {
      if (status === "running") {
        const open = attrs.open_minutes;
        return { chip: "Open", cls: "open", now: open ? `Open for ${minutesText(open)}` : "Open" };
      }
      return { chip: "Closed", cls: "idle", now: "Closed" };
    }
    const phase = attrs.phase && !["idle", "complete"].includes(String(attrs.phase).toLowerCase()) ? attrs.phase : "";
    switch (status) {
      case "running":
        if (a.type === "oven" && String(attrs.phase || "").toLowerCase() === "preheating") {
          const target = this._target(a);
          return { chip: "Preheating", cls: "running", now: target ? `Preheating to ${Math.round(target)}°` : "Preheating" };
        }
        return { chip: "Running", cls: "running", now: phase || "Running" };
      case "paused":
        return { chip: "Paused", cls: "paused", now: phase ? `Paused · ${phase}` : "Paused" };
      case "delayed":
        return { chip: "Delayed start", cls: "delayed", now: attrs.starts_at ? `Starts at ${clockText(attrs.starts_at)}` : "Waiting to start" };
      case "complete":
        return { chip: "Done", cls: "complete", now: a.recent_cycles[0] ? `Finished ${whenText(a.recent_cycles[0].finished).replace(/^Today /, "at ")}` : "Finished" };
      default:
        return { chip: "Idle", cls: "idle", now: a.recent_cycles[0] ? `Last run ${whenText(a.recent_cycles[0].finished)}` : "Idle" };
    }
  }

  _progress(a) {
    const st = this._hass.states;
    if (!["running", "paused"].includes(this._status(a)) || a.door) return "";
    let pct = Number(st[a.entities.progress]?.state);
    const left = st[a.entities.time_left];
    const finish = st[a.entities.finishes_at];
    const leftMinutes = usable(left) ? Number(left.state) : NaN;
    if (!(Number.isFinite(pct) && pct > 0) && Number.isFinite(leftMinutes)) {
      // No progress from the appliance: estimate from its usual cycle length.
      const usual = Number(st[a.entities.average_cycle]?.state);
      if (Number.isFinite(usual) && usual > 0) pct = Math.max(2, Math.min(98, 100 * (1 - leftMinutes / Math.max(usual, leftMinutes))));
    }
    const parts = [];
    if (Number.isFinite(leftMinutes) && leftMinutes > 0) parts.push(`<span>${minutesText(leftMinutes)} left</span>`);
    if (usable(finish)) parts.push(`<span>Done at ${clockText(finish.state)}</span>`);
    const bar = Number.isFinite(pct) && pct > 0
      ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(a.name)} progress"><div style="width:${Math.min(100, pct)}%"></div></div>`
      : "";
    return `${bar}${parts.length ? `<div class="times">${parts.join("")}</div>` : ""}`;
  }

  _waitingRow(a) {
    const w = this._waiting(a);
    if (!w) return "";
    return `<div class="waiting" role="status"><span>${esc(w.text)}</span>${w.since ? `<span>${esc(sinceText(w.since))}</span>` : ""}</div>`;
  }

  _alerts(a) {
    const attrs = this._attrs(a);
    const items = [];
    if (attrs.leak_detected) items.push(["Water leak detected", true]);
    if (attrs.vent_blocked) items.push(["Dryer vent may be blocked", false]);
    if (attrs.cooktop_on) items.push([`Cooktop on${attrs.cooktop_on_minutes ? ` for ${minutesText(attrs.cooktop_on_minutes)}` : ""}`, false]);
    if (attrs.probe_temperature) items.push([`Probe ${attrs.probe_temperature}°${attrs.probe_target ? ` of ${attrs.probe_target}°` : ""}`, false]);
    if (attrs.kitchen_timer_minutes) items.push([`Kitchen timer: ${minutesText(attrs.kitchen_timer_minutes)}`, false]);
    if (attrs.snoozed_until) items.push([`Reminders snoozed until ${clockText(attrs.snoozed_until)}`, false]);
    for (const text of a.alerts) items.push([text, /leak|warm/i.test(text)]);
    if (!items.length) return "";
    return `<div class="alerts">${items.map(([t, bad]) => `<div class="alert${bad ? " bad" : ""}">${esc(t)}</div>`).join("")}</div>`;
  }

  _upkeep(a) {
    const tasks = a.upkeep.filter((t) => t.status !== "ok");
    if (!tasks.length) return "";
    const busy = this._busy.has(a.entry_id);
    return `<div class="upkeep">${tasks.map((t) => {
      const when = t.status === "due" ? "due" : t.days_left != null && (t.cycles_left == null || t.days_left <= t.cycles_left)
        ? `in ${Math.max(0, t.days_left)} ${t.days_left === 1 ? "day" : "days"}`
        : `in ${Math.max(0, t.cycles_left)} ${t.cycles_left === 1 ? "cycle" : "cycles"}`;
      return `<span class="task ${t.status}">${esc(t.label)} · ${esc(when)}<button data-upkeep="${esc(t.key)}" data-id="${esc(a.entry_id)}" ${busy ? "disabled" : ""} aria-label="${esc(`${t.label}: done`)}">Done</button></span>`;
    }).join("")}</div>`;
  }

  _energyStats(a) {
    const withKwh = a.recent_cycles.filter((c) => c.kwh != null).slice(0, 10);
    if (!withKwh.length) return null;
    const avg = withKwh.reduce((sum, c) => sum + c.kwh, 0) / withKwh.length;
    const costs = withKwh.filter((c) => c.cost != null);
    const cost = costs.length ? costs.reduce((sum, c) => sum + c.cost, 0) / costs.length : null;
    return { avg, cost };
  }

  _facts(a) {
    const st = this._hass.states;
    const facts = [];
    if (a.type !== "refrigerator") {
      for (const t of a.temperatures) {
        const temp = this._temp(t.entity_id, t.limit);
        if (temp) facts.push([t.zone === "fridge" ? "Fridge" : "Freezer", temp.text]);
      }
    }
    const trend = this._trends[a.entry_id];
    if (a.door_entities.length && trend) {
      facts.push(["Opened today", `${trend.opens} ${trend.opens === 1 ? "time" : "times"}`]);
      facts.push(["Open today", minutesText(trend.seconds / 60)]);
    }
    if (!a.door) {
      const week = st[a.entities.cycles_week];
      if (usable(week)) facts.push(["This week", `${week.state} ${Number(week.state) === 1 ? "cycle" : "cycles"}`]);
      const avg = st[a.entities.average_cycle];
      if (usable(avg) && Number(avg.state) > 0) facts.push(["Usual cycle", minutesText(avg.state)]);
      const energy = this._energyStats(a);
      if (energy) {
        facts.push(["Energy per cycle", kwhText(energy.avg)]);
        if (energy.cost != null) facts.push(["Cost per cycle", moneyText(energy.cost, a.currency)]);
      } else if (a.recent_cycles[0]) facts.push(["Last cycle", minutesText(a.recent_cycles[0].minutes)]);
    }
    if (!facts.length) return "";
    return `<div class="facts">${facts.map(([k, v]) => `<div class="fact">${esc(k)}<b>${esc(v)}</b></div>`).join("")}</div>`;
  }

  // Fridge and freezer over the last 24 hours.
  _trend(a) {
    const trend = this._trends[a.entry_id];
    if (!trend || !a.temperatures.length) return "";
    const nowS = Date.now() / 1000;
    const rows = a.temperatures.map((t) => {
      const pts = (trend.zones[t.entity_id] || []).slice();
      const current = this._temp(t.entity_id, t.limit);
      if (current) pts.push([nowS, current.value]);
      if (pts.length < 2) return "";
      const values = pts.map(([, v]) => v);
      let lo = Math.min(...values);
      let hi = Math.max(...values);
      if (t.limit != null) hi = Math.max(hi, t.limit);
      if (hi - lo < 2) { lo -= 1; hi += 1; }
      const t0 = nowS - 86400;
      const x = (time) => Math.max(0, Math.min(100, ((time - t0) / 86400) * 100));
      const y = (v) => 30 - ((v - lo) / (hi - lo)) * 28;
      let path = "";
      let last = null;
      for (const [time, v] of pts) {
        if (time < t0) { last = v; continue; }
        if (!path) path = `M0 ${y(last ?? v).toFixed(1)} `;
        path += `L${x(time).toFixed(1)} ${y(v).toFixed(1)} `;
      }
      const unit = current?.unit || "°";
      const label = t.zone === "fridge" ? "Fridge" : "Freezer";
      return `<div class="trend"><span>${label}${current ? ` <b>${esc(current.text)}</b>` : ""}</span>
        <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-label="${esc(`${label} over the last 24 hours, ${Math.round(Math.min(...values))} to ${Math.round(Math.max(...values))}${unit}`)}" role="img">
          ${t.limit != null ? `<line class="limit" x1="0" x2="100" y1="${y(t.limit).toFixed(1)}" y2="${y(t.limit).toFixed(1)}"/>` : ""}
          <path class="line" d="${path}"/>
        </svg>
        <span class="range">${Math.round(Math.min(...values))}–${Math.round(Math.max(...values))}${esc(unit)}</span></div>`;
    }).join("");
    return rows ? `<div><div class="section-title"><span>Last 24 hours</span></div>${rows}</div>` : "";
  }

  // Cycles per day this week; tap a day for its cycles.
  _week(a) {
    if (a.door || !a.days?.length || !a.days.some((d) => d.count) ) return "";
    const max = Math.max(1, ...a.days.map((d) => d.count));
    const picked = this._day[a.entry_id];
    return `<div><div class="section-title"><span>Cycles per day</span></div>
      <div class="week">${a.days.map((d) => {
        const h = d.count ? Math.max(8, (d.count / max) * 46) : 3;
        return `<button data-day="${esc(d.date)}" data-id="${esc(a.entry_id)}" class="${picked === d.date ? "on" : ""}" aria-pressed="${picked === d.date}"
          aria-label="${esc(`${dayLabel(d.date, "long")}: ${d.count} ${d.count === 1 ? "cycle" : "cycles"}`)}">
          <span class="n">${d.count || ""}</span><span class="col${d.count ? "" : " zero"}" style="height:${h}px"></span><span>${esc(dayLabel(d.date))}</span></button>`;
      }).join("")}</div></div>`;
  }

  _cycleList(a) {
    const picked = this._day[a.entry_id];
    let cycles = a.recent_cycles;
    let title = "Recent cycles";
    if (picked) {
      cycles = cycles.filter((c) => localDay(new Date(c.finished)) === picked);
      title = dayLabel(picked, "long");
    } else if (!this._open.has(a.entry_id)) return "";
    const row = (c) => {
      const extra = [minutesText(c.minutes), kwhText(c.kwh), moneyText(c.cost, a.currency)].filter(Boolean).join(" · ");
      return `<li><span>${esc(picked ? clockText(c.finished) : whenText(c.finished))}</span><span>${esc(extra)}</span></li>`;
    };
    return `<div><div class="section-title"><span>${esc(title)}</span><span>${cycles.length} ${cycles.length === 1 ? "cycle" : "cycles"}</span></div>
      ${cycles.length ? `<ul class="cycles">${cycles.map(row).join("")}</ul>` : ""}</div>`;
  }

  _menuPop(a) {
    if (this._menu !== a.entry_id) return "";
    const id = esc(a.entry_id);
    if (this._picker === a.entry_id) {
      // Pick how it's drawn: each choice drawn small, as it is now.
      const view = this._view(a);
      const options = a.drawings.map((style) => {
        const preview = this._drawing({ ...a, drawing: style }, view).replace('class="art"', 'class="art mini"');
        return `<button class="${style === a.drawing ? "on" : ""}" data-drawing="${esc(style)}" data-id="${id}" aria-pressed="${style === a.drawing}">${preview}<span>${esc(DRAWING_NAMES[style] || style)}</span></button>`;
      });
      return `<div class="menu-pop" role="menu" aria-label="${esc(`How ${a.name} is drawn`)}">
        <div class="pick">${options.join("")}</div>
        ${a.drawing_picked ? `<button data-drawing="" data-id="${id}">Pick it for me</button>` : ""}
        <button data-picker-close>Back</button></div>`;
    }
    const items = [];
    if (a.entities.update_live_activity) items.push(`<button data-update="${esc(a.entities.update_live_activity)}" data-id="${id}">Update Live Activity</button>`);
    items.push(a.muted_until
      ? `<button data-mute="off" data-id="${id}">Unmute</button>`
      : `<button data-mute="on" data-id="${id}">Mute for today</button>`);
    if (!a.door && a.recent_cycles.length) {
      items.push(`<button data-cycles="${id}">${this._open.has(a.entry_id) ? "Hide recent cycles" : "Recent cycles"}</button>`);
    }
    if (a.drawings.length > 1) items.push(`<button data-picker="${id}">Change the drawing</button>`);
    items.push(`<button data-link="${esc(a.link)}">Device page</button>`);
    return `<div class="menu-pop" role="menu" aria-label="${esc(a.name)}">${items.join("")}</div>`;
  }

  _card(a) {
    const line = this._statusLine(a);
    const id = a.entry_id;
    const view = this._view(a);
    const note = this._notes[id];
    let badge = "";
    if (a.door && view.doorOpen) {
      const open = this._attrs(a).open_minutes;
      badge = `<span class="badge alarm">Door open${open ? ` · ${esc(minutesText(open))}` : ""}</span>`;
    } else if (a.muted_until) badge = `<span class="badge">🔕 Muted today</span>`;
    return `<section class="card" style="--c:${esc(a.color || "#03a9f4")}" aria-label="${esc(a.name)}">
      <div class="pic">${this._drawing(a, view)}<span class="chip ${line.cls}"><span class="dot"></span>${esc(line.chip)}</span>${badge}</div>
      <div class="body">
        <div class="head"><div class="who"><a class="name" href="${esc(a.link)}">${esc(a.name)}</a><span class="type">${esc(a.type_name)}</span></div>
          <button class="more" data-menu="${esc(id)}" aria-haspopup="menu" aria-expanded="${this._menu === id}" aria-label="More for ${esc(a.name)}">⋯</button></div>
        <div class="now">${esc(line.now)}</div>
        ${this._waitingRow(a)}
        ${this._progress(a)}
        ${this._alerts(a)}
        ${this._upkeep(a)}
        ${this._facts(a)}
        ${this._trend(a)}
        ${this._week(a)}
        ${this._cycleList(a)}
        ${note ? `<div class="note${note.error ? " error" : ""}" role="status">${esc(note.text)}</div>` : ""}
      </div>
      ${this._menuPop(a)}
    </section>`;
  }

  // ------------------------------------------------------------- events

  _onChange(ev) {
    const el = ev.target;
    if (el.id === "show" || el.id === "sort") {
      this._dash[el.id] = el.value;
      this._saveDash();
      this._render(true);
    }
  }

  _navigate(path) {
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed"));
  }

  _onClick(ev) {
    const el = ev.target.closest("button, a.name");
    const hadMenu = this._menu;
    if (!el || !el.closest(".menu-pop, .more")) this._menu = null;
    if (!el) {
      if (hadMenu) this._render(true);
      return;
    }
    if (el.matches("a.name")) {
      // Navigate inside Home Assistant rather than reloading the page.
      ev.preventDefault();
      this._navigate(el.getAttribute("href"));
      return;
    }
    const ds = el.dataset;
    if ("reset" in ds) {
      this._dash = { ...this._dash, show: "all", query: "" };
      this.shadowRoot.getElementById("show").value = "all";
      this.shadowRoot.getElementById("search").value = "";
      this._saveDash();
      this._render(true);
    } else if (ds.picker) {
      this._menu = ds.picker;
      this._picker = ds.picker;
      this._render(true);
    } else if ("pickerClose" in ds) {
      this._menu = hadMenu;
      this._picker = null;
      this._render(true);
    } else if (ds.drawing !== undefined) {
      this._menu = null;
      this._picker = null;
      this._setDrawing(ds.id, ds.drawing || null);
    } else if (ds.menu) {
      this._picker = null;
      this._menu = hadMenu === ds.menu ? null : ds.menu;
      this._render(true);
    } else if (ds.cycles) {
      this._menu = null;
      delete this._day[ds.cycles];
      if (this._open.has(ds.cycles)) this._open.delete(ds.cycles);
      else this._open.add(ds.cycles);
      this._saveDash();
      this._render(true);
    } else if (ds.day) {
      this._day[ds.id] = this._day[ds.id] === ds.day ? undefined : ds.day;
      this._render(true);
    } else if (ds.update) {
      this._menu = null;
      this._press(ds.id, ds.update);
    } else if (ds.mute) {
      this._menu = null;
      this._mute(ds.id, ds.mute === "on");
    } else if (ds.upkeep) {
      this._upkeepDone(ds.id, ds.upkeep);
    } else if (ds.link) {
      this._menu = null;
      this._navigate(ds.link);
    } else if (hadMenu) {
      this._render(true);
    }
  }

  _note(id, text, error = false) {
    this._notes[id] = { text, error };
    this._render(true);
    clearTimeout(this._noteTimers?.[id]);
    this._noteTimers = this._noteTimers || {};
    if (!error) this._noteTimers[id] = setTimeout(() => { delete this._notes[id]; this._render(true); }, 4000);
  }

  async _press(id, entityId) {
    try {
      await this._hass.callService("button", "press", { entity_id: entityId });
      this._note(id, "Live Activity sent again.");
    } catch (err) {
      this._note(id, `Couldn't update it: ${err?.message || err}`, true);
    }
  }

  async _mute(id, muted) {
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/mute`, entry_id: id, muted });
      const appliance = this._appliances.find((a) => a.entry_id === id);
      if (appliance) appliance.muted_until = res.muted_until;
      this._note(id, muted ? "Muted until midnight. Critical alerts still come through." : "Alerts are back on.");
    } catch (err) {
      this._note(id, `Couldn't change it: ${err?.message || err}`, true);
    }
  }

  async _setDrawing(id, drawing) {
    const appliance = this._appliances.find((x) => x.entry_id === id);
    try {
      await this._hass.callWS({ type: `${DOMAIN}/drawing`, entry_id: id, drawing });
      await this._load();
    } catch (err) {
      if (appliance) this._note(id, `Couldn't change it: ${err?.message || err}`, true);
    }
  }

  async _upkeepDone(id, key) {
    this._busy.add(id);
    this._render(true);
    try {
      await this._hass.callWS({ type: `${DOMAIN}/upkeep_done`, entry_id: id, key });
      await this._load();
      this._note(id, "Marked as done.");
    } catch (err) {
      this._note(id, `Couldn't save it: ${err?.message || err}`, true);
    } finally {
      this._busy.delete(id);
      this._render(true);
    }
  }
}

if (!customElements.get("appliance-mgmt-panel")) {
  customElements.define("appliance-mgmt-panel", ApplianceMgmtPanel);
}
