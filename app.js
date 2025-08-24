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
let RATE_LIMIT_MS = 1200; // ajustable por UI
const PARALLEL_REQUESTS = 4; // concurrencia controlada

// Estado global
let map, clusterGroup, allMarkers = [], allData = [];
let clusterRadiusSetting = 40; // 0..100 desde el slider
let preloadedGeocoded = {}; // direccion-> {lat,lon}
let initialCacheOnly = true; // al inicio, intentar dibujar desde cache sin CSV
let lastGeocodeTs = 0;

// UI refs
const statTotal = () => document.getElementById('stat-total');
const statGeocoded = () => document.getElementById('stat-geocoded');
const statVisible = () => document.getElementById('stat-visible');
const progressBar = () => document.getElementById('progress-bar');
const progressText = () => document.getElementById('progress-text');
const controlPanel = () => document.getElementById('control-panel');
const LS_KEYS = { cluster: 'ui:clusterRadius' };

// Helpers
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function keyFor(address) { return `geo:${address.toLowerCase()}`; }
function normalizeAddressForKey(address) { return (address || '').toLowerCase().trim(); }
function parseNumberFlexible(v) {
    if (v == null) return NaN;
    const s = String(v).trim().replace(',', '.');
    return parseFloat(s);
}
function getCoordsFromRow(row) {
    const latKeys = ['Lat', 'lat', 'LAT', 'Latitude', 'latitude', 'Latitud', 'latitud', 'Y', 'y'];
    const lonKeys = ['Lon', 'lon', 'LON', 'Lng', 'lng', 'Long', 'long', 'Longitude', 'longitude', 'Longitud', 'longitud', 'X', 'x'];
    let lat; let lon;
    for (const k of latKeys) { if (row[k] != null && row[k] !== '') { lat = parseNumberFlexible(row[k]); break; } }
    for (const k of lonKeys) { if (row[k] != null && row[k] !== '') { lon = parseNumberFlexible(row[k]); break; } }
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    return null;
}
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

