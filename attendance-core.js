/* attendance-core.js - shared rules for the attendance pages.
   Parsing, the delay rules (clock in 25 before / 10 after, clock out 5 before / 25 after, 30 min cap),
   exceptional duties and the data sent to the sheet. Both pages load this file. */

/* ---------- Date helpers (all times as naive local minutes, day numbers are UTC-based) ---------- */
const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WDN = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const WDS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const pad = n => String(n).padStart(2, "0");
const dayOf = (y, m, d) => Date.UTC(y, m, d) / 864e5;
const ymd = day => { const d = new Date(day * 864e5); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() }; };
const monthKey = day => { const x = ymd(day); return x.y + "-" + pad(x.m + 1); };
const monthName = key => { const [y, m] = key.split("-"); return MONL[+m - 1] + " " + y; };
const fmtDay = day => { const x = ymd(day); return x.d + " " + MONS[x.m]; };
const fmtDayLong = day => { const x = ymd(day); return WDS[x.wd] + " " + x.d + " " + MONS[x.m]; };
const fmt12 = min => { const m = ((min % 1440) + 1440) % 1440, h = Math.floor(m / 60); return ((h % 12) || 12) + ":" + pad(m % 60) + " " + (h < 12 ? "AM" : "PM"); };
function nowParts() { const n = new Date(); const today = dayOf(n.getFullYear(), n.getMonth(), n.getDate()); return { today, nowMin: today * 1440 + n.getHours() * 60 + n.getMinutes() }; }

function parseTime12(s) {
  s = (s || "").trim();
  if (/missed\s*action/i.test(s)) return "MA";
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return null;
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  return h * 60 + +m[2];
}
function parseStamp(s) { // 25-OCT-2026 07:05:06, 25-SEP-2026 01:00 or 11-10-2026 00:43
  s = (s || "").trim();
  let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const mo = MON.indexOf(m[2].toUpperCase()); if (mo < 0) return null;
    return dayOf(+m[3], mo, +m[1]) * 1440 + +m[4] * 60 + +m[5];
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return dayOf(+m[3], +m[2] - 1, +m[1]) * 1440 + +m[4] * 60 + +m[5];
}

// Only the current year counts; rows from any other year are dropped while reading.
const thisYear = () => new Date().getFullYear();

/* ---------- Parsers ---------- */
function parseClock(text) {
  const seen = new Set(), recs = []; let dup = 0;
  for (const line of (text || "").split(/\r?\n/)) {
    let biz, id, name, code, ts;
    const c = line.split("\t").map(s => s.trim());
    if (c.length >= 7 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c[0])) { [biz, id, name] = c; code = c[5]; ts = c[6]; }
    else {
      const m = line.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+)\s+(\S+).*?\b(DAY\s+IN|DAY\s+OUT)\s+(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i);
      if (!m) continue; [, biz, id, name, code, ts] = m;
    }
    code = (code || "").toUpperCase().replace(/\s+/g, " ");
    const side = code === "DAY IN" ? "in" : code === "DAY OUT" ? "out" : null;
    if (!side) continue;
    const b = biz.split("/").map(Number), tsMin = parseStamp(ts);
    if (tsMin == null) continue;
    if (b[2] !== thisYear()) continue;
    const day = dayOf(b[2], b[0] - 1, b[1]);
    const key = day + "|" + id + "|" + side + "|" + tsMin;
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    recs.push({ day, id, name: name || id, side, tsMin });
  }
  return { recs, dup };
}

