# Co-Pilot — pocket co-driver

A "Rods"-style pace-note app: generates rally-style voiced corner callouts
(direction, severity, tightens/opens, distance) either from a planned route
or live as you free-roam, using your phone's GPS.

## What it actually is

A **PWA** (installable website), not an App Store app — that's the fastest
path to something that really runs on your phone today, works offline once
a route is loaded, and needs zero developer accounts or app review.

## How the pace notes work

- **Plan a route**: search a start/destination (OpenStreetMap geocoding),
  fetch the road path from OSRM, then `js/geo.js` walks the path and
  measures how much the road's bearing changes over a rolling ~30 m window.
  Bigger swing = tighter corner. That's converted into direction, severity
  (Easy/Medium/Hard or rally 1–6), and whether it's tightening or opening.
- **Free roam**: no destination — grabs your GPS heading, asks OSRM for a
  route ~1.5 km straight ahead along real roads, and keeps auto-extending
  that "route" ahead of you as you drive, re-running the same detector.
- **During the drive**: your GPS position is projected onto the route line
  to know exactly how far you are from the next corner; callouts fire based
  on your current speed (more lead time the faster you're going).

## Running it on your phone

You need it served over **HTTPS** (required for GPS + install prompts on
Android/iOS; `localhost` also works for quick testing). Easiest options:

**Option A — GitHub Pages (free, 2 minutes)**
1. Create a new GitHub repo, upload everything in this folder to it.
2. Repo Settings → Pages → deploy from the `main` branch, root folder.
3. Open the given `https://<you>.github.io/<repo>/` URL on your phone.
4. Safari/Chrome → Share/menu → "Add to Home Screen".

**Option B — Netlify Drop**
1. Go to https://app.netlify.com/drop on a computer, drag this whole folder in.
2. Open the generated URL on your phone, "Add to Home Screen".

**Option C — test locally first**
```
cd rods-clone
python3 -m http.server 8000
```
Open `http://localhost:8000` on the same computer to sanity-check it in a
desktop browser before deploying (GPS will use your computer's location).

## Notes & honest limitations

- Corner detection is a genuine geometric algorithm, not a lookup of real
  pace notes — it's a solid approximation, tune `LOOKAROUND`/`THRESH`/the
  severity breakpoints in `js/geo.js` to taste once you've driven with it.
- No speed cameras / speed bump database is wired in (Rods has one; that
  requires a data source I didn't want to fake). Corner + hazard-geometry
  callouts are real; camera/bump alerts aren't included yet.
- As a web app it can't hold GPS + audio reliably with the screen fully
  locked on iOS the way a native app can — keep the app open/foreground
  while driving. It does request a screen wake lock to prevent auto-lock.
- Uses free public OpenStreetMap/OSRM servers — fine for personal use;
  don't hammer them with high-frequency requests.
