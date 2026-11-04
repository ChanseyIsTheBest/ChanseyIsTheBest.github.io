"use strict";

const FAMILIES = {
  recomp: { one: "Xbox 360 recomp", many: "Xbox 360 recomps" },
  android: { one: "Android wrapper", many: "Android wrappers" },
  native: { one: "Native port", many: "Native ports" },
};
const SORTS = {
  popular: { label: "Popular", by: (a, b) => b.downloads - a.downloads || b.stars - a.stars },
  newest: { label: "Newest", title: "By each port's very first release", by: (a, b) => b.firstReleased.localeCompare(a.firstReleased) },
  updated: { label: "Last updated", title: "By each port's most recent release", by: (a, b) => b.released.localeCompare(a.released) },
  az: { label: "A–Z", by: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) },
};
const LATEST_COUNT = 14;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
const state = { family: "all", sort: "popular", query: "" };

let ports = [];
let byId = new Map();
let selected = null;
let current = null; // the port open in the detail panel
const detail = $("detail");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const released = (p) => new Date(p.released);
const fmtDate = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const plural = (n, word) => `${nf.format(n)} ${word}${n === 1 ? "" : "s"}`;

/* ---------- tiles ---------- */

function tile(p, eager) {
  const img = el("img", { src: p.icon, alt: "", width: 256, height: 256, decoding: "async", loading: eager ? "eager" : "lazy" });
  const art = el("span", { class: "art" }, img);
  if (p.archived) art.append(el("span", { class: "flag" }, "Archived"));

  const a = el("a", { class: "tile" + (p.archived ? " is-off" : ""), href: `#${p.id}`, "data-id": p.id, "aria-label": p.title, tabindex: -1 },
    art, el("span", { class: "name" }, p.title));
  a.style.setProperty("--accent", p.accent || "#555");
  return a;
}

const tilesIn = (box) => [...box.querySelectorAll(".tile")];

function select(t, { focus = false } = {}) {
  if (selected && selected !== t) selected.classList.remove("is-selected");
  selected = t;
  if (!t) { renderStatus(null); return; }
  t.classList.add("is-selected");

  // Roving tabindex: each group is one tab stop.
  const box = t.parentElement;
  tilesIn(box).forEach((x) => x.setAttribute("tabindex", x === t ? 0 : -1));
  if (focus) t.focus({ preventScroll: true });

  placeName(t);
  renderStatus(byId.get(t.dataset.id));
}

/* Keep the floating name on screen (and inside the row, which clips). */
function placeName(t) {
  const name = t.querySelector(".name");
  name.style.setProperty("--shift", "0px");
  if (getComputedStyle(name).position !== "absolute") return;
  const rect = name.getBoundingClientRect();
  const inRow = t.parentElement === $("row");
  const edge = inRow ? $("row").getBoundingClientRect() : document.body.getBoundingClientRect();
  const margin = 18;
  let shift = 0;
  if (rect.left < edge.left + margin) shift = edge.left + margin - rect.left;
  else if (rect.right > edge.right - margin) shift = edge.right - margin - rect.right;
  name.style.setProperty("--shift", `${shift}px`);
}

function renderStatus(p) {
  const box = $("status");
  box.replaceChildren();
  if (!p) return;
  box.append(el("b", {}, p.title), el("span", {}, `${p.version} · ${plural(p.downloads, "download")}`));
}

function nudge(t, x, y) {
  t.style.setProperty("--nudge-x", `${x * 5}px`);
  t.style.setProperty("--nudge-y", `${y * 5}px`);
  t.classList.remove("nudge");
  void t.offsetWidth;
  t.classList.add("nudge");
}

