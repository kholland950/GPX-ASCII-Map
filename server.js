const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static('public'));
app.use(express.json());

// ── GPX Parsing ──────────────────────────────────────────────────────────────

function parseGPX(content) {
  const points = [];
  // Match trkpt, rtept, or wpt opening tags (handle attribute order variation)
  const blockRe = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    const attrs = m[2];
    const inner = m[3] || '';
    const latM = attrs.match(/\blat="([^"]+)"/);
    const lonM = attrs.match(/\blon="([^"]+)"/);
    if (!latM || !lonM) continue;
    const eleM = inner.match(/<ele>([^<]+)<\/ele>/);
    const timeM = inner.match(/<time>([^<]+)<\/time>/);
    const lat = parseFloat(latM[1]);
    const lon = parseFloat(lonM[1]);
    if (isNaN(lat) || isNaN(lon)) continue;
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
  const φ1 = p1.lat * Math.PI / 180, φ2 = p2.lat * Math.PI / 180;
  const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
  const Δλ = (p2.lon - p1.lon) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeStats(points) {
  let distance = 0, elevGain = 0, elevLoss = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(points[i - 1], points[i]);
    if (points[i].ele !== null && points[i - 1].ele !== null) {
      const d = points[i].ele - points[i - 1].ele;
      if (d > 0) elevGain += d; else elevLoss += Math.abs(d);
    }
  }
  const hasEle = points.some(p => p.ele !== null);
  const hasTime = points[0]?.time && points[points.length - 1]?.time;
  let duration = null;
  if (hasTime) {
    duration = (points[points.length - 1].time - points[0].time) / 1000;
  }
  return { distance, elevGain: hasEle ? elevGain : null, elevLoss: hasEle ? elevLoss : null, duration };
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDuration(s) {
  if (!s) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtCoord(deg, posLabel, negLabel) {
  return `${Math.abs(deg).toFixed(4)}° ${deg >= 0 ? posLabel : negLabel}`;
}

// ── ASCII Rendering ───────────────────────────────────────────────────────────

function bresenham(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return pts;
}

// Map segment direction to ASCII character (screen coords: right=+x, down=+y)
function dirChar(dx, dy) {
  if (dx === 0 && dy === 0) return '*';
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const a = ((angle % 180) + 180) % 180; // 0-180
  if (a < 22.5 || a >= 157.5) return '-';
  if (a < 67.5) return (dy > 0) ? '\\' : '/';
  if (a < 112.5) return '|';
  return (dy > 0) ? '/' : '\\';
}

const COMPASS = [
  '  N  ',
  ' \\|/ ',
  'W-+-E',
  ' /|\\ ',
  '  S  ',
];

function renderASCII(points, name) {
  const MAP_W = 100;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const latPad = (maxLat - minLat) * 0.12 || 0.005;
  const lonPad = (maxLon - minLon) * 0.12 || 0.005;
  minLat -= latPad; maxLat += latPad;
  minLon -= lonPad; maxLon += lonPad;

  const midLat = (minLat + maxLat) / 2;
  const lonRange = maxLon - minLon;
  const latRange = maxLat - minLat;

  // Compute height for geographically proportional map
  // charAspect (w/h) ≈ 0.50; geo correction: lon degrees * cos(lat) = equivalent lat degrees
  const charAspect = 0.50;
  let MAP_H = Math.round((latRange / (lonRange * Math.cos(midLat * Math.PI / 180))) * MAP_W * charAspect);
  MAP_H = Math.max(18, Math.min(52, MAP_H));

  // Create grid filled with spaces
  const grid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(' '));

  // Background dot pattern (staggered)
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if ((x * 2 + y * 3) % 9 === 0) grid[y][x] = '.';
    }
  }

  // Lat/lon grid lines every ~nice interval
  function niceInterval(range, target) {
    const rough = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    for (const mult of [1, 2, 5, 10]) {
      if (mag * mult >= rough) return mag * mult;
    }
    return mag * 10;
  }

  const latInterval = niceInterval(latRange, 4);
  const lonInterval = niceInterval(lonRange, 5);

  function toGrid(lat, lon) {
    const x = Math.round(((lon - minLon) / lonRange) * (MAP_W - 1));
    const y = Math.round(((maxLat - lat) / latRange) * (MAP_H - 1));
    return [Math.max(0, Math.min(MAP_W - 1, x)), Math.max(0, Math.min(MAP_H - 1, y))];
  }

  // Draw lat grid lines (horizontal, faint)
  const firstLat = Math.ceil(minLat / latInterval) * latInterval;
  for (let lat = firstLat; lat <= maxLat; lat += latInterval) {
    const [, gy] = toGrid(lat, minLon);
    for (let x = 0; x < MAP_W; x++) {
      if (grid[gy][x] === ' ') grid[gy][x] = '·'; // middle dot
    }
  }

  // Draw lon grid lines (vertical, faint)
  const firstLon = Math.ceil(minLon / lonInterval) * lonInterval;
  for (let lon = firstLon; lon <= maxLon; lon += lonInterval) {
    const [gx] = toGrid(minLat, lon);
    for (let y = 0; y < MAP_H; y++) {
      if (grid[y][gx] === ' ' || grid[y][gx] === '·') grid[y][gx] = ':';
    }
  }

  // Subsample points if route is very dense
  let renderPoints = points;
  if (points.length > 3000) {
    const step = Math.ceil(points.length / 3000);
    renderPoints = points.filter((_, i) => i % step === 0);
    renderPoints.push(points[points.length - 1]);
  }

  // Draw route segments
  for (let i = 1; i < renderPoints.length; i++) {
    const [x0, y0] = toGrid(renderPoints[i - 1].lat, renderPoints[i - 1].lon);
    const [x1, y1] = toGrid(renderPoints[i].lat, renderPoints[i].lon);
    const dx = x1 - x0, dy = y1 - y0;
    const ch = dirChar(dx, dy);
    for (const [px, py] of bresenham(x0, y0, x1, y1)) {
      grid[py][px] = ch;
    }
  }

  // Start and end markers
  const [sx, sy] = toGrid(points[0].lat, points[0].lon);
  const [ex, ey] = toGrid(points[points.length - 1].lat, points[points.length - 1].lon);

  // Write markers with bounds check
  function writeStr(row, col, str) {
    for (let i = 0; i < str.length; i++) {
      if (col + i >= 0 && col + i < MAP_W) grid[row][col + i] = str[i];
    }
  }
  writeStr(sy, sx - 1, '[A]');
  writeStr(ey, ex - 1, '[B]');

  // Compass rose (top-right, 5 cols × 5 rows)
  const cr = 1, cc = MAP_W - 7;
  for (let i = 0; i < COMPASS.length; i++) {
    for (let j = 0; j < COMPASS[i].length; j++) {
      if (cr + i < MAP_H && cc + j < MAP_W) grid[cr + i][cc + j] = COMPASS[i][j];
    }
  }

  // Build lat labels for left margin (we'll prepend outside the map)
  const latLabels = {};
  for (let lat = firstLat; lat <= maxLat; lat += latInterval) {
    const [, gy] = toGrid(lat, minLon);
    latLabels[gy] = lat.toFixed(3);
  }

  // Build the text lines
  const mapLines = grid.map(row => row.join(''));

  // Header row: title centered in box
  const title = name ? `[ ${name} ]` : '[ GPX Route ]';
  const titlePad = Math.max(0, MAP_W - title.length);
  const header = title + ' '.repeat(titlePad);

  // Coordinate labels below the map
  const lonLabels = [];
  for (let lon = firstLon; lon <= maxLon; lon += lonInterval) {
    const [gx] = toGrid(minLat, lon);
    lonLabels.push({ gx, label: `${lon.toFixed(3)}` });
  }
  let lonLabelRow = new Array(MAP_W).fill(' ');
  for (const { gx, label } of lonLabels) {
    const start = Math.max(0, gx - Math.floor(label.length / 2));
    for (let i = 0; i < label.length && start + i < MAP_W; i++) {
      lonLabelRow[start + i] = label[i];
    }
  }

  // Left margin width
  const MARGIN = 8;

  function pad(n, w) { return String(n).padStart(w); }

  const borderTop    = ' '.repeat(MARGIN) + '+' + '-'.repeat(MAP_W) + '+';
  const borderBottom = ' '.repeat(MARGIN) + '+' + '-'.repeat(MAP_W) + '+';
  const headerLine   = ' '.repeat(MARGIN) + '|' + header + '|';

  const rows = [];
  rows.push(borderTop);
  rows.push(headerLine);

  for (let y = 0; y < MAP_H; y++) {
    const latLabel = latLabels[y] ? latLabels[y].padStart(MARGIN - 1) + ' ' : ' '.repeat(MARGIN);
    rows.push(latLabel + '|' + mapLines[y] + '|');
  }

  rows.push(borderBottom);
  rows.push(' '.repeat(MARGIN + 1) + lonLabelRow.join(''));

  return rows.join('\n');
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('gpx'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const content = req.file.buffer.toString('utf-8');
    const points = parseGPX(content);

    if (points.length === 0) {
      return res.status(400).json({ error: 'No track points found in GPX file.' });
    }

    const name = extractName(content);
    const stats = computeStats(points);
    const ascii = renderASCII(points, name);

    const id = uuidv4().replace(/-/g, '').slice(0, 10);

    const bounds = {
      minLat: Math.min(...points.map(p => p.lat)),
      maxLat: Math.max(...points.map(p => p.lat)),
      minLon: Math.min(...points.map(p => p.lon)),
      maxLon: Math.max(...points.map(p => p.lon)),
    };

    const shareData = {
      id,
      name,
      ascii,
      stats: {
        ...stats,
        distanceFmt: fmtDist(stats.distance),
        durationFmt: fmtDuration(stats.duration),
        elevGainFmt: stats.elevGain !== null ? `+${Math.round(stats.elevGain)} m` : null,
        elevLossFmt: stats.elevLoss !== null ? `-${Math.round(stats.elevLoss)} m` : null,
      },
      pointCount: points.length,
      bounds,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(shareData));

    res.json(shareData);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process GPX file.' });
  }
});

app.get('/api/share/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-f0-9]/gi, '');
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Route not found.' });
  }
  res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GPX ASCII Map running at http://localhost:${PORT}`);
});
