/* =========================================================================
   Store Performance Dashboard
   -------------------------------------------------------------------------
   Same five published Google Sheets as the Maybell staff dashboard:
     SALE_URL / SALE_LY_URL     Raw bill-line data (this FY / last FY).
     STORE_TARGET_URL / _LY     Store-wise monthly Gross Target.
     STORE_TYPE_URL             Store Name -> Store Type (COCO-TN / FOFO-TN /
                                 Other States, etc.)
   Everything here is store-level (no staff target sheet is used for targets;
   the Staff Performance panel simply lists whoever billed at the selected
   store, straight from the raw Sale sheet).
   ========================================================================= */

const SALE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=1054702314&single=true&output=csv";
const SALE_LY_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=234205256&single=true&output=csv";
const STORE_TARGET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=311460288&single=true&output=csv";
const STORE_TARGET_LY_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=108189863&single=true&output=csv";
const STORE_TYPE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=1866992180&single=true&output=csv";

const REFRESH_MS = 5 * 60 * 1000;

const FY_MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const MONTH_NUM = { Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3 };
const MONTH_NAME_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TYPE_ORDER = ["COCO-TN", "FOFO-TN"]; // any other type falls into "Other States"

let state = {
  saleRows: [],      // this-FY raw bill lines
  saleLyRows: [],     // last-FY raw bill lines
  storeTargets: {},   // "STORE||Month" -> target (this FY)
  storeTargetsLY: {},
  storeType: {},       // normKey(store) -> type string
  storeNames: {},       // normKey(store) -> nicely-cased display name
  categories: [],       // distinct Item/Category values seen
  cyYear: null, lyYear: null,   // guessed calendar years, for labels only
  month: null,           // selected FY month abbrev
  category: "All",
  selectedStore: null,
  monthView: "growth",     // 'target' | 'growth' | 'combined'   (Month Performance table)
  monthScope: "all",       // 'all' | 'l2l'
  ytdView: "growth",
  ytdScope: "l2l",
  monthSearch: "",
  ytdSearch: "",
  monthChartHidden: false,
  loadSeq: 0,
  lastUpdated: null,
  failedSources: [],
};

let weekChart = null;

/* ---------------------------- generic helpers ---------------------------- */

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").replace(/^\u20b9/, "").trim();
  if (s === "" || s.startsWith("#")) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function fmtINR(v) {
  const n = Math.round(num(v));
  const sign = n < 0 ? "-" : "";
  return sign + "\u20b9" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.abs(n));
}
function fmtNum(v) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(num(v)));
}
function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  return `${num(v) >= 0 ? "+" : ""}${num(v).toFixed(digits)}%`;
}
function normKey(s) { return (s || "").trim().toUpperCase(); }
function titleCase(s) { return (s || "").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }
function normYear(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }

function normMonth(raw) {
  const t = String(raw || "").trim().slice(0, 3).toLowerCase();
  const n = MONTH_NAME_IDX[t];
  return n ? Object.keys(MONTH_NUM).find((k) => MONTH_NUM[k] === n) : "";
}

// Extract {day, year} from a Bill Date cell. monthAbbrev (ground truth from
// the sheet's own Month column) disambiguates D/M vs M/D ordering.
function parseDayYear(dateStr, monthAbbrev) {
  const none = { day: null, year: null };
  if (dateStr === undefined || dateStr === null) return none;
  const s = String(dateStr).trim();
  if (!s) return none;
  const mn = MONTH_NUM[monthAbbrev];

  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Math.round((parseFloat(s) - 25569) * 86400 * 1000));
    return { day: d.getUTCDate(), year: d.getUTCFullYear() };
  }
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return { day: num(m[3]), year: num(m[1]) };

  m = s.match(/^(\d{1,2})[-\s\/]([A-Za-z]{3,9})[-\s\/.]*(\d{2,4})?/);
  if (m && MONTH_NAME_IDX[m[2].slice(0, 3).toLowerCase()]) {
    return { day: num(m[1]), year: m[3] ? normYear(num(m[3])) : null };
  }
  m = s.match(/^([A-Za-z]{3,9})[-\s\/.]+(\d{1,2})[,\s]+(\d{2,4})?/);
  if (m && MONTH_NAME_IDX[m[1].slice(0, 3).toLowerCase()]) {
    return { day: num(m[2]), year: m[3] ? normYear(num(m[3])) : null };
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    const a = num(m[1]), b = num(m[2]), yr = normYear(num(m[3]));
    if (a === mn && b !== mn) return { day: b, year: yr };
    if (b === mn && a !== mn) return { day: a, year: yr };
    if (a === mn && b === mn) return { day: a, year: yr };
    if (a > 12) return { day: a, year: yr };
    if (b > 12) return { day: b, year: yr };
    return { day: null, year: yr };
  }
  return none;
}