// Reads the Monthly Schedule page (clock out before clock in, date without year)
// and the Attendance Duty Report (clock in before clock out, date with year, several stores).
// The column order is taken from the header lines inside the paste itself.
function parseSchedule(text) {
  const byStore = new Map(), template = {}; let dup = 0, first = "";
  let order = null, fresh = true;
  for (const line of (text || "").split(/\r?\n/)) {
    const tl = line.trim();
    if (tl === "Click In Time" || tl === "Click Out Time") {
      if (fresh) { order = tl === "Click In Time" ? "in" : "out"; fresh = false; }
      continue;
    }
    const c = line.split("\t").map(x => x.trim());
    const twd = WDN.findIndex(w => w.toLowerCase() === (c[1] || "").toLowerCase());
    if (twd >= 0 && c.length >= 4 && parseTime12(c[2]) != null) { template[twd] = { out: parseTime12(c[2]), in: parseTime12(c[3]) }; continue; }
    let st, dd, mon, yr = null, wd, a, b, type, by, upd;
    const dm = c.length >= 6 && (c[1] || "").match(/^(\d{1,2})-([A-Za-z]{3})(?:-(\d{4}))?$/);
    if (dm) { st = c[0]; dd = +dm[1]; mon = dm[2]; yr = dm[3] ? +dm[3] : null; wd = c[2]; a = c[3]; b = c[4]; type = c[5]; by = c[9] || ""; upd = c[10] || ""; }
    else {
      const m = line.match(/^\s*(\d+)\s+(\d{1,2})-([A-Za-z]{3})\s+([A-Za-z]+day)\s+(\d{1,2}:\d{2}\s*[AP]M|Missed Action)\s+(\d{1,2}:\d{2}\s*[AP]M|Missed Action)\s+(Target Submission|Exceptional Duty Change|[A-Za-z]+(?: [A-Za-z]+)*?)\s.*?(\S+@\S+)?\s+(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2})\s*$/i);
      if (!m) continue;
      [, st, dd, mon, wd, a, b, type, by, upd] = m; dd = +dd;
    }
    fresh = true;
    const inFirst = order ? order === "in" : yr != null;
    const out = inFirst ? b : a, inn = inFirst ? a : b;
    const mo = MON.indexOf(mon.toUpperCase()); if (mo < 0) continue;
    const updMin = parseStamp(upd);
    let year = yr;
    if (year == null) {
      const refYear = updMin != null ? ymd(Math.floor(updMin / 1440)).y : new Date().getFullYear();
      const wdi = WDN.findIndex(w => w.toLowerCase() === (wd || "").toLowerCase());
      year = refYear;
      for (const y of [refYear, refYear + 1, refYear - 1]) { if (wdi < 0 || ymd(dayOf(y, mo, dd)).wd === wdi) { year = y; break; } }
    }
    if (year !== thisYear()) continue;
    const day = dayOf(year, mo, dd);
    const idm = (by || "").match(/\.(\d{3,})\./);
    const row = { day, out: parseTime12(out), in: parseTime12(inn), outText: (out || "").trim(), inText: (inn || "").trim(),
      type: (type || "").trim(), byId: idm ? idm[1] : (by || "").trim(), updMin };
    if (row.out == null && row.in == null) continue; // e.g. 24-hour stores
    st = String(st || "").trim();
    if (!first) first = st;
    if (!byStore.has(st)) byStore.set(st, new Map());
    const map = byStore.get(st), prev = map.get(day);
    if (prev) { dup++; if ((row.updMin ?? 0) < (prev.updMin ?? 0)) continue; }
    map.set(day, row);
  }
  return { byStore, stores: [...byStore.keys()], multi: byStore.size > 1, byDay: byStore.get(first) || new Map(), dup, store: first, template };
}

/* ---------- Comparison ---------- */
const WIN = { in: [-25, 10], out: [-5, 25] };
const CAP = 30;

