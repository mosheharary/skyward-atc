// In-game help: controls, workflow, phraseology, separation rules and scoring.

import { h } from './dom';

interface Section {
  id: string;
  title: string;
  html: string;
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    html: `
<p><b>Skyward ATC</b> puts you in a combined radar and tower position. You control every aircraft from the moment it enters your airspace until it is parked at a gate, and every departure from push-back until you hand it to the departure controller.</p>
<ol>
<li><b>Select an aircraft</b> by clicking it on the radar scope, in the 3D view or in the flight strips on the left.</li>
<li><b>Give an instruction</b> with the command panel on the right. Only instructions that make sense right now are shown.</li>
<li><b>Listen to the readback.</b> Pilots answer on the radio, and the transcript appears in the radio log at the bottom.</li>
</ol>
<p>Aircraft <span class="k amber">glowing amber</span> are calling you with a request, such as push-back, taxi, take-off, landing or runway crossing. The button that answers the request is highlighted. Don't keep pilots waiting: delays cost points.</p>
<p>Your game is <b>saved automatically</b> every few seconds and when you close the tab. Choose <i>Continue</i> on the main menu to pick up exactly where you left off. You can also make named saves from the pause menu.</p>`,
  },
  {
    id: 'controls',
    title: 'Controls',
    html: `
<table class="keys">
<tr><td><kbd>Click</kbd></td><td>Select an aircraft (radar, 3D view or strip)</td></tr>
<tr><td><kbd>Right-click</kbd> on radar</td><td>Vector the selected airborne aircraft towards that point (heading rounded to 5°)</td></tr>
<tr><td><kbd>Mouse wheel</kbd> on radar</td><td>Zoom the scope. Zoom inside 5 NM to see ground traffic and taxiways</td></tr>
<tr><td><kbd>Drag</kbd> on radar</td><td>Pan the scope. Double-click re-centres it</td></tr>
<tr><td><kbd>Drag</kbd> in 3D</td><td>Look around (tower / cockpit) or rotate (orbit / follow)</td></tr>
<tr><td><kbd>Right-drag</kbd> in 3D</td><td>Pan (orbit camera)</td></tr>
<tr><td><kbd>Mouse wheel</kbd> in 3D</td><td>Binoculars zoom in the tower, distance in orbit and follow views</td></tr>
<tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>Tower cab / orbit / follow selected / cockpit of selected</td></tr>
<tr><td><kbd>Tab</kbd></td><td>Swap the big view between 3D and radar</td></tr>
<tr><td><kbd>Space</kbd></td><td>Pause / resume</td></tr>
<tr><td><kbd>+</kbd> / <kbd>-</kbd></td><td>Simulation speed ×1, ×2, ×4</td></tr>
<tr><td><kbd>Esc</kbd></td><td>Deselect / close dialogs / pause menu</td></tr>
<tr><td><kbd>F1</kbd> or <kbd>?</kbd></td><td>This help</td></tr>
</table>`,
  },
  {
    id: 'arrivals',
    title: 'Handling arrivals',
    html: `
<p>Arrivals check in at an <span class="k blue">entry fix</span> (blue triangles) and follow their published route. If you do nothing they hold at the last fix, which is a waste of fuel and points.</p>
<ol>
<li><b>Descend</b> them with <i>Altitude</i>. You may not assign an altitude below the minimum vectoring altitude.</li>
<li><b>Vector</b> them towards the final approach with <i>Heading</i>, or send them <i>Direct to</i> the <span class="k green">IF</span> (green fixes on the extended centreline).</li>
<li><b>Clear them for the ILS</b> with <i>Cleared ILS</i>. The aircraft intercepts the localizer, a 30° intercept angle is ideal, then follows the glideslope. Intercept from <b>below</b> the glideslope: an aircraft more than ~900 ft too high will not capture.</li>
<li>Around 8–10 NM out the pilot requests landing. Give <i>Cleared to land</i> once the runway will be clear.</li>
<li>After landing the aircraft vacates and calls clear of the runway: give <i>Taxi to gate</i>.</li>
</ol>
<p><b>Speed control</b> is your best spacing tool: 180 kt until 10 NM and 160 kt to 5 NM keeps a stream tidy. If the runway is not clear, send the aircraft around with <i>Go around</i>. Otherwise the pilot will go around on their own, and that costs you more.</p>`,
  },
  {
    id: 'departures',
    title: 'Handling departures',
    html: `
<ol>
<li>A parked aircraft calls <b>ready for push-back</b>: <i>Push back</i>.</li>
<li>Once pushed it requests taxi: <i>Taxi to runway</i>. The route and any runway crossings are read back.</li>
<li>At a crossing the pilot stops and asks: <i>Cross runway</i>, but only when nothing is landing or taking off there.</li>
<li>At the holding point: <i>Line up &amp; wait</i> or <i>Cleared for take-off</i>. The runway must be free of landing traffic and wake-turbulence intervals must be met (2 minutes behind a heavy, 3 minutes behind a super).</li>
<li>After take-off the aircraft climbs to the initial altitude. Climb it, vector or send it <i>Direct to</i> its <span class="k orange">exit fix</span> (orange), then <i>Contact departure</i> to hand it off.</li>
</ol>`,
  },
  {
    id: 'rules',
    title: 'Separation rules',
    html: `
<ul>
<li><b>Radar separation:</b> 3 NM horizontally <i>or</i> 1,000 ft vertically between airborne aircraft.</li>
<li><b>On the same final</b> the minimum is 2.5 NM, plus <b>wake turbulence</b> spacing: 4 NM medium behind heavy, 5 NM light behind heavy, 6 NM behind a super.</li>
<li>Aircraft in the tower environment (within ~5 NM of the field and below 2,500 ft above it) are separated by the runway rules instead.</li>
<li><b>Runway:</b> only one aircraft at a time may use a runway. Never clear two movements onto the same runway, and never let a taxiing aircraft cross an active runway without a clearance.</li>
<li>Predicted conflicts (within 60 s) are drawn as an <span class="k amber">amber dashed line</span> on the radar. A lost separation shows as a <span class="k red">red line</span>.</li>
<li>If aircraft get too close, TCAS issues a resolution advisory and the pilots manoeuvre on their own.</li>
</ul>`,
  },
  {
    id: 'scoring',
    title: 'Scoring',
    html: `
<table class="keys">
<tr><td class="pos">+40</td><td>Arrival landed and vacated the runway</td></tr>
<tr><td class="pos">+60</td><td>Arrival parked on stand</td></tr>
<tr><td class="pos">+60</td><td>Departure handed off near its exit fix, at or above the minimum altitude</td></tr>
<tr><td class="pos">+80</td><td>Emergency aircraft landed safely</td></tr>
<tr><td class="neg">−10</td><td>Pilot kept waiting for a clearance (repeats), or holding for too long</td></tr>
<tr><td class="neg">−20 / −60 / −80</td><td>Go-around: ordered by you / unstable approach / forced by an occupied runway</td></tr>
<tr><td class="neg">−30 / −40</td><td>Departure left too low or off course / without a hand-off</td></tr>
<tr><td class="neg">−30</td><td>Below minimum vectoring altitude</td></tr>
<tr><td class="neg">−50</td><td>TCAS resolution advisory, or take-off wake interval violated</td></tr>
<tr><td class="neg">−60</td><td>Wake turbulence separation lost on final</td></tr>
<tr><td class="neg">−100</td><td>Loss of separation (−20 every 20 s while it lasts), or an arrival leaving your airspace</td></tr>
<tr><td class="neg">−120</td><td>Emergency not landed within 15 minutes</td></tr>
<tr><td class="neg">−150</td><td>Runway incursion</td></tr>
<tr><td class="neg">−200</td><td>Aircraft diverted because it ran out of fuel</td></tr>
</table>
<p>Career shifts award 1–3 ★ depending on your score. A shift fails immediately if the score falls below its failure threshold.</p>`,
  },
  {
    id: 'phraseology',
    title: 'Radio phraseology',
    html: `
<p>Every button is transmitted with standard ICAO phraseology and read back by the pilot. Some examples:</p>
<ul class="phr">
<li><b>ATC:</b> "Azure 123, turn left heading 270, descend and maintain 4,000"</li>
<li><b>ATC:</b> "Azure 123, cleared ILS approach runway 27"</li>
<li><b>Pilot:</b> "Harbor Point Tower, Azure 123, 10 miles final runway 27"</li>
<li><b>ATC:</b> "Azure 123, wind 260 at 8, runway 27, cleared to land"</li>
<li><b>ATC:</b> "Coastal 45, taxi to holding point runway 27 via A, B, hold short of runway 09R"</li>
<li><b>ATC:</b> "Coastal 45, runway 27, cleared for take-off"</li>
<li><b>ATC:</b> "Coastal 45, contact departure 124.35, good day"</li>
</ul>
<p>Numbers are spoken digit by digit ("niner" for 9). Altitudes are spoken in thousands and hundreds. Heavy aircraft add "heavy" to their callsign.</p>`,
  },
  {
    id: 'views',
    title: 'Views & HUD',
    html: `
<ul>
<li><b>Tower cab</b>: the view from the control tower at the real eye height. Use the wheel as binoculars.</li>
<li><b>Orbit</b>: a free camera around the airport.</li>
<li><b>Follow</b>: chase camera behind the selected aircraft.</li>
<li><b>Cockpit</b>: the pilot's view of the selected aircraft.</li>
<li><b>Flight strips</b> (left): every aircraft that is your responsibility, grouped by arrivals and departures. Amber strips need you.</li>
<li><b>Radar data block</b>: callsign / altitude in hundreds of feet ↑↓ assigned altitude, ground speed in tens of knots / type, wake and clearance.</li>
<li><b>Top bar</b>: airport, local time, remaining shift time, ATIS letter, wind, score, speed controls and menu.</li>
</ul>`,
  },
  {
    id: 'career',
    title: 'Career & saving',
    html: `
<p>The <b>career</b> is a series of 10 shifts across three airports: the fictional Harbor Point (HPX), Tel Aviv Ben Gurion (LLBG) and San Francisco (KSFO). Traffic, weather and emergencies increase along the way. Passing a shift unlocks the next.</p>
<p><b>Free play</b> lets you choose the airport, runway configuration, traffic, weather, time of day and shift length (or endless).</p>
<p>All progress lives on the server inside the Docker container's data volume, under your pilot profile:</p>
<ul>
<li><b>Checkpoint</b>: saved automatically while you play, when you pause and when you leave. <i>Continue</i> restores the complete simulation: every aircraft, clearance, score and the weather.</li>
<li><b>Named saves</b>: up to 20 per profile, from the pause menu.</li>
<li><b>Settings</b>: graphics quality, volumes and voices are stored per profile.</li>
</ul>`,
  },
];