function monthAbbrevFromCell(cell) {
  if (!cell) return null;
  const s = String(cell).trim();
  const iso = s.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
  if (iso) return numToAbbrev(num(iso[1]));
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (slash) {
    const a = num(slash[1]), b = num(slash[2]);
    const mn = (a >= 1 && a <= 12) ? a : (b >= 1 && b <= 12 ? b : null);
    return mn ? numToAbbrev(mn) : null;
  }
  const named = FY_MONTHS.find((m) => new RegExp(m, "i").test(s));
  return named || null;
}
function numToAbbrev(n) { return Object.keys(MONTH_NUM).find((k) => MONTH_NUM[k] === n) || null; }

// Months in Apr..target order, e.g. monthsUpTo("Sep") -> [Apr..Sep]
function monthsUpTo(month) {
  const i = FY_MONTHS.indexOf(month);
  return i === -1 ? FY_MONTHS.slice() : FY_MONTHS.slice(0, i + 1);
}
function typeGroupOf(type) {
  return TYPE_ORDER.includes(type) ? type : "Other States";
}

/* ---------------------------- CSV fetch / parse ---------------------------- */

async function fetchCsv(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("No data returned.");
  return text;
}
function parseRows(csvText) {
  return Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true }).data;
}

/* ---------------------------- builders ---------------------------- */

function rememberStoreName(store) {
  const key = normKey(store);
  if (key && !state.storeNames[key]) state.storeNames[key] = store.trim();
  return key;
}

function buildSaleRows(csvText) {
  const rows = parseRows(csvText);
  const out = [];
  const catSet = new Set();
  for (const row of rows) {
    const store = (row["Location"] || "").trim();
    const staffRaw = (row["Salesman"] || "").trim();
    const month = normMonth(row["Month"]);
    if (!store || !month) continue;
    const storeKey = rememberStoreName(store);
    const amt = num(row["Bill Amount"]);
    const qty = num(row["Net Qty"]);
    const billCode = (row["Bill Code"] || "").trim();
    const category = (row["Item"] || row["Category"] || "Uncategorised").trim() || "Uncategorised";
    catSet.add(category);
    const { day, year } = parseDayYear(row["Bill Date"], month);
    out.push({
      storeKey, store, staff: titleCase(staffRaw) || "(Unnamed)",
      month, day, year, amt, qty, billCode, category,
    });
  }
  return { rows: out, categories: catSet };
}

function buildStoreTargetMap(csvText) {
  const rows = parseRows(csvText);
  if (!rows.length) return {};
  const header = Object.keys(rows[0]);
  const sc = header.find((h) => /store/i.test(h)) || header[0];
  const tc = header.find((h) => /target/i.test(h)) || header[1];
  const mc = header.find((h) => /month/i.test(h)) || header[2];
  const map = {};
  for (const row of rows) {
    const store = (row[sc] || "").trim();
    if (!store) continue;
    const month = monthAbbrevFromCell(row[mc]);
    if (!month) continue;
    const key = `${rememberStoreName(store)}||${month}`;
    map[key] = (map[key] || 0) + num(row[tc]);
  }
  return map;
}

function buildStoreTypeMap(csvText) {
  const rows = parseRows(csvText);
  if (!rows.length) return {};
  const header = Object.keys(rows[0]);
  const sc = header.find((h) => /store/i.test(h)) || header[0];
  const tc = header.find((h) => /type/i.test(h)) || header[1];
  const map = {};
  for (const row of rows) {
    const store = (row[sc] || "").trim();
    const type = (row[tc] || "").trim();
    if (!store || !type) continue;
    map[rememberStoreName(store)] = type;
  }
  return map;
}

/* ---------------------------- aggregation ---------------------------- */

// storeKey -> { store, months: { MonAbbrev: {amt, qty, bills:Set} } }
function aggregate(rows, category) {
  const map = {};
  for (const r of rows) {
    if (category && category !== "All" && r.category !== category) continue;
    if (!map[r.storeKey]) map[r.storeKey] = { store: r.store, months: {} };
    const mm = map[r.storeKey].months[r.month] || (map[r.storeKey].months[r.month] = { amt: 0, qty: 0, bills: new Set() });
    mm.amt += r.amt; mm.qty += r.qty;
    if (r.billCode) mm.bills.add(r.billCode);
  }
  return map;
}

function cell(agg, storeKey, month) {
  const mm = agg[storeKey] && agg[storeKey].months[month];
  return mm ? { amt: mm.amt, qty: mm.qty, nob: mm.bills.size } : { amt: 0, qty: 0, nob: 0 };
}

function sumMonths(agg, storeKey, months) {
  let amt = 0, qty = 0, nob = 0;
  for (const m of months) { const c = cell(agg, storeKey, m); amt += c.amt; qty += c.qty; nob += c.nob; }
  return { amt, qty, nob };
}

function allStoreKeys() {
  const s = new Set([
    ...Object.keys(state.storeNames),
  ]);
  return [...s];
}

