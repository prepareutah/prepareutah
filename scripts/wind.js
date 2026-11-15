/* Builds site/assets/js/wind.js: hourly wind readings near the refinery corridor, counted by direction,
   season, and time of day, plus a simple base map. The refinery guide draws its wind map from that file.

   Run: node scripts/wind.js <folder>     (Node 18+; prints a summary; rewrites site/assets/js/wind.js)

   <folder> holds the downloaded records (they're large, so they stay out of the repo). All come from the
   Iowa Environmental Mesonet (IEM) and the U.S. Census Bureau:
     slc.csv            Salt Lake City International Airport, routine hourly reports:
                        https://mesonet.agron.iastate.edu/request/download.phtml?network=UT_ASOS
                        (station SLC; direction and speed in knots; America/Denver time; comma delimited;
                        routine hourly reports only)
     rwis_<ID>.csv      Utah DOT road weather stations, every reading (about one each 10 minutes), no header:
                        https://mesonet.agron.iastate.edu/request/rwis/fe.phtml?network=UT_RWIS
                        (direction and speed in knots; America/Denver time; comma delimited)
     roads.geojson      Census TIGERweb "Primary Roads" for the map area, as GeoJSON:
                        https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/2
     water.geojson      Census TIGERweb "Areal Hydrography" over 2 square kilometers for the same area:
                        https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Hydro/MapServer/1

   Method: one reading per clock hour (the airport's routine report; the first road-station reading of the hour).
   Each goes into one of 36 ten-degree direction bins (airports report direction to the nearest 10 degrees, so
   wider bins would favor some directions). Calm and light, shifting readings (no direction reported, or under
   the station's calm speed below) are counted separately. Directions here are where the wind comes FROM; the page flips them to show
   where smoke would drift. */
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/wind.js <folder with slc.csv, rwis_*.csv, roads.geojson, water.geojson>"); process.exit(1); }

const START = "2016-11-01", END = "2026-11-01";   // ten years: [START, END) in local time
const SEASONS = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "fall", "fall", "fall", "winter"];
const TIMES = ["night", "morning", "afternoon", "evening"];   // midnight-6, 6-noon, noon-6, 6-midnight

// Station coordinates are the ones IEM lists for each station. calmKt: airport reports call anything under
// 3 knots calm and give no direction; the road stations report lighter winds, so only under 1 knot counts as calm.
const STATIONS = [
  { id: "legacy", file: "rwis_UTLGP.csv", name: "Legacy Parkway, West Bountiful (Utah DOT road weather station)", short: "Legacy Parkway", lat: 40.9077, lon: -111.9166, src: "iem-rwis", calmKt: 1, labelAbove: true },
  { id: "slc", file: "slc.csv", name: "Salt Lake City International Airport", short: "Airport", lat: 40.78, lon: -111.97, src: "iem-asos", calmKt: 3 }
];
// Not used: the Utah DOT station on I-15 at 500 South (UT20). From July 2021 to June 2026 its directions read about
// 25 to 30 degrees off its own earlier and later record and off both stations above, so its rose would mislead.

const num = s => { s = (s || "").trim(); return s === "" || s === "M" || s === "null" ? null : +s; };   // blank, "M" or "null" = missing; any other text becomes NaN
function add(st, date, hour, deg, kt) {
  if (date < START || date >= END) return;
  const season = SEASONS[+date.slice(5, 7) - 1], time = TIMES[Math.floor(hour / 6)];
  const calm = deg === null || kt < st.calmKt;
  const bin = calm ? -1 : Math.round(deg / 10) % 36;
  if (!st.first || date < st.first) st.first = date;
  if (!st.last || date > st.last) st.last = date;
  st.months[date.slice(0, 7)] = (st.months[date.slice(0, 7)] || 0) + 1;
  [["all", "all"], [season, "all"], ["all", time], [season, time]].forEach(([s, t]) => {
    const v = st.views[s + "." + t] || (st.views[s + "." + t] = { n: 0, calm: 0, c: new Array(36).fill(0) });
    v.n++; if (calm) v.calm++; else v.c[bin]++;
  });
}
const stations = STATIONS.map(cfg => {
  const st = { id: cfg.id, name: cfg.name, short: cfg.short, lat: cfg.lat, lon: cfg.lon, src: cfg.src, calmKt: cfg.calmKt, labelAbove: !!cfg.labelAbove, first: null, last: null, months: {}, views: {} };
  const seen = new Set();
  fs.readFileSync(path.join(dir, cfg.file), "utf8").split("\n").forEach(line => {
    const f = line.split(","); if (f.length < 4 || f[0] === "station") return;
    const kt = num(f[3]); if (kt === null || !(kt >= 0 && kt <= 120)) return;       // no usable speed: skip the reading
    const deg = num(f[2]); if (deg !== null && !(deg >= 0 && deg <= 360)) return;   // unreadable direction: skip the reading
    const hourKey = f[1].slice(0, 13); if (seen.has(hourKey)) return;               // one reading per clock hour
    seen.add(hourKey);
    add(st, f[1].slice(0, 10), +f[1].slice(11, 13), deg, kt);                       // speed but no direction = light and shifting
  });
  return st;
});

