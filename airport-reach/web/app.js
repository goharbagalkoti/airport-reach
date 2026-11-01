/* Airport Reach: how far is the nearest large airport?
 * MapLibre GL JS front end. Optional Amazon Location Service for basemap, geocoding and routing. */
(function () {
  'use strict';

  var cfg = Object.assign({ region: '', apiKey: '', mapStyle: 'Standard', colorScheme: 'Dark', basemap: 'plain' },
    window.AIRPORT_REACH_CONFIG || {});
  var HAVE_AWS = Boolean(cfg.region && cfg.apiKey);

  var BANDS = [
    { max: 50, color: '#2dd4bf', label: 'Under 50 km' },
    { max: 100, color: '#a3e635', label: '50–100 km' },
    { max: 250, color: '#facc15', label: '100–250 km' },
    { max: 500, color: '#fb923c', label: '250–500 km' },
    { max: Infinity, color: '#f43f5e', label: '500 km and more' }
  ];
  var EMPTY = { type: 'FeatureCollection', features: [] };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmtInt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var fmtPop = function (n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(n);
  };
  var fmtKm = function (k) { return (k < 10 ? k.toFixed(1) : fmtInt(k)) + ' km'; };
  var bandOf = function (km) { for (var i = 0; i < BANDS.length; i++) if (km < BANDS[i].max) return i; return BANDS.length - 1; };
  var countryName = (function () {
    try { var dn = new Intl.DisplayNames(['en'], { type: 'region' }); return function (cc) { try { return dn.of(cc) || cc; } catch (e) { return cc; } }; }
    catch (e) { return function (cc) { return cc; }; }
  })();

  var map, cities = [], airports = [], byIata = {}, meta = {};
  var state = { minDist: 0, minPop: 0, country: '', view: [] };
  var hoverPopup, pinMarker = null, searchSeq = 0, searchTimer = null;

  /* ---------- data ---------- */
  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' → ' + r.status); return r.json(); });
  }

  function load() {
    return Promise.all([getJson('data/cities.geojson'), getJson('data/airports.geojson'), getJson('data/meta.json')])
      .then(function (res) {
        cities = res[0].features; airports = res[1].features; meta = res[2];
        cities.forEach(function (f, i) { f.properties.id = i; });
        airports.forEach(function (f) { byIata[f.properties.iata] = f; });
      });
  }

  /* ---------- map style ---------- */
  function styleSpec() {
    if (HAVE_AWS) {
      return 'https://maps.geo.' + cfg.region + '.amazonaws.com/v2/styles/' + encodeURIComponent(cfg.mapStyle) +
        '/descriptor?key=' + encodeURIComponent(cfg.apiKey) + '&color-scheme=' + encodeURIComponent(cfg.colorScheme);
    }
    return fallbackStyle(cfg.basemap);
  }

  function fallbackStyle(kind) {
    var style = {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } }]
    };
    if (kind === 'osm') {
      style.sources.osm = {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      };
      style.layers.push({ id: 'osm', type: 'raster', source: 'osm',
        paint: { 'raster-opacity': 0.9, 'raster-brightness-max': 0.5, 'raster-saturation': -0.7, 'raster-contrast': 0.1 } });
    }
    return style;
  }

  function labelFont() {
    if (!HAVE_AWS) return ['Open Sans Regular'];
    var layers = map.getStyle().layers || [];
    for (var i = 0; i < layers.length; i++) {
      var f = layers[i].layout && layers[i].layout['text-font'];
      if (layers[i].type === 'symbol' && Array.isArray(f)) {
        if (f[0] === 'literal' && Array.isArray(f[1])) return f[1];
        if (f.every(function (x) { return typeof x === 'string'; })) return f;
      }
    }
    return ['Noto Sans Regular'];
  }

  /* ---------- layers ---------- */
  function colorExpr() {
    var e = ['step', ['get', 'dist_km'], BANDS[0].color];
    for (var i = 1; i < BANDS.length; i++) e.push(BANDS[i - 1].max, BANDS[i].color);
    return e;
  }

  function addLayers() {
    var font = labelFont();
    var pm = function (lo, mid, hi) { return ['interpolate', ['linear'], ['get', 'pop'], 1e5, lo, 5e6, mid, 3e7, hi]; };

    if (!HAVE_AWS) {
      map.addSource('graticule', { type: 'geojson', data: Geo.graticule(30) });
      map.addLayer({ id: 'graticule', type: 'line', source: 'graticule',
        paint: { 'line-color': '#1b2a44', 'line-width': 0.8, 'line-opacity': 0.8 } });
    }
    ['rings', 'served', 'link', 'route', 'pin'].forEach(function (id) { map.addSource(id, { type: 'geojson', data: EMPTY }); });
    map.addSource('cities', { type: 'geojson', data: { type: 'FeatureCollection', features: cities } });
    map.addSource('airports', {
      type: 'geojson', data: { type: 'FeatureCollection', features: airports },
      cluster: true, clusterRadius: 45, clusterMaxZoom: 5
    });

    map.addLayer({ id: 'rings-fill', type: 'fill', source: 'rings', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.04 } });
    map.addLayer({ id: 'rings-line', type: 'line', source: 'rings',
      paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-opacity': 0.6, 'line-dasharray': [2, 3] } });
    map.addLayer({ id: 'served-lines', type: 'line', source: 'served',
      paint: { 'line-color': '#5eead4', 'line-width': 1, 'line-opacity': 0.35 } });

    map.addLayer({ id: 'cities-circle', type: 'circle', source: 'cities', paint: {
      'circle-color': colorExpr(),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, pm(1.5, 4, 8), 8, pm(5, 12, 22)],
      'circle-opacity': 0.82, 'circle-stroke-width': 0.6, 'circle-stroke-color': 'rgba(5,10,20,0.7)'
    } });
    map.addLayer({ id: 'cities-served', type: 'circle', source: 'cities', filter: ['==', ['get', 'nearest'], '__none__'], paint: {
      'circle-color': 'rgba(0,0,0,0)', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, pm(3, 6, 10), 8, pm(7, 14, 24)],
      'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff'
    } });

    map.addLayer({ id: 'link-line', type: 'line', source: 'link',
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#22d3ee', 'line-width': 4, 'line-opacity': 0.95 } });

    map.addLayer({ id: 'ap-cluster', type: 'circle', source: 'airports', filter: ['has', 'point_count'], paint: {
      'circle-color': '#38bdf8', 'circle-opacity': 0.88, 'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 30, 22],
      'circle-stroke-width': 1.5, 'circle-stroke-color': '#0b1220'
    } });
    map.addLayer({ id: 'ap-cluster-n', type: 'symbol', source: 'airports', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': font, 'text-size': 11, 'text-allow-overlap': true },
      paint: { 'text-color': '#04121f' } });
    map.addLayer({ id: 'ap-point', type: 'circle', source: 'airports', filter: ['!', ['has', 'point_count']], paint: {
      'circle-color': '#f8fafc', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 8, 6.5],
      'circle-stroke-width': 2, 'circle-stroke-color': '#38bdf8'
    } });
    map.addLayer({ id: 'ap-label', type: 'symbol', source: 'airports', minzoom: 3.5, filter: ['!', ['has', 'point_count']],
      layout: { 'text-field': ['get', 'iata'], 'text-font': font, 'text-size': 11, 'text-offset': [0, 1.0], 'text-anchor': 'top' },
      paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b1220', 'text-halo-width': 1.3 } });

    map.addLayer({ id: 'pin-circle', type: 'circle', source: 'pin', paint: {
      'circle-color': '#ffffff', 'circle-radius': 6, 'circle-stroke-width': 3, 'circle-stroke-color': '#f43f5e' } });
  }

  /* ---------- filtering + summary ---------- */
  function passes(p) {
    return p.dist_km >= state.minDist && p.pop >= state.minPop && (!state.country || p.cc === state.country);
  }

  function median(sorted) {
    var n = sorted.length; if (!n) return 0;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  function refresh() {
    var f = ['all', ['>=', ['get', 'dist_km'], state.minDist], ['>=', ['get', 'pop'], state.minPop]];
    if (state.country) f.push(['==', ['get', 'cc'], state.country]);
    if (map && document.body.dataset.ready && map.getLayer('cities-circle')) map.setFilter('cities-circle', f);

    state.view = cities.filter(function (c) { return passes(c.properties); });
    var d = state.view.map(function (c) { return c.properties.dist_km; }).sort(function (a, b) { return a - b; });
    var pop = state.view.reduce(function (s, c) { return s + c.properties.pop; }, 0);
    $('k-count').textContent = fmtInt(state.view.length);
    $('k-pop').textContent = fmtPop(pop);
    $('k-median').textContent = d.length ? fmtKm(median(d)) : '–';
    $('k-max').textContent = d.length ? fmtKm(d[d.length - 1]) : '–';
    $('distVal').textContent = fmtInt(state.minDist) + ' km';

    var top = state.view.slice().sort(function (a, b) { return b.properties.dist_km - a.properties.dist_km; }).slice(0, 12);
    $('remote').innerHTML = top.map(function (c) {
      var p = c.properties;
      return '<li data-id="' + p.id + '" tabindex="0"><span>' + esc(p.name) + ', ' + esc(p.cc) +
        '</span><span class="d">' + fmtKm(p.dist_km) + ' → ' + esc(p.nearest) + '</span></li>';
    }).join('') || '<li class="hint">No cities match these filters.</li>';
  }

  /* ---------- selection ---------- */
  function setSrc(id, data) { var s = map.getSource(id); if (s) s.setData(data); }
  function line(coords) { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }; }
  function fc(features) { return { type: 'FeatureCollection', features: features }; }

  function clearSelection() {
    ['rings', 'served', 'link', 'route', 'pin'].forEach(function (id) { setSrc(id, EMPTY); });
    if (map.getLayer('cities-served')) map.setFilter('cities-served', ['==', ['get', 'nearest'], '__none__']);
    $('detail').innerHTML = '<p class="hint">Click a city, an airport, or any empty spot on the map. Airports show who they serve; cities and pins show the way to the nearest airport.</p>';
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }

  function setRings(airportFeature) {
    var c = airportFeature.geometry.coordinates;
    setSrc('rings', fc([100, 250].map(function (km) {
      return { type: 'Feature', properties: { km: km }, geometry: { type: 'Polygon', coordinates: [Geo.circle(c, km)] } };
    })));
  }

  function nearestAirport(lonlat) {
    var best = null, bd = Infinity;
    for (var i = 0; i < airports.length; i++) {
      var d = Geo.haversineKm(lonlat, airports[i].geometry.coordinates);
      if (d < bd) { bd = d; best = airports[i]; }
    }
    return { airport: best, km: bd };
  }

  function fitTo(points, maxZoom) {
    var b = new maplibregl.LngLatBounds(points[0], points[0]);
    points.forEach(function (p) { b.extend(p); });
    map.fitBounds(b, { padding: 70, maxZoom: maxZoom || 8, duration: 900 });
  }

  function distanceBlock(km, airport) {
    var b = BANDS[bandOf(km)], p = airport.properties;
    return '<div class="big"><span class="chip" style="background:' + b.color + '"></span>' + fmtKm(km) + '</div>' +
      '<div>to <b>' + esc(p.name) + '</b> (' + esc(p.iata) + ')</div>';
  }

  function selectCity(f, opts) {
    var p = f.properties, c = f.geometry.coordinates, ap = byIata[p.nearest];
    if (!ap) return;
    clearMarkerState();
    setSrc('link', line(Geo.greatCircle(c, ap.geometry.coordinates)));
    setRings(ap);
    $('detail').innerHTML =
      '<h3>' + esc(p.name) + '</h3><div class="meta">' + esc(countryName(p.cc)) + ' · about ' + fmtPop(p.pop) + ' people</div>' +
      distanceBlock(p.dist_km, ap) +
      '<div class="actions"><button data-act="route">Route to airport</button><button data-act="airport">Open airport</button></div>' +
      '<div id="routeInfo" class="meta"></div>';
    $('detail').dataset.from = JSON.stringify(c);
    $('detail').dataset.to = JSON.stringify(ap.geometry.coordinates);
    $('detail').dataset.iata = p.nearest;
    if (!opts || !opts.noFit) fitTo([c, ap.geometry.coordinates]);
    if (history.replaceState) history.replaceState(null, '', '#c=' + encodeURIComponent(p.name + ',' + p.cc));
  }

  function selectAirport(f, opts) {
    var p = f.properties, iata = p.iata;
    clearMarkerState();
    var served = cities.filter(function (c) { return c.properties.nearest === iata; });
    setSrc('served', fc(served.slice(0, 500).map(function (c) {
      return line(Geo.greatCircle(f.geometry.coordinates, c.geometry.coordinates, 16));
    })));
    map.setFilter('cities-served', ['==', ['get', 'nearest'], iata]);
    setRings(f);
    var top = served.slice().sort(function (a, b) { return b.properties.pop - a.properties.pop; }).slice(0, 6);
    var far = served.reduce(function (m, c) { return Math.max(m, c.properties.dist_km); }, 0);
    $('detail').innerHTML =
      '<h3>' + esc(p.name) + '</h3><div class="meta">' + esc(p.iata) + (p.icao ? ' · ' + esc(p.icao) : '') + ' · ' +
      esc(p.city || '') + ', ' + esc(countryName(p.cc)) + '</div>' +
      '<div><b>' + fmtInt(served.length) + '</b> cities have this as their nearest large airport, home to about <b>' +
      fmtPop(served.reduce(function (s, c) { return s + c.properties.pop; }, 0)) + '</b> people' +
      (served.length ? '; the farthest is ' + fmtKm(far) + ' away' : '') + '.</div>' +
      (top.length ? '<ul>' + top.map(function (c) {
        return '<li>' + esc(c.properties.name) + ' · ' + fmtKm(c.properties.dist_km) + '</li>';
      }).join('') + '</ul>' : '') +
      '<div class="meta">Dashed rings: 100 km and 250 km.</div>';
    if (!opts || !opts.noFit) {
      var pts = [f.geometry.coordinates].concat(served.slice(0, 200).map(function (c) { return c.geometry.coordinates; }));
      fitTo(pts, 7);
    }
    if (history.replaceState) history.replaceState(null, '', '#a=' + encodeURIComponent(iata));
  }

  function dropPin(lonlat, label) {
    clearMarkerState();
    var r = nearestAirport(lonlat);
    if (!r.airport) return;
    setSrc('pin', fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lonlat } }]));
    setSrc('link', line(Geo.greatCircle(lonlat, r.airport.geometry.coordinates)));
    setRings(r.airport);
    $('detail').innerHTML =
      '<h3>' + esc(label || 'Dropped pin') + '</h3><div class="meta">' + lonlat[1].toFixed(4) + ', ' + lonlat[0].toFixed(4) + '</div>' +
      distanceBlock(r.km, r.airport) +
      '<div class="actions"><button data-act="route">Route to airport</button><button data-act="airport">Open airport</button></div>' +
      '<div id="routeInfo" class="meta"></div>';
    $('detail').dataset.from = JSON.stringify(lonlat);
    $('detail').dataset.to = JSON.stringify(r.airport.geometry.coordinates);
    $('detail').dataset.iata = r.airport.properties.iata;
    fitTo([lonlat, r.airport.geometry.coordinates]);
    if (history.replaceState) history.replaceState(null, '', '#p=' + lonlat[1].toFixed(4) + ',' + lonlat[0].toFixed(4));
  }

  function clearMarkerState() {
    ['rings', 'served', 'link', 'route', 'pin'].forEach(function (id) { setSrc(id, EMPTY); });
    map.setFilter('cities-served', ['==', ['get', 'nearest'], '__none__']);
  }

  /* ---------- Amazon Location: routing + geocoding ---------- */
  function awsPost(host, path, body) {
    var url = 'https://' + host + '.geo.' + cfg.region + '.amazonaws.com' + path + '?key=' + encodeURIComponent(cfg.apiKey);
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(host + ' ' + r.status + ' ' + t.slice(0, 160)); });
        return r.json();
      });
  }

  function awsRoute(from, to) {
    return awsPost('routes', '/v2/routes', { Origin: from, Destination: to, TravelMode: 'Car', LegGeometryFormat: 'Simple' })
      .then(function (j) {
        var r = (j.Routes || [])[0];
        if (!r) throw new Error('no route');
        var coords = [], dist = 0, dur = 0;
        (r.Legs || []).forEach(function (leg) {
          var ls = leg.Geometry && leg.Geometry.LineString;
          if (ls) coords = coords.concat(ls);
          var ov = leg.VehicleLegDetails && leg.VehicleLegDetails.Summary && leg.VehicleLegDetails.Summary.Overview;
          if (ov) { dist += ov.Distance || 0; dur += ov.Duration || 0; }
        });
        if (r.Summary && r.Summary.Distance != null) { dist = r.Summary.Distance; }
        if (r.Summary && r.Summary.Duration != null) { dur = r.Summary.Duration; }
        if (!coords.length) throw new Error('route had no geometry');
        return { coords: coords, km: dist / 1000, minutes: dur / 60 };
      });
  }

  function showRoute() {
    var d = $('detail'); if (!d.dataset.from) return;
    var from = JSON.parse(d.dataset.from), to = JSON.parse(d.dataset.to), info = $('routeInfo');
    var straight = Geo.haversineKm(from, to);
    if (!HAVE_AWS) {
      info.textContent = 'Straight-line distance ' + fmtKm(straight) + '. Add an Amazon Location key in config.js for driving routes.';
      return;
    }
    info.textContent = 'Asking Amazon Location for a driving route…';
    awsRoute(from, to).then(function (r) {
      setSrc('route', line(r.coords));
      setSrc('link', EMPTY);
      info.textContent = 'Driving: ' + fmtKm(r.km) + ', about ' + (r.minutes >= 90 ? (r.minutes / 60).toFixed(1) + ' h' : Math.round(r.minutes) + ' min') +
        ' (straight line ' + fmtKm(straight) + ').';
      fitTo(r.coords.length > 400 ? [from, to] : r.coords);
    }).catch(function (e) {
      info.textContent = 'No driving route available (' + e.message + '). Straight-line distance is ' + fmtKm(straight) + '.';
    });
  }

  function awsSearch(q) {
    var c = map.getCenter();
    return awsPost('places', '/v2/search-text', { QueryText: q, MaxResults: 4, BiasPosition: [c.lng, c.lat] })
      .then(function (j) {
        return (j.ResultItems || []).filter(function (it) { return it.Position; }).map(function (it) {
          return { kind: 'place', label: it.Title || (it.Address && it.Address.Label) || q,
            sub: (it.Address && it.Address.Label) || '', pos: it.Position };
        });
      });
  }

  /* ---------- search ---------- */
  function localSearch(q) {
    q = q.toLowerCase();
    var out = [];
    airports.forEach(function (a) {
      var p = a.properties, hay = (p.iata + ' ' + p.name + ' ' + (p.city || '')).toLowerCase();
      if (hay.indexOf(q) !== -1) out.push({ kind: 'airport', label: p.iata + ' · ' + p.name, rank: p.iata.toLowerCase() === q ? 0 : 1, f: a });
    });
    cities.forEach(function (c) {
      var p = c.properties;
      if (p.name.toLowerCase().indexOf(q) !== -1)
        out.push({ kind: 'city', label: p.name + ', ' + p.cc, rank: p.name.toLowerCase().indexOf(q) === 0 ? 1 : 2, pop: p.pop, f: c });
    });
    out.sort(function (a, b) { return a.rank - b.rank || (b.pop || 0) - (a.pop || 0); });
    return out.slice(0, 6);
  }

  function renderResults(items) {
    var ul = $('results');
    ul.innerHTML = items.map(function (it, i) {
      return '<li role="option" tabindex="0" data-i="' + i + '"><span>' + esc(it.label) +
        (it.sub ? '<br><small class="tag">' + esc(it.sub) + '</small>' : '') + '</span><span class="tag">' +
        (it.kind === 'place' ? 'Amazon Location' : it.kind) + '</span></li>';
    }).join('');
    ul.hidden = !items.length;
    ul._items = items;
  }

  function chooseResult(it) {
    $('results').hidden = true;
    $('q').value = it.label;
    if (it.kind === 'airport') selectAirport(it.f);
    else if (it.kind === 'city') selectCity(it.f);
    else dropPin(it.pos, it.label);
  }

  function onSearchInput() {
    var q = $('q').value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { renderResults([]); return; }
    var seq = ++searchSeq, local = localSearch(q);
    renderResults(local);
    if (HAVE_AWS && q.length >= 3) {
      searchTimer = setTimeout(function () {
        awsSearch(q).then(function (places) { if (seq === searchSeq) renderResults(local.concat(places)); })
          .catch(function (e) { console.warn('Amazon Location search failed:', e.message); });
      }, 250);
    }
  }

  /* ---------- wiring ---------- */
  function popupHtml(p, isAirport) {
    return isAirport
      ? '<b>' + esc(p.iata) + '</b> · ' + esc(p.name) + '<br>' + fmtInt(p.served_cities) + ' cities served'
      : '<b>' + esc(p.name) + '</b>, ' + esc(p.cc) + '<br>' + fmtKm(p.dist_km) + ' to ' + esc(p.nearest);
  }

  function wireMap() {
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    ['cities-circle', 'ap-point'].forEach(function (layer) {
      map.on('mousemove', layer, function (e) {
        var f = e.features && e.features[0]; if (!f) return;
        map.getCanvas().style.cursor = 'pointer';
        hoverPopup.setLngLat(f.geometry.coordinates).setHTML(popupHtml(f.properties, layer === 'ap-point')).addTo(map);
      });
      map.on('mouseleave', layer, function () { map.getCanvas().style.cursor = ''; hoverPopup.remove(); });
    });
    map.on('mouseenter', 'ap-cluster', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'ap-cluster', function () { map.getCanvas().style.cursor = ''; });

    map.on('click', function (e) {
      var hits = map.queryRenderedFeatures(e.point, { layers: ['ap-cluster', 'ap-point', 'cities-circle'] });
      var top = hits[0];
      if (!top) { dropPin([e.lngLat.lng, e.lngLat.lat]); return; }
      if (top.layer.id === 'ap-cluster') {
        map.getSource('airports').getClusterExpansionZoom(top.properties.cluster_id).then(function (z) {
          map.easeTo({ center: top.geometry.coordinates, zoom: z + 0.2 });
        });
      } else if (top.layer.id === 'ap-point') {
        selectAirport(byIata[top.properties.iata]);
      } else {
        selectCity(cities[top.properties.id]);
      }
    });
  }

  function wireUi() {
    $('dist').addEventListener('input', function (e) { state.minDist = +e.target.value; refresh(); });
    $('pop').addEventListener('change', function (e) { state.minPop = +e.target.value; refresh(); });
    $('country').addEventListener('change', function (e) { state.country = e.target.value; refresh(); });
    $('q').addEventListener('input', onSearchInput);
    $('q').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var it = ($('results')._items || [])[0]; if (it) chooseResult(it); }
      if (e.key === 'Escape') { $('results').hidden = true; }
    });
    $('results').addEventListener('click', function (e) {
      var li = e.target.closest('li[data-i]'); if (li) chooseResult($('results')._items[+li.dataset.i]);
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.search')) $('results').hidden = true; });
    $('remote').addEventListener('click', function (e) {
      var li = e.target.closest('li[data-id]'); if (li) selectCity(cities[+li.dataset.id]);
    });
    $('remote').addEventListener('keydown', function (e) {
      var li = e.target.closest('li[data-id]'); if (li && e.key === 'Enter') selectCity(cities[+li.dataset.id]);
    });
    $('detail').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      if (b.dataset.act === 'route') showRoute();
      if (b.dataset.act === 'airport') selectAirport(byIata[$('detail').dataset.iata]);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !e.target.closest('input')) clearSelection(); });

    var basemap = $('basemap');
    if (HAVE_AWS) { $('basemapRow').hidden = true; }
    else {
      basemap.value = cfg.basemap === 'osm' ? 'osm' : 'plain';
      basemap.addEventListener('change', function () { cfg.basemap = basemap.value; location.reload(); });
    }
  }

  function buildStatic() {
    $('legend').innerHTML = BANDS.map(function (b) {
      return '<span><i style="background:' + b.color + '"></i>' + b.label + '</span>';
    }).join('');

    var ccs = {};
    cities.forEach(function (c) { ccs[c.properties.cc] = true; });
    var opts = Object.keys(ccs).map(function (cc) { return { cc: cc, name: countryName(cc) }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    $('country').innerHTML = '<option value="">All</option>' + opts.map(function (o) {
      return '<option value="' + esc(o.cc) + '">' + esc(o.name) + '</option>';
    }).join('');

    if (meta.label === 'seed') {
      var b = $('banner'); b.hidden = false;
      b.textContent = 'Sample data: ' + meta.counts.airports + ' airports and ' + meta.counts.cities +
        ' cities with approximate coordinates and populations, bundled so the app runs offline. ' +
        'Run pipeline/build_dataset.py for the full OurAirports + GeoNames dataset.';
    }
    $('foot').innerHTML = esc(meta.attribution || '') + ' Distances are great-circle. ' +
      (HAVE_AWS ? 'Basemap, search and routing: Amazon Location Service. ' : '') +
      'Built with <a href="https://maplibre.org">MapLibre GL JS</a>.';
  }

  function restoreFromHash() {
    var h = decodeURIComponent(location.hash.slice(1)), m;
    if ((m = /^a=([A-Z0-9]{3})$/.exec(h)) && byIata[m[1]]) selectAirport(byIata[m[1]]);
    else if ((m = /^c=(.+),([A-Z]{2})$/.exec(h))) {
      var f = cities.filter(function (c) { return c.properties.name === m[1] && c.properties.cc === m[2]; })[0];
      if (f) selectCity(f);
    } else if ((m = /^p=(-?\d+\.?\d*),(-?\d+\.?\d*)$/.exec(h))) dropPin([+m[2], +m[1]]);
  }

  function start() {
    map = new maplibregl.Map({
      container: 'map', style: styleSpec(), center: [20, 25], zoom: 1.6, minZoom: 1, attributionControl: { compact: true }
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    window.__map = map; // handy for debugging in the console

    map.on('error', function (e) { console.warn('map error:', e && e.error && e.error.message); });
    map.once('load', function () {
      addLayers(); wireMap();
      document.body.dataset.ready = '1';
      refresh(); restoreFromHash();
    });
  }

  load().then(function () { buildStatic(); wireUi(); state.view = cities; start(); })
    .catch(function (e) {
      $('detail').innerHTML = '<p class="hint"><b>Could not load the data.</b> ' + esc(e.message) +
        '<br>Run <code>python pipeline/build_dataset.py --seed</code>, then serve the <code>web/</code> folder (for example <code>python -m http.server -d web</code>).</p>';
    });
})();