function guessYears() {
  const count = {};
  for (const r of state.saleRows) if (r.year) count[r.year] = (count[r.year] || 0) + 1;
  let cy = null, best = 0;
  for (const y in count) if (count[y] > best) { best = count[y]; cy = Number(y); }
  if (!cy) {
    const now = new Date();
    cy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // FY starts Apr
  }
  state.cyYear = cy;
  state.lyYear = cy - 1;
}

/* ---------------------------- like-for-like ---------------------------- */

// For one store: months (within `months`) where LY had sales > 0.
function l2lMonthsFor(storeKey, lyAgg, months) {
  return months.filter((m) => cell(lyAgg, storeKey, m).amt > 0);
}

function isNewStore(storeKey) {
  return !state.saleLyRows.some((r) => r.storeKey === storeKey);
}

/* ---------------------------- KPI groups ---------------------------- */

function computeStoreRow(storeKey, cyAgg, lyAgg, months, targetMap, targetMapLy) {
  const store = state.storeNames[storeKey] || storeKey;
  const cy = sumMonths(cyAgg, storeKey, months);
  const ly = sumMonths(lyAgg, storeKey, months);
  let target = 0;
  for (const m of months) target += targetMap[`${storeKey}||${m}`] || 0;
  const l2lMonths = l2lMonthsFor(storeKey, lyAgg, months);
  const l2lCY = sumMonths(cyAgg, storeKey, l2lMonths);
  const l2lLY = sumMonths(lyAgg, storeKey, l2lMonths);
  return {
    storeKey, store,
    type: state.storeType[storeKey] || "Other States",
    target, achieved: cy.amt, qty: cy.qty, nob: cy.nob,
    achievement: target > 0 ? (cy.amt / target) * 100 : (cy.amt > 0 ? 100 : 0),
    lySales: ly.amt, lyQty: ly.qty, lyNob: ly.nob,
    growth: ly.amt > 0 ? ((cy.amt - ly.amt) / ly.amt) * 100 : (cy.amt > 0 ? null : 0),
    abv: cy.nob > 0 ? cy.amt / cy.nob : 0,
    abvLy: ly.nob > 0 ? ly.amt / ly.nob : 0,
    basket: cy.nob > 0 ? cy.qty / cy.nob : 0,
    basketLy: ly.nob > 0 ? ly.qty / ly.nob : 0,
    isL2L: l2lMonths.length > 0,
    isNew: isNewStore(storeKey),
    l2lCY: l2lCY.amt, l2lLY: l2lLY.amt,
  };
}

function buildAllRows(months, category) {
  const cyAgg = aggregate(state.saleRows, category);
  const lyAgg = aggregate(state.saleLyRows, category);
  return allStoreKeys().map((k) =>
    computeStoreRow(k, cyAgg, lyAgg, months, state.storeTargets, state.storeTargetsLY)
  );
}

/* ---------------------------- rendering: header ---------------------------- */

function renderHeaderMeta() {
  const fyStart = ["Jan", "Feb", "Mar"].includes(state.month) ? state.cyYear - 1 : state.cyYear;
  document.getElementById("fyLabel").textContent = `FY ${fyStart}-${String(fyStart + 1).slice(2)}`;
  document.getElementById("monthMeta").textContent = `${state.month} ${state.cyYear} selected`;
  document.getElementById("growthMeta").textContent = `${state.lyYear} vs ${state.cyYear} Growth`;
}

function pctBadgeClass(pct) {
  if (pct === null) return "";
  return pct >= 100 ? "good" : pct >= 80 ? "warn" : "bad";
}
function growthClass(g) { return g === null ? "" : g >= 0 ? "good" : "bad"; }

/* ---------------------------- Category Comparison (YTD, by store type) ---------------------------- */