/* Arrow keys walk the tiles like a d-pad: across the row, down into the grid and back. */
function move(dx, dy) {
  if (!selected) {
    const first = tilesIn($("row"))[0];
    if (first) select(first, { focus: true });
    return;
  }
  const inRow = selected.parentElement === $("row");
  const list = tilesIn(selected.parentElement);
  const i = list.indexOf(selected);
  let next = null;

  const nearestBelowOrAbove = (others) => {
    const x = selected.getBoundingClientRect().left;
    const firstTop = others[0].offsetTop;
    const line = others.filter((o) => o.offsetTop === firstTop);
    return line.reduce((best, o) =>
      Math.abs(o.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? o : best);
  };

  if (dx) {
    next = list[i + dx] || null;
  } else if (inRow) {
    const grid = tilesIn($("grid"));
    if (dy > 0 && grid.length) next = nearestBelowOrAbove(grid);
  } else {
    const columns = list.filter((o) => o.offsetTop === list[0].offsetTop).length;
    const target = i + dy * columns;
    if (target < 0) next = dy < 0 ? nearestBelowOrAbove(tilesIn($("row"))) : null;
    else if (target >= list.length) next = (selected.offsetTop < list[list.length - 1].offsetTop) ? list[list.length - 1] : null;
    else next = list[target];
  }

  if (!next) { nudge(selected, dx, dy); return; }
  select(next, { focus: true });
  next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/* ---------- grid and controls ---------- */

function visiblePorts() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  return ports
    .filter((p) => state.family === "all" || p.family === state.family)
    .filter((p) => {
      if (!terms.length) return true;
      const hay = `${p.title} ${p.repo} ${p.description || ""} ${p.tech || ""}`.toLowerCase();
      return terms.every((w) => hay.includes(w));
    })
    .sort(SORTS[state.sort].by);
}

function renderGrid() {
  const list = visiblePorts();
  const grid = $("grid");
  const hadSelection = selected && selected.parentElement === grid;
  const keep = hadSelection ? selected.dataset.id : null;
  const wasFocused = hadSelection && document.activeElement === selected;
  grid.replaceChildren(...list.map((p) => tile(p, false)));
  $("count").textContent = list.length;

  const first = grid.querySelector(".tile");
  if (first) first.setAttribute("tabindex", 0);
  if (hadSelection) {
    // Stay on the same game through a re-sort; fall back only if it was filtered out.
    const same = keep && grid.querySelector(`.tile[data-id="${CSS.escape(keep)}"]`);
    select(same || first || tilesIn($("row"))[0] || null, { focus: wasFocused && !!(same || first) });
  }

  const empty = $("empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const reset = el("button", { type: "button" }, "Show everything");
    reset.addEventListener("click", () => {
      state.family = "all";
      state.query = "";
      $("search").value = "";
      renderControls();
      renderGrid();
    });
    empty.replaceChildren(`Nothing matches that. `, reset);
  }
}

function renderControls() {
  const counts = { all: ports.length };
  for (const p of ports) counts[p.family] = (counts[p.family] || 0) + 1;

  const filterButton = (key, label) => {
    const b = el("button", { class: "pill", type: "button", "aria-pressed": String(state.family === key) },
      label, el("i", {}, String(counts[key] || 0)));
    b.addEventListener("click", () => { state.family = key; renderControls(); renderGrid(); });
    return b;
  };
  $("filters").replaceChildren(
    filterButton("all", "All"),
    ...Object.keys(FAMILIES).filter((k) => counts[k]).map((k) => filterButton(k, FAMILIES[k].many)),
  );

  $("sorts").replaceChildren(...Object.entries(SORTS).map(([key, s]) => {
    const b = el("button", { class: "pill", type: "button", title: s.title, "aria-pressed": String(state.sort === key) }, s.label);
    b.addEventListener("click", () => { state.sort = key; renderControls(); renderGrid(); });
    return b;
  }));
  $("sort-hint").textContent = `Sort: ${SORTS[state.sort].label}`;
}

function cycleSort() {
  const keys = Object.keys(SORTS);
  state.sort = keys[(keys.indexOf(state.sort) + 1) % keys.length];
  renderControls();
  renderGrid();
}

/* ---------- detail panel ---------- */

function renderDetail(p) {
  current = p;
  detail.style.setProperty("--accent", p.accent || "#888");
  $("d-icon").src = p.icon;
  $("d-title").textContent = p.title;

  const family = FAMILIES[p.family] ? FAMILIES[p.family].one : null;
  // The family already says "wrapper"; READMEs say it again ("Unity 6 / IL2CPP wrapper").
  const tech = (p.tech || "").replace(/\s*(loader\s*)?wrapper$/i, "");
  $("d-kicker").textContent = [family, tech].filter(Boolean).join(" · ");

  // "Port of X for Switch" only repeats the title.
  $("d-desc").textContent = /^Port of /.test(p.description || "") ? "" : (p.description || "");

  // A port with one release only has one date worth showing.
  const dates = p.firstReleased === p.released
    ? [["Released", fmtDate(released(p))]]
    : [["First released", fmtDate(new Date(p.firstReleased))], ["Last updated", fmtDate(released(p))]];
  const meta = [
    ["Version", p.version],
    ...dates,
    ["Downloads", nf.format(p.downloads)],
    ["Stars", nf.format(p.stars)],
    ["Size", fmtSize(p.assetSize)],
  ];
  if (p.upstream) meta.push(["Based on", p.upstream]);
  $("d-meta").replaceChildren(...meta.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));

  const note = $("d-note");
  note.className = "d-note";
  note.replaceChildren();
  if (p.archived) {
    note.classList.add("is-warn");
    note.append(el("strong", {}, "Archived"), p.archivedNote || "This repo is archived and no longer updated.");
  } else if (p.needs) {
    note.append(el("strong", {}, "What you need"), p.needs);
  }

  const actions = [];
  const repoLabel = p.archived ? "View on GitHub" : "Setup guide & source";
  if (!p.archived && p.installer) {
    actions.push(el("a", { class: "btn btn-main", href: p.installer }, "Web installer"));
  }
  if (!p.archived) {
    actions.push(el("a", { class: p.installer ? "btn" : "btn btn-main", href: p.assetUrl },
      `Download ${p.assetName}`, el("small", {}, p.version)));
  }
  actions.push(el("a", { class: actions.length ? "btn" : "btn btn-main", href: p.repoUrl }, repoLabel));
  $("d-actions").replaceChildren(...actions);

  document.title = `${p.title} · ChanseyIsTheBest`;
}