function loadCSVFromFile(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
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
    // Cache precargada (geocoded.json) en memoria
    const norm = normalizeAddressForKey(q);
    if (preloadedGeocoded[norm]) {
        localStorage.setItem(k, JSON.stringify(preloadedGeocoded[norm]));
        return preloadedGeocoded[norm];
    }

    // Rate-limit sencillo
    const delta = Date.now() - lastGeocodeTs;
    if (delta < RATE_LIMIT_MS) await sleep(RATE_LIMIT_MS - delta);

    const params = new URLSearchParams({
        q: `${q}`,
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

function createCustomIcon() {
    return L.divIcon({
        className: 'custom-marker',
        html: `<div style="transform: translate(-50%, -50%); display:flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:999px; background: linear-gradient(180deg,#00e0ff,#00ffa3); color:#00131a; font-weight:800; font-size:11px; border:2px solid #001b2e; box-shadow: 0 4px 10px rgba(0,0,0,0.4)">★</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -10],
    });
}

function markerForRow(row, lat, lon) {
    const icon = createCustomIcon();
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

// No filters: siempre mostrar todos los puntos

async function processData(rows) {
    allData = rows.filter(r => r && (r['Direccion'] || r['Dirección'] || r['direccion']));
    statTotal().textContent = String(allData.length);
    setProgress(0, allData.length);

    // Sin filtros, no construimos UI de regiones

    // Geocodificación más rápida: concurrencia + render incremental + cache progresiva
    let done = 0; let geocodedCount = 0; const failedAddresses = [];
    const queue = [];
    // Sembrar coordenadas de filas que ya traen Lat/Lon en CSV
    for (const row of allData) {
        const coords = getCoordsFromRow(row);
        if (coords) {
            row._geo = coords;
            // Sembrar cache para la clave compuesta
            const direccion = (row['Direccion'] ?? row['Dirección'] ?? row['direccion'] ?? '').trim();
            const barrio = (row['Barrio'] ?? row['barrio'] ?? '').trim();
            const key = normalizeAddressForKey(barrio ? `${direccion}, ${barrio}` : `${direccion}`);
            if (key) localStorage.setItem(keyFor(key), JSON.stringify(row._geo));
            geocodedCount++;
            const m = markerForRow(row, coords.lat, coords.lon);
            allMarkers.push(m);
            clusterGroup.addLayer(m);
        } else {
            queue.push(row);
        }
    }

    async function worker() {
        while (queue.length) {
            const row = queue.shift();
            const direccion = row['Direccion'] ?? row['Dirección'] ?? row['direccion'];
            const barrio = row['Barrio'] ?? row['barrio'] ?? '';
            const query = `${direccion}`;
            // const query = barrio ? `${direccion}, ${barrio}` : `${direccion}`;
            try {
                const geo = await geocodeAddress(query);
                if (geo) {
                    row._geo = geo; // cachea en memoria
                    geocodedCount++;
                    // render incremental: agregar marcador y actualizar visible
                    const m = markerForRow(row, geo.lat, geo.lon);
                    allMarkers.push(m);
                    clusterGroup.addLayer(m);
                    updateVisibleCount();
                } else {
                    failedAddresses.push(query);
                }
            } catch (e) {
                console.warn('Geocode fallo', query, e);
                failedAddresses.push(query);
            } finally {
                done++;
                setProgress(done, allData.length);
                statGeocoded().textContent = String(geocodedCount);
            }
        }
    }

    // Lanzar N workers en paralelo
    const workers = Array.from({ length: PARALLEL_REQUESTS }, () => worker());
    await Promise.all(workers);

    if (geocodedCount > 0) fireConfetti();
    // Una vez finalizado, ya están todos los marcadores cargados
    updateVisibleCount();

    // Loguear direcciones sin coordenadas
    if (failedAddresses.length) {
        const uniques = Array.from(new Set(failedAddresses));
        console.log('Direcciones sin coordenadas (%d):', uniques.length);
        uniques.forEach(addr => console.log(addr));
    }
}

function setupMap() {
    map = L.map('map', {
        zoomControl: true,
        minZoom: MAP_INITIAL.minZoom,
        maxZoom: MAP_INITIAL.maxZoom,
    }).setView(MAP_INITIAL.center, MAP_INITIAL.zoom);

    // Base map: CARTO Positron (claro/blanco)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap & CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    // Crear cluster group inicial
    clusterGroup = createClusterGroup();
    attachClusterEvents(clusterGroup);

    map.addLayer(clusterGroup);

    map.on('moveend zoomend', updateVisibleCount);
}

// Crear cluster group con radio actual
function createClusterGroup() {
    // Mapear 0..100 a pixeles de radio (0 => 0px, 100 => 200px por ejemplo)
    const radiusPx = Math.round((clusterRadiusSetting / 100) * 200);
    const opts = {
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: true,
        animateAddingMarkers: true,
        chunkedLoading: true,
        // Si radius es 0, desactivar clustering devolviendo -1
        maxClusterRadius: radiusPx === 0 ? 1 : radiusPx,
        iconCreateFunction: function (cluster) {
            const count = cluster.getChildCount();
            const c = count < 20 ? 'small' : count < 100 ? 'medium' : 'large';
            return L.divIcon({ html: `<div><span>${count}</span></div>`, className: `marker-cluster marker-cluster-${c}`, iconSize: L.point(40, 40) });
        },
    };
    return L.markerClusterGroup(opts);
}

// Asegurar comportamiento de zoom al hacer click en un cluster (y spiderfy si ya está muy cerca)
function attachClusterEvents(group) {
    group.on('clusterclick', function (a) {
        // Zoom a límites del cluster
        a.layer.zoomToBounds({ padding: [40, 40] });
        // Si ya estamos muy cerca y sigue agrupado, spiderfy para separar
        if (map.getZoom() >= 16) {
            try { a.layer.spiderfy(); } catch (_) { }
        }
    });
}

function wireUI() {
    // Sin buscador ni filtros
    document.getElementById('toggle-panel-btn').addEventListener('click', () => {
        controlPanel().classList.toggle('collapsed');
        // Ajuste de mapa cuando el panel se oculta/muestra
        setTimeout(() => map.invalidateSize(), 260);
    });
    // Velocidad fija por defecto (1 req/s); sin UI
    // Selección manual de CSV
    const selectCsvBtn = document.getElementById('select-csv-btn');
    const csvInput = document.getElementById('csv-file-input');
    if (selectCsvBtn && csvInput) {
        selectCsvBtn.addEventListener('click', () => csvInput.click());
        csvInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                setProgress(0, 0);
                progressText().textContent = 'Cargando CSV...';
                const rows = await loadCSVFromFile(file);
                await processData(rows);
            } catch (err) {
                console.error(err);
                alert('No se pudo leer el CSV.');
            }
        });
    }
    // Slider de agrupación
    const clusterRange = document.getElementById('cluster-range');
    if (clusterRange) {
        // Set initial from persisted
        const persistedCluster = localStorage.getItem(LS_KEYS.cluster);
        if (persistedCluster !== null) {
            const v = parseInt(persistedCluster, 10);
            if (!Number.isNaN(v)) {
                clusterRadiusSetting = v;
                clusterRange.value = String(v);
            }
        } else {
            clusterRange.value = String(clusterRadiusSetting);
        }
        clusterRange.addEventListener('input', () => {
            clusterRadiusSetting = parseInt(clusterRange.value, 10) || 0;
            localStorage.setItem(LS_KEYS.cluster, String(clusterRadiusSetting));
            // Re-crear el cluster group manteniendo los marcadores
            const prevMarkers = allMarkers.slice();
            map.removeLayer(clusterGroup);
            clusterGroup = createClusterGroup();
            map.addLayer(clusterGroup);
            attachClusterEvents(clusterGroup);
            if (prevMarkers.length) clusterGroup.addLayers(prevMarkers);
            updateVisibleCount();
        });
    }
    // Guardar JSON
    document.getElementById('save-json-btn').addEventListener('click', () => {
        const out = {};
        for (const row of allData) {
            const direccion = row['Direccion'] ?? row['Dirección'] ?? row['direccion'];
            const barrio = row['Barrio'] ?? row['barrio'] ?? '';
            const key = normalizeAddressForKey(barrio ? `${direccion}, ${barrio}` : `${direccion}`);
            if (row._geo) out[key] = { lat: row._geo.lat, lon: row._geo.lon };
        }
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'geocoded.json';
        a.click();
        URL.revokeObjectURL(a.href);
    });
    // Guardar CSV
    document.getElementById('save-csv-btn').addEventListener('click', () => {
        // Exportar CSV original + dos columnas nuevas Lat y Lon
        // Preservamos columnas base si vienen en el CSV, y agregamos al final Lat,Lon
        const cols = ['Region', 'Región', 'region', 'Barrio', 'barrio', 'Direccion', 'Dirección', 'direccion'];
        const pick = (r, keys) => {
            for (const k of keys) if (r[k] != null && r[k] !== '') return String(r[k]);
            return '';
        };
        const header = ['Region', 'Barrio', 'Direccion', 'Lat', 'Lon'];
        const lines = allData.map(r => {
            const region = pick(r, ['Region', 'Región', 'region']);
            const barrio = pick(r, ['Barrio', 'barrio']);
            const direccion = pick(r, ['Direccion', 'Dirección', 'direccion']);
            const lat = r._geo?.lat ?? '';
            const lon = r._geo?.lon ?? '';
            // Encerrar siempre en comillas y duplicar comillas internas para evitar problemas con comas
            const q = v => '"' + String(v).replace(/"/g, '""') + '"';
            return `${q(region)},${q(barrio)},${q(direccion)},${lat},${lon}`;
        });
        const csv = header.join(',') + '\n' + lines.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'geocoded.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    });
    // Importar JSON
    const importBtn = document.getElementById('import-json-btn');
    const importInput = document.getElementById('import-json-input');
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const obj = JSON.parse(text);
            // Sembrar cache localStorage
            Object.entries(obj).forEach(([normKey, val]) => {
                if (val && typeof val.lat === 'number' && typeof val.lon === 'number') {
                    localStorage.setItem(keyFor(normKey), JSON.stringify(val));
                    preloadedGeocoded[normKey] = val;
                }
            });
            alert('Geolocalizaciones importadas y cacheadas. Recargá para aplicar rápido.');
        } catch (err) {
            console.error(err);
            alert('No se pudo importar el JSON.');
        }
    });
    // Botón de recarga eliminado
    document.getElementById('clear-cache-btn').addEventListener('click', () => {
        Object.keys(localStorage).filter(k => k.startsWith('geo:') || k.startsWith('ui:')).forEach(k => localStorage.removeItem(k));
        alert('Guardado borrado (coordenadas y preferencias).');
    });
}

async function init(forceReload = false) {
    // Si no se fuerza, mantenemos data en memoria
    if (forceReload) {
        allData = []; allMarkers = [];
        clusterGroup && clusterGroup.clearLayers();
        setProgress(0, 0);
    }

    try {
        // Leer preferencias persistidas antes de crear mapa
        try {
            const pCluster = localStorage.getItem(LS_KEYS.cluster);
            if (pCluster !== null) {
                const v = parseInt(pCluster, 10);
                if (!Number.isNaN(v)) clusterRadiusSetting = v;
            }
        } catch (_) { /* ignore */ }
        if (!map) setupMap();
        wireUI();
        // Intento de precarga automática desde geocoded.json (si existe en la carpeta)
        try {
            const preloadRes = await fetch('geocoded.json', { cache: 'no-store' });
            if (preloadRes.ok) {
                const obj = await preloadRes.json();
                preloadedGeocoded = obj || {};
                // Pre-sembrar localStorage para velocidad inmediata
                Object.entries(preloadedGeocoded).forEach(([normKey, val]) => {
                    if (val && typeof val.lat === 'number' && typeof val.lon === 'number') {
                        localStorage.setItem(keyFor(normKey), JSON.stringify(val));
                    }
                });
            }
        } catch (_) { /* silencioso si no existe */ }
        // Si hay direcciones cacheadas previas, dibujarlas sin CSV para no esperar
        if (initialCacheOnly) {
            // Mostrar puntos desde cache si existen claves geo:*
            const keys = Object.keys(localStorage).filter(k => k.startsWith('geo:'));
            if (keys.length) {
                for (const k of keys) {
                    try {
                        const val = JSON.parse(localStorage.getItem(k));
                        if (val && typeof val.lat === 'number' && typeof val.lon === 'number') {
                            const m = L.marker([val.lat, val.lon], { icon: createCustomIcon() });
                            allMarkers.push(m);
                        }
                    } catch (_) { }
                }
                if (allMarkers.length) {
                    clusterGroup.addLayers(allMarkers);
                    updateVisibleCount();
                    progressText().textContent = 'Mostrando posiciones desde caché. Seleccioná un CSV para ver detalles.';
                } else {
                    progressText().textContent = 'Seleccioná un CSV para cargar los datos.';
                }
            } else {
                progressText().textContent = 'Seleccioná un CSV para cargar los datos.';
            }
        }
    } catch (e) {
        progressText().textContent = 'Error al cargar o procesar el CSV';
        console.error(e);
        alert('Hubo un problema al cargar data.csv. Ver la consola para más detalles.');
    }
}

// Kickoff
init();