function renderCategoryComparison() {
  const months = monthsUpTo(state.month);
  const rows = buildAllRows(months, "All"); // this table ignores the category filter by design
  const groups = {};
  for (const r of rows) {
    const g = typeGroupOf(r.type);
    (groups[g] = groups[g] || []).push(r);
  }
  const order = [...TYPE_ORDER, "Other States"].filter((g) => groups[g] && groups[g].length);

  const thead = document.getElementById("catCompHead");
  thead.innerHTML = `<th>Metric</th>` + order.map((g) => `<th>${g}</th>`).join("");

  function groupCalc(g) {
    const list = groups[g];
    const stores = list.length;
    const target = list.reduce((s, r) => s + r.target, 0);
    const achieved = list.reduce((s, r) => s + r.achieved, 0);
    const nob = list.reduce((s, r) => s + r.nob, 0);
    const lyNob = list.reduce((s, r) => s + r.lyNob, 0);
    const qty = list.reduce((s, r) => s + r.qty, 0);
    const lyQty = list.reduce((s, r) => s + r.lyQty, 0);
    const lySales = list.reduce((s, r) => s + r.lySales, 0);
    const l2l = list.filter((r) => r.isL2L);
    const l2lCY = l2l.reduce((s, r) => s + r.l2lCY, 0);
    const l2lLY = l2l.reduce((s, r) => s + r.l2lLY, 0);
    return {
      stores,
      target, achieved,
      achievement: target > 0 ? (achieved / target) * 100 : 0,
      abvCY: nob > 0 ? achieved / nob : 0,
      abvLY: lyNob > 0 ? lySales / lyNob : 0,
      basketCY: nob > 0 ? qty / nob : 0,
      basketLY: lyNob > 0 ? lyQty / lyNob : 0,
      l2lGrowth: l2lLY > 0 ? ((l2lCY - l2lLY) / l2lLY) * 100 : null,
      l2lCount: l2l.length,
    };
  }

  const metrics = [
    { label: "Stores", get: (c) => fmtNum(c.stores) },
    { label: "Target", get: (c) => fmtINR(c.target) },
    { label: "Achieved", get: (c) => fmtINR(c.achieved) },
    { label: "Achievement %", get: (c) => fmtPct(c.achievement).replace("+", ""), strong: true },
    { label: "ABV (CY)", get: (c) => fmtINR(c.abvCY) },
    { label: "ABV (LY)", get: (c) => fmtINR(c.abvLY) },
    { label: "Basket (CY)", get: (c) => c.basketCY.toFixed(2) },
    { label: "Basket (LY)", get: (c) => c.basketLY.toFixed(2) },
    { label: "L2L Growth %", get: (c) => fmtPct(c.l2lGrowth), cls: (c) => growthClass(c.l2lGrowth) },
    { label: "L2L Stores", get: (c) => `${c.l2lCount} of ${c.stores}` },
  ];
  const calcs = {}; order.forEach((g) => (calcs[g] = groupCalc(g)));

  const tbody = document.getElementById("catCompBody");
  tbody.innerHTML = metrics.map((m) => `
    <tr>
      <td class="metric-name">${m.label}</td>
      ${order.map((g) => `<td class="${m.strong ? "strong" : ""} ${m.cls ? m.cls(calcs[g]) : ""}">${m.get(calcs[g])}</td>`).join("")}
    </tr>`).join("");
}

/* ---------------------------- This Month / YTD cards ---------------------------- */

function renderCardGroup(prefix, months, label, note) {
  const rows = buildAllRows(months, state.category);
  const target = rows.reduce((s, r) => s + r.target, 0);
  const achieved = rows.reduce((s, r) => s + r.achieved, 0);
  const lySales = rows.reduce((s, r) => s + r.lySales, 0);
  const achievement = target > 0 ? (achieved / target) * 100 : 0;
  const growth = lySales > 0 ? ((achieved - lySales) / lySales) * 100 : null;
  const l2l = rows.filter((r) => r.isL2L);
  const l2lCY = l2l.reduce((s, r) => s + r.l2lCY, 0);
  const l2lLY = l2l.reduce((s, r) => s + r.l2lLY, 0);
  const l2lGrowth = l2lLY > 0 ? ((l2lCY - l2lLY) / l2lLY) * 100 : null;

  document.getElementById(`${prefix}Target`).textContent = fmtINR(target);
  document.getElementById(`${prefix}Achieved`).textContent = fmtINR(achieved);
  const achEl = document.getElementById(`${prefix}Achievement`);
  achEl.textContent = fmtPct(achievement).replace("+", "");
  achEl.className = "kpi-value " + pctBadgeClass(achievement);
  document.getElementById(`${prefix}Previous`).textContent = fmtINR(lySales);
  const growEl = document.getElementById(`${prefix}Growth`);
  growEl.textContent = fmtPct(growth);
  growEl.className = "kpi-value " + growthClass(growth);
  document.getElementById(`${prefix}L2L`).textContent = fmtPct(l2lGrowth);
  document.getElementById(`${prefix}L2LSub`).textContent = `${l2l.length} of ${rows.length} stores compared`;

  const noteEl = document.getElementById(`${prefix}Note`);
  if (noteEl) {
    noteEl.textContent = achieved === 0
      ? `No ${label} sales uploaded yet for any store \u2014 showing \u20b90 achieved.`
      : "";
  }

  return { target, achieved, growth, l2lGrowth, l2lCount: l2l.length, total: rows.length };
}

function renderYtdBanner(ytd) {
  const newStores = allStoreKeys().filter(isNewStore).map((k) => state.storeNames[k]).sort();
  const el = document.getElementById("ytdBanner");
  const overall = fmtPct(ytd.growth);
  const l2l = fmtPct(ytd.l2lGrowth);
  let html = `Reported vs like-for-like (YTD): overall YTD sales growth of <strong>${overall}</strong> vs like-for-like growth of <strong>${l2l}</strong> across ${ytd.l2lCount} of ${ytd.total} stores compared (each compared only on the months it was trading in both years).`;
  if (newStores.length) html += ` New stores this period: ${newStores.join(", ")}.`;
  el.innerHTML = html;
}