function openFromHash() {
  const p = byId.get(decodeURIComponent(location.hash.slice(1)));
  if (!p) {
    if (detail.open) detail.close();
    return;
  }
  renderDetail(p);
  if (!detail.open) detail.showModal();
  detail.scrollTop = 0;
}

function closeDetail() {
  if (detail.open) detail.close();
}

function stepDetail(by) {
  const list = visiblePorts();
  const from = list.indexOf(current);
  const next = list[(from + by + list.length) % list.length];
  if (!next) return;
  history.replaceState(null, "", `#${next.id}`);
  renderDetail(next);
  detail.scrollTop = 0;
  // Leave the selection on whatever was last being looked at.
  const t = document.querySelector(`#grid .tile[data-id="${CSS.escape(next.id)}"]`);
  if (t) select(t);
}

/* ---------- wiring ---------- */

function wireTiles(box) {
  box.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const t = e.target.closest(".tile");
    if (t && t !== selected) select(t);
  });
  box.addEventListener("focusin", (e) => {
    const t = e.target.closest(".tile");
    if (t && t !== selected) select(t);
  });
}

function wireRow() {
  const row = $("row");
  const prev = document.querySelector(".row-nav.prev");
  const next = document.querySelector(".row-nav.next");
  const update = () => {
    prev.disabled = row.scrollLeft < 8;
    next.disabled = row.scrollLeft + row.clientWidth > row.scrollWidth - 8;
  };
  const page = (dir) => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: "smooth" });
  prev.addEventListener("click", () => page(-1));
  next.addEventListener("click", () => page(1));
  row.addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