// ---- simple base map: Census TIGER interstates and water (public domain), drawn 440 units wide
const MAP = { west: -112.035, east: -111.835, north: 40.945, south: 40.735, w: 440 };
const COS = Math.cos(40.84 * Math.PI / 180), KX = MAP.w / (MAP.east - MAP.west), KY = KX / COS;
MAP.h = Math.round((MAP.north - MAP.south) * KY);
const px = (lon, lat) => [(lon - MAP.west) * KX, (MAP.north - lat) * KY];
const r1 = n => Math.round(n * 10) / 10;
function simplify(pts, tol) {   // Douglas-Peucker
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]]; let worst = 0, at = 0;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / len; if (d > worst) { worst = d; at = i; } }
  return worst <= tol ? [a, b] : simplify(pts.slice(0, at + 1), tol).slice(0, -1).concat(simplify(pts.slice(at), tol));
}
const inView = p => p[0] > -40 && p[0] < MAP.w + 40 && p[1] > -40 && p[1] < MAP.h + 40;
const pathOf = (pts, close) => "M" + pts.map(p => r1(p[0]) + " " + r1(p[1])).join("L") + (close ? "Z" : "");
const geo = f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).features;
const ROADS = { "I- 15": true, "I- 80": true, "I- 215": true, "Legacy Pkwy": false };   // name -> drawn as a major road
const roads = [], roadPts = {};
geo("roads.geojson").forEach(f => {
  const name = f.properties.NAME; if (!(name in ROADS)) return;
  (f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates]).forEach(line => {
    let run = [];
    const flush = () => { if (run.length > 1) { roads.push({ name, major: ROADS[name], d: pathOf(simplify(run, 0.5)) }); (roadPts[name] = roadPts[name] || []).push(...run); } run = []; };
    line.forEach(c => { const p = px(c[0], c[1]); if (inView(p)) run.push(p); else flush(); });
    flush();
  });
});
const water = geo("water.geojson").map(f => (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates])
  .map(poly => poly.map(ring => { const p = ring.map(c => px(c[0], c[1])), mid = p.length >> 1;   // a ring starts and ends at one point, so simplify it in two halves
    return pathOf(simplify(p.slice(0, mid + 1), 0.8).slice(0, -1).concat(simplify(p.slice(mid), 0.8)), true); }).join("")).join(""));