/* ---------------------------- store performance tables ---------------------------- */

function buildGroupedRows(rows) {
  // Order: COCO-TN stores + subtotal, FOFO-TN stores + subtotal, combined
  // "TN Total", then Other States stores + subtotal, then Retail Total.
  const out = [];
  const byType = { "COCO-TN": [], "FOFO-TN": [], "Other States": [] };
  for (const r of rows) byType[typeGroupOf(r.type)].push(r);
  const sumRows = (list, label, cls) => {
    const target = list.reduce((s, r) => s + r.target, 0);
    const achieved = list.reduce((s, r) => s + r.achieved, 0);
    const lySales = list.reduce((s, r) => s + r.lySales, 0);
    return {
      isTotal: true, cls, store: label,
      target, achieved, lySales,
      achievement: target > 0 ? (achieved / target) * 100 : 0,
      growth: lySales > 0 ? ((achieved - lySales) / lySales) * 100 : null,
    };
  };
  let tnList = [];
  for (const g of ["COCO-TN", "FOFO-TN"]) {
    if (!byType[g].length) continue;
    out.push(...byType[g]);
    out.push(sumRows(byType[g], `${g} Total`, "sub"));
    tnList = tnList.concat(byType[g]);
  }
  if (tnList.length) out.push(sumRows(tnList, "TN Total", "sub"));
  if (byType["Other States"].length) {
    out.push(...byType["Other States"]);
    out.push(sumRows(byType["Other States"], "Other States Total", "sub"));
  }
  out.push(sumRows(rows, "Retail Total", "grand"));
  return out;
}

function tableRowsHtml(rows, view, onClickable) {
  return rows.map((r) => {
    if (r.isTotal) {
      const cells = view === "target"
        ? [fmtINR(r.target), fmtINR(r.achieved), `<span class="${pctBadgeClass(r.achievement)}">${fmtPct(r.achievement).replace("+", "")}</span>`]
        : view === "growth"
        ? [fmtINR(r.lySales), fmtINR(r.achieved), `<span class="${growthClass(r.growth)}">${fmtPct(r.growth)}</span>`]
        : [fmtINR(r.target), fmtINR(r.achieved), `<span class="${pctBadgeClass(r.achievement)}">${fmtPct(r.achievement).replace("+", "")}</span>`, fmtINR(r.lySales), `<span class="${growthClass(r.growth)}">${fmtPct(r.growth)}</span>`];
      return `<tr class="row-${r.cls}"><td>${r.store}</td>${cells.map((c) => `<td class="num">${c}</td>`).join("")}</tr>`;
    }
    const clickAttr = onClickable ? `data-store="${r.storeKey}" class="clickable-row"` : "";
    const cells = view === "target"
      ? [fmtINR(r.target), fmtINR(r.achieved), `<span class="pill ${pctBadgeClass(r.achievement)}">${fmtPct(r.achievement).replace("+", "")}</span>`]
      : view === "growth"
      ? [fmtINR(r.lySales), fmtINR(r.achieved), `<span class="pill ${growthClass(r.growth)}">${r.isNew ? "New" : fmtPct(r.growth)}</span>`]
      : [fmtINR(r.target), fmtINR(r.achieved), `<span class="pill ${pctBadgeClass(r.achievement)}">${fmtPct(r.achievement).replace("+", "")}</span>`, fmtINR(r.lySales), `<span class="pill ${growthClass(r.growth)}">${r.isNew ? "New" : fmtPct(r.growth)}</span>`];
    return `<tr ${clickAttr}><td class="store-name">${r.store}</td>${cells.map((c) => `<td class="num">${c}</td>`).join("")}</tr>`;
  }).join("");
}

function tableHeadHtml(view, yearLabelCY, yearLabelLY, sameMonthLabel) {
  if (view === "target") return `<th>Store</th><th class="num">Target</th><th class="num">Achieved</th><th class="num">Achievement %</th>`;
  if (view === "growth") return `<th>Store</th><th class="num">${yearLabelLY} Sales${sameMonthLabel ? " (Same Month)" : ""}</th><th class="num">${yearLabelCY} Sales</th><th class="num">Growth %</th>`;
  return `<th>Store</th><th class="num">Target</th><th class="num">Achieved</th><th class="num">Achievement %</th><th class="num">${yearLabelLY} Sales</th><th class="num">Growth %</th>`;
}