export class HelpDialog {
  readonly el: HTMLElement;
  private readonly content: HTMLElement;
  private readonly nav: HTMLElement;
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.nav = h('nav', { class: 'help-nav' });
    this.content = h('div', { class: 'help-content' });
    this.el = h('div', { class: 'modal help hidden', role: 'dialog', 'aria-label': 'Help' },
      h('div', { class: 'modal-card help-card' },
        h('div', { class: 'modal-head' }, h('h2', null, 'Help'), h('button', { class: 'close', 'aria-label': 'Close help', onclick: () => this.close() }, '✕')),
        h('div', { class: 'help-body' }, this.nav, this.content),
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    for (const s of SECTIONS) {
      this.nav.append(h('button', { 'data-id': s.id, onclick: () => this.show(s.id) }, s.title));
    }
    parent.appendChild(this.el);
    this.show('start');
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(id: string): void {
    const s = SECTIONS.find((x) => x.id === id) ?? SECTIONS[0];
    this.content.innerHTML = `<h3>${s.title}</h3>${s.html}`;
    this.content.scrollTop = 0;
    for (const b of this.nav.querySelectorAll('button')) b.classList.toggle('active', b.getAttribute('data-id') === s.id);
  }

  open(id?: string): void {
    if (id) this.show(id);
    this.el.classList.remove('hidden');
  }

  close(): void {
    this.el.classList.add('hidden');
    this.onClose?.();
  }
}