const at = (lon, lat, dx = 0, dy = 0) => { const p = px(lon, lat); return { x: r1(p[0] + dx), y: r1(p[1] + dy) }; };
const onRoad = (name, lat, dx, dy) => { const y = px(0, lat)[1]; const p = roadPts[name].reduce((a, b) => Math.abs(b[1] - y) < Math.abs(a[1] - y) ? b : a); return { x: r1(p[0] + dx), y: r1(p[1] + dy) }; };
// Places are pinned to each city hall, from the Census Geocoder (https://geocoding.geo.census.gov). Rose Park is a
// Salt Lake City neighborhood, so it is pinned to its point in the USGS place-names gazetteer (GNIS 1448938).
// Refineries are pinned to the middle of each site, not the street address, which lands on the gate: EPA's
// facility coordinates for Big West and Chevron (Greenhouse Gas Reporting Program), and for the others a point
// in the middle of the site's main parcel on Utah's parcel map. The label offsets just keep the words clear of the lines.
const labels = [
  { text: "Salt Lake City", ...at(-111.88815, 40.75955, 0, 4), cls: "place" },
  { text: "Rose Park", ...at(-111.92384, 40.79023, -8, -30), cls: "place" },
  { text: "North Salt Lake", ...at(-111.91129, 40.84180, 12, 4), cls: "place", anchor: "start" },
  { text: "Woods Cross", ...at(-111.90195, 40.87426, 4, 4), cls: "place", anchor: "end" },
  { text: "Bountiful", ...at(-111.88060, 40.88121, 8, -8), cls: "place", anchor: "start" },
  { text: "Centerville", ...at(-111.87889, 40.91999, 10, 4), cls: "place", anchor: "start" },
  { text: "Great Salt Lake", ...at(-112.005, 40.905), cls: "water" },
  { text: "Wasatch Range", ...at(-111.842, 40.83), cls: "range", rot: -90 },
  { text: "I-15", ...onRoad("I- 15", 40.935, 8, 0), cls: "road", anchor: "start" },
  { text: "I-80", ...at(-112.02, 40.769, 0, -12), cls: "road", anchor: "start" },
  { text: "I-215", ...at(-111.9495, 40.815, -8, 4), cls: "road", anchor: "end" }
];
const refineries = [
  { n: 1, name: "HF Sinclair Woods Cross Refinery", city: "West Bountiful", ...at(-111.9041, 40.8873) },
  { n: 2, name: "Silver Eagle Refining", city: "Woods Cross", ...at(-111.9098, 40.8678) },
  { n: 3, name: "Big West Oil refinery", city: "North Salt Lake", ...at(-111.92144, 40.83839) },
  { n: 4, name: "Chevron Salt Lake Refinery", city: "on the Salt Lake City and North Salt Lake line", ...at(-111.9238, 40.8249) },
  { n: 5, name: "Marathon Salt Lake City Refinery", city: "Salt Lake City", ...at(-111.9083, 40.7937) }
];
stations.forEach(st => Object.assign(st, at(st.lon, st.lat)));
const map = { w: MAP.w, h: MAP.h, mile2: r1(3.21869 * KX / (111.32 * COS)), water, roads, labels, refineries };

const out = {
  made: new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }), from: START, to: END,   // Utah calendar date
  seasons: [["all", "All year"], ["winter", "Winter (Dec to Feb)"], ["spring", "Spring (Mar to May)"], ["summer", "Summer (Jun to Aug)"], ["fall", "Fall (Sep to Nov)"]],
  times: [["all", "All hours"], ["night", "Midnight to 6 a.m."], ["morning", "6 a.m. to noon"], ["afternoon", "Noon to 6 p.m."], ["evening", "6 p.m. to midnight"]],
  stations: stations.map(st => { const { months, ...rest } = st; return rest; }), map
};
const js = `/* Prepare Utah - wind history near the refinery corridor. GENERATED by scripts/wind.js; don't edit by hand.
   For each station and each season.time view: n = hourly readings, calm = calm or light and shifting readings,
   c = readings in each ten-degree bin by the direction the wind came FROM (c[0] = north, c[9] = east, ...). */
(function (root) {
  root.UR = root.UR || {};
  root.UR.wind = ${JSON.stringify(out)};
})(typeof window !== "undefined" ? window : globalThis);
`;
fs.writeFileSync(path.resolve(__dirname, "..", "site", "assets", "js", "wind.js"), js);

const NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function octants(c) {   // share the ten-degree bins among eight 45-degree sectors without favoring any
  const o = new Array(8).fill(0);
  c.forEach((n, i) => { for (let d = i * 10 - 5; d < i * 10 + 5; d += 0.5) o[Math.floor((((d + 22.75) % 360) + 360) % 360 / 45)] += n / 20; });
  return o;
}
stations.forEach(st => {
  const thin = Object.entries(st.months).filter(([, n]) => n < 500).map(([k, n]) => k + ":" + n);
  console.log(`\n${st.name}  (${st.lat}, ${st.lon})  ${st.first} to ${st.last}; ${Object.keys(st.months).length} of 120 months; months under 500 readings: ${thin.length ? thin.join(" ") : "none"}`);
  ["all.all", "winter.all", "summer.all", "all.night", "all.afternoon", "summer.afternoon", "winter.night"].forEach(k => {
    const v = st.views[k]; if (!v) return;
    const o = octants(v.c).map((n, i) => [NAMES[i], 100 * n / v.n]).sort((a, b) => b[1] - a[1]);
    console.log(`  ${k.padEnd(17)} n=${String(v.n).padStart(6)}  calm ${(100 * v.calm / v.n).toFixed(1).padStart(4)}%  from: ` + o.slice(0, 4).map(x => `${x[0]} ${x[1].toFixed(1)}%`).join(", "));
  });
});
