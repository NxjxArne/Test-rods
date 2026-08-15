// api.js — talks to public OSM geocoding + routing services
'use strict';

const RodsAPI = (() => {
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const OSRM = 'https://router.project-osrm.org';

  async function geocode(query) {
    const url = `${NOMINATIM}/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    return data.map(d => ({
      label: d.display_name,
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
    }));
  }

  // Route between an ordered list of {lat,lng} waypoints.
  // Returns { points: [{lat,lng},...], distance, duration }
  async function route(waypoints, { avoidHighways = false } = {}) {
    const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Routing service unavailable');
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error('No route found between those points');
    }
    const r = data.routes[0];
    const points = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    return { points, distance: r.distance, duration: r.duration };
  }

  // For free-roam: given current position + heading, ask OSRM for a route
  // that continues roughly in that direction for `aheadMeters`. We fake a
  // destination point out along the current bearing and let OSRM snap it to
  // the real road network, so the resulting path follows actual roads.
  async function routeAhead(from, headingDeg, aheadMeters) {
    const dest = Geo.destinationPoint(from, headingDeg, aheadMeters);
    return route([from, dest]);
  }

  return { geocode, route, routeAhead };
})();
