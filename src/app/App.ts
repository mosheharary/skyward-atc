// Application shell: Google sign-in, main menu, career / free play setup, settings, pause menu and shift results.

import { World, type WorldSnapshot } from '../sim/world';
import { SHIFTS, SHIFT_BY_ID, shiftSession, starsFor, NEW_CAREER, type CareerState, type SessionConfig, type WeatherPreset } from '../sim/career';
import { AIRPORTS, AIRPORT_BY_ID } from '../sim/airports';
import { GameRenderer } from '../render/Renderer';
import { createAudioEngine } from '../audio';
import type { IAudioEngine } from '../audio/contracts';
import { Game, type GameHost } from './Game';
import { HelpDialog } from '../ui/help';
import { api, AuthError, DEFAULT_SETTINGS, LOGIN_URL, type CheckpointSummary, type Profile, type ResultInfo, type Settings } from '../ui/api';
import { h, fmtDate, fmtDuration, trapFocus, initials } from '../ui/dom';
import { icon } from '../ui/icons';
import { applyUiPrefs } from '../ui/prefs';
import { breakdownView } from '../ui/notifications';

/** Pre-auth builds remembered the chosen profile id here. */
const LEGACY_PROFILE_KEY = 'skyward.profile';

type ModalEl = HTMLElement & { onClose?: () => void; closable?: boolean; release?: () => void };

export class App implements GameHost {
  readonly renderer: GameRenderer;
  readonly audio: IAudioEngine;
  settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly root: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly modalLayer: HTMLElement;
  private readonly help: HelpDialog;
  private profile: Profile | null = null;
  private game: Game | null = null;
  private modals: ModalEl[] = [];
  private readonly toastEl: HTMLElement;
  private saveSettingsT = 0;
  private version = '';
  private authEnabled = true;