function analyze(clock, sched, now) {
  const { today, nowMin } = now;
  // last punch per business day and side
  const last = new Map(), names = new Map();
  let minDay = Infinity, maxDay = -Infinity;
  for (const r of clock.recs) {
    names.set(r.id, r.name);
    const k = r.day + "|" + r.side, p = last.get(k);
    if (!p || r.tsMin >= p.tsMin) last.set(k, r);
    if (r.day < minDay) minDay = r.day; if (r.day > maxDay) maxDay = r.day;
  }
  const days = [];
  const excByMonth = new Map(); // monthKey -> list

  // Usual planned time per month, weekday and side: the most common time on days without an exceptional duty.
  const tally = new Map(), usual = new Map();
  for (const r of sched.byDay.values()) {
    if (r.type && !/target\s*submission/i.test(r.type)) continue;
    const pre = monthKey(r.day) + "|" + ymd(r.day).wd + "|";
    for (const side of ["out", "in"]) {
      if (typeof r[side] !== "number") continue;
      const m = tally.get(pre + side) || new Map();
      m.set(r[side], (m.get(r[side]) || 0) + 1); tally.set(pre + side, m);
    }
  }
  for (const [k, m] of tally) usual.set(k, [...m.entries()].sort((x, y) => y[1] - x[1])[0][0]);
  const usualFor = (day, side) => {
    const k = monthKey(day) + "|" + ymd(day).wd + "|" + side;
    if (usual.has(k)) return usual.get(k);
    const tp = sched.template && sched.template[ymd(day).wd];
    return tp && typeof tp[side] === "number" ? tp[side] : null;
  };
  // Compare one punch with one planned time.
  const judge = (side, S, rec, day, missState) => {
    if (rec) {
      const diff = rec.tsMin - (day * 1440 + S), [lo, hi] = WIN[side];
      return diff >= lo && diff <= hi ? { state: "ok", minutes: 0, diff } : { state: "late", minutes: Math.min(CAP, Math.abs(diff)), diff };
    }
    return missState === "missed" ? { state: "missed", minutes: CAP } : { state: missState, minutes: 0 };
  };

  for (const s of [...sched.byDay.values()].sort((a, b) => b.day - a.day)) {
    const isExcType = s.type && !/target\s*submission/i.test(s.type);
    const editedAfter = s.updMin != null && s.updMin >= s.day * 1440;
    const hol = (sched.holidays || []).find(h => s.day >= h.from && s.day <= h.to);
    // On holidays set by the supervisor, schedule changes count as normal planned times.
    const counted = isExcType && editedAfter && !hol;
    const editLag = s.updMin != null ? Math.floor(s.updMin / 1440) - s.day : null;
    const lateEdit = counted && editLag > 4;
    const exc = { counted, lateEdit, editLag, rank: 0, over: false, planned: isExcType && !editedAfter && !hol, holiday: hol ? hol.name : "", byId: s.byId, updMin: s.updMin, day: s.day, alt: null, added: 0, dayRef: null };
    if (counted) { const mk = monthKey(s.day); if (!excByMonth.has(mk)) excByMonth.set(mk, []); excByMonth.get(mk).push(exc); }
    if (s.day > today) continue;

    const inRange = clock.recs.length && s.day >= minDay && s.day <= maxDay;
    const missState = !inRange ? "nodata" : s.day === today ? "pending" : s.day === minDay ? "nodata" : "missed"; // oldest day may be cut at a page boundary
    const sides = {};
    for (const side of ["out", "in"]) {
      const S = s[side];
      const cell = { side, S, schedText: S === "MA" ? "Missed Action" : (S == null ? "" : fmt12(S)), state: "none", minutes: 0, rec: null };
      sides[side] = cell;
      if (S == null) continue;
      const rec = last.get(s.day + "|" + side) || null;
      cell.rec = rec;
      if (S === "MA") { cell.state = "excused"; continue; }
      Object.assign(cell, judge(side, S, rec, s.day, missState));
    }
    const list = [sides.out, sides.in].filter(c => c.state !== "none");
    const minutes = list.reduce((a, c) => a + c.minutes, 0);
    const compared = list.some(c => ["ok", "late", "missed", "excused"].includes(c.state));
    const issue = minutes > 0;
    let status = "wait", left = null;
    if (issue) { const dl = s.day + 4; left = dl - today; status = left >= 0 ? "red" : "black"; }
    else if (compared && list.every(c => c.state !== "pending")) status = "ok";
    else if (list.every(c => c.state === "nodata")) status = "nodata";
    const dayObj = { day: s.day, sides, minutes, compared, issue, status, left, exc };
    days.push(dayObj);

    // What would count if this exceptional duty were rejected: compare with the usual time instead.
    if (counted) {
      const alt = {}; let altTotal = 0;
      for (const side of ["out", "in"]) {
        const c = sides[side], U = usualFor(s.day, side);
        if (c.state === "none" || U == null || U === c.S) { alt[side] = null; altTotal += c.minutes; continue; }
        alt[side] = Object.assign({ usual: U }, judge(side, U, c.rec, s.day, missState));
        altTotal += alt[side].minutes;
      }
      exc.alt = alt; exc.added = Math.max(0, altTotal - minutes); exc.dayRef = dayObj;
    }
  }
  // The monthly limit of 5 is counted in the order the edits were made.
  for (const list of excByMonth.values()) {
    list.sort((a, b) => (a.updMin ?? 0) - (b.updMin ?? 0) || a.day - b.day);
    list.forEach((e, i) => { e.rank = i + 1; e.over = e.rank > 5; });
  }
  return { days, excByMonth, names, minDay, maxDay };
}

