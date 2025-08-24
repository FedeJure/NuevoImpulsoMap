/*
  Mapa Interactivo de Argentina a partir de data.csv
  CSV esperado: Region (numero), Barrio (string), Direccion (string)
  - Carga CSV con PapaParse
  - Geocodifica direcciones con Nominatim (OSM) + cache en localStorage
  - Dibuja marcadores en Leaflet con clustering (leaflet.markercluster)
  - Filtro por texto y por región
  - UI gamificada con progreso y confetti al completar geocodificación
*/

const MAP_INITIAL = {
  center: [-38.4161, -63.6167], // Argentina
  zoom: 4,
  minZoom: 3,
  maxZoom: 18,
};

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT_EMAIL = 'example@example.com'; // opcional: reemplazar por un email propio para cortesía
const RATE_LIMIT_MS = 1200; // ~1 req/s para ser buenos ciudadanos

// Estado global
let map, clusterGroup, allMarkers = [], allData = [], filteredData = [], regionSet = new Set();
let lastGeocodeTs = 0;

// UI refs
const statTotal = () => document.getElementById('stat-total');
const statGeocoded = () => document.getElementById('stat-geocoded');
const statVisible = () => document.getElementById('stat-visible');
const regionsContainer = () => document.getElementById('regions-container');
const progressBar = () => document.getElementById('progress-bar');
const progressText = () => document.getElementById('progress-text');
const searchInput = () => document.getElementById('search-input');

// Helpers
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function keyFor(address) { return `geo:${address.toLowerCase()}`; }
function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressBar().style.width = `${pct}%`;
  progressText().textContent = `${done}/${total} geocodificados (${pct}%)`;
}

function fireConfetti() {
  if (typeof confetti !== 'function') return;
  confetti({
    particleCount: 150,
    spread: 70,
    origin: { y: 0.6 },
    colors: ['#00e0ff', '#00ffa3', '#ffffff']
  });
}

