const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("node:path");
const fs = require("node:fs");
const Jimp = require("jimp");

const app = express();
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 50 * 1024 * 1024 },
});

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static("public"));
app.use(express.json());

// ── GPX Parsing ──────────────────────────────────────────────────────────────

function parseGPX(content) {
	const points = [];
	const blockRe = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
	for (const m of content.matchAll(blockRe)) {
		const attrs = m[2];
		const inner = m[3] || "";
		const latM = attrs.match(/\blat="([^"]+)"/);
		const lonM = attrs.match(/\blon="([^"]+)"/);
		if (!latM || !lonM) continue;
		const eleM = inner.match(/<ele>([^<]+)<\/ele>/);
		const timeM = inner.match(/<time>([^<]+)<\/time>/);
		const lat = parseFloat(latM[1]);
		const lon = parseFloat(lonM[1]);
		if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
		points.push({
			lat,
			lon,
			ele: eleM ? parseFloat(eleM[1]) : null,
			time: timeM ? new Date(timeM[1]) : null,
		});
	}
	return points;
}

function extractName(content) {
	const m = content.match(/<name>([^<]+)<\/name>/);
	return m ? m[1].trim() : null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function haversine(p1, p2) {
	const R = 6371000;
	const φ1 = (p1.lat * Math.PI) / 180,
		φ2 = (p2.lat * Math.PI) / 180;
	const Δφ = ((p2.lat - p1.lat) * Math.PI) / 180;
	const Δλ = ((p2.lon - p1.lon) * Math.PI) / 180;
	const a =
		Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeStats(points) {
	let distance = 0,
		elevGain = 0,
		elevLoss = 0;
	for (let i = 1; i < points.length; i++) {
		distance += haversine(points[i - 1], points[i]);
		if (points[i].ele !== null && points[i - 1].ele !== null) {
			const d = points[i].ele - points[i - 1].ele;
			if (d > 0) elevGain += d;
			else elevLoss += Math.abs(d);
		}
	}
	const hasEle = points.some((p) => p.ele !== null);
	const hasTime = points[0]?.time && points[points.length - 1]?.time;
	let duration = null;
	if (hasTime)
		duration = (points[points.length - 1].time - points[0].time) / 1000;
	return {
		distance,
		elevGain: hasEle ? elevGain : null,
		elevLoss: hasEle ? elevLoss : null,
		duration,
	};
}

function fmtDist(m) {
	return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(s) {
	if (!s) return null;
	const h = Math.floor(s / 3600),
		m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── ASCII Helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bresenham(x0, y0, x1, y1) {
	const pts = [];
	const dx = Math.abs(x1 - x0),
		dy = Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1,
		sy = y0 < y1 ? 1 : -1;
	let err = dx - dy;
	while (true) {
		pts.push([x0, y0]);
		if (x0 === x1 && y0 === y1) break;
		const e2 = 2 * err;
		if (e2 > -dy) {
			err -= dy;
			x0 += sx;
		}
		if (e2 < dx) {
			err += dx;
			y0 += sy;
		}
	}
	return pts;
}

function dirChar(dx, dy) {
	if (dx === 0 && dy === 0) return "*";
	const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	const a = ((angle % 180) + 180) % 180;
	if (a < 22.5 || a >= 157.5) return "-";
	if (a < 67.5) return dy > 0 ? "\\" : "/";
	if (a < 112.5) return "|";
	return dy > 0 ? "/" : "\\";
}

const COMPASS = ["    N    ", "  \\ | /  ", "W - + - E", "  / | \\  ", "    S    "];

// ── Tile Engine ───────────────────────────────────────────────────────────────

const TILE_SIZE = 256;
const tileCache = new Map(); // key → Jimp image
const pendingTiles = new Map(); // key → Promise<Jimp image>

function latLonToTile(lat, lon, zoom) {
	const n = 2 ** zoom;
	const x = ((lon + 180) / 360) * n;
	const latRad = (lat * Math.PI) / 180;
	const y =
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	return { x, y };
}

function pickZoom(minLat, minLon, maxLat, maxLon) {
	const tl = latLonToTile(maxLat, minLon, 0);
	const br = latLonToTile(minLat, maxLon, 0);
	for (let z = 16; z >= 4; z--) {
		const scale = 2 ** z;
		const tilesX = Math.ceil((br.x - tl.x) * scale) + 1;
		const tilesY = Math.ceil((br.y - tl.y) * scale) + 1;
		if (tilesX * tilesY <= 20 && tilesX * TILE_SIZE >= 400) return z;
	}
	return 5;
}

async function fetchTile(z, x, y) {
	const key = `${z}/${x}/${y}`;
	if (tileCache.has(key)) return tileCache.get(key);
	if (pendingTiles.has(key)) return pendingTiles.get(key);

	const promise = (async () => {
		const sub = "abcd"[(x + y) % 4];
		const url = `https://${sub}.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`;
		const resp = await fetch(url, {
			headers: { "User-Agent": "gpx-ascii-map/1.0" },
			signal: AbortSignal.timeout(10000),
		});
		if (!resp.ok) throw new Error(`Tile ${z}/${x}/${y}: HTTP ${resp.status}`);
		const img = await Jimp.read(Buffer.from(await resp.arrayBuffer()));
		pendingTiles.delete(key);
		if (tileCache.size >= 200) tileCache.delete(tileCache.keys().next().value);
		tileCache.set(key, img);
		return img;
	})();

	pendingTiles.set(key, promise);
	promise.catch(() => pendingTiles.delete(key));
	return promise;
}

// Fetch, stitch, and return a Jimp image cropped to [minLon,minLat]→[maxLon,maxLat]
async function buildMapImage(minLat, minLon, maxLat, maxLon) {
	const zoom = pickZoom(minLat, minLon, maxLat, maxLon);

	const tl = latLonToTile(maxLat, minLon, zoom);
	const br = latLonToTile(minLat, maxLon, zoom);
	const txMin = Math.floor(tl.x),
		txMax = Math.floor(br.x);
	const tyMin = Math.floor(tl.y),
		tyMax = Math.floor(br.y);
	const cols = txMax - txMin + 1,
		rows = tyMax - tyMin + 1;

	const jobs = [];
	for (let ty = tyMin; ty <= tyMax; ty++) {
		for (let tx = txMin; tx <= txMax; tx++) {
			jobs.push(
				fetchTile(zoom, tx, ty)
					.then((img) => ({ img, col: tx - txMin, row: ty - tyMin }))
					.catch(() => null),
			);
		}
	}
	const tiles = await Promise.all(jobs);
	console.log(
		`Tiles: zoom=${zoom}, ${cols}×${rows} grid, ${tiles.filter(Boolean).length}/${tiles.length} fetched`,
	);

	const stitched = await Jimp.create(
		cols * TILE_SIZE,
		rows * TILE_SIZE,
		0xf5f5f5ff,
	);
	for (const t of tiles) {
		if (t) stitched.composite(t.img, t.col * TILE_SIZE, t.row * TILE_SIZE);
	}

	// Pixel coords within the stitched image for a lat/lon
	function px(lat, lon) {
		const { x, y } = latLonToTile(lat, lon, zoom);
		return [(x - txMin) * TILE_SIZE, (y - tyMin) * TILE_SIZE];
	}

	const [cropX, cropY] = px(maxLat, minLon).map(Math.floor);
	const [cropX2, cropY2] = px(minLat, maxLon).map(Math.ceil);
	const cropW = Math.max(1, cropX2 - cropX);
	const cropH = Math.max(1, cropY2 - cropY);
	stitched.crop(cropX, cropY, cropW, cropH);

	return stitched;
}

// ── Pixel → ASCII ─────────────────────────────────────────────────────────────

// ASCII chars indexed by 4-bit water mask: bit3=TL bit2=TR bit1=BL bit0=BR
const WATER_BLOCKS = [
	null,
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	"~",
	null,
];

// Positron water ≈ RGB(159, 196, 203) — light blue-gray, g≈b both > r
function isWater(r, g, b) {
	const lum = (r + g + b) / 3;
	return (
		lum > 175 && lum < 240 && g >= r + 4 && b >= r + 4 && Math.abs(b - g) < 10
	);
}

// CartoDB Positron No Labels color → ASCII char + terrain type
function classifyPixel(r, g, b) {
	if (isWater(r, g, b)) return ["~", "water"];

	// Nature / vegetation: green channel leads red and blue.
	// Positron parks ≈ RGB(212, 234, 210) — g leads r by ~22, b by ~24.
	// Use a low threshold (3/1) so park cells survive averaging with roads:
	// even a cell that's 80% road still has a 3–5pt green lead on red.
	if (g > r + 3 && g > b + 1) return ["%", "nature"];

	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	if (lum > 242) return ["/", "land"];
	if (lum > 220) return ["/", "land"];
	if (lum > 195) return ["-", "urban"];
	if (lum > 165) return ["/", "urban"];
	return ["#", "urban"];
}

function imageToASCII(img, MAP_W, MAP_H) {
	const W = img.bitmap.width,
		H = img.bitmap.height;
	const data = img.bitmap.data;
	const cellW = W / MAP_W,
		cellH = H / MAP_H;

	const grid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(" "));
	const typeGrid = Array.from({ length: MAP_H }, () =>
		new Array(MAP_W).fill("bg"),
	);

	function avgColor(x0, y0, x1, y1) {
		x1 = Math.min(x1, W - 1);
		y1 = Math.min(y1, H - 1);
		let r = 0,
			g = 0,
			b = 0,
			n = 0;
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const i = (y * W + x) * 4;
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
				n++;
			}
		}
		return n > 0 ? [r / n, g / n, b / n] : [245, 245, 245];
	}

	for (let row = 0; row < MAP_H; row++) {
		for (let col = 0; col < MAP_W; col++) {
			const x0 = Math.floor(col * cellW),
				x1 = Math.floor((col + 1) * cellW);
			const y0 = Math.floor(row * cellH),
				y1 = Math.floor((row + 1) * cellH);
			const mx = (x0 + x1) >> 1,
				my = (y0 + y1) >> 1;

			// Sample each quadrant to detect coastal transitions
			const qTL = avgColor(x0, y0, mx, my);
			const qTR = avgColor(mx + 1, y0, x1, my);
			const qBL = avgColor(x0, my + 1, mx, y1);
			const qBR = avgColor(mx + 1, my + 1, x1, y1);

			const wTL = isWater(...qTL),
				wTR = isWater(...qTR);
			const wBL = isWater(...qBL),
				wBR = isWater(...qBR);
			const waterCount =
				(wTL ? 1 : 0) + (wTR ? 1 : 0) + (wBL ? 1 : 0) + (wBR ? 1 : 0);

			if (waterCount === 4) {
				grid[row][col] = "~";
				typeGrid[row][col] = "water";
			} else if (waterCount > 0) {
				const mask =
					(wTL ? 8 : 0) | (wTR ? 4 : 0) | (wBL ? 2 : 0) | (wBR ? 1 : 0);
				grid[row][col] = WATER_BLOCKS[mask];
				typeGrid[row][col] = "coast";
			} else {
				const [ar, ag, ab] = avgColor(x0, y0, x1, y1);
				const [ch, type] = classifyPixel(ar, ag, ab);
				grid[row][col] = ch;
				typeGrid[row][col] = type;
			}
		}
	}

	return { grid, typeGrid };
}

// ── Place Names ───────────────────────────────────────────────────────────────

async function fetchPlaceNames(minLat, minLon, maxLat, maxLon) {
	const bbox = `${minLat.toFixed(6)},${minLon.toFixed(6)},${maxLat.toFixed(6)},${maxLon.toFixed(6)}`;
	const query = `[out:json][timeout:10];
(
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter)$"](${bbox});
  node["natural"~"^(peak|bay|cape|island|volcano)$"]["name"](${bbox});
  node["amenity"~"^(hospital|university|museum|theatre|stadium)$"]["name"](${bbox});
);
out body;`;

	try {
		const resp = await fetch("https://overpass-api.de/api/interpreter", {
			method: "POST",
			body: `data=${encodeURIComponent(query)}`,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: AbortSignal.timeout(10000),
		});
		if (!resp.ok) return [];
		const json = await resp.json();
		return (json.elements || [])
			.map((el) => ({
				lat: el.lat,
				lon: el.lon,
				name: el.tags?.name,
				place: el.tags?.place || el.tags?.natural || el.tags?.amenity,
			}))
			.filter((p) => p.name && p.lat != null && p.lon != null);
	} catch (e) {
		console.warn("Place names fetch failed:", e.message);
		return [];
	}
}

// ── Elevation Profile ─────────────────────────────────────────────────────────

function buildElevHTML(points, MAP_W, totalSteps, stepMs) {
	const pts = points.filter((p) => p.ele !== null);
	if (pts.length < 2) return null;

	const dists = [0];
	for (let i = 1; i < pts.length; i++)
		dists.push(dists[i - 1] + haversine(pts[i - 1], pts[i]));
	const totalDist = dists[dists.length - 1];

	const eles = pts.map((p) => p.ele);
	const minE = Math.min(...eles);
	const maxE = Math.max(...eles);
	const rangeE = maxE - minE || 1;

	const ELEV_H = 8;
	const LABEL_W = 8; // "1234 m  " right-aligned
	const CHART_W = MAP_W - LABEL_W - 1; // -1 for the Y-axis '|' char

	// Sample elevation at each chart column via linear interpolation
	const samples = Array.from({ length: CHART_W }, (_, col) => {
		const d = (col / (CHART_W - 1)) * totalDist;
		const i = dists.findIndex((x) => x >= d);
		if (i < 0) return pts[pts.length - 1].ele;
		if (i === 0) return pts[0].ele;
		const t = (d - dists[i - 1]) / (dists[i] - dists[i - 1]);
		return pts[i - 1].ele + t * (pts[i].ele - pts[i - 1].ele);
	});

	// Precompute per-column animation delay: column x-fraction maps to the same
	// totalSteps timeline used by the route, so elevation reveals in lock-step.
	const colDelay = Array.from({ length: CHART_W }, (_, col) => {
		const step = Math.round((col / (CHART_W - 1)) * totalSteps);
		return (step * stepMs).toFixed(1);
	});

	const html = [];

	// Chart rows — filled bar chart, top row = maxE, bottom row = minE
	for (let row = 0; row < ELEV_H; row++) {
		const lo = maxE - ((row + 1) / ELEV_H) * rangeE;
		const label =
			row === 0
				? `${Math.round(maxE)} m`.padStart(LABEL_W)
				: row === ELEV_H - 1
					? `${Math.round(minE)} m`.padStart(LABEL_W)
					: " ".repeat(LABEL_W);

		const cells = samples.map((e) => (e >= lo ? "#" : " "));
		let rowHtml = `<span class="bg">${escapeHtml(label)}|</span>`;
		let i = 0;
		while (i < cells.length) {
			if (cells[i] === "#") {
				rowHtml += `<span class="elev" style="--d:${colDelay[i]}ms">#</span>`;
				i++;
			} else {
				let j = i + 1;
				while (j < cells.length && cells[j] !== "#") j++;
				rowHtml += `<span class="bg">${" ".repeat(j - i)}</span>`;
				i = j;
			}
		}
		html.push(rowHtml);
	}

	// X-axis
	html.push(
		`<span class="bg">${escapeHtml(`${" ".repeat(LABEL_W)}+${"-".repeat(CHART_W)}`)}</span>`,
	);

	// Distance labels spread across the chart width
	const totalKm = totalDist / 1000;
	const distArr = Array(CHART_W).fill(" ");
	for (let t = 0; t <= 4; t++) {
		const frac = t / 4;
		const col = Math.round(frac * (CHART_W - 1));
		const km = frac * totalKm;
		const lbl =
			km < 0.1 ? "0" : `${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
		const start = Math.max(
			0,
			Math.min(CHART_W - lbl.length, col - Math.floor(lbl.length / 2)),
		);
		for (let c = 0; c < lbl.length && start + c < CHART_W; c++)
			distArr[start + c] = lbl[c];
	}
	html.push(
		`<span class="bg">${escapeHtml(`${" ".repeat(LABEL_W)} ${distArr.join("")}`)}</span>`,
	);

	return html;
}

// ── ASCII Rendering ───────────────────────────────────────────────────────────

const MAP_W = 120;
const CHAR_ASPECT = 0.5; // char width / char height (Courier New @ line-height 1.2)

async function renderASCII(points, name) {
	let minLat = Infinity,
		maxLat = -Infinity,
		minLon = Infinity,
		maxLon = -Infinity;
	for (const p of points) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lon < minLon) minLon = p.lon;
		if (p.lon > maxLon) maxLon = p.lon;
	}

	const latPad = (maxLat - minLat) * 0.12 || 0.005;
	const lonPad = (maxLon - minLon) * 0.12 || 0.005;
	minLat -= latPad;
	maxLat += latPad;
	minLon -= lonPad;
	maxLon += lonPad;

	const latRange = maxLat - minLat;
	const lonRange = maxLon - minLon;
	const midLat = (minLat + maxLat) / 2;

	let MAP_H = Math.round(
		(latRange / (lonRange * Math.cos((midLat * Math.PI) / 180))) *
			MAP_W *
			CHAR_ASPECT,
	);
	MAP_H = Math.max(18, Math.min(100, MAP_H));

	// Fetch tile image and place names in parallel
	const [img, placeNames] = await Promise.all([
		buildMapImage(minLat, minLon, maxLat, maxLon),
		fetchPlaceNames(minLat, minLon, maxLat, maxLon),
	]);

	// Convert tile image to ASCII grid
	const { grid, typeGrid } = imageToASCII(img, MAP_W, MAP_H);

	// Grid coordinate helper
	function toGrid(lat, lon) {
		const gx = Math.round(((lon - minLon) / lonRange) * (MAP_W - 1));
		const gy = Math.round(((maxLat - lat) / latRange) * (MAP_H - 1));
		return [
			Math.max(0, Math.min(MAP_W - 1, gx)),
			Math.max(0, Math.min(MAP_H - 1, gy)),
		];
	}

	function writeStr(row, col, str, type) {
		for (let i = 0; i < str.length; i++) {
			if (col + i >= 0 && col + i < MAP_W) {
				grid[row][col + i] = str[i];
				typeGrid[row][col + i] = type;
			}
		}
	}

	// Collect route pixels, tracking total steps (including re-traversals) for
	// correct animation timing when the route doubles back over itself.
	let renderPts = points;
	if (points.length > 3000) {
		const step = Math.ceil(points.length / 3000);
		renderPts = points.filter((_, i) => i % step === 0);
		renderPts.push(points[points.length - 1]);
	}
	const routePixels = [];          // unique pixels in first-visit order
	const firstStep = new Map();     // "x,y" → total-step index at first visit
	const lastRevisit = new Map();   // "x,y" → total-step index at most recent revisit
	let totalSteps = 0;

	for (let i = 1; i < renderPts.length; i++) {
		const [x0, y0] = toGrid(renderPts[i - 1].lat, renderPts[i - 1].lon);
		const [x1, y1] = toGrid(renderPts[i].lat, renderPts[i].lon);
		for (const [px, py] of bresenham(x0, y0, x1, y1)) {
			const key = `${px},${py}`;
			if (!firstStep.has(key)) {
				firstStep.set(key, totalSteps);
				routePixels.push([px, py]);
			} else {
				lastRevisit.set(key, totalSteps);
			}
			totalSteps++;
		}
	}

	// Assign each pixel a character based on local direction (prev→next),
	// so corners blend rather than switching abruptly mid-cell.
	const last = routePixels.length - 1;
	for (let i = 0; i <= last; i++) {
		const [x, y] = routePixels[i];
		const [px, py] = routePixels[Math.max(0, i - 1)];
		const [nx, ny] = routePixels[Math.min(last, i + 1)];
		grid[y][x] = dirChar(nx - px, ny - py);
		typeGrid[y][x] = "route";
	}

	// Per-pixel grids: first-visit step and most-recent revisit step (-1 = none)
	const riGrid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(0));
	const rvGrid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(-1));
	for (const [x, y] of routePixels) {
		const key = `${x},${y}`;
		riGrid[y][x] = firstStep.get(key);
		if (lastRevisit.has(key)) rvGrid[y][x] = lastRevisit.get(key);
	}
	// Step size based on total traversal so outbound and return animate at the same speed
	const stepMs = totalSteps > 0
		? Math.max(0.5, Math.min(15, 2500 / totalSteps))
		: 4;

	// Start / end markers
	const [sx, sy] = toGrid(points[0].lat, points[0].lon);
	const [ex, ey] = toGrid(
		points[points.length - 1].lat,
		points[points.length - 1].lon,
	);
	writeStr(sy, sx - 1, "[A]", "marker");
	writeStr(ey, ex - 1, "[B]", "marker");

	// Compass rose
	const cr = 1,
		cc = MAP_W - 9;
	for (let i = 0; i < COMPASS.length; i++) {
		for (let j = 0; j < COMPASS[i].length; j++) {
			if (cr + i < MAP_H && cc + j < MAP_W) {
				grid[cr + i][cc + j] = COMPASS[i][j];
				typeGrid[cr + i][cc + j] = "bg";
			}
		}
	}

	// Place name labels — most important first, skip if overlapping route/markers
	const placeOrder = [
		"city",
		"town",
		"village",
		"hamlet",
		"suburb",
		"neighbourhood",
		"quarter",
	];
	placeNames.sort((a, b) => {
		const ai = placeOrder.indexOf(a.place ?? ""),
			bi = placeOrder.indexOf(b.place ?? "");
		return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
	});
	for (const p of placeNames) {
		const [gx, gy] = toGrid(p.lat, p.lon);
		const label = p.name;
		const startX = gx - Math.floor(label.length / 2);
		if (startX < 0 || startX + label.length > MAP_W) continue;
		const blocked = typeGrid[gy]
			.slice(startX, startX + label.length)
			.some((t) => t === "route" || t === "marker" || t === "label");
		if (blocked) continue;
		writeStr(gy, startX, label, "label");
	}

	// ── HTML output ───────────────────────────────────────────────────────────

	function rowToHtml(mapLine, typeRow, riRow, rvRow) {
		let html = "";
		let i = 0;
		while (i < mapLine.length) {
			const t = typeRow[i];
			if (t === "route") {
				const d1 = (riRow[i] * stepMs).toFixed(1);
				const rv = rvRow[i];
				const cls = rv >= 0 ? "route revisit" : "route";
				const style = rv >= 0
					? `--d1:${d1}ms;--d2:${(rv * stepMs).toFixed(1)}ms`
					: `--d1:${d1}ms`;
				html += `<span class="${cls}" style="${style}">${escapeHtml(mapLine[i])}</span>`;
				i++;
				continue;
			}
			let j = i + 1;
			while (j < mapLine.length && typeRow[j] === t) j++;
			const chunk = escapeHtml(mapLine.slice(i, j));
			if (t === "marker") html += `<span class="marker">${chunk}</span>`;
			else if (t === "water") html += `<span class="water">${chunk}</span>`;
			else if (t === "coast") html += `<span class="coast">${chunk}</span>`;
			else if (t === "nature") html += `<span class="nature">${chunk}</span>`;
			else if (t === "land") html += `<span class="land">${chunk}</span>`;
			else if (t === "urban") html += `<span class="urban">${chunk}</span>`;
			else if (t === "label") html += `<span class="label">${chunk}</span>`;
			else html += `<span class="bg">${chunk}</span>`;
			i = j;
		}
		return html;
	}

	const mapLines = grid.map((row) => row.join(""));
	const titleRaw = name ? `[ ${name} ]` : "[ GPX Route ]";
	const titleHtml = name
		? `<span class="bg">[ </span>${escapeHtml(name)}<span class="bg"> ]</span>`
		: `<span class="bg">[ GPX Route ]</span>`;
	const titlePadLen = Math.max(0, MAP_W - titleRaw.length);
	const bg = (s) => `<span class="bg">${escapeHtml(s)}</span>`;

	const rows = [];
	rows.push(bg(`+${"-".repeat(MAP_W)}+`));
	rows.push(bg("|") + titleHtml + bg(`${" ".repeat(titlePadLen)}|`));
	for (let y = 0; y < MAP_H; y++) {
		rows.push(bg("|") + rowToHtml(mapLines[y], typeGrid[y], riGrid[y], rvGrid[y]) + bg("|"));
	}
	rows.push(bg(`+${"-".repeat(MAP_W)}+`));

	const elevRows = buildElevHTML(points, MAP_W, totalSteps, stepMs);
	if (elevRows) {
		const elevLabel = " elevation profile";
		rows.push(
			bg("|") + bg(elevLabel) + bg(`${" ".repeat(MAP_W - elevLabel.length)}|`),
		);
		for (const r of elevRows) rows.push(`${bg("|")}${r}${bg("|")}`);
		rows.push(bg(`+${"-".repeat(MAP_W)}+`));
	}

	rows.push(bg(" map © OpenStreetMap contributors · CartoDB"));

	return rows.join("\n");
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post("/api/upload", upload.single("gpx"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "No file uploaded." });

		const content = req.file.buffer.toString("utf-8");
		const points = parseGPX(content);

		if (points.length === 0) {
			return res
				.status(400)
				.json({ error: "No track points found in GPX file." });
		}

		const name = extractName(content);
		const stats = computeStats(points);

		const bounds = {
			minLat: Math.min(...points.map((p) => p.lat)),
			maxLat: Math.max(...points.map((p) => p.lat)),
			minLon: Math.min(...points.map((p) => p.lon)),
			maxLon: Math.max(...points.map((p) => p.lon)),
		};

		const ascii = await renderASCII(points, name);

		const id = uuidv4().replace(/-/g, "").slice(0, 10);

		const shareData = {
			id,
			name,
			ascii,
			format: "html",
			stats: {
				...stats,
				distanceFmt: fmtDist(stats.distance),
				durationFmt: fmtDuration(stats.duration),
				elevGainFmt:
					stats.elevGain !== null ? `+${Math.round(stats.elevGain)} m` : null,
				elevLossFmt:
					stats.elevLoss !== null ? `-${Math.round(stats.elevLoss)} m` : null,
			},
			pointCount: points.length,
			bounds,
			createdAt: new Date().toISOString(),
		};

		fs.writeFileSync(
			path.join(DATA_DIR, `${id}.json`),
			JSON.stringify(shareData),
		);

		res.json(shareData);
	} catch (err) {
		console.error("Upload error:", err);
		res.status(500).json({ error: "Failed to process GPX file." });
	}
});

app.get("/api/share/:id", (req, res) => {
	const id = req.params.id.replace(/[^a-f0-9]/gi, "");
	const filePath = path.join(DATA_DIR, `${id}.json`);
	if (!fs.existsSync(filePath)) {
		return res.status(404).json({ error: "Route not found." });
	}
	res.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`GPX ASCII Map running at http://localhost:${PORT}`);
});
