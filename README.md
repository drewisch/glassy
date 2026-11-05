# Glassy

A free, lightweight surf forecast app. It models local surf height from open swell, wind and bathymetry data.

Work in progress.

## Data sources
- Swell, wind, tide and water temperature: [Open-Meteo](https://open-meteo.com) (Marine + Forecast APIs)
- Bathymetry and terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (ETOPO1, GEBCO, SRTM, NOAA Coastal Relief)
- Place search: Open-Meteo Geocoding; reverse geocoding: OpenStreetMap Nominatim
- Map: Leaflet with CARTO basemaps, © OpenStreetMap contributors

## Run locally
No build step. Serve the folder with any static server:

```bash
python3 -m http.server 5173
```