function renderStoreTable(idPrefix, months, view, scope, search) {
  let rows = buildAllRows(months, state.category);
  if (scope === "l2l") rows = rows.filter((r) => r.isL2L);
  if (search) rows = rows.filter((r) => r.store.toLowerCase().includes(search.toLowerCase()));
  rows.sort((a, b) => b.achieved - a.achieved);

  document.getElementById(`${idPrefix}Head`).innerHTML = tableHeadHtml(view, state.cyYear, state.lyYear, months.length === 1);
  const grouped = search ? rows : buildGroupedRows(rows);
  document.getElementById(`${idPrefix}Body`).innerHTML = tableRowsHtml(grouped, view, true);
  document.getElementById(`${idPrefix}Count`).textContent = `${rows.length} stores`;

  document.querySelectorAll(`#${idPrefix}Body tr.clickable-row`).forEach((tr) => {
    tr.addEventListener("click", () => {
      state.selectedStore = tr.dataset.store;
      renderStaffPanel();
      document.getElementById("staffPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/* ---------------------------- growth / decline bar chart ---------------------------- */

function renderGrowthChart(months) {
  const rows = buildAllRows(months, state.category).filter((r) => r.growth !== null);
  rows.sort((a, b) => b.growth - a.growth);
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.growth)));
  const el = document.getElementById("growthChartBody");
  el.innerHTML = rows.map((r) => {
    const pct = Math.min(100, (Math.abs(r.growth) / maxAbs) * 100);
    const cls = r.growth >= 0 ? "growth-bar-pos" : "growth-bar-neg";
    return `
      <div class="growth-row">
        <div class="growth-label">${r.store}</div>
        <div class="growth-track"><div class="growth-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="growth-value ${growthClass(r.growth)}">${fmtPct(r.growth)}</div>
      </div>`;
  }).join("");
}

/* ---------------------------- staff / week-on-week panel ---------------------------- */

// Monday-Sunday week buckets for a given month/year: [[startDay,endDay], ...]
function weekBucketsFor(year, monthAbbrev) {
  const monthNum = MONTH_NUM[monthAbbrev];
  if (!year || !monthNum) return [];
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const buckets = [];
  let day = 1;
  while (day <= daysInMonth) {
    const dow = new Date(year, monthNum - 1, day).getDay(); // 0=Sun..6=Sat
    const isoDow = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
    const end = Math.min(daysInMonth, day + (7 - isoDow));
    buckets.push([day, end]);
    day = end + 1;
  }
  return buckets;
}

function renderStaffPanel() {
  const panel = document.getElementById("staffPanel");
  const storeKey = state.selectedStore;
  if (!storeKey) { panel.hidden = true; return; }
  panel.hidden = false;
  const storeName = state.storeNames[storeKey] || storeKey;
  document.getElementById("staffStoreSelect").value = storeKey;
  document.getElementById("staffSubtitle").textContent = `${storeName} \u2014 ${state.month} '${String(state.cyYear).slice(2)} staff breakdown`;

  const cyRows = state.saleRows.filter((r) => r.storeKey === storeKey && r.month === state.month &&
    (state.category === "All" || r.category === state.category));

  const staffMap = {};
  for (const r of cyRows) {
    if (!staffMap[r.staff]) staffMap[r.staff] = { amt: 0, qty: 0, bills: new Set() };
    staffMap[r.staff].amt += r.amt; staffMap[r.staff].qty += r.qty;
    if (r.billCode) staffMap[r.staff].bills.add(r.billCode);
  }
  const staffRows = Object.entries(staffMap)
    .map(([staff, v]) => ({ staff, amt: v.amt, qty: v.qty, nob: v.bills.size }))
    .sort((a, b) => b.amt - a.amt);

  const tableWrap = document.getElementById("staffTableWrap");
  if (!staffRows.length) {
    tableWrap.innerHTML = `<p class="empty-note">No staff-level billing data found for ${storeName} in ${state.month} '${String(state.cyYear).slice(2)}.</p>`;
  } else {
    tableWrap.innerHTML = `
      <table class="staff-table">
        <thead><tr><th>Staff</th><th class="num">Sales</th><th class="num">Qty</th><th class="num">NOB</th><th class="num">ABV</th><th class="num">Basket</th></tr></thead>
        <tbody>${staffRows.map((s) => `
          <tr>
            <td>${s.staff}</td>
            <td class="num">${fmtINR(s.amt)}</td>
            <td class="num">${fmtNum(s.qty)}</td>
            <td class="num">${fmtNum(s.nob)}</td>
            <td class="num">${fmtINR(s.nob ? s.amt / s.nob : 0)}</td>
            <td class="num">${(s.nob ? s.qty / s.nob : 0).toFixed(2)}</td>
          </tr>`).join("")}</tbody>
      </table>`;
  }

  renderWeekChart(storeKey);
}

function renderWeekChart(storeKey) {
  const cyBuckets = weekBucketsFor(state.cyYear, state.month);
  const lyBuckets = weekBucketsFor(state.lyYear, state.month);
  const weekCount = Math.max(cyBuckets.length, lyBuckets.length);

  const sumBucket = (rows, storeKeyArg, month, bucket) => {
    if (!bucket) return 0;
    return rows.filter((r) => r.storeKey === storeKeyArg && r.month === month && r.day >= bucket[0] && r.day <= bucket[1] &&
      (state.category === "All" || r.category === state.category))
      .reduce((s, r) => s + r.amt, 0);
  };

  const cyVals = [], lyVals = [], labels = [], subLabels = [];
  for (let i = 0; i < weekCount; i++) {
    cyVals.push(sumBucket(state.saleRows, storeKey, state.month, cyBuckets[i]));
    lyVals.push(sumBucket(state.saleLyRows, storeKey, state.month, lyBuckets[i]));
    labels.push(`Week ${i + 1}`);
    const lyR = lyBuckets[i] ? `${state.lyYear}: ${lyBuckets[i][0]}\u2013${lyBuckets[i][1]}` : `${state.lyYear}: \u2014`;
    const cyR = cyBuckets[i] ? `${state.cyYear}: ${cyBuckets[i][0]}\u2013${cyBuckets[i][1]}` : `${state.cyYear}: \u2014`;
    subLabels.push(`${lyR} | ${cyR}`);
  }

  const ctx = document.getElementById("weekChart").getContext("2d");
  if (weekChart) weekChart.destroy();
  weekChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: `${state.month} ${state.lyYear} (\u20b9)`, data: lyVals, backgroundColor: "#B9C6E8", datalabels: { anchor: "end", align: "top" } },
        { label: `${state.month} ${state.cyYear} (\u20b9)`, data: cyVals, backgroundColor: "#1C2B6B", datalabels: { anchor: "end", align: "top" } },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "top", labels: { usePointStyle: true } },
        datalabels: {
          color: "#1C2530", font: { weight: 700, size: 11 },
          formatter: (v) => (v ? fmtINR(v) : "\u20b90"),
        },
        tooltip: { callbacks: { title: (items) => `${items[0].label}  (${subLabels[items[0].dataIndex]})` } },
      },
      scales: {
        x: { ticks: { callback: (v, i) => `${labels[i]}\n${subLabels[i]}` }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: (v) => fmtINR(v) } },
      },
    },
    plugins: [ChartDataLabels],
  });
  document.getElementById("weekChartNote").textContent =
    "Monday\u2013Sunday weeks within " + state.month + " (by week position; first/last week may be shorter) \u2014 " + (state.storeNames[storeKey] || storeKey);
}