  constructor(root: HTMLElement) {
    this.root = root;
    this.screen = h('div', { class: 'screen-host' });
    this.modalLayer = h('div', { class: 'modal-layer' });
    this.toastEl = h('div', { class: 'toast hidden', role: 'status', 'aria-live': 'polite' });
    root.append(this.screen, this.modalLayer, this.toastEl);
    applyUiPrefs(this.settings);
    const canvas = document.createElement('canvas');
    canvas.className = 'gl';
    this.renderer = new GameRenderer(canvas, this.settings.quality);
    this.audio = createAudioEngine();
    this.help = new HelpDialog(this.modalLayer);
    this.help.onClose = () => this.audio.playUI('click');
    // Browsers only allow audio after a user gesture.
    const unlock = (): void => {
      void this.audio.start().then(() => {
        if (!this.game) this.audio.setMusic('menu');
      });
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    // Expose a small hook for automated verification.
    (window as unknown as { skyward: unknown }).skyward = this;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Help is re-appended on open, so when it is visible it is always the top-most dialog.
      if (this.help.isOpen) {
        e.stopImmediatePropagation();
        this.help.close();
      } else if (this.modals.length) {
        e.stopImmediatePropagation();
        this.closeTopModal();
      }
    }, { capture: true });
  }

  async start(): Promise<void> {
    try {
      const hl = await api.health();
      this.version = hl.version ?? '';
      this.authEnabled = hl.auth !== false;
    } catch {
      this.show(h('div', { class: 'menu' }, h('h1', null, 'Skyward ATC'), h('p', { class: 'err' }, 'Cannot reach the game server. Is the container running?')));
      return;
    }
    try {
      localStorage.removeItem(LEGACY_PROFILE_KEY);
    } catch {
      /* storage unavailable */
    }
    const authFailed = new URLSearchParams(location.search).has('auth_error');
    if (authFailed) history.replaceState(null, '', location.pathname);
    try {
      await this.useProfile(await api.me());
    } catch (e) {
      if (!(e instanceof AuthError)) this.toast((e as Error).message, true);
      this.showSignIn(authFailed);
    }
  }

  /** Called when an API call reports the session is gone: keep playing, but tell the user. */
  private sessionLost(e: unknown): boolean {
    if (!(e instanceof AuthError)) return false;
    this.toast('Your session has expired. Sign in again to keep saving.', true);
    return true;
  }

  // ------------------------------------------------------------ GameHost
  async saveCheckpoint(state: WorldSnapshot, summary: CheckpointSummary, beacon = false): Promise<boolean> {
    if (!this.profile) return false;
    if (beacon) return api.beaconCheckpoint(state, summary);
    try {
      await api.putCheckpoint(state, summary);
      return true;
    } catch (e) {
      if (!this.sessionLost(e)) console.warn('checkpoint save failed', e);
      return false;
    }
  }

  openHelp(section?: string): void {
    this.audio.playUI('click');
    this.help.open(section);
  }

  isModalOpen(): boolean {
    return this.modals.length > 0 || this.help.isOpen;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.applySettings();
    clearTimeout(this.saveSettingsT);
    this.saveSettingsT = window.setTimeout(() => this.persistSettings(), 800);
  }

  private persistSettings(): void {
    if (!this.profile) return;
    this.profile.settings = this.settings;
    void api.saveSettings(this.settings).catch((e) => this.sessionLost(e) || this.toast('Could not save settings', true));
  }

  // ------------------------------------------------------------ helpers
  private show(el: HTMLElement): void {
    this.screen.replaceChildren(el);
  }

  private toast(text: string, bad = false): void {
    this.toastEl.textContent = text;
    this.toastEl.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout((this.toastEl as unknown as { t: number }).t);
    (this.toastEl as unknown as { t: number }).t = window.setTimeout(() => this.toastEl.classList.add('hidden'), 3500);
  }

  private modal(title: string, body: HTMLElement | HTMLElement[], opts: { wide?: boolean; onClose?: () => void; closable?: boolean; icon?: string; cls?: string } = {}): ModalEl {
    const close = (): void => this.closeModal(m);
    const m: ModalEl = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: `modal-card${opts.wide ? ' wide' : ''}${opts.cls ? ` ${opts.cls}` : ''}` },
        h('div', { class: 'modal-head' }, h('h2', null, opts.icon ? icon(opts.icon) : '', title), opts.closable === false ? null : h('button', { class: 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close'))),
        h('div', { class: 'modal-body' }, ...(Array.isArray(body) ? body : [body])),
      ),
    );
    m.onClose = opts.onClose;
    m.closable = opts.closable !== false;
    // A new dialog always goes on top of Help, too.
    if (this.help.isOpen) this.help.close();
    this.modalLayer.append(m);
    this.modals.push(m);
    m.release = trapFocus(m);
    return m;
  }

  private closeModal(m: ModalEl): void {
    const i = this.modals.indexOf(m);
    if (i >= 0) this.modals.splice(i, 1);
    m.remove();
    m.release?.();
    m.onClose?.();
  }

  private closeTopModal(): void {
    const m = this.modals[this.modals.length - 1];
    if (m && m.closable) this.closeModal(m);
  }

  private confirm(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
    return new Promise((res) => {
      let done = false;
      const m = this.modal(title, [
        h('p', null, text),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => { done = true; this.closeModal(m); res(false); } }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done = true; this.closeModal(m); res(true); } }, ok),
        ),
      ], { onClose: () => !done && res(false), icon: danger ? 'alert' : 'info' });
    });
  }

  private prompt(title: string, label: string, value: string): Promise<string | null> {
    return new Promise((res) => {
      let done = false;
      const input = h('input', { type: 'text', value, maxlength: '60' }) as HTMLInputElement;
      const submit = (): void => {
        done = true;
        this.closeModal(m);
        res(input.value.trim());
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      const m = this.modal(title, [
        h('label', { class: 'field' }, h('span', null, label), input),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => { done = true; this.closeModal(m); res(null); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: submit }, 'OK'),
        ),
      ], { onClose: () => !done && res(null), icon: 'save' });
      setTimeout(() => input.select(), 0);
    });
  }

  private menuShell(...children: (HTMLElement | null)[]): HTMLElement {
    const blips = Array.from({ length: 7 }, (_, i) => h('span', { class: 'blip', style: `left:${12 + ((i * 37) % 76)}%;top:${14 + ((i * 53) % 70)}%` }));
    return h('div', { class: 'menu-screen' },
      h('div', { class: 'menu-bg', 'aria-hidden': 'true' }, h('div', { class: 'sweep' }), ...blips),
      h('div', { class: 'menu' },
        h('div', { class: 'brand' },
          h('div', { class: 'logo' }, icon('logo')),
          h('div', null, h('h1', null, 'Skyward ATC'), h('div', { class: 'tag' }, 'Approach · Tower · Ground')),
          this.version ? h('span', { class: 'chip ver' }, `v${this.version}`) : null,
        ),
        ...children,
      ),
    );
  }

  // ------------------------------------------------------------ sign-in
  private showSignIn(failed = false): void {
    this.profile = null;
    this.audio.setMusic('menu');
    this.show(this.menuShell(
      h('div', { class: 'signin card' },
        h('h2', null, 'Sign in to start your shift'),
        h('p', { class: 'dim' }, 'Your career, checkpoint and saved games are stored with your Google account. Only you can see them.'),
        this.authEnabled
          ? h('a', { class: 'btn google', id: 'btn-google', href: LOGIN_URL }, icon('google'), 'Sign in with Google')
          : h('p', { class: 'err' }, 'Sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET).'),
        failed ? h('p', { class: 'err', role: 'alert' }, 'Google sign-in did not complete. Please try again.') : null,
      ),
    ));
  }

  private async signOut(): Promise<void> {
    await api.logout().catch(() => undefined);
    this.showSignIn();
  }

  private async useProfile(profile: Profile): Promise<void> {
    this.profile = profile;
    this.settings = { ...DEFAULT_SETTINGS, ...this.profile.settings };
    this.applySettings();
    await this.showMainMenu();
  }

  private get career(): CareerState {
    const c = this.profile?.career ?? {};
    return { unlocked: c.unlocked ?? NEW_CAREER.unlocked, best: c.best ?? {} };
  }

  private applySettings(): void {
    applyUiPrefs(this.settings);
    this.audio.setVolumes({ master: this.settings.master, engines: this.settings.engines, radio: this.settings.radio, ambience: this.settings.ambience, music: this.settings.music, ui: this.settings.ui });
    this.audio.setVoiceEnabled(this.settings.pilotVoices, this.settings.controllerVoice);
    if (this.renderer.quality !== this.settings.quality) this.renderer.setQuality(this.settings.quality);
    this.game?.applySettings(this.settings);
  }

  // ------------------------------------------------------------ main menu
  private async showMainMenu(): Promise<void> {
    const p = this.profile!;
    this.audio.setMusic('menu');
    let cp: CheckpointSummary | null = null;
    let results: ResultInfo[] = [];
    try {
      const [me, res] = await Promise.all([api.me(), api.results().catch(() => [] as ResultInfo[])]);
      this.profile = { ...p, checkpoint: me.checkpoint, career: me.career };
      cp = me.checkpoint;
      results = res;
    } catch (e) {
      if (e instanceof AuthError) return this.showSignIn();
      /* offline */
    }
    const c = this.career;
    const stars = Object.values(c.best).reduce((s, b) => s + b.stars, 0);
    const done = Object.keys(c.best).length;
    const pct = Math.round((Math.min(c.unlocked - 1, SHIFTS.length) / SHIFTS.length) * 100);
    const recent = [...results].sort((a, b) => b.completedAt - a.completedAt).slice(0, 6);
    this.show(this.menuShell(
      h('div', { class: 'welcome' },
        h('span', { class: 'avatar' }, initials(p.name)),
        h('div', { class: 'who' }, h('div', null, 'Welcome back'), h('b', null, p.name), p.email ? h('small', { class: 'dim' }, p.email) : null),
      ),
      h('div', { class: 'menu-grid' },
        h('div', { class: 'menu-buttons' },
          cp ? h('button', { class: 'big primary', id: 'btn-continue', onclick: () => void this.continueCheckpoint() },
            icon('play'),
            h('b', null, 'Continue'),
            h('span', null, `${cp.title} · score ${cp.score}${cp.remaining != null ? ` · ${fmtDuration(cp.remaining)} left` : ''}`),
            h('small', null, `Saved ${fmtDate(cp.savedAt)}`),
            icon('chevronRight', 'go'),
          ) : null,
          h('button', { class: `big${cp ? '' : ' primary'}`, id: 'btn-career', onclick: () => this.showCareer() },
            icon('career'), h('b', null, 'Career'), h('span', null, `${SHIFTS.length} shifts across three airports`), h('small', null, `Shift ${Math.min(c.unlocked, SHIFTS.length)} unlocked`), icon('chevronRight', 'go')),
          h('button', { class: 'big', id: 'btn-free', onclick: () => this.showFreePlay() },
            icon('sliders'), h('b', null, 'Free play'), h('span', null, 'Your airport, traffic and weather'), h('small', null, `${AIRPORTS.length} airports · 6 weather presets`), icon('chevronRight', 'go')),
        ),
        h('div', { class: 'menu-side' },
          h('div', { class: 'card career-card' },
            h('h3', null, 'Career progress', h('span', { class: 'stars' }, `${stars}★`)),
            h('div', { class: 'big-num' }, `${Math.min(c.unlocked, SHIFTS.length)}`, h('small', null, ` / ${SHIFTS.length} shifts`)),
            h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
            h('div', { class: 'dim' }, `${done} completed · ${stars} of ${SHIFTS.length * 3} stars`),
          ),
          h('div', { class: 'card' },
            h('h3', null, 'Recent shifts'),
            recent.length
              ? h('div', { class: 'results-list' }, ...recent.map((r) => {
                const s = SHIFT_BY_ID[r.shiftId];
                return h('div', { class: 'res' },
                  h('span', null, s ? `${s.index}. ${s.title}` : r.shiftId, h('small', null, `${r.airport} · ${fmtDate(r.completedAt)}`)),
                  h('span', { class: 'num' }, String(r.score)),
                  h('span', { class: 'st' }, '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars)));
              }))
              : h('div', { class: 'dim' }, 'No completed shifts yet. Start your career!'),
          ),
        ),
      ),
      h('div', { class: 'menu-tools' },
        h('button', { class: 'btn', onclick: () => void this.showLoad() }, icon('folder'), 'Load game'),
        h('button', { class: 'btn', onclick: () => this.showSettings() }, icon('gear'), 'Settings'),
        h('button', { class: 'btn', id: 'btn-help', onclick: () => this.openHelp() }, icon('help'), 'Help'),
        h('button', { class: 'btn', id: 'btn-signout', onclick: () => void this.signOut() }, icon('user'), 'Sign out'),
      ),
      h('div', { class: 'footer dim' }, icon('save'), 'Your progress is saved automatically to your account.'),
    ));
  }

  private showCareer(): void {
    const c = this.career;
    const detail = h('div', { class: 'shift-detail' });
    const buttons = new Map<string, HTMLElement>();
    const pick = (id: string): void => {
      const s = SHIFT_BY_ID[id];
      const ap = AIRPORT_BY_ID[s.airport];
      const best = c.best[s.id];
      const locked = s.index > c.unlocked;
      for (const [k, b] of buttons) b.classList.toggle('active', k === id);
      const fact = (label: string, value: string): HTMLElement => h('div', null, h('b', null, value), h('span', null, label));
      detail.replaceChildren(
        h('h3', null, `Shift ${s.index} — ${s.title}`),
        h('div', { class: 'dim' }, `${ap.name} (${ap.icao})`),
        h('div', { class: 'shift-facts' },
          fact('Duration', `${s.config.durationMin} min`), fact('Arrivals', `${s.config.arrivalsPerHour}/h`), fact('Departures', `${s.config.departuresPerHour}/h`),
          fact('Weather', s.config.weather), fact('Start', `${String(s.config.startHour).padStart(2, '0')}:00`), fact('Emergencies', s.config.emergencyRate ? 'possible' : 'none'),
        ),
        h('p', null, s.briefing),
        h('p', { class: 'tip' }, icon('info'), h('span', null, s.tip)),
        h('div', { class: 'targets' },
          h('span', null, 'Pass ', h('b', null, String(s.passScore))), h('span', null, '★★ ', h('b', null, String(Math.round(s.passScore * 1.6)))),
          h('span', null, '★★★ ', h('b', null, String(Math.round(s.passScore * 2.4)))), h('span', null, 'Fails below ', h('b', null, String(s.failScore)))),
        best ? h('p', null, `Best: ${best.score} pts `, h('span', { class: 'k amber' }, `${'★'.repeat(best.stars)}${'☆'.repeat(3 - best.stars)}`)) : '',
        h('button', { class: 'btn primary big-btn', id: 'btn-start-shift', disabled: locked ? '' : null, onclick: () => void this.startSession(shiftSession(s, (Math.random() * 2 ** 31) >>> 0)) },
          locked ? icon('lock') : icon('play'), locked ? 'Locked' : 'Start shift'),
      );
    };
    const list = h('div', { class: 'shift-list' },
      ...SHIFTS.map((s) => {
        const b = c.best[s.id];
        const locked = s.index > c.unlocked;
        const el = h('button', { class: `shift${locked ? ' locked' : ''}`, onclick: () => pick(s.id) },
          h('span', { class: 'n' }, String(s.index)),
          h('span', { class: 't' }, s.title, h('small', null, `${AIRPORT_BY_ID[s.airport].icao} · ${s.config.durationMin} min`)),
          h('span', { class: 'st' }, locked ? icon('lock') : b ? '★'.repeat(b.stars) + '☆'.repeat(3 - b.stars) : '☆☆☆'),
        );
        buttons.set(s.id, el);
        return el;
      }),
    );
    pick(SHIFTS[Math.min(c.unlocked, SHIFTS.length) - 1].id);
    this.show(this.menuShell(
      h('div', { class: 'row between' }, h('h2', null, 'Career'), h('button', { class: 'btn', onclick: () => void this.showMainMenu() }, icon('chevronLeft'), 'Back')),
      h('div', { class: 'career' }, list, detail),
    ));
  }

  private showFreePlay(): void {
    const sel = (name: string, opts: [string, string][], value: string): HTMLSelectElement =>
      h('select', { name }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value ? '' : null }, l))) as HTMLSelectElement;
    const airport = sel('airport', AIRPORTS.map((a) => [a.id, `${a.name} (${a.icao})`]), 'HPX');
    const cfgSel = h('select', { name: 'config' }) as HTMLSelectElement;
    const desc = h('p', { class: 'dim' });
    const fillCfg = (): void => {
      const ap = AIRPORT_BY_ID[airport.value];
      cfgSel.replaceChildren(h('option', { value: 'auto' }, 'Automatic (from wind)'), ...ap.runwayConfigs.map((c) => h('option', { value: c.id }, c.label)));
      desc.textContent = ap.description;
    };
    airport.addEventListener('change', fillCfg);
    fillCfg();
    const traffic = sel('traffic', [['light', 'Light (6/5 per hour)'], ['moderate', 'Moderate (10/8)'], ['busy', 'Busy (14/12)'], ['heavy', 'Heavy (20/16)']], 'moderate');
    const weather = sel('weather', [['clear', 'Clear'], ['cloudy', 'Cloudy'], ['windy', 'Windy & gusty'], ['rain', 'Rain'], ['storm', 'Thunderstorms'], ['fog', 'Fog (low visibility)']], 'clear');
    const hour = sel('hour', [['6', 'Dawn (06:00)'], ['9', 'Morning (09:00)'], ['13', 'Midday (13:00)'], ['17', 'Late afternoon (17:00)'], ['19', 'Sunset (19:00)'], ['22', 'Night (22:00)'], ['2', 'Small hours (02:00)']], '13');
    const dur = sel('duration', [['15', '15 minutes'], ['30', '30 minutes'], ['60', '60 minutes'], ['0', 'Endless']], '30');
    const emerg = sel('emergency', [['0', 'None'], ['0.04', 'Occasional'], ['0.1', 'Frequent']], '0.04');
    const field = (label: string, el: HTMLElement): HTMLElement => h('label', { class: 'field' }, h('span', null, label), el);
    const TRAFFIC: Record<string, [number, number]> = { light: [6, 5], moderate: [10, 8], busy: [14, 12], heavy: [20, 16] };
    const start = (): void => {
      const [arr, dep] = TRAFFIC[traffic.value];
      const cfg: SessionConfig = {
        mode: 'free', shiftId: null, airport: airport.value, runwayConfig: cfgSel.value,
        arrivalsPerHour: arr, departuresPerHour: dep, weather: weather.value as WeatherPreset,
        startHour: Number(hour.value), dayOfYear: 172, durationMin: Number(dur.value) || null,
        emergencyRate: Number(emerg.value), initialParked: 0.55, seed: (Math.random() * 2 ** 31) >>> 0,
      };
      void this.startSession(cfg);
    };
    this.show(this.menuShell(
      h('div', { class: 'row between' }, h('h2', null, 'Free play'), h('button', { class: 'btn', onclick: () => void this.showMainMenu() }, icon('chevronLeft'), 'Back')),
      h('div', { class: 'form-grid' },
        field('Airport', airport), field('Runways', cfgSel), field('Traffic', traffic), field('Weather', weather),
        field('Time of day', hour), field('Session length', dur), field('Emergencies', emerg),
      ),
      desc,
      h('button', { class: 'btn primary big-btn', id: 'btn-start-free', onclick: start }, icon('play'), 'Start session'),
    ));
  }

  // ------------------------------------------------------------ sessions
  private async startSession(cfg: SessionConfig): Promise<void> {
    if (!this.profile) return;
    try {
      // /api/me carries the checkpoint summary, so no 404-producing GET when there is none.
      const cp = (await api.me()).checkpoint;
      if (cp) {
        const ok = await this.confirm('Replace checkpoint?', `Starting a new session replaces your checkpoint (${cp.title}, score ${cp.score}). Use "Save game" in the pause menu first if you want to keep it.`, 'Start new session');
        if (!ok) return;
      }
    } catch {
      /* none */
    }
    this.launch(new World(cfg));
    if (cfg.mode === 'career' && cfg.shiftId) {
      const s = SHIFT_BY_ID[cfg.shiftId];
      this.game!.togglePause(true);
      const m = this.modal(`Shift ${s.index}: ${s.title}`, [
        h('p', null, s.briefing),
        h('p', { class: 'tip' }, icon('info'), h('span', null, s.tip)),
        h('p', { class: 'dim' }, `Target: ${s.passScore} points in ${s.config.durationMin} minutes. New to the job? Press F1 for help at any time.`),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => this.openHelp('start') }, icon('help'), 'How to play'),
          h('button', { class: 'btn primary', id: 'btn-begin', onclick: () => this.closeModal(m) }, icon('play'), 'Begin shift'),
        ),
      ], { onClose: () => this.game?.togglePause(false), icon: 'career' });
    }
    void this.game?.save();
  }

  private launch(world: World): void {
    this.game?.dispose();
    for (const m of [...this.modals]) this.closeModal(m);
    this.screen.replaceChildren();
    this.audio.setMusic('none');
    this.game = new Game(this, this.screen, world);
  }

  private async continueCheckpoint(): Promise<void> {
    if (!this.profile) return;
    try {
      const cp = await api.checkpoint();
      this.launch(new World(cp.state.cfg, cp.state));
      this.game!.togglePause(true);
      const m = this.modal('Welcome back', [
        h('p', null, `${cp.summary.title}. Score ${cp.summary.score}${cp.summary.remaining != null ? `, ${fmtDuration(cp.summary.remaining)} remaining` : ''}.`),
        h('p', { class: 'dim' }, 'The simulation is paused exactly where you left it.'),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', id: 'btn-resume', onclick: () => this.closeModal(m) }, icon('play'), 'Resume')),
      ], { onClose: () => this.game?.togglePause(false), icon: 'play' });
    } catch (e) {
      this.toast(`Could not load the checkpoint: ${(e as Error).message}`, true);
    }
  }

  private async showLoad(): Promise<void> {
    if (!this.profile) return;
    const list = await api.saves().catch(() => []);
    const body = h('div', { class: 'save-list' },
      ...(list.length ? list.map((s) =>
        h('div', { class: 'save' },
          h('button', {
            class: 'save-main', onclick: async () => {
              try {
                const full = await api.loadSave(s.id);
                this.closeModal(m);
                if (this.game && !(await this.confirm('Load game', 'Leave the current session? Its checkpoint will be replaced by the loaded game.', 'Load'))) return;
                this.launch(new World(full.state.cfg, full.state));
                this.game!.togglePause(true);
                void this.game!.save();
                this.toast(`Loaded "${s.label}" — press Space to resume`);
              } catch (e) {
                this.toast((e as Error).message, true);
              }
            },
          }, h('b', null, s.label), h('span', null, `${s.summary.title ?? ''} · score ${s.summary.score ?? 0}`), h('small', null, fmtDate(s.updatedAt))),
          h('button', {
            class: 'icon danger', title: 'Delete save', 'aria-label': `Delete ${s.label}`, onclick: async () => {
              if (await this.confirm('Delete save', `Delete "${s.label}"?`, 'Delete', true)) {
                await api.deleteSave(s.id);
                this.closeModal(m);
                void this.showLoad();
              }
            },
          }, icon('trash')),
        )) : [h('p', { class: 'dim' }, 'No saved games yet. Use "Save game" in the pause menu while playing.')]),
    );
    const m = this.modal('Load game', body, { wide: true, icon: 'folder' });
  }

  openPauseMenu(): void {
    const g = this.game;
    if (!g || this.isModalOpen()) return;
    const wasPaused = g.paused;
    g.togglePause(true);
    const w = g.world;
    const rem = w.remaining;
    const mine = w.aircraft.filter((a) => a.phase !== 'parked' && a.phase !== 'exited' && !a.handedOff).length;
    const m = this.modal('Paused', [
      h('div', { class: 'pause-stats' },
        h('div', null, h('span', null, 'Score'), h('b', { class: w.score < 0 ? 'err' : 'good' }, String(w.score))),
        h('div', null, h('span', null, 'Time left'), h('b', null, rem == null ? '∞' : fmtDuration(rem))),
        h('div', null, h('span', null, 'Traffic'), h('b', null, String(mine))),
      ),
      h('div', { class: 'pause-menu' },
        h('button', { class: 'btn primary', onclick: () => this.closeModal(m) }, icon('play'), 'Resume', h('kbd', null, 'Esc')),
        h('button', {
          class: 'btn', id: 'btn-save', onclick: async () => {
            const label = await this.prompt('Save game', 'Name', `${g.summary().title} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
            if (label == null || !this.profile) return;
            try {
              await api.createSave(label, g.world.snapshot(), g.summary());
              this.toast(`Saved "${label}"`);
            } catch (e) {
              this.toast((e as Error).message, true);
            }
          },
        }, icon('save'), 'Save game'),
        h('button', { class: 'btn', onclick: () => void this.showLoad() }, icon('folder'), 'Load game'),
        h('button', { class: 'btn', onclick: () => this.showSettings() }, icon('gear'), 'Settings'),
        h('button', { class: 'btn', onclick: () => this.openHelp() }, icon('help'), 'Help', h('kbd', null, 'F1')),
        h('button', { class: 'btn danger', id: 'btn-exit', onclick: () => void this.exitToMenu() }, icon('exit'), 'Save & exit to menu'),
      ),
    ], { onClose: () => this.game && this.game.togglePause(wasPaused), icon: 'pause' });
  }

  private async exitToMenu(): Promise<void> {
    const g = this.game;
    if (g) {
      await g.save();
      g.dispose();
      this.game = null;
    }
    for (const m of [...this.modals]) this.closeModal(m);
    await this.showMainMenu();
  }

  shiftEnded(world: World): void {
    const p = this.profile;
    const s = world.cfg.shiftId ? SHIFT_BY_ID[world.cfg.shiftId] : null;
    const st = world.stats;
    const stars = s ? starsFor(s, world.score) : 0;
    const passed = s ? world.ended !== 'failed' && world.score >= s.passScore : true;
    let unlockedNext = false;
    if (p) {
      void api.deleteCheckpoint().catch(() => undefined);
      if (s) {
        const c = this.career;
        const best = c.best[s.id];
        if (!best || world.score > best.score) c.best[s.id] = { score: world.score, stars: Math.max(stars, best?.stars ?? 0) };
        if (passed && c.unlocked <= s.index && s.index < SHIFTS.length) {
          c.unlocked = s.index + 1;
          unlockedNext = true;
        }
        const totalStars = Object.values(c.best).reduce((n, b) => n + b.stars, 0);
        const summary = `Shift ${Math.min(c.unlocked, SHIFTS.length)} of ${SHIFTS.length} · ${totalStars}★`;
        p.career = { ...c, summary };
        void api.saveCareer({ ...c, summary });
        void api.postResult({ shiftId: s.id, airport: world.cfg.airport, score: world.score, stars, stats: st });
      }
    }
    const tile = (ic: string, label: string, v: number, bad = false): HTMLElement => h('div', { class: bad && v > 0 ? 'bad' : '' }, icon(ic), h('b', null, String(v)), h('span', null, label));
    const title = world.ended === 'failed' ? 'Shift failed' : s ? (passed ? 'Shift complete' : 'Shift over — target missed') : 'Session complete';
    const m = this.modal(title, [
      s ? h('div', { class: 'stars-big', 'aria-label': `${stars} of 3 stars` },
        ...[0, 1, 2].map((i) => h('span', { class: i < stars ? '' : 'off', style: `animation-delay:${0.25 + i * 0.35}s` }, i < stars ? '★' : '☆'))) : null,
      h('div', { class: 'final-score' }, `${world.score} points`),
      s ? h('div', { class: 'final-sub' }, `Pass ${s.passScore} · ★★ ${Math.round(s.passScore * 1.6)} · ★★★ ${Math.round(s.passScore * 2.4)}`) : null,
      world.ended === 'failed' ? h('p', { class: 'err' }, 'The score dropped below the failure threshold: the supervisor relieved you from the position.') : null,
      unlockedNext ? h('p', { class: 'good' }, `Shift ${s!.index + 1} unlocked!`) : null,
      h('div', { class: 'results-grid' },
        tile('land', 'Landed', st.landed), tile('takeoff', 'Departed', st.departed), tile('ground', 'Parked', st.parked), tile('goaround', 'Go-arounds', st.goArounds, true),
        tile('alert', 'Separation', st.separationLosses, true), tile('runway', 'Incursions', st.incursions, true), tile('emergency', 'Emergencies', st.emergencies), tile('radio', 'Instructions', st.commands),
      ),
      h('div', { class: 'sec-title' }, 'Score breakdown'),
      breakdownView(world.scoreLog),
      h('div', { class: 'row end' },
        s ? h('button', { class: 'btn', onclick: () => { this.closeModal(m); void this.startSession(shiftSession(s, (Math.random() * 2 ** 31) >>> 0)); } }, icon('goaround'), 'Retry') : null,
        s && unlockedNext ? h('button', { class: 'btn primary', onclick: () => { this.closeModal(m); void this.startSession(shiftSession(SHIFTS[s.index], (Math.random() * 2 ** 31) >>> 0)); } }, icon('play'), 'Next shift') : null,
        h('button', { class: 'btn', id: 'btn-menu', onclick: () => { this.game?.dispose(); this.game = null; this.closeModal(m); void this.showMainMenu(); } }, icon('home'), 'Main menu'),
      ),
    ].filter(Boolean) as HTMLElement[], { closable: false, wide: true, icon: passed ? 'star' : 'alert' });
  }

  // ------------------------------------------------------------ settings
  showSettings(): void {
    const set = (patch: Partial<Settings>): void => {
      this.settings = { ...this.settings, ...patch };
      this.applySettings();
    };
    const opt = (label: string, hint: string, control: HTMLElement): HTMLElement =>
      h('label', { class: 'opt' }, h('span', null, h('b', null, label), hint ? h('small', null, hint) : ''), control);
    const range = (key: keyof Settings, label: string, hint: string, min: number, max: number, step: number, fmt: (v: number) => string): HTMLElement => {
      const out = h('output', null, fmt(this.settings[key] as number));
      return opt(label, hint, h('span', { class: 'rng' },
        h('input', {
          type: 'range', min: String(min), max: String(max), step: String(step), value: String(this.settings[key]), 'aria-label': label,
          oninput: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            out.textContent = fmt(v);
            set({ [key]: v } as Partial<Settings>);
          },
        }), out));
    };
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const check = (key: keyof Settings, label: string, hint = ''): HTMLElement =>
      opt(label, hint, h('input', { type: 'checkbox', checked: this.settings[key] ? '' : null, 'aria-label': label, onchange: (e: Event) => set({ [key]: (e.target as HTMLInputElement).checked } as Partial<Settings>) }));
    const choice = <K extends keyof Settings>(key: K, label: string, hint: string, opts: [Settings[K], string][]): HTMLElement =>
      opt(label, hint, h('select', {
        'aria-label': label, onchange: (e: Event) => {
          const raw = (e.target as HTMLSelectElement).value;
          const v = opts.find(([o]) => String(o) === raw)?.[0];
          set({ [key]: v } as Partial<Settings>);
        },
      }, ...opts.map(([v, l]) => h('option', { value: String(v), selected: this.settings[key] === v ? '' : null }, l))));

    const kbdRow = (keys: string[], text: string): HTMLElement => h('tr', null, h('td', null, ...keys.flatMap((k, i) => [i ? ' ' : '', h('kbd', null, k)])), h('td', null, text));
    const TABS: [string, string, string, () => HTMLElement[]][] = [
      ['graphics', 'Graphics', 'monitor', () => [
        h('h4', null, 'Rendering'),
        choice('quality', 'Quality', 'Lower it if the frame rate drops', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]),
        h('h4', null, '3D labels'),
        check('labels3d', 'Aircraft labels in the 3D view'),
        range('labelDistance', 'Label distance', 'Hide labels beyond this distance', 5000, 40000, 1000, (v) => `${Math.round(v / 1000)} km`),
      ]],
      ['interface', 'Interface', 'sliders', () => [
        h('h4', null, 'Appearance'),
        choice('uiScale', 'Interface scale', 'Size of all text and panels. Auto adapts to the window size', [[0, 'Auto'], [0.85, '85%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.2, '120%'], [1.3, '130%'], [1.4, '140%'], [1.5, '150%']]),
        choice('theme', 'Theme', '', [['console', 'Console (dark)'], ['contrast', 'High contrast']]),
        choice('density', 'Flight strip density', '', [['comfortable', 'Comfortable'], ['compact', 'Compact']]),
        check('reducedMotion', 'Reduce motion', 'Disables pulsing, flashes and animated transitions'),
        check('kbdHints', 'Show keyboard hints on buttons'),
        h('h4', null, 'Units & time'),
        choice('units', 'Altitude units', 'Strips and command panel (the radar keeps hundreds of feet)', [['ft', 'Feet'], ['m', 'Metres']]),
        choice('clock24', 'Clock', '', [[true, '24-hour'], [false, '12-hour']]),
        h('h4', null, 'Layout'),
        opt('Reset panel layout', 'Column widths, comms height and collapsed panels', h('button', {
          class: 'btn sm', onclick: (e: Event) => {
            e.preventDefault();
            set({ stripsW: DEFAULT_SETTINGS.stripsW, rightW: DEFAULT_SETTINGS.rightW, commsH: DEFAULT_SETTINGS.commsH, commsCollapsed: false, stripsCollapsed: false });
            this.toast('Layout reset');
          },
        }, 'Reset')),
      ]],
      ['radar', 'Radar', 'radar', () => [
        h('h4', null, 'Scope'),
        choice('radarRange', 'Default range', 'Used when a session starts', [[0, 'Fit airspace'], [10, '10 NM'], [20, '20 NM'], [30, '30 NM'], [40, '40 NM']]),
        check('radarRings', 'Range rings'),
        check('radarFixes', 'Fixes'),
        check('radarIls', 'Extended centrelines'),
        check('radarWater', 'Coastline'),
        h('h4', null, 'Targets'),
        check('radarBlocks', 'Full data blocks', 'Adds type and clearance as a third line'),
        range('radarTrail', 'History trail', 'Dots behind each target', 0, 12, 1, (v) => (v ? String(v) : 'off')),
        choice('radarVector', 'Predicted vector', '', [[0, 'Off'], [60, '1 minute'], [120, '2 minutes']]),
        range('radarFont', 'Data block size', '', 9, 15, 1, (v) => `${v}px`),
      ]],
      ['audio', 'Audio', 'volume', () => [
        h('h4', null, 'Volume'),
        range('master', 'Master', '', 0, 1, 0.05, pct), range('engines', 'Engines', '', 0, 1, 0.05, pct), range('radio', 'Radio', '', 0, 1, 0.05, pct),
        range('ambience', 'Ambience & weather', '', 0, 1, 0.05, pct), range('music', 'Music', '', 0, 1, 0.05, pct), range('ui', 'Interface sounds', '', 0, 1, 0.05, pct),
        h('h4', null, 'Radio voices'),
        check('pilotVoices', 'Speak pilot transmissions'),
        check('controllerVoice', 'Speak my (controller) transmissions'),
      ]],
      ['gameplay', 'Gameplay', 'gamepad', () => [
        h('h4', null, 'Session'),
        range('autosaveSec', 'Autosave interval', 'How often the checkpoint is saved while playing', 10, 120, 5, (v) => `${v} s`),
        check('pauseOnBlur', 'Pause when the tab is hidden'),
        h('h4', null, 'Account'),
        opt('Signed in', this.profile?.email || this.profile?.name || '', h('button', {
          class: 'btn sm', disabled: this.game ? '' : null, title: this.game ? 'Finish or exit the session first' : 'Sign out of this device',
          onclick: (e: Event) => {
            e.preventDefault();
            this.closeTopModal();
            void this.signOut();
          },
        }, 'Sign out')),
        opt('Delete my account', 'Removes your profile, career, checkpoint, saved games and results for good', h('button', {
          class: 'btn sm danger', id: 'btn-delete-account', disabled: this.game ? '' : null, title: this.game ? 'Finish or exit the session first' : 'Delete account',
          onclick: async (e: Event) => {
            e.preventDefault();
            if (!(await this.confirm('Delete account', 'Delete your profile with all careers, checkpoints, saved games and results? This cannot be undone.', 'Delete everything', true))) return;
            try {
              await api.deleteAccount();
            } catch (err) {
              if (!(err instanceof AuthError)) return this.toast((err as Error).message, true);
            }
            this.profile = null; // nothing left to persist when the settings dialog closes
            for (const m of [...this.modals].reverse()) this.closeModal(m);
            this.showSignIn();
          },
        }, 'Delete')),
      ]],
      ['controls', 'Controls', 'keyboard', () => [
        h('h4', null, 'General'),
        h('table', { class: 'keys' },
          kbdRow(['Space'], 'Pause / resume'), kbdRow(['Tab'], 'Swap radar and 3D view'), kbdRow(['1', '2', '3', '4'], 'Tower / orbit / follow / cockpit camera'),
          kbdRow(['+', '−'], 'Simulation speed'), kbdRow(['↑', '↓'], 'Select previous / next flight strip'), kbdRow(['N'], 'Notifications'),
          kbdRow(['Esc'], 'Close picker · deselect · pause menu'), kbdRow(['F1'], 'Help')),
        h('h4', null, 'Selected aircraft'),
        h('table', { class: 'keys' },
          kbdRow(['R'], 'Respond to the pilot’s request'), kbdRow(['H'], 'Heading (←/→ adjust, Enter sends)'), kbdRow(['A'], 'Altitude'), kbdRow(['S'], 'Speed'),
          kbdRow(['D'], 'Direct to'), kbdRow(['O'], 'Hold at'), kbdRow(['I'], 'Cleared ILS'), kbdRow(['L'], 'Cleared to land'), kbdRow(['G'], 'Go around'),
          kbdRow(['C'], 'Contact departure'), kbdRow(['P'], 'Push back'), kbdRow(['T'], 'Taxi'), kbdRow(['X'], 'Cross runway'), kbdRow(['Z'], 'Hold position'),
          kbdRow(['V'], 'Continue taxi'), kbdRow(['U'], 'Line up & wait'), kbdRow(['K'], 'Cleared for take-off'), kbdRow(['Q'], 'Cancel take-off')),
        h('h4', null, 'Radar'),
        h('table', { class: 'keys' },
          kbdRow(['Wheel'], 'Zoom'), kbdRow(['Drag'], 'Pan · drag a data block to move it'), kbdRow(['Shift', 'Drag'], 'Measure bearing & distance'),
          kbdRow(['R-click'], 'Vector the selected aircraft'), kbdRow(['Dbl-click'], 'Re-centre · reset a moved data block')),
      ]],
    ];
    const pane = h('div', { class: 'settings-pane' });
    const nav = h('nav', { class: 'settings-nav', role: 'tablist' });
    const showTab = (id: string): void => {
      const t = TABS.find((x) => x[0] === id) ?? TABS[0];
      pane.replaceChildren(...t[3]());
      for (const b of nav.children) b.classList.toggle('active', (b as HTMLElement).dataset.id === t[0]);
    };
    for (const [id, label, ic] of TABS) nav.append(h('button', { 'data-id': id, role: 'tab', onclick: () => showTab(id) }, icon(ic), label));
    showTab('graphics');
    this.modal('Settings', [
      h('div', { class: 'settings' }, nav, pane),
      h('div', { class: 'settings-foot' },
        h('button', {
          class: 'btn ghost sm', onclick: async () => {
            if (await this.confirm('Reset settings', 'Restore every setting to its default value?', 'Reset')) {
              set({ ...DEFAULT_SETTINGS });
              const active = (nav.querySelector('.active') as HTMLElement | null)?.dataset.id ?? 'graphics';
              showTab(active);
            }
          },
        }, 'Restore defaults'),
        h('button', { class: 'btn primary', onclick: () => this.closeTopModal() }, 'Done'),
      ),
    ], {
      wide: true,
      icon: 'gear',
      onClose: () => this.persistSettings(),
    });
  }
}
