/* Small spherical-geometry helpers. Works in the browser (window.Geo) and in Node (module.exports). */
(function (root) {
  'use strict';
  var R = 6371.0088; // mean Earth radius, km
  var rad = function (d) { return d * Math.PI / 180; };
  var deg = function (r) { return r * 180 / Math.PI; };

  /** Great-circle distance in km between [lon, lat] points. */
  function haversineKm(a, b) {
    var dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    var s = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** Point reached from p = [lon, lat] after travelling km along bearingDeg. */
  function destination(p, bearingDeg, km) {
    var d = km / R, br = rad(bearingDeg), lat1 = rad(p[1]), lon1 = rad(p[0]);
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
    var lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [deg(lon2), deg(lat2)];
  }

  /** Keep consecutive longitudes within 180 degrees of each other so lines do not wrap across the map. */
  function unwrap(coords) {
    var out = [], off = 0;
    for (var i = 0; i < coords.length; i++) {
      var lon = coords[i][0] + off;
      if (i > 0) {
        var prev = out[i - 1][0];
        while (lon - prev > 180) { lon -= 360; off -= 360; }
        while (lon - prev < -180) { lon += 360; off += 360; }
      }
      out.push([lon, coords[i][1]]);
    }
    return out;
  }

  /** Points along the great circle from a to b (inclusive), n segments. */
  function greatCircle(a, b, n) {
    n = n || 48;
    var phi1 = rad(a[1]), lam1 = rad(a[0]), phi2 = rad(b[1]), lam2 = rad(b[0]);
    var d = haversineKm(a, b) / R;
    if (d < 1e-9) return [a.slice(), b.slice()];
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
      var y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
      var z = A * Math.sin(phi1) + B * Math.sin(phi2);
      pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
    }
    return unwrap(pts);
  }

  /** Closed ring (GeoJSON polygon coordinates) of radius km around centre. */
  function circle(center, km, steps) {
    steps = steps || 96;
    var ring = [];
    for (var i = 0; i < steps; i++) ring.push(destination(center, (360 * i) / steps, km));
    var u = unwrap(ring);
    u.push(u[0].slice());
    return u;
  }

  /** Lat/lon graticule as a GeoJSON FeatureCollection of LineStrings. */
  function graticule(stepDeg) {
    stepDeg = stepDeg || 30;
    var f = [], lon, lat, i;
    for (lon = -180; lon <= 180; lon += stepDeg) {
      var m = []; for (lat = -80; lat <= 80; lat += 5) m.push([lon, lat]);
      f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: m } });
    }
    for (lat = -60; lat <= 60; lat += stepDeg) {
      var p = []; for (i = -180; i <= 180; i += 5) p.push([i, lat]);
      f.push({ type: 'Feature', properties: { equator: lat === 0 }, geometry: { type: 'LineString', coordinates: p } });
    }
    return { type: 'FeatureCollection', features: f };
  }

  var api = { haversineKm: haversineKm, destination: destination, greatCircle: greatCircle, circle: circle, graticule: graticule, unwrap: unwrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Geo = api;
})(typeof window !== 'undefined' ? window : this);
