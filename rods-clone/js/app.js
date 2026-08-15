// app.js — main application controller
'use strict';

const App = (() => {
  // ---------- state ----------
  const state = {
    mode: null,           // 'plan' | 'roam'
    units: 'km',          // 'km' | 'mi'
    severityMode: 'simple',// 'simple' | 'rally'
    timing: 'standard',   // 'early' | 'standard' | 'late'
    voiceURI: null,
    muted: false,

    driving: false,
    path: [],             // [{lat,lng}]
    cum: [],              // cumulative dist for path
    corners: [],          // detected corners along path
    announced: new Set(),
    watchId: null,
    wakeLock: null,
    lastFix: null,
    lastHeading: 0,
    speedMps: 0,
    map: null,
    mapRoute: null,
    mapMarker: null,
    mapStart: null,
    mapEnd: null,
    mapReady: false,
    mapRouteDirty: false,
    mapMarkerLastPos: null,

    // free-roam specific
    roamAheadMeters: 1500,
    roamExtendTriggerRemaining: 400, // extend when remaining path < this
    roamBusy: false,
  };

  const LEAD_SECONDS = { early: 7, standard: 4.5, late: 2.5 };
  const LEAD_MIN_M = 30;

  // ---------- dom ----------
  const $ = sel => document.querySelector(sel);
  const el = {};

  function cacheDom() {
    Object.assign(el, {
      screens: {
        home: $('#screen-home'),
        plan: $('#screen-plan'),
        drive: $('#screen-drive'),
        settings: $('#screen-settings'),
      },
      btnPlan: $('#btn-mode-plan'),
      btnRoam: $('#btn-mode-roam'),
      btnSettings: $('#btn-settings'),
      btnSettingsBack: $('#btn-settings-back'),
      startInput: $('#input-start'),
      destInput: $('#input-dest'),
      startResults: $('#start-results'),
      destResults: $('#dest-results'),
      useMyLocation: $('#btn-use-my-location'),
      planGo: $('#btn-plan-go'),
      planBack: $('#btn-plan-back'),
      planStatus: $('#plan-status'),
      driveExit: $('#btn-drive-exit'),
      driveMute: $('#btn-drive-mute'),
      speed: $('#drive-speed'),
      speedUnit: $('#drive-speed-unit'),
      cornerCard: $('#corner-card'),
      cornerArrow: $('#corner-arrow'),
      cornerLabel: $('#corner-label'),
      cornerDist: $('#corner-dist'),
      cornerNext: $('#corner-next'),
      ring: $('#ring-progress'),
      driveModeLabel: $('#drive-mode-label'),
      driveStatus: $('#drive-status'),
      unitsToggle: $('#toggle-units'),
      severityToggle: $('#toggle-severity'),
      timingSelect: $('#select-timing'),
      voiceSelect: $('#select-voice'),
      testVoiceBtn: $('#btn-test-voice'),
    });
  }

  function showScreen(name) {
    Object.values(el.screens).forEach(s => s.classList.remove('active'));
    el.screens[name].classList.add('active');
  }

  function ensureMap() {
    if (state.map || typeof L === 'undefined') return;

    state.map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      dragging: true,
      tap: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      noWrap: true,
    }).addTo(state.map);

    state.mapRoute = L.polyline([], {
      color: '#f5a623',
      weight: 6,
      opacity: 0.95,
    }).addTo(state.map);

    state.mapMarker = L.circleMarker([0, 0], {
      radius: 9,
      color: '#0b0d10',
      fillColor: '#4fd1e6',
      fillOpacity: 1,
      weight: 3,
    }).addTo(state.map);

    state.mapStart = L.circleMarker([0, 0], {
      radius: 6,
      color: '#0b0d10',
      fillColor: '#3ccb6f',
      fillOpacity: 1,
      weight: 3,
    }).addTo(state.map);

    state.mapEnd = L.circleMarker([0, 0], {
      radius: 6,
      color: '#0b0d10',
      fillColor: '#e5484d',
      fillOpacity: 1,
      weight: 3,
    }).addTo(state.map);
  }

  function updateMapView(fix = null) {
    if (!state.map || !state.path.length || typeof L === 'undefined') return;

    if (state.mapRouteDirty || !state.mapRoute.getLatLngs().length) {
      const coords = state.path.map(p => [p.lat, p.lng]);
      state.mapRoute.setLatLngs(coords);
      state.mapRouteDirty = false;
      if (coords.length) {
        state.mapStart.setLatLng(coords[0]);
        state.mapEnd.setLatLng(coords[coords.length - 1]);
      }
    }

    if (!state.mapReady) {
      const bounds = L.latLngBounds(state.path.map(p => [p.lat, p.lng]));
      if (bounds.isValid()) {
        state.map.fitBounds(bounds, { padding: [20, 20] });
        state.mapReady = true;
      }
    }

    if (fix) {
      const markerPoint = [fix.lat, fix.lng];
      const lastPos = state.mapMarker.getLatLng();
      const movedEnough = !lastPos || Geo.haversine({ lat: lastPos.lat, lng: lastPos.lng }, fix) > 8;
      if (movedEnough) state.mapMarker.setLatLng(markerPoint);

      const currentCenter = state.map.getCenter();
      const centerDist = Geo.haversine({ lat: currentCenter.lat, lng: currentCenter.lng }, fix);
      if (centerDist > 18) state.map.panTo(markerPoint, { animate: true, duration: 0.2 });
    }
  }

  // ---------- speech ----------
  function speak(text) {
    if (state.muted || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (state.voiceURI) {
      const v = speechSynthesis.getVoices().find(v => v.voiceURI === state.voiceURI);
      if (v) u.voice = v;
    }
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  function cornerPhrase(c) {
    const sev = state.severityMode === 'rally' ? c.rally : c.simple;
    const dirWord = c.direction === 'left' ? 'left' : 'right';
    if (state.severityMode === 'rally') {
      let s = `${dirWord} ${sev.code}`;
      if (c.trend !== 'constant') s += ` ${c.trend}`;
      return s;
    } else {
      let s = `${sev.label} ${dirWord}`;
      if (c.trend !== 'constant') s += ` ${c.trend}`;
      return s;
    }
  }

  // ---------- units ----------
  function fmtDist(meters) {
    if (state.units === 'mi') {
      const ft = meters * 3.28084;
      if (ft < 900) return `${Math.round(ft / 10) * 10} ft`;
      return `${(meters / 1609.34).toFixed(1)} mi`;
    }
    if (meters < 950) return `${Math.round(meters / 5) * 5} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function fmtSpeed(mps) {
    return state.units === 'mi' ? Math.round(mps * 2.23694) : Math.round(mps * 3.6);
  }

  // ---------- corner visuals ----------
  function updateCornerCard(c, distRemaining, next) {
    if (!c) {
      el.cornerArrow.style.transform = 'rotate(0deg)';
      el.cornerArrow.classList.remove('left', 'right');
      el.cornerLabel.textContent = 'Clear road';
      el.cornerDist.textContent = '—';
      el.cornerCard.dataset.sev = '0';
      setRing(0);
    } else {
      const bend = Math.min(75, (c.angle / 170) * 75);
      const sign = c.direction === 'left' ? -1 : 1;
      el.cornerArrow.style.transform = `rotate(${sign * bend}deg)`;
      el.cornerArrow.classList.toggle('left', c.direction === 'left');
      el.cornerArrow.classList.toggle('right', c.direction === 'right');
      const sev = state.severityMode === 'rally' ? c.rally : c.simple;
      const sevCode = state.severityMode === 'rally' ? sev.code : sev.code; // 1-3 or 1-6
      el.cornerCard.dataset.sev = String(sev.code);
      const label = state.severityMode === 'rally'
        ? `${c.direction === 'left' ? 'Left' : 'Right'} ${sev.code}`
        : `${sev.label} ${c.direction === 'left' ? 'left' : 'right'}`;
      el.cornerLabel.textContent = c.trend !== 'constant' ? `${label} · ${c.trend}` : label;
      el.cornerDist.textContent = fmtDist(Math.max(0, distRemaining));
      const lead = leadDistance();
      setRing(1 - Math.min(1, Math.max(0, distRemaining / lead)));
    }
    el.cornerNext.textContent = next
      ? `then ${next.direction} ${(state.severityMode === 'rally' ? next.rally.code : next.simple.label)} · ${fmtDist(next.gap)}`
      : '';
  }

  const RING_CIRC = 2 * Math.PI * 54;
  function setRing(fraction) {
    el.ring.style.strokeDashoffset = String(RING_CIRC * (1 - fraction));
  }

  // ---------- corner scheduling ----------
  function leadDistance() {
    return Math.max(LEAD_MIN_M, state.speedMps * LEAD_SECONDS[state.timing]);
  }

  function resetAnnouncements() { state.announced = new Set(); }

  function tickDrive(distAlong) {
    // find next un-passed, un-announced corner ahead
    const upcoming = state.corners.filter(c => c.distAlong > distAlong - 5);
    const current = upcoming[0];
    const next = upcoming[1];

    if (current) {
      const distRemaining = current.distAlong - distAlong;
      const lead = leadDistance();
      const key = current.distAlong.toFixed(0);
      if (distRemaining <= lead && !state.announced.has(key)) {
        state.announced.add(key);
        let phrase = cornerPhrase(current);
        // chain: if the following corner starts very soon after this one ends, mention it
        if (next && (next.startDist - current.endDist) < 60 && (next.distAlong - current.distAlong) < 120) {
          const nextSev = state.severityMode === 'rally' ? `${next.direction} ${next.rally.code}` : `${next.simple.label.toLowerCase()} ${next.direction}`;
          phrase += `, into ${nextSev}`;
        }
        phrase += `, ${Math.round(distRemaining)}`;
        speak(phrase);
      }
      updateCornerCard(current, distRemaining, next ? { ...next, gap: next.distAlong - distAlong } : null);
    } else {
      updateCornerCard(null);
    }

    // free-roam: extend route when running low on remaining path
    if (state.mode === 'roam') {
      const remaining = state.cum[state.cum.length - 1] - distAlong;
      if (remaining < state.roamExtendTriggerRemaining && !state.roamBusy) {
        extendRoam();
      }
    }
  }

  // ---------- GPS ----------
  function onGpsFix(pos) {
    const { latitude, longitude, speed, heading } = pos.coords;
    const fix = { lat: latitude, lng: longitude };
    if (speed != null && speed >= 0) state.speedMps = speed;
    else if (state.lastFix) {
      const d = Geo.haversine(state.lastFix, fix);
      const dt = (pos.timestamp - (state.lastFixTime || pos.timestamp)) / 1000;
      if (dt > 0) state.speedMps = d / dt;
    }
    if (heading != null && !isNaN(heading)) state.lastHeading = heading;
    else if (state.lastFix) state.lastHeading = Geo.bearing(state.lastFix, fix);

    state.lastFix = fix;
    state.lastFixTime = pos.timestamp;

    el.speed.textContent = String(fmtSpeed(state.speedMps));
    el.speedUnit.textContent = state.units === 'mi' ? 'mph' : 'km/h';

    if (!state.path.length) return;
    const proj = Geo.projectOntoPath(state.path, state.cum, fix);
    if (proj.lateralDist > 60 && state.mode === 'plan') {
      el.driveStatus.textContent = 'Off route — recalculating…';
      recalcPlanFromHere(fix);
      return;
    }
    el.driveStatus.textContent = '';
    updateMapView(fix);
    tickDrive(proj.distAlong);
  }

  function onGpsError(err) {
    el.driveStatus.textContent = `GPS: ${err.message || 'signal lost'}`;
  }

  function startGps() {
    if (!('geolocation' in navigator)) {
      alert('Geolocation is not available in this browser.');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError, {
      enableHighAccuracy: true, maximumAge: 500, timeout: 10000,
    });
  }

  function stopGps() {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* non-fatal */ }
  }
  function releaseWakeLock() {
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }

  // ---------- plan mode ----------
  let planStart = null, planDest = null;

  function wireAutocomplete(input, resultsBox, onPick) {
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { resultsBox.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const results = await RodsAPI.geocode(q);
          resultsBox.innerHTML = '';
          results.forEach(r => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.textContent = r.label;
            div.addEventListener('click', () => {
              onPick(r);
              input.value = r.label;
              resultsBox.innerHTML = '';
            });
            resultsBox.appendChild(div);
          });
        } catch (e) { /* ignore */ }
      }, 400);
    });
  }

  async function planAndGo() {
    if (!planStart || !planDest) {
      el.planStatus.textContent = 'Pick a start and destination first.';
      return;
    }
    el.planStatus.textContent = 'Fetching route…';
    try {
      const { points } = await RodsAPI.route([planStart, planDest]);
      el.planStatus.textContent = 'Analyzing corners…';
      await beginDrive('plan', points);
    } catch (e) {
      el.planStatus.textContent = e.message || 'Could not build a route.';
    }
  }

  async function recalcPlanFromHere(fix) {
    if (!planDest) return;
    try {
      const { points } = await RodsAPI.route([fix, planDest]);
      loadPath(points);
    } catch (e) { /* keep trying on next fix */ }
  }

  // ---------- roam mode ----------
  async function startRoam() {
    if (!('geolocation' in navigator)) return;
    el.driveStatus.textContent = 'Finding your position…';
    navigator.geolocation.getCurrentPosition(async pos => {
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const heading = (pos.coords.heading != null && !isNaN(pos.coords.heading)) ? pos.coords.heading : 0;
      state.lastFix = fix;
      state.lastHeading = heading;
      try {
        const { points } = await RodsAPI.routeAhead(fix, heading, state.roamAheadMeters);
        await beginDrive('roam', points);
      } catch (e) {
        el.driveStatus.textContent = 'Could not find roads nearby — try Plan Route instead.';
      }
    }, () => { el.driveStatus.textContent = 'Location permission needed for Free Roam.'; },
      { enableHighAccuracy: true, timeout: 10000 });
  }

  async function extendRoam() {
    if (!state.lastFix) return;
    state.roamBusy = true;
    try {
      const { points } = await RodsAPI.routeAhead(state.lastFix, state.lastHeading, state.roamAheadMeters);
      // append new corners with distance offset so nothing already-passed is re-announced
      const offset = state.cum[state.cum.length - 1];
      const newCorners = Geo.detectCorners(points).map(c => ({
        ...c,
        distAlong: c.distAlong + offset,
        startDist: c.startDist + offset,
        endDist: c.endDist + offset,
      }));
      state.path = state.path.concat(points.slice(1));
      state.cum = Geo.cumulativeDistances(state.path);
      state.mapRouteDirty = true;
      updateMapView(state.lastFix);
      // keep only future corners from old list + new ones, avoid dup near seam
      state.corners = state.corners.concat(newCorners.filter(c => c.distAlong > offset + 5));
    } catch (e) { /* try again next tick */ }
    state.roamBusy = false;
  }

  // ---------- shared drive lifecycle ----------
  function loadPath(points) {
    state.path = points;
    state.cum = Geo.cumulativeDistances(points);
    state.corners = Geo.detectCorners(points);
    resetAnnouncements();
    state.mapRouteDirty = true;
    state.mapReady = false;
    ensureMap();
    updateMapView();
  }

  async function beginDrive(mode, points) {
    state.mode = mode;
    state.mapReady = false;
    loadPath(points);
    state.driving = true;
    el.driveModeLabel.textContent = mode === 'plan' ? 'Planned route' : 'Free roam';
    showScreen('drive');
    await requestWakeLock();
    startGps();
    updateCornerCard(null);
  }

  function endDrive() {
    state.driving = false;
    stopGps();
    releaseWakeLock();
    speechSynthesis.cancel();
    state.path = []; state.cum = []; state.corners = [];
    showScreen('home');
  }

  // ---------- settings ----------
  function populateVoices() {
    const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
    el.voiceSelect.innerHTML = '';
    (voices.length ? voices : speechSynthesis.getVoices()).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      el.voiceSelect.appendChild(opt);
    });
    if (state.voiceURI) el.voiceSelect.value = state.voiceURI;
  }

  // ---------- wiring ----------
  function wireEvents() {
    el.btnPlan.addEventListener('click', () => { showScreen('plan'); });
    el.btnRoam.addEventListener('click', () => { startRoam(); });
    el.btnSettings.addEventListener('click', () => showScreen('settings'));
    el.btnSettingsBack.addEventListener('click', () => showScreen('home'));
    el.planBack.addEventListener('click', () => showScreen('home'));

    wireAutocomplete(el.startInput, el.startResults, r => { planStart = r; });
    wireAutocomplete(el.destInput, el.destResults, r => { planDest = r; });

    el.useMyLocation.addEventListener('click', () => {
      navigator.geolocation.getCurrentPosition(pos => {
        planStart = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        el.startInput.value = 'My current location';
      }, () => { el.planStatus.textContent = 'Could not get your location.'; });
    });

    el.planGo.addEventListener('click', planAndGo);

    el.driveExit.addEventListener('click', endDrive);
    el.driveMute.addEventListener('click', () => {
      state.muted = !state.muted;
      el.driveMute.textContent = state.muted ? '🔇' : '🔊';
      if (state.muted) speechSynthesis.cancel();
    });

    el.unitsToggle.addEventListener('change', () => { state.units = el.unitsToggle.checked ? 'mi' : 'km'; });
    el.severityToggle.addEventListener('change', () => { state.severityMode = el.severityToggle.checked ? 'rally' : 'simple'; });
    el.timingSelect.addEventListener('change', () => { state.timing = el.timingSelect.value; });
    el.voiceSelect.addEventListener('change', () => { state.voiceURI = el.voiceSelect.value; });
    el.testVoiceBtn.addEventListener('click', () => speak('Medium left tightens, into easy right, 100'));

    if ('speechSynthesis' in window) {
      speechSynthesis.onvoiceschanged = populateVoices;
      populateVoices();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.driving) requestWakeLock();
    });
  }

  function init() {
    cacheDom();
    wireEvents();
    showScreen('home');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