function act(name) {
  if (name === "search") { scrollSearchIntoView(); $("search").focus(); }
  if (name === "sort") cycleSort();
  if (name === "open" && selected) location.hash = selected.dataset.id;
  if (name === "close") closeDetail();
}

function scrollSearchIntoView() {
  const head = document.querySelector(".all-head");
  if (head.getBoundingClientRect().top < 0 || head.getBoundingClientRect().bottom > innerHeight) {
    head.scrollIntoView({ block: "start" });
  }
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (detail.open) {
    const k = e.key.toLowerCase();
    if (k === "b") closeDetail();
    else if (e.key === "ArrowLeft" || k === "l") stepDetail(-1);
    else if (e.key === "ArrowRight" || k === "r") stepDetail(1);
    return;
  }

  if (e.target.matches("input")) {
    if (e.key === "Escape") { e.target.value = ""; state.query = ""; renderGrid(); e.target.blur(); }
    if (e.key === "ArrowDown" || e.key === "Enter") {
      const first = $("grid").querySelector(".tile");
      if (first) { e.preventDefault(); select(first, { focus: true }); first.scrollIntoView({ block: "nearest" }); }
    }
    return;
  }

  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handlers = {
    ArrowLeft: () => move(-1, 0),
    ArrowRight: () => move(1, 0),
    ArrowUp: () => move(0, -1),
    ArrowDown: () => move(0, 1),
    a: () => act("open"),
    x: () => act("sort"),
    y: () => act("search"),
    "/": () => act("search"),
  };
  if (handlers[k]) { e.preventDefault(); handlers[k](); }
}

function wire() {
  wireTiles($("row"));
  wireTiles($("grid"));
  wireRow();

  $("search").addEventListener("input", (e) => { state.query = e.target.value; renderGrid(); });
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b.dataset.act);
  });

  addEventListener("hashchange", openFromHash);
  detail.addEventListener("close", () => {
    history.replaceState(null, "", location.pathname + location.search);
    document.title = "ChanseyIsTheBest · Switch Ports";
    // The browser just refocused the tile that opened the panel; land on the one last viewed.
    const last = current && document.querySelector(`#grid .tile[data-id="${CSS.escape(current.id)}"]`);
    if (last) select(last, { focus: true });
  });
  detail.addEventListener("click", (e) => { if (e.target === detail) closeDetail(); }); // backdrop

  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]').content = next === "light" ? "#ececee" : "#2b2c30";
    try { localStorage.setItem("theme", next); } catch (err) { /* private window: this visit only */ }
  });
  addEventListener("resize", () => { if (selected) placeName(selected); });
}

function renderHeader(data) {
  const { totals, owner } = data;
  $("headline").textContent = `${totals.ports} ports for Nintendo Switch`;
  const tagline = $("tagline");
  tagline.replaceChildren(
    `${owner.bio ? owner.bio + ". " : ""}`,
    el("b", {}, nf.format(totals.downloads)), " downloads and ",
    el("b", {}, nf.format(totals.stars)), " stars so far.",
  );
  $("updated").textContent = `Release data from GitHub, ${fmtDate(new Date(data.generated))}.`;
}

async function main() {
  let data;
  try {
    const res = await fetch("data/ports.json");
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch (err) {
    $("grid").replaceChildren(el("p", { class: "empty" }, "Couldn't load the list of ports. They're all on ",
      el("a", { href: "https://github.com/ChanseyIsTheBest?tab=repositories" }, "GitHub"), "."));
    return;
  }

  ports = data.ports;
  byId = new Map(ports.map((p) => [p.id, p]));

  renderHeader(data);
  renderControls();

  const latest = ports.filter((p) => !p.archived).sort(SORTS.updated.by).slice(0, LATEST_COUNT);
  $("row").replaceChildren(...latest.map((p, i) => tile(p, i < 8)));
  renderGrid();
  wire();

  const first = $("row").querySelector(".tile");
  if (first) select(first);
  openFromHash();
}

main();
