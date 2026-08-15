// geo.js — geometry helpers + the pace-note (corner detection) engine
'use strict';

const Geo = (() => {
  const R = 6371000; // earth radius, meters

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Initial bearing from a to b, degrees 0-360
  function bearing(a, b) {
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // signed smallest difference b-a in degrees, range -180..180
  function angleDiff(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // Cumulative distance array for a path of {lat,lng} points
  function cumulativeDistances(points) {
    const out = [0];
    for (let i = 1; i < points.length; i++) {
      out.push(out[i - 1] + haversine(points[i - 1], points[i]));
    }
    return out;
  }

  // Find the point along the path (by walking cumulative distance) that is
  // `dist` meters behind (dir=-1) or ahead (dir=1) of index i. Returns a point.
  function pointAtOffset(points, dist_, i, dir, targetDist) {
    let d = 0;
    let j = i;
    while (j + dir >= 0 && j + dir < points.length && d < targetDist) {
      d += haversine(points[j], points[j + dir]);
      j += dir;
    }
    return points[j];
  }

  /**
   * Compute turn-angle (curvature) samples along a path.
   * lookaround: meters to look forward/back from each sample for bearing calc (noise smoothing)
   */
  function computeCurvature(points, cum, lookaround = 10) {
    const n = points.length;
    const turn = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const pBack = pointAtOffset(points, cum, i, -1, lookaround);
      const pFwd = pointAtOffset(points, cum, i, 1, lookaround);
      if (pBack === points[i] || pFwd === points[i]) continue;
      const bIn = bearing(pBack, points[i]);
      const bOut = bearing(points[i], pFwd);
      turn[i] = angleDiff(bIn, bOut); // + = right turn, - = left turn
    }
    return turn;
  }

  function movingAverage(arr, window = 3) {
    const out = new Array(arr.length).fill(0);
    const half = Math.floor(window / 2);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let k = -half; k <= half; k++) {
        const idx = i + k;
        if (idx >= 0 && idx < arr.length) { s += arr[idx]; c++; }
      }
      out[i] = s / c;
    }
    return out;
  }

  // Severity is derived from bearing change across a fixed ~30m window
  // centered on each point (see LOOKAROUND below), which approximates
  // curvature (tighter radius -> bigger swing over the same distance).
  function simpleSeverity(absAngle) {
    if (absAngle < 10) return null;
    if (absAngle < 35) return { label: 'Easy', code: 1 };
    if (absAngle < 75) return { label: 'Medium', code: 2 };
    return { label: 'Hard', code: 3 };
  }

  // rally 1-6 scale (6 = tightest)
  const RALLY_BREAKS = [10, 25, 40, 60, 85, 120, 999];
  function rallySeverity(absAngle) {
    if (absAngle < RALLY_BREAKS[0]) return null;
    for (let i = 1; i < RALLY_BREAKS.length; i++) {
      if (absAngle < RALLY_BREAKS[i]) return { label: String(i), code: i };
    }
    return { label: '6', code: 6 };
  }

  /**
   * Main entry point: turn a polyline into a list of corners (pace notes).
   * points: [{lat,lng}, ...] in travel order
   * returns: [{ distAlong, direction: 'left'|'right', angle, simple, rally,
   *             trend: 'tightens'|'opens'|'constant', startDist, endDist }]
   */
  function detectCorners(points) {
    if (points.length < 3) return [];
    const cum = cumulativeDistances(points);
    const LOOKAROUND = 15; // meters each side (~30m window) used to estimate curvature
    const rawTurn = computeCurvature(points, cum, LOOKAROUND);
    const turn = movingAverage(rawTurn, 3);

    const THRESH = 9; // deg, minimum to count as "in a corner"
    const corners = [];
    let i = 1;
    const n = points.length;
    while (i < n - 1) {
      if (Math.abs(turn[i]) >= THRESH) {
        const sign = Math.sign(turn[i]);
        let start = i, end = i;
        let peak = turn[i];
        let peakIdx = i;
        // extend while same-sign and above a lower "in progress" threshold
        while (end + 1 < n - 1 && Math.sign(turn[end + 1]) === sign && Math.abs(turn[end + 1]) >= THRESH * 0.4) {
          end++;
          if (Math.abs(turn[end]) > Math.abs(peak)) { peak = turn[end]; peakIdx = end; }
        }
        const absPeak = Math.abs(peak);
        // trend: where does the peak curvature sit within the corner?
        // peak near the exit -> tightening into the corner; peak near the
        // entry -> opening back out; peak in the middle -> constant radius.
        const span = end - start;
        const pos = span > 0 ? (peakIdx - start) / span : 0.5;
        let trend = 'constant';
        if (pos > 0.65) trend = 'tightens';
        else if (pos < 0.35) trend = 'opens';

        corners.push({
          distAlong: cum[peakIdx],
          startDist: cum[start],
          endDist: cum[end],
          direction: sign > 0 ? 'right' : 'left',
          angle: absPeak,
          trend,
          simple: simpleSeverity(absPeak),
          rally: rallySeverity(absPeak),
        });
        i = end + 1;
      } else {
        i++;
      }
    }
    // drop corners with no valid severity (shouldn't happen given THRESH) and
    // merge corners that are essentially duplicates (<8m apart, same direction)
    const merged = [];
    for (const c of corners) {
      const prev = merged[merged.length - 1];
      if (prev && c.direction === prev.direction && (c.startDist - prev.endDist) < 8) {
        if (c.angle > prev.angle) {
          prev.angle = c.angle; prev.distAlong = c.distAlong; prev.simple = c.simple; prev.rally = c.rally;
        }
        prev.endDist = c.endDist;
      } else {
        merged.push(c);
      }
    }
    return merged;
  }

  // Project a live GPS point onto a path; returns {index, distAlong, lateralDist}
  function projectOntoPath(points, cum, fix) {
    let best = { index: 0, distAlong: 0, lateralDist: Infinity };
    for (let i = 0; i < points.length - 1; i++) {
      const seg = closestPointOnSegment(points[i], points[i + 1], fix);
      const d = haversine(seg.point, fix);
      if (d < best.lateralDist) {
        const segLen = haversine(points[i], points[i + 1]) || 1e-6;
        const distAlong = cum[i] + segLen * seg.t;
        best = { index: i, distAlong, lateralDist: d };
      }
    }
    return best;
  }

  // closest point on segment a-b to point p, using local equirectangular approx
  function closestPointOnSegment(a, b, p) {
    const lat0 = toRad(a.lat);
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(lat0);
    const ax = 0, ay = 0;
    const bx = (b.lng - a.lng) * mPerDegLng, by = (b.lat - a.lat) * mPerDegLat;
    const px = (p.lng - a.lng) * mPerDegLng, py = (p.lat - a.lat) * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const lat = a.lat + (t * dy) / mPerDegLat;
    const lng = a.lng + (t * dx) / mPerDegLng;
    return { point: { lat, lng }, t };
  }

  function destinationPoint(from, bearingDeg, distMeters) {
    const br = toRad(bearingDeg);
    const la1 = toRad(from.lat), lo1 = toRad(from.lng);
    const dR = distMeters / R;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dR) + Math.cos(la1) * Math.sin(dR) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(
      Math.sin(br) * Math.sin(dR) * Math.cos(la1),
      Math.cos(dR) - Math.sin(la1) * Math.sin(la2)
    );
    return { lat: toDeg(la2), lng: (toDeg(lo2) + 540) % 360 - 180 };
  }

  return {
    haversine, bearing, angleDiff, cumulativeDistances, detectCorners,
    projectOntoPath, destinationPoint, closestPointOnSegment,
  };
})();
