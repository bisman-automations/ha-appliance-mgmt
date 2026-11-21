// Node tests for the dashboard's history reads (fridge trends and door opens).
// Run with: node --test tests/*.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Local midnight is worked out by the panel; UTC gives a fixed answer.
process.env.TZ = "UTC";

const SOURCE = readFileSync(
  new URL("../custom_components/appliance_mgmt/frontend/appliance-mgmt-panel.js", import.meta.url),
  "utf8",
);

function load() {
  const defined = {};
  const context = {
    console,
    Date,
    Math,
    JSON,
    Number,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    HTMLElement: class {
      attachShadow() {
        this.shadowRoot = { querySelector: () => null, innerHTML: "" };
        return this.shadowRoot;
      }
    },
    customElements: {
      get: (name) => defined[name],
      define: (name, cls) => {
        defined[name] = cls;
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, Panel: defined["appliance-mgmt-panel"] };
}

test("mergeHistory keeps new changes only, once, and trims to the window", () => {
  const { context } = load();
  const old = [[100, "off"], [200, "on"], [300, "off"]];
  // The read since 250 starts with the state at 250 (a repeat), then the
  // change at 300 already seen, then a new one.
  const fresh = [[250, "on"], [300, "off"], [400, "on"]];
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.mergeHistory(old, fresh, 0))),
    [[100, "off"], [200, "on"], [300, "off"], [400, "on"]],
  );
  // Only the last point before the window start stays (the starting state).
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.mergeHistory(old, fresh, 350))),
    [[300, "off"], [400, "on"]],
  );
  // Nothing new: the same list.
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.mergeHistory(old, [[350, "off"]], 0))),
    old,
  );
});

test("after the first read, only what changed since is asked for", async () => {
  const { context, Panel } = load();
  const panel = new Panel();
  panel._render = () => {};
  const calls = [];
  const day = 86400;
  let nowS = 10 * day + 12 * 3600; // noon
  const RealDate = Date;
  const answers = [
    {
      "binary_sensor.kitchen_fridge_door": [
        { s: "off", lu: nowS - day },
        { s: "on", lu: nowS - 3600 },
        { s: "off", lu: nowS - 3540 },
      ],
      "sensor.kitchen_fridge_temperature": [
        { s: "37", lu: nowS - day },
        { s: "38", lu: nowS - 600 },
      ],
    },
    {
      "binary_sensor.kitchen_fridge_door": [
        { s: "off", lu: nowS - 60 },
        { s: "on", lu: nowS + 100 },
        { s: "off", lu: nowS + 130 },
      ],
      "sensor.kitchen_fridge_temperature": [{ s: "38", lu: nowS - 60 }],
    },
  ];
  panel._hass = {
    states: {},
    callWS: async (msg) => {
      calls.push(msg);
      return answers[calls.length - 1];
    },
  };
  panel._appliances = [
    {
      entry_id: "e1",
      temperatures: [{ entity_id: "sensor.kitchen_fridge_temperature", zone: "fridge" }],
      door_entities: ["binary_sensor.kitchen_fridge_door"],
    },
  ];
  context.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [nowS * 1000]));
    }
    static now() {
      return nowS * 1000;
    }
  };
  try {
    await panel._loadTrends();
    const firstStart = new RealDate(calls[0].start_time).getTime() / 1000;
    assert.equal(firstStart, nowS - day);
    assert.equal(panel._trends.e1.opens, 1);
    assert.equal(panel._trends.e1.seconds, 60);

    const firstEnd = nowS;
    nowS += 300; // the next read, five minutes later
    await panel._loadTrends();
    const secondStart = new RealDate(calls[1].start_time).getTime() / 1000;
    assert.equal(secondStart, firstEnd - 60);
    assert.equal(panel._trends.e1.opens, 2);
    assert.equal(panel._trends.e1.seconds, 90);
    assert.deepEqual(
      JSON.parse(JSON.stringify(panel._trends.e1.zones["sensor.kitchen_fridge_temperature"])),
      [[firstEnd - day, 37], [firstEnd - 600, 38]],
    );
  } finally {
    context.Date = RealDate;
  }
});