function loadCSV() {
  return new Promise((resolve, reject) => {
    Papa.parse('data.csv', {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

async function geocodeAddress(q) {
  // Cache local
  const k = keyFor(q);
  const cached = localStorage.getItem(k);
  if (cached) return JSON.parse(cached);

  // Rate-limit sencillo
  const delta = Date.now() - lastGeocodeTs;
  if (delta < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - delta);

  const params = new URLSearchParams({
    q: `${q}, Argentina`,
    format: 'json',
    addressdetails: '0',
    limit: '1',
  countrycodes: 'ar',
  });
  if (USER_AGENT_EMAIL && USER_AGENT_EMAIL.includes('@')) {
    params.set('email', USER_AGENT_EMAIL);
  }

  const res = await fetch(`${NOMINATIM_ENDPOINT}?${params.toString()}`, {
    headers: {
      'Accept-Language': 'es',
      'Referer': location.origin,
      'User-Agent': `Argentina-Map-App/1.0 (${USER_AGENT_EMAIL})`
    }
  });
  lastGeocodeTs = Date.now();
  if (!res.ok) throw new Error(`Geocoding error ${res.status}`);
  const data = await res.json();
  const item = data && data[0] ? { lat: +data[0].lat, lon: +data[0].lon } : null;
  if (item) localStorage.setItem(k, JSON.stringify(item));
  return item;
}

function markerForRow(row, lat, lon) {
  const icon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="transform: translate(-50%, -50%); display:flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:999px; background: linear-gradient(180deg,#00e0ff,#00ffa3); color:#00131a; font-weight:800; font-size:11px; border:2px solid #001b2e; box-shadow: 0 4px 10px rgba(0,0,0,0.4)">★</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  });
  const m = L.marker([lat, lon], { icon });
  const barrio = row['Barrio'] ?? row['barrio'] ?? '';
  const direccion = row['Direccion'] ?? row['Dirección'] ?? row['direccion'] ?? '';
  const region = row['Region'] ?? row['Región'] ?? row['region'] ?? '';
  m.bindPopup(`
    <div>
      <div><strong>Dirección:</strong> ${direccion}</div>
      <div><strong>Barrio:</strong> ${barrio}</div>
      <div><strong>Región:</strong> ${region}</div>
    </div>
  `);
  return m;
}

function updateVisibleCount() {
  // Contar solo marcadores hoja (no clusters) dentro del viewport
  let visible = 0;
  clusterGroup.eachLayer(layer => {
    const isCluster = typeof layer.getAllChildMarkers === 'function';
    if (!isCluster && layer instanceof L.Marker && map.getBounds().contains(layer.getLatLng())) {
      visible++;
    }
  });
  statVisible().textContent = String(visible);
}

function buildRegionFilters() {
  const container = regionsContainer();
  container.innerHTML = '';
  const regions = Array.from(regionSet).sort((a,b) => +a - +b);
  const allBtn = document.createElement('div');
  allBtn.textContent = 'Todas';
  allBtn.className = 'region-chip active';
  allBtn.dataset.value = '';
  container.appendChild(allBtn);

  for (const r of regions) {
    const chip = document.createElement('div');
    chip.className = 'region-chip';
    chip.textContent = `Región ${r}`;
    chip.dataset.value = String(r);
    container.appendChild(chip);
  }

  container.addEventListener('click', (e) => {
    const target = e.target.closest('.region-chip');
    if (!target) return;
    container.querySelectorAll('.region-chip').forEach(c => c.classList.remove('active'));
    target.classList.add('active');
    applyFilters();
  });
}

function applyFilters() {
  const text = (searchInput().value || '').toLowerCase().trim();
  const activeChip = regionsContainer().querySelector('.region-chip.active');
  const regionFilter = activeChip ? activeChip.dataset.value : '';

  clusterGroup.clearLayers();
  allMarkers.length = 0;

  for (const row of filteredData) {
    // Filtro por región
    const region = String(row['Region'] ?? row['Región'] ?? row['region'] ?? '').trim();
    if (regionFilter && region !== regionFilter) continue;

    // Filtro por texto
    const barrio = String(row['Barrio'] ?? row['barrio'] ?? '').toLowerCase();
    const direccion = String(row['Direccion'] ?? row['Dirección'] ?? row['direccion'] ?? '').toLowerCase();
    if (text && !(barrio.includes(text) || direccion.includes(text))) continue;

    if (row._geo) {
      const m = markerForRow(row, row._geo.lat, row._geo.lon);
      allMarkers.push(m);
    }
  }

  clusterGroup.addLayers(allMarkers);
  statVisible().textContent = String(allMarkers.length);
}

async function processData(rows) {
  allData = rows.filter(r => r && (r['Direccion'] || r['Dirección'] || r['direccion']));
  statTotal().textContent = String(allData.length);
  setProgress(0, allData.length);

  // Crear set de regiones
  regionSet = new Set(allData.map(r => String(r['Region'] ?? r['Región'] ?? r['region'] ?? '').trim()).filter(Boolean));
  buildRegionFilters();

  let done = 0; let geocodedCount = 0;
  for (const row of allData) {
    const direccion = row['Direccion'] ?? row['Dirección'] ?? row['direccion'];
    const barrio = row['Barrio'] ?? row['barrio'] ?? '';
    const query = barrio ? `${direccion}, ${barrio}` : `${direccion}`;
    try {
      const geo = await geocodeAddress(query);
      if (geo) {
        row._geo = geo;
        geocodedCount++;
      }
    } catch (e) {
      console.warn('Geocode fallo', query, e);
    } finally {
      done++;
      setProgress(done, allData.length);
      statGeocoded().textContent = String(geocodedCount);
    }
  }

  if (geocodedCount > 0) fireConfetti();
  filteredData = allData.filter(r => r._geo);
  applyFilters();
}

function setupMap() {
  map = L.map('map', {
    zoomControl: true,
    minZoom: MAP_INITIAL.minZoom,
    maxZoom: MAP_INITIAL.maxZoom,
  }).setView(MAP_INITIAL.center, MAP_INITIAL.zoom);

  // Base map: Carto Dark Matter (bonito y legible)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap & CARTO',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  // Clustering con centroid agregando agrupación por proximidad
  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    animateAddingMarkers: true,
    chunkedLoading: true,
    iconCreateFunction: function(cluster) {
      const count = cluster.getChildCount();
      const c = count < 20 ? 'small' : count < 100 ? 'medium' : 'large';
      return L.divIcon({ html: `<div><span>${count}</span></div>`, className: `marker-cluster marker-cluster-${c}`, iconSize: L.point(40, 40) });
    },
  });

  clusterGroup.on('clusterclick', function (a) {
    // Si el zoom es lejano y hay superposición, acercamos; si ya está cerca, spiderfy
    if (a.layer._childCount > 10 && map.getZoom() < 12) {
      a.layer.zoomToBounds({ padding: [40, 40] });
    } else {
      a.layer.spiderfy();
    }
  });

  map.addLayer(clusterGroup);

  map.on('moveend zoomend', updateVisibleCount);
}

function wireUI() {
  searchInput().addEventListener('input', () => applyFilters());
  document.getElementById('reload-btn').addEventListener('click', async () => {
    await init(true);
  });
  document.getElementById('clear-cache-btn').addEventListener('click', () => {
    Object.keys(localStorage).filter(k => k.startsWith('geo:')).forEach(k => localStorage.removeItem(k));
    alert('Caché de geocodificación limpiada.');
  });
}

async function init(forceReload = false) {
  // Si no se fuerza, mantenemos data en memoria
  if (forceReload) {
    allData = []; filteredData = []; allMarkers = []; regionSet = new Set();
    clusterGroup && clusterGroup.clearLayers();
    regionsContainer().innerHTML = '';
    setProgress(0, 0);
  }

  try {
    if (!map) setupMap();
    wireUI();
    const rows = await loadCSV();
    await processData(rows);
  } catch (e) {
    progressText().textContent = 'Error al cargar o procesar el CSV';
    console.error(e);
    alert('Hubo un problema al cargar data.csv. Ver la consola para más detalles.');
  }
}

// Kickoff
init();