/* ---------- Saved data ---------- */
const dateStr = day => { const x = ymd(day); return x.y + "-" + pad(x.m + 1) + "-" + pad(x.d); };
const stampStr = min => dateStr(Math.floor(min / 1440)) + " " + pad(Math.floor((min % 1440) / 60)) + ":" + pad(min % 60);
const isoDay = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? dayOf(+m[1], +m[2] - 1, +m[3]) : null; };
const isoMin = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/); return m ? dayOf(+m[1], +m[2] - 1, +m[3]) * 1440 + +m[4] * 60 + +m[5] : null; };
const recKey = r => r.day + "|" + r.id + "|" + r.side + "|" + r.tsMin;

function fromSaved(res) {
  const recs = [];
  for (const x of res.punches || []) {
    const day = isoDay(x.date), tsMin = isoMin(x.time);
    if (day == null || tsMin == null || !/^(in|out)$/.test(x.side) || ymd(day).y !== thisYear()) continue;
    recs.push({ day, id: String(x.id), name: x.name || String(x.id), side: x.side, tsMin });
  }
  const byDay = new Map();
  for (const x of res.schedule || []) {
    const day = isoDay(x.date); if (day == null || ymd(day).y !== thisYear()) continue;
    byDay.set(day, { day, out: parseTime12(x.out), in: parseTime12(x.in), outText: x.out, inText: x.in, type: x.type || "", byId: x.by || "", updMin: isoMin(x.updated) });
  }
  return { recs, byDay };
}
function mergeClock(a, b) {
  const seen = new Set(), recs = [];
  for (const r of a.concat(b)) { const k = recKey(r); if (!seen.has(k)) { seen.add(k); recs.push(r); } }
  return { recs, dup: 0 };
}
function mergeSched(base, extra) {
  const m = new Map(base);
  for (const [day, row] of extra) { const old = m.get(day); if (!old || (row.updMin ?? 0) >= (old.updMin ?? 0)) m.set(day, row); }
  return m;
}

/* ---------- Data sent to the sheet ---------- */
function punchesPayload(recs) {
  return recs.map(r => ({ date: dateStr(r.day), id: r.id, name: r.name, side: r.side, time: stampStr(r.tsMin) }));
}
function schedPayload(byDay) {
  return [...byDay.values()].map(r => ({ date: dateStr(r.day), weekday: WDN[ymd(r.day).wd], out: r.outText, in: r.inText, type: r.type, by: r.byId, updated: r.updMin != null ? stampStr(r.updMin) : "" }));
}
// Every compared day of the year is sent; the sheet keeps days older than 31 days unchanged.
function daysPayload(A, today) {
  return A.days.filter(d => d.compared && d.day <= today).map(d => {
    const side = c => ({ planned: c.schedText, actual: c.rec ? fmt12(c.rec.tsMin) : "", minutes: c.minutes, byId: c.rec ? c.rec.id : "", byName: c.rec ? c.rec.name : "" });
    return { date: dateStr(d.day), weekday: WDN[ymd(d.day).wd], out: side(d.sides.out), in: side(d.sides.in), minutes: d.minutes, exceptional: d.exc.counted, lateEdit: d.exc.lateEdit };
  });
}
function holidaysFrom(list) {
  return (list || []).map(h => ({ from: isoDay(h.from), to: isoDay(h.to), name: h.name })).filter(h => h.from != null && h.to != null);
}

/* ---------- Exceptional duties from saved schedule rows (supervisor page) ---------- */
// rows: [store, date, weekday, out, in, type, updatedBy, updatedAt] as saved in the sheet.
// A change counts when it was edited on or after its day and the day is not a supervisor holiday.
// The monthly limit of 5 is counted in the order the edits were made.
function rankExceptions(rows, holidays) {
  const byKey = new Map(), groups = new Map();
  for (const r of rows) {
    const [store, date, weekday, out, inn, type, by, updated] = r;
    if (!type || /target\s*submission/i.test(type)) continue;
    if (!updated || updated.slice(0, 10) < date) continue;
    const day = isoDay(date), updDay = isoDay(updated);
    if (day == null || updDay == null) continue;
    const hol = (holidays || []).find(h => day >= h.from && day <= h.to);
    const e = { store, date, weekday, out, in: inn, by, updated, lag: updDay - day, holiday: hol ? hol.name : "", rank: 0, over: false, lateEdit: false };
    e.lateEdit = !e.holiday && e.lag > 4;
    byKey.set(store + "|" + date, e);
    if (e.holiday) continue;
    const g = store + "|" + date.slice(0, 7);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : (a.date < b.date ? -1 : 1));
    list.forEach((e, i) => { e.rank = i + 1; e.over = e.rank > 5; });
  }
  return byKey;
}