/* ---------------------------- month select / category select / store dropdown ---------------------------- */

function populateSelectors() {
  const monthSel = document.getElementById("monthSelect");
  monthSel.innerHTML = FY_MONTHS.map((m) => `<option value="${m}">${m}</option>`).join("");
  monthSel.value = state.month;

  const catSel = document.getElementById("categorySelect");
  catSel.innerHTML = `<option value="All">All</option>` + state.categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  catSel.value = state.category;

  const storeSel = document.getElementById("staffStoreSelect");
  const opts = allStoreKeys().map((k) => ({ k, name: state.storeNames[k] })).sort((a, b) => a.name.localeCompare(b.name));
  storeSel.innerHTML = opts.map((o) => `<option value="${o.k}">${o.name}</option>`).join("");
}

/* ---------------------------- orchestration ---------------------------- */

function render() {
  renderHeaderMeta();
  document.getElementById("catCompMonth").textContent = `${state.month} ${state.cyYear}`;
  document.getElementById("monthCardTitle").textContent = `${state.month} ${state.cyYear}`;
  document.getElementById("ytdCardTitle").textContent = `${state.month} ${state.cyYear}`;
  document.getElementById("monthTargetSub").textContent = `${state.month} ${state.cyYear} target`;
  document.getElementById("monthPrevSub").textContent = `${state.month} ${state.lyYear}`;
  document.getElementById("ytdTargetSub").textContent = `${state.month} ${state.cyYear}`;
  renderCategoryComparison();
  renderCardGroup("month", [state.month], `${state.month} ${state.cyYear}`);
  const ytd = renderCardGroup("ytd", monthsUpTo(state.month), `Apr\u2013${state.month} ${state.cyYear}`);
  renderYtdBanner(ytd);

  document.getElementById("monthSectionTitle").textContent = `Month Performance \u2014 ${state.month} ${state.cyYear}`;
  renderStoreTable("month", [state.month], state.monthView, state.monthScope, state.monthSearch);

  document.getElementById("ytdSectionTitle").textContent = `YTD Performance \u2014 Apr to ${state.month} ${state.cyYear}`;
  renderStoreTable("ytd", monthsUpTo(state.month), state.ytdView, state.ytdScope, state.ytdSearch);

  if (!document.getElementById("growthChartWrap").hidden) renderGrowthChart(monthsUpTo(state.month));

  if (state.selectedStore) renderStaffPanel();

  document.getElementById("footerUpdated").textContent = state.lastUpdated
    ? `Last refreshed ${state.lastUpdated.toLocaleString()}` : "";
  if (state.failedSources.length) {
    document.getElementById("footerUpdated").textContent += ` \u00b7 failed: ${state.failedSources.join(", ")}`;
  }
}

