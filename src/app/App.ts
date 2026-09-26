// Application shell: pilot profiles, main menu, career / free play setup, settings, pause menu and shift results.

import { World, type WorldSnapshot } from '../sim/world';
import { SHIFTS, SHIFT_BY_ID, shiftSession, starsFor, NEW_CAREER, type CareerState, type SessionConfig, type WeatherPreset } from '../sim/career';
import { AIRPORTS, AIRPORT_BY_ID } from '../sim/airports';
import { GameRenderer } from '../render/Renderer';
import { createAudioEngine } from '../audio';
import type { IAudioEngine } from '../audio/contracts';
import { Game, type GameHost } from './Game';
import { HelpDialog } from '../ui/help';
import { api, DEFAULT_SETTINGS, type CheckpointSummary, type Profile, type ProfileSummary, type Settings } from '../ui/api';
import { h, fmtDate, fmtDuration } from '../ui/dom';

const PROFILE_KEY = 'skyward.profile';

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
  private modals: HTMLElement[] = [];
  private readonly toastEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.screen = h('div', { class: 'screen-host' });
    this.modalLayer = h('div', { class: 'modal-layer' });
    this.toastEl = h('div', { class: 'toast hidden' });
    root.append(this.screen, this.modalLayer, this.toastEl);
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
      if (e.key === 'Escape' && this.modals.length && !this.help.isOpen) {
        e.stopImmediatePropagation();
        this.closeTopModal();
      } else if (e.key === 'Escape' && this.help.isOpen) {
        e.stopImmediatePropagation();
        this.help.close();
      }
    }, { capture: true });
  }

  async start(): Promise<void> {
    try {
      await api.health();
    } catch {
      this.show(h('div', { class: 'menu' }, h('h1', null, 'Skyward ATC'), h('p', { class: 'err' }, 'Cannot reach the game server. Is the container running?')));
      return;
    }
    const last = Number(localStorage.getItem(PROFILE_KEY));
    if (last) {
      try {
        await this.useProfile(last);
        return;
      } catch {
        localStorage.removeItem(PROFILE_KEY);
      }
    }
    await this.showProfiles();
  }

  // ------------------------------------------------------------ GameHost
  async saveCheckpoint(state: WorldSnapshot, summary: CheckpointSummary, beacon = false): Promise<boolean> {
    if (!this.profile) return false;
    if (beacon) return api.beaconCheckpoint(this.profile.id, state, summary);
    try {
      await api.putCheckpoint(this.profile.id, state, summary);
      return true;
    } catch (e) {
      console.warn('checkpoint save failed', e);
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

  private modal(title: string, body: HTMLElement | HTMLElement[], opts: { wide?: boolean; onClose?: () => void; closable?: boolean } = {}): HTMLElement {
    const close = (): void => this.closeModal(m);
    const m = h('div', { class: 'modal' },
      h('div', { class: `modal-card${opts.wide ? ' wide' : ''}` },
        h('div', { class: 'modal-head' }, h('h2', null, title), opts.closable === false ? null : h('button', { class: 'close', 'aria-label': 'Close', onclick: close }, '✕')),
        h('div', { class: 'modal-body' }, ...(Array.isArray(body) ? body : [body])),
      ),
    );
    (m as unknown as { onClose?: () => void }).onClose = opts.onClose;
    (m as unknown as { closable: boolean }).closable = opts.closable !== false;
    this.modalLayer.append(m);
    this.modals.push(m);
    return m;
  }

  private closeModal(m: HTMLElement): void {
    const i = this.modals.indexOf(m);
    if (i >= 0) this.modals.splice(i, 1);
    m.remove();
    (m as unknown as { onClose?: () => void }).onClose?.();
  }

  private closeTopModal(): void {
    const m = this.modals[this.modals.length - 1];
    if (m && (m as unknown as { closable: boolean }).closable) this.closeModal(m);
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
      ], { onClose: () => !done && res(false) });
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
      ], { onClose: () => !done && res(null) });
      setTimeout(() => input.select(), 0);
    });
  }

  private menuShell(...children: (HTMLElement | null)[]): HTMLElement {
    return h('div', { class: 'menu-screen' },
      h('div', { class: 'menu-bg' }),
      h('div', { class: 'menu' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, '◈'), h('div', null, h('h1', null, 'Skyward ATC'), h('div', { class: 'tag' }, 'Approach · Tower · Ground'))),
        ...children,
      ),
    );
  }

  // ------------------------------------------------------------ profiles
  private async showProfiles(): Promise<void> {
    let list: ProfileSummary[] = [];
    try {
      list = await api.profiles();
    } catch (e) {
      this.toast(String(e), true);
    }
    const input = h('input', { type: 'text', placeholder: 'Your controller name', maxlength: '24', 'aria-label': 'New profile name' }) as HTMLInputElement;
    const create = async (): Promise<void> => {
      try {
        const p = await api.createProfile(input.value);
        await this.useProfile(p.id);
      } catch (e) {
        this.toast((e as Error).message, true);
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
    this.show(this.menuShell(
      h('h2', null, 'Choose your controller profile'),
      h('div', { class: 'profile-list' },
        ...list.map((p) =>
          h('div', { class: 'profile' },
            h('button', { class: 'profile-main', onclick: () => void this.useProfile(p.id) },
              h('b', null, p.name),
              h('span', null, p.careerSummary ?? 'New controller'),
              h('small', null, p.checkpoint ? `Checkpoint: ${p.checkpoint.title} · ${fmtDate(p.checkpoint.savedAt)}` : `Last played ${fmtDate(p.lastPlayedAt)}`),
            ),
            h('button', {
              class: 'icon danger', title: `Delete ${p.name}`, 'aria-label': `Delete ${p.name}`,
              onclick: async () => {
                if (await this.confirm('Delete profile', `Delete "${p.name}" with its career, checkpoint and saves? This cannot be undone.`, 'Delete', true)) {
                  await api.deleteProfile(p.id);
                  void this.showProfiles();
                }
              },
            }, '🗑'),
          ),
        ),
      ),
      h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onclick: () => void create() }, 'Create profile')),
    ));
    setTimeout(() => input.focus(), 0);
  }

  private async useProfile(id: number): Promise<void> {
    this.profile = await api.profile(id);
    localStorage.setItem(PROFILE_KEY, String(id));
    this.settings = { ...DEFAULT_SETTINGS, ...this.profile.settings };
    this.applySettings();
    await this.showMainMenu();
  }

  private get career(): CareerState {
    const c = this.profile?.career ?? {};
    return { unlocked: c.unlocked ?? NEW_CAREER.unlocked, best: c.best ?? {} };
  }

  private applySettings(): void {
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
    try {
      const all = await api.profiles();
      cp = all.find((x) => x.id === p.id)?.checkpoint ?? null;
    } catch {
      /* offline */
    }
    const c = this.career;
    const stars = Object.values(c.best).reduce((s, b) => s + b.stars, 0);
    this.show(this.menuShell(
      h('div', { class: 'welcome' }, `Welcome back, `, h('b', null, p.name), h('span', { class: 'dim' }, ` · Career ${Math.min(c.unlocked, SHIFTS.length)}/${SHIFTS.length} · ${stars}★`)),
      h('div', { class: 'menu-buttons' },
        cp ? h('button', { class: 'big primary', id: 'btn-continue', onclick: () => void this.continueCheckpoint() },
          h('b', null, '▶ Continue'),
          h('span', null, `${cp.title} · score ${cp.score}${cp.remaining != null ? ` · ${fmtDuration(cp.remaining)} left` : ''}`),
          h('small', null, `Saved ${fmtDate(cp.savedAt)}`),
        ) : null,
        h('button', { class: 'big', id: 'btn-career', onclick: () => this.showCareer() }, h('b', null, 'Career'), h('span', null, '10 shifts across three airports')),
        h('button', { class: 'big', id: 'btn-free', onclick: () => this.showFreePlay() }, h('b', null, 'Free play'), h('span', null, 'Your airport, traffic and weather')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => void this.showLoad() }, 'Load game'),
          h('button', { class: 'btn', onclick: () => this.showSettings() }, 'Settings'),
          h('button', { class: 'btn', id: 'btn-help', onclick: () => this.openHelp() }, 'Help'),
          h('button', { class: 'btn', onclick: () => { localStorage.removeItem(PROFILE_KEY); this.profile = null; void this.showProfiles(); } }, 'Switch profile'),
        ),
      ),
      h('div', { class: 'footer dim' }, 'Your progress is saved automatically on the server.'),
    ));
  }

  private showCareer(): void {
    const c = this.career;
    const detail = h('div', { class: 'shift-detail' });
    const pick = (id: string): void => {
      const s = SHIFT_BY_ID[id];
      const ap = AIRPORT_BY_ID[s.airport];
      const best = c.best[s.id];
      const locked = s.index > c.unlocked;
      detail.replaceChildren(
        h('h3', null, `Shift ${s.index} — ${s.title}`),
        h('div', { class: 'dim' }, `${ap.name} (${ap.icao}) · ${s.config.durationMin} min · ${s.config.arrivalsPerHour} arr/h · ${s.config.departuresPerHour} dep/h · ${s.config.weather}`),
        h('p', null, s.briefing),
        h('p', { class: 'tip' }, `💡 ${s.tip}`),
        h('div', { class: 'dim' }, `Pass: ${s.passScore} pts · ★★ ${Math.round(s.passScore * 1.6)} · ★★★ ${Math.round(s.passScore * 2.4)} · Fails below ${s.failScore}`),
        best ? h('div', null, `Best: ${best.score} pts ${'★'.repeat(best.stars)}${'☆'.repeat(3 - best.stars)}`) : '',
        h('button', { class: 'btn primary', id: 'btn-start-shift', disabled: locked ? '' : null, onclick: () => void this.startSession(shiftSession(s, (Math.random() * 2 ** 31) >>> 0)) }, locked ? '🔒 Locked' : 'Start shift'),
      );
    };
    const list = h('div', { class: 'shift-list' },
      ...SHIFTS.map((s) => {
        const b = c.best[s.id];
        const locked = s.index > c.unlocked;
        return h('button', { class: `shift${locked ? ' locked' : ''}`, onclick: () => pick(s.id) },
          h('span', { class: 'n' }, String(s.index)),
          h('span', { class: 't' }, s.title, h('small', null, AIRPORT_BY_ID[s.airport].icao)),
          h('span', { class: 'st' }, locked ? '🔒' : b ? '★'.repeat(b.stars) + '☆'.repeat(3 - b.stars) : '☆☆☆'),
        );
      }),
    );
    pick(SHIFTS[Math.min(c.unlocked, SHIFTS.length) - 1].id);
    this.show(this.menuShell(
      h('div', { class: 'row between' }, h('h2', null, 'Career'), h('button', { class: 'btn', onclick: () => void this.showMainMenu() }, '← Back')),
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
      h('div', { class: 'row between' }, h('h2', null, 'Free play'), h('button', { class: 'btn', onclick: () => void this.showMainMenu() }, '← Back')),
      h('div', { class: 'form-grid' },
        field('Airport', airport), field('Runways', cfgSel), field('Traffic', traffic), field('Weather', weather),
        field('Time of day', hour), field('Session length', dur), field('Emergencies', emerg),
      ),
      desc,
      h('button', { class: 'btn primary big-btn', id: 'btn-start-free', onclick: start }, 'Start session'),
    ));
  }

  // ------------------------------------------------------------ sessions
  private async startSession(cfg: SessionConfig): Promise<void> {
    if (!this.profile) return;
    try {
      // The profile list carries the checkpoint summary, so no 404-producing GET when there is none.
      const pid = this.profile.id;
      const cp = (await api.profiles()).find((x) => x.id === pid)?.checkpoint ?? null;
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
        h('p', { class: 'tip' }, `💡 ${s.tip}`),
        h('p', { class: 'dim' }, `Target: ${s.passScore} points in ${s.config.durationMin} minutes. New to the job? Press F1 for help at any time.`),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => this.openHelp('start') }, 'How to play'),
          h('button', { class: 'btn primary', id: 'btn-begin', onclick: () => this.closeModal(m) }, 'Begin shift'),
        ),
      ], { onClose: () => this.game?.togglePause(false) });
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
      const cp = await api.checkpoint(this.profile.id);
      this.launch(new World(cp.state.cfg, cp.state));
      this.game!.togglePause(true);
      const m = this.modal('Welcome back', [
        h('p', null, `${cp.summary.title}. Score ${cp.summary.score}${cp.summary.remaining != null ? `, ${fmtDuration(cp.summary.remaining)} remaining` : ''}.`),
        h('p', { class: 'dim' }, 'The simulation is paused exactly where you left it.'),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', id: 'btn-resume', onclick: () => this.closeModal(m) }, 'Resume')),
      ], { onClose: () => this.game?.togglePause(false) });
    } catch (e) {
      this.toast(`Could not load the checkpoint: ${(e as Error).message}`, true);
    }
  }

  private async showLoad(): Promise<void> {
    if (!this.profile) return;
    const pid = this.profile.id;
    const list = await api.saves(pid).catch(() => []);
    const body = h('div', { class: 'save-list' },
      ...(list.length ? list.map((s) =>
        h('div', { class: 'save' },
          h('button', {
            class: 'save-main', onclick: async () => {
              try {
                const full = await api.loadSave(pid, s.id);
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
                await api.deleteSave(pid, s.id);
                this.closeModal(m);
                void this.showLoad();
              }
            },
          }, '🗑'),
        )) : [h('p', { class: 'dim' }, 'No saved games yet. Use "Save game" in the pause menu while playing.')]),
    );
    const m = this.modal('Load game', body, { wide: true });
  }

  openPauseMenu(): void {
    const g = this.game;
    if (!g || this.isModalOpen()) return;
    const wasPaused = g.paused;
    g.togglePause(true);
    const m = this.modal('Paused', h('div', { class: 'pause-menu' },
      h('button', { class: 'btn primary', onclick: () => this.closeModal(m) }, 'Resume'),
      h('button', {
        class: 'btn', id: 'btn-save', onclick: async () => {
          const label = await this.prompt('Save game', 'Name', `${g.summary().title} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
          if (label == null || !this.profile) return;
          try {
            await api.createSave(this.profile.id, label, g.world.snapshot(), g.summary());
            this.toast(`Saved "${label}"`);
          } catch (e) {
            this.toast((e as Error).message, true);
          }
        },
      }, 'Save game'),
      h('button', { class: 'btn', onclick: () => void this.showLoad() }, 'Load game'),
      h('button', { class: 'btn', onclick: () => this.showSettings() }, 'Settings'),
      h('button', { class: 'btn', onclick: () => this.openHelp() }, 'Help'),
      h('button', { class: 'btn danger', id: 'btn-exit', onclick: () => void this.exitToMenu() }, 'Save & exit to menu'),
    ), { onClose: () => this.game && this.game.togglePause(wasPaused) });
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
      void api.deleteCheckpoint(p.id).catch(() => undefined);
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
        void api.saveCareer(p.id, { ...c, summary });
        void api.postResult(p.id, { shiftId: s.id, airport: world.cfg.airport, score: world.score, stars, stats: st });
      }
    }
    const row = (k: string, v: string | number): HTMLElement => h('tr', null, h('td', null, k), h('td', null, String(v)));
    const title = world.ended === 'failed' ? 'Shift failed' : s ? (passed ? 'Shift complete' : 'Shift over — target missed') : 'Session complete';
    const m = this.modal(title, [
      s ? h('div', { class: 'stars-big' }, '★'.repeat(stars) + '☆'.repeat(3 - stars)) : null,
      h('div', { class: 'final-score' }, `${world.score} points`),
      world.ended === 'failed' ? h('p', { class: 'err' }, 'The score dropped below the failure threshold: the supervisor relieved you from the position.') : null,
      unlockedNext ? h('p', { class: 'good' }, `Shift ${s!.index + 1} unlocked!`) : null,
      h('table', { class: 'stats' },
        row('Landed', st.landed), row('Departed', st.departed), row('Parked', st.parked), row('Go-arounds', st.goArounds),
        row('Separation losses', st.separationLosses), row('Runway incursions', st.incursions), row('Emergencies', st.emergencies), row('Instructions given', st.commands),
      ),
      h('div', { class: 'row end' },
        s ? h('button', { class: 'btn', onclick: () => { this.closeModal(m); void this.startSession(shiftSession(s, (Math.random() * 2 ** 31) >>> 0)); } }, 'Retry') : null,
        s && unlockedNext ? h('button', { class: 'btn primary', onclick: () => { this.closeModal(m); void this.startSession(shiftSession(SHIFTS[s.index], (Math.random() * 2 ** 31) >>> 0)); } }, 'Next shift') : null,
        h('button', { class: 'btn', id: 'btn-menu', onclick: () => { this.game?.dispose(); this.game = null; this.closeModal(m); void this.showMainMenu(); } }, 'Main menu'),
      ),
    ].filter(Boolean) as HTMLElement[], { closable: false });
  }

  // ------------------------------------------------------------ settings
  showSettings(): void {
    const s = { ...this.settings };
    const slider = (key: keyof Settings, label: string): HTMLElement => {
      const out = h('output', null, `${Math.round((s[key] as number) * 100)}%`);
      return h('label', { class: 'field slider' }, h('span', null, label),
        h('input', {
          type: 'range', min: '0', max: '1', step: '0.05', value: String(s[key]),
          oninput: (e: Event) => {
            (s as Record<string, unknown>)[key] = Number((e.target as HTMLInputElement).value);
            out.textContent = `${Math.round((s[key] as number) * 100)}%`;
            this.settings = { ...s };
            this.applySettings();
          },
        }), out);
    };
    const check = (key: keyof Settings, label: string): HTMLElement =>
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: s[key] ? '' : null, onchange: (e: Event) => {
          (s as Record<string, unknown>)[key] = (e.target as HTMLInputElement).checked;
          this.settings = { ...s };
          this.applySettings();
        },
      }), ` ${label}`);
    const quality = h('select', {
      onchange: (e: Event) => {
        s.quality = (e.target as HTMLSelectElement).value as Settings['quality'];
        this.settings = { ...s };
        this.applySettings();
      },
    }, ...(['low', 'medium', 'high', 'ultra'] as const).map((q) => h('option', { value: q, selected: s.quality === q ? '' : null }, q[0].toUpperCase() + q.slice(1))));
    this.modal('Settings', [
      h('div', { class: 'settings-grid' },
        h('div', null,
          h('h4', null, 'Graphics'),
          h('label', { class: 'field' }, h('span', null, 'Quality'), quality),
          check('labels3d', 'Aircraft labels in the 3D view'),
          h('h4', null, 'Radio'),
          check('pilotVoices', 'Speak pilot transmissions'),
          check('controllerVoice', 'Speak my (controller) transmissions'),
        ),
        h('div', null,
          h('h4', null, 'Volume'),
          slider('master', 'Master'), slider('engines', 'Engines'), slider('radio', 'Radio'), slider('ambience', 'Ambience & weather'), slider('music', 'Music'), slider('ui', 'Interface'),
        ),
      ),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => this.closeTopModal() }, 'Done')),
    ], {
      wide: true,
      onClose: () => {
        if (this.profile) {
          this.profile.settings = this.settings;
          void api.saveSettings(this.profile.id, this.settings).catch(() => this.toast('Could not save settings', true));
        }
      },
    });
  }
}
