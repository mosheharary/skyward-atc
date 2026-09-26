# Skyward ATC

A 3D air-traffic-control simulator that runs in the browser. You work as approach, tower and ground at once:
vector arrivals onto the ILS on radar, clear them to land, then taxi them to a gate — and push, taxi and
launch departures from the tower cab.

- **3D:** three.js with HDR lighting, bloom, a day/night sky, weather (clouds, rain, storms, fog),
  terrain, water, cities, and detailed airports and aircraft with airline liveries.
- **Sound:** procedural engine and ambience audio, radio squelch, and synthesised pilot and controller voices.
- **Airports:** Harbor Point (KHPX, fictional), Tel Aviv Ben Gurion (LLBG, approximate) and
  San Francisco (KSFO, approximate).
- **Modes:** a 10-shift career plus free play (choose the airport, traffic, weather and time of day).
- **Stateful:** the container keeps profiles, career progress, an autosaved checkpoint of the full sim state,
  manual saves and results in SQLite on a Docker volume. **Continue** in the main menu resumes where you left off.

## Run

```sh
docker compose up -d --build
open http://localhost:8080        # Chrome / Edge / Firefox with WebGL2
```

Data lives in the `skyward-data` volume and survives `docker compose restart`, `down`/`up` and rebuilds.
Wiping it (`docker compose down -v`) deletes all profiles and saves.

The port is bound to `127.0.0.1` only. Change it to `"8080:8080"` in `docker-compose.yml` to allow other
machines on your network.

## How to play

Press **F1** or **?** in the game, or choose **Help** in the main menu, for the full manual. The basics:

- Click an aircraft on the radar, in the 3D view or in the flight strips to select it. Then use the command panel.
- Right-click the radar to vector the selected aircraft towards that point.
- Keys: `Space` pause, `1`–`4` camera (Tower / Orbit / Follow / Cockpit), `Tab` swaps the radar and the 3D view,
  `+`/`-` sim speed, `Esc` deselect / menu.

## Development

```sh
npm install
npm run dev:server        # API on :8787, data in ./.data
npm run dev               # Vite on :5173, proxies /api
npm run typecheck && npm test && npm run build
```

`verify/` holds the puppeteer-core scripts that drive a real Chrome for end-to-end checks
(`node verify/flow.mjs http://localhost:8080 /tmp/flow new|continue|ground`).

### Layout

| Path | Contents |
| --- | --- |
| `src/sim` | Deterministic simulation: world, aircraft flight model, phraseology, airports, career |
| `src/render` | three.js renderer: environment, airport and aircraft modules |
| `src/audio` | WebAudio engine: engines, ambience, radio, speech |
| `src/ui`, `src/app` | Menus, radar scope, command panel, help, game loop |
| `server/server.mjs` | Static server + JSON API on `node:sqlite` |