/* ---------------------------- pulse / status ---------------------------- */

function setPulse(kind, text) {
  const el = document.getElementById("pulse");
  el.className = `pulse pulse-${kind}`;
  el.querySelector(".pulse-text").textContent = text;
}

/* ---------------------------- data loading ---------------------------- */

async function loadAll() {
  const seq = ++state.loadSeq;
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  setPulse("loading", "Connecting\u2026");

  const results = await Promise.allSettled([
    fetchCsv(SALE_URL), fetchCsv(SALE_LY_URL),
    fetchCsv(STORE_TARGET_URL), fetchCsv(STORE_TARGET_LY_URL),
    fetchCsv(STORE_TYPE_URL),
  ]);
  const [saleR, saleLyR, targetR, targetLyR, typeR] = results;
  if (seq !== state.loadSeq) return;

  const failed = [];
  if (typeR.status === "fulfilled") state.storeType = buildStoreTypeMap(typeR.value); else failed.push("Store Type");
  if (targetR.status === "fulfilled") state.storeTargets = buildStoreTargetMap(targetR.value); else failed.push("2026 Target");
  if (targetLyR.status === "fulfilled") state.storeTargetsLY = buildStoreTargetMap(targetLyR.value); else failed.push("2025 Target");

  if (saleR.status === "fulfilled") {
    const b = buildSaleRows(saleR.value);
    state.saleRows = b.rows;
    state.categories = [...b.categories].sort();
  } else failed.push("2026 Sale");
  if (saleLyR.status === "fulfilled") {
    state.saleLyRows = buildSaleRows(saleLyR.value).rows;
  } else failed.push("2025 Sale");

  state.failedSources = failed;
  guessYears();

  if (!state.month) {
    const withData = FY_MONTHS.filter((m) => state.saleRows.some((r) => r.month === m) || Object.keys(state.storeTargets).some((k) => k.endsWith("||" + m)));
    state.month = withData.length ? withData[withData.length - 1] : FY_MONTHS[0];
  }

  populateSelectors();

  state.lastUpdated = new Date();
  btn.disabled = false;
  if (failed.length === results.length) setPulse("error", "Connection failed");
  else if (failed.length) setPulse("partial", `Live \u00b7 ${failed.length} source(s) failed`);
  else setPulse("live", "Live");

  render();
}

/* ---------------------------- events ---------------------------- */

function wireEvents() {
  document.getElementById("refreshBtn").addEventListener("click", loadAll);

  document.getElementById("monthSelect").addEventListener("change", (e) => {
    state.month = e.target.value;
    state.selectedStore = null;
    document.getElementById("staffPanel").hidden = true;
    render();
  });
  document.getElementById("categorySelect").addEventListener("change", (e) => {
    state.category = e.target.value;
    render();
  });

  document.querySelectorAll("[data-month-view]").forEach((btn) => btn.addEventListener("click", () => {
    state.monthView = btn.dataset.monthView;
    document.querySelectorAll("[data-month-view]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  }));
  document.querySelectorAll("[data-month-scope]").forEach((btn) => btn.addEventListener("click", () => {
    state.monthScope = btn.dataset.monthScope;
    document.querySelectorAll("[data-month-scope]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  }));
  document.getElementById("monthSearch").addEventListener("input", (e) => { state.monthSearch = e.target.value; render(); });

  document.querySelectorAll("[data-ytd-view]").forEach((btn) => btn.addEventListener("click", () => {
    state.ytdView = btn.dataset.ytdView;
    document.querySelectorAll("[data-ytd-view]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  }));
  document.querySelectorAll("[data-ytd-scope]").forEach((btn) => btn.addEventListener("click", () => {
    state.ytdScope = btn.dataset.ytdScope;
    document.querySelectorAll("[data-ytd-scope]").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  }));
  document.getElementById("ytdSearch").addEventListener("input", (e) => { state.ytdSearch = e.target.value; render(); });

  document.getElementById("growthChartToggle").addEventListener("click", (e) => {
    const wrap = document.getElementById("growthChartWrap");
    wrap.hidden = !wrap.hidden;
    e.target.textContent = wrap.hidden ? "Show chart" : "Hide chart";
    if (!wrap.hidden) renderGrowthChart(monthsUpTo(state.month));
  });

  document.getElementById("staffStoreSelect").addEventListener("change", (e) => {
    state.selectedStore = e.target.value;
    renderStaffPanel();
  });
  document.getElementById("weekChartToggle").addEventListener("click", (e) => {
    const wrap = document.getElementById("weekChartWrap");
    wrap.hidden = !wrap.hidden;
    e.target.textContent = wrap.hidden ? "Show chart" : "Hide chart";
  });
}

/* ---------------------------- boot ---------------------------- */

function boot() {
  wireEvents();
  loadAll();
  setInterval(loadAll, REFRESH_MS);
}
document.addEventListener("DOMContentLoaded", boot);
