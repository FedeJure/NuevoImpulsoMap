# Mapa de Puntos — Argentina (desde CSV)

Este proyecto carga `data.csv` con columnas `Region`, `Barrio`, `Direccion`, geocodifica cada dirección (usando Nominatim/OSM) y dibuja los puntos en un mapa de Argentina con clustering inteligente.

Características
- UI/UX moderna, con panel lateral y estadísticas.
- Búsqueda por texto (barrio/dirección) y filtro por región.
- Clustering automático con visual llamativa.
- Cache local de geocodificación en `localStorage` para acelerar recargas.

Requisitos
- Un navegador moderno. No requiere servidor backend.
- Un archivo `data.csv` en la raíz del proyecto.

Uso
1. Colocá tu `data.csv` en la carpeta del proyecto. Formato:
   ```csv
   Region,Barrio,Direccion
   1,Palermo,Av. Santa Fe 3253
   2,Centro,Av. 9 de Julio 100
   ```
2. Abrí `index.html` con un servidor estático local. Por ejemplo, usando Python:

   Windows PowerShell/Bash (Python 3):
   ```bash
   # Opción 1: con Python 3
   python -m http.server 5500
   # Opción 2: con Node (si tenés npx)
   npx serve -l 5500
   ```
   Luego navegá a: http://localhost:5500/

Consejos
- Podés limpiar la caché de geocodificación con el botón "Limpiar caché" del panel.
- Para ser buenos ciudadanos con Nominatim, en `app.js` podés cambiar `USER_AGENT_EMAIL` a tu email.

Licencias
- Mapas: OpenStreetMap & CARTO tiles.
- Librerías: Leaflet, leaflet.markercluster, PapaParse, canvas-confetti.
