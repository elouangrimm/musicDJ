import { html, LitElement, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicGenerationConfig, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils';

const GEMINI_API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY; // Allow both API_KEY and GEMINI_API_KEY

interface DefaultPromptData {
  color: string;
  text: string;
}
let LOADED_DEFAULT_PROMPTS: DefaultPromptData[] = [];

interface Prompt {
  readonly promptId: string;
  text: string;
  weight: number;
  color: string;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

function throttle<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => ReturnType<T> {
  let lastCall = -Infinity;
  let lastResult: ReturnType<T>;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      lastResult = func(...args);
      lastCall = now;
    }
    return lastResult;
  };
}

@customElement('toast-message')
class ToastMessage extends LitElement {
  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;

  override createRenderRoot() { return this; }

  override render() {
    return html`
      <div class="toast-container ${classMap({ showing: this.showing })}">
        <div class="toast-message-content">
            <span class="toast-text">${this.message}</span>
            <button class="toast-close-button" @click=${this.hide} aria-label="Close">
                <span class="material-symbols-outlined">close</span>
            </button>
        </div>
      </div>`;
  }

  show(message: string, duration = 5000) {
    this.message = message;
    this.showing = true;
    if (duration > 0) {
        setTimeout(() => this.hide(), duration);
    }
  }

  hide() { this.showing = false; }
}

class IconButtonBase extends LitElement {
  protected renderIcon() { return svg``; }
  override createRenderRoot() { return this; }
  override render() {
    return html`
        <button class="icon-button" part="button" aria-label=${this.getAttribute('aria-label') || 'icon button'}>
            ${this.renderIcon()}
        </button>
    `;
  }
}

@customElement('play-pause-button')
export class PlayPauseButton extends IconButtonBase {
  @property({ type: String }) playbackState: PlaybackState = 'stopped';

  private renderPause() { return svg`<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>`; }
  private renderPlay() { return svg`<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>`; }
  private renderLoading() {
    return svg`<svg class="loader-svg" viewBox="0 0 24 24"><circle class="loader-bg" cx="12" cy="12" r="10" /><circle class="loader-fg" cx="12" cy="12" r="10" /></svg>`;
  }
  override renderIcon() {
    let icon;
    let label = "Play";
    if (this.playbackState === 'playing') { icon = this.renderPause(); label = "Pause"; }
    else if (this.playbackState === 'loading') { icon = this.renderLoading(); label = "Loading"; }
    else { icon = this.renderPlay(); label = "Play"; }
    this.setAttribute('aria-label', label);
    return icon;
  }
}

@customElement('reset-button')
export class ResetButton extends IconButtonBase {
  private renderResetIcon() {
    return svg`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"></path></svg>`;
  }
  override renderIcon() { return this.renderResetIcon(); }
}

@customElement('add-prompt-button')
export class AddPromptButton extends IconButtonBase {
  private renderAddIcon() {
    return svg`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"></path></svg>`;
  }
  override renderIcon() { return this.renderAddIcon(); }
}


@customElement('prompt-controller')
class PromptController extends LitElement {
  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';
  @property({ type: Boolean, reflect: true }) filtered = false;

  @query('#text-input') private textInputEl!: HTMLSpanElement;
  @query('.weight-slider') private _sliderEl!: HTMLInputElement;

  private lastValidText!: string;

  override createRenderRoot() { return this; }

  private _updateSliderFill() {
    if (this._sliderEl) {
      const min = parseFloat(this._sliderEl.min) || 0;
      const max = parseFloat(this._sliderEl.max) || 2;
      const value = this.weight;
      const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
      this._sliderEl.style.setProperty('--slider-fill-percent', `${percentage}%`);
    }
  }

  override firstUpdated() {
    if (this.textInputEl) { this.textInputEl.textContent = this.text; }
    this.lastValidText = this.text;
    this._updateSliderFill();
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has('text') && this.textInputEl) { this.textInputEl.textContent = this.text; }
    if (changedProperties.has('weight')) { this._updateSliderFill(); }
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: { promptId: this.promptId, text: this.text, weight: this.weight, color: this.color, },
        bubbles: true, composed: true
      }),
    );
  }
  private dispatchPromptRemoved() {
    this.dispatchEvent( new CustomEvent<string>('prompt-removed', { detail: this.promptId, bubbles: true, composed: true, }), );
  }

  private handleTextInput(e: Event) { }
  private handleTextBlur(e: Event) {
    const newText = this.textInputEl.textContent?.trim();
    if (!newText || newText.length === 0) { this.textInputEl.textContent = this.lastValidText; }
    else { if (this.text !== newText) { this.text = newText; this.lastValidText = newText; this.dispatchPromptChange(); } }
  }
  private handleTextKeyDown(e: KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); this.textInputEl.blur(); } }
  private onFocus() {
    const selection = window.getSelection(); if (!selection || !this.textInputEl) return;
    const range = document.createRange(); range.selectNodeContents(this.textInputEl);
    selection.removeAllRanges(); selection.addRange(range);
  }
  private updateWeight(e: Event) {
    const slider = e.target as HTMLInputElement; this.weight = parseFloat(slider.value);
    const min = parseFloat(slider.min) || 0; const max = parseFloat(slider.max) || 2;
    const value = this.weight;
    const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    slider.style.setProperty('--slider-fill-percent', `${percentage}%`);
    this.dispatchPromptChange();
  }

  override render() {
    const haloStyle = styleMap({ '--prompt-halo-color': this.color, 'opacity': (this.weight / 2 * 0.7).toString() });
    const sliderContainerStyles = styleMap({ '--slider-thumb-color': this.color, });
    return html`
    <div class="prompt-card">
      <button class="remove-prompt-button" @click=${this.dispatchPromptRemoved} aria-label="Remove Prompt">
        <span class="material-symbols-outlined">delete</span>
      </button>
      <div class="prompt-halo" style=${haloStyle}></div>
      <span id="text-input" class="prompt-text-input" contenteditable="plaintext-only" spellcheck="false"
        @focus=${this.onFocus} @blur=${this.handleTextBlur} @keydown=${this.handleTextKeyDown} @input=${this.handleTextInput}
      >${this.text}</span>
      <div class="slider-container" style=${sliderContainerStyles}>
        <input type="range" class="weight-slider" min="0" max="2" step="0.01" .value=${this.weight.toString()}
            @input=${this.updateWeight} aria-label="Prompt weight for ${this.text}"/>
      </div>
    </div>`;
  }
}

@customElement('settings-controller')
class SettingsController extends LitElement {
    override createRenderRoot() { return this; }

    private readonly defaultConfig: LiveMusicGenerationConfig = { temperature: 1.1, topK: 40, guidance: 4.0 };
    @state() config: LiveMusicGenerationConfig = { ...this.defaultConfig };
    @state() showAdvanced = false;
    @state() autoDensity = true;
    @state() lastDefinedDensity: number | undefined = 0.5;
    @state() autoBrightness = true;
    @state() lastDefinedBrightness: number | undefined = 0.5;

    public resetToDefaults() {
        this.config = { ...this.defaultConfig };
        this.autoDensity = true; this.lastDefinedDensity = 0.5;
        this.autoBrightness = true; this.lastDefinedBrightness = 0.5;
        this.dispatchSettingsChange();
    }
    private updateSliderBackground(inputEl: HTMLInputElement) {
        if (inputEl.type !== 'range') return;
        const min = Number(inputEl.min) || 0; const max = Number(inputEl.max) || 100;
        const value = Number(inputEl.value);
        const percentage = ((value - min) / (max - min)) * 100;
        inputEl.style.setProperty('--value-percent', `${percentage}%`);
    }
    private handleInputChange(e: Event) {
        const target = e.target as HTMLInputElement;
        const key = target.id as keyof LiveMusicGenerationConfig | 'auto-density' | 'auto-brightness';
        let value: string | number | boolean | undefined = target.value;

        if (target.type === 'number' || target.type === 'range') {
            value = target.value === '' ? undefined : Number(target.value);
            if (target.type === 'range') this.updateSliderBackground(target);
        } else if (target.type === 'checkbox') {
            value = target.checked;
        } else if (target.type === 'select-one') {
            const selectElement = target as HTMLSelectElement;
            value = selectElement.options[selectElement.selectedIndex]?.disabled ? undefined : target.value;
        }

        const newConfig = { ...this.config };
        if (key === 'auto-density') {
            this.autoDensity = Boolean(value);
            newConfig.density = this.autoDensity ? undefined : this.lastDefinedDensity;
        } else if (key === 'auto-brightness') {
            this.autoBrightness = Boolean(value);
            newConfig.brightness = this.autoBrightness ? undefined : this.lastDefinedBrightness;
        } else {
            // @ts-ignore
            newConfig[key] = value;
        }
        if (key === 'density' && value !== undefined) this.lastDefinedDensity = Number(value);
        if (key === 'brightness' && value !== undefined) this.lastDefinedBrightness = Number(value);
        this.config = newConfig;
        this.dispatchSettingsChange();
    }
    override updated(changedProperties: Map<string | symbol, unknown>) {
        super.updated(changedProperties);
        if (changedProperties.has('config') || changedProperties.has('autoDensity') || changedProperties.has('autoBrightness')) {
            this.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((slider: HTMLInputElement) => {
                const configKey = slider.id as keyof LiveMusicGenerationConfig;
                let configValue: number | undefined;
                if (configKey === 'density') configValue = this.autoDensity ? this.lastDefinedDensity : this.config.density;
                else if (configKey === 'brightness') configValue = this.autoBrightness ? this.lastDefinedBrightness : this.config.brightness;
                else configValue = this.config[configKey] as number | undefined;

                slider.value = String(configValue ?? (slider.id === 'density' || slider.id === 'brightness' ? 0.5 : Number(slider.defaultValue) || 0) );
                this.updateSliderBackground(slider);
            });
        }
    }
    private dispatchSettingsChange() {
        this.dispatchEvent(new CustomEvent<LiveMusicGenerationConfig>('settings-changed', { detail: this.config, bubbles: true, composed: true }));
    }
    private toggleAdvancedSettings() { this.showAdvanced = !this.showAdvanced; }
    override render() {
        const cfg = this.config; const advancedClasses = classMap({ 'advanced-settings': true, 'visible': this.showAdvanced });
        const scaleMap = new Map<string, string>([ ['Auto', 'SCALE_UNSPECIFIED'], ['C Major / A Minor', 'C_MAJOR_A_MINOR'], ['C# Major / A# Minor', 'D_FLAT_MAJOR_B_FLAT_MINOR'], ['D Major / B Minor', 'D_MAJOR_B_MINOR'], ['D# Major / C Minor', 'E_FLAT_MAJOR_C_MINOR'], ['E Major / C# Minor', 'E_MAJOR_D_FLAT_MINOR'], ['F Major / D Minor', 'F_MAJOR_D_MINOR'], ['F# Major / D# Minor', 'G_FLAT_MAJOR_E_FLAT_MINOR'], ['G Major / E Minor', 'G_MAJOR_E_MINOR'], ['G# Major / F Minor', 'A_FLAT_MAJOR_F_MINOR'], ['A Major / F# Minor', 'A_MAJOR_G_FLAT_MINOR'], ['A# Major / G Minor', 'B_FLAT_MAJOR_G_MINOR'], ['B Major / G# Minor', 'B_MAJOR_A_FLAT_MINOR'], ]);
        return html`
      <div class="core-settings-row">
        <div class="setting"><label for="temperature">Temperature<span>${(cfg.temperature ?? this.defaultConfig.temperature!).toFixed(1)}</span></label><input type="range" id="temperature" min="0" max="3" step="0.1" .value=${String(cfg.temperature ?? this.defaultConfig.temperature)} @input=${this.handleInputChange} /></div>
        <div class="setting"><label for="guidance">Guidance<span>${(cfg.guidance ?? this.defaultConfig.guidance!).toFixed(1)}</span></label><input type="range" id="guidance" min="0" max="6" step="0.1" .value=${String(cfg.guidance ?? this.defaultConfig.guidance)} @input=${this.handleInputChange} /></div>
        <div class="setting"><label for="topK">Top K<span>${cfg.topK ?? this.defaultConfig.topK}</span></label><input type="range" id="topK" min="1" max="100" step="1" .value=${String(cfg.topK ?? this.defaultConfig.topK)} @input=${this.handleInputChange} /></div>
      </div>
      <hr class="divider" />
      <div class=${advancedClasses}>
        <div class="setting"><label for="seed">Seed</label><input type="number" id="seed" .value=${cfg.seed ?? ''} @input=${this.handleInputChange} placeholder="Auto" /></div>
        <div class="setting"><label for="bpm">BPM</label><input type="number" id="bpm" min="60" max="180" .value=${cfg.bpm ?? ''} @input=${this.handleInputChange} placeholder="Auto" /></div>
        <div class="setting" ?auto=${this.autoDensity}><label for="density">Density</label><input type="range" id="density" min="0" max="1" step="0.05" .value=${String(this.autoDensity ? this.lastDefinedDensity : cfg.density ?? 0.5)} @input=${this.handleInputChange} /><div class="auto-row"><input type="checkbox" id="auto-density" .checked=${this.autoDensity} @input=${this.handleInputChange} /><label for="auto-density">Auto</label><span>${(this.autoDensity ? this.lastDefinedDensity : cfg.density ?? 0.5).toFixed(2)}</span></div></div>
        <div class="setting" ?auto=${this.autoBrightness}><label for="brightness">Brightness</label><input type="range" id="brightness" min="0" max="1" step="0.05" .value=${String(this.autoBrightness ? this.lastDefinedBrightness : cfg.brightness ?? 0.5)} @input=${this.handleInputChange} /><div class="auto-row"><input type="checkbox" id="auto-brightness" .checked=${this.autoBrightness} @input=${this.handleInputChange} /><label for="auto-brightness">Auto</label><span>${(this.autoBrightness ? this.lastDefinedBrightness : cfg.brightness ?? 0.5).toFixed(2)}</span></div></div>
        <div class="setting"><label for="scale">Scale</label><select id="scale" .value=${cfg.scale || 'SCALE_UNSPECIFIED'} @change=${this.handleInputChange}><option value="SCALE_UNSPECIFIED">Auto (Default)</option>${[...scaleMap.entries()].filter(e => e[1] !== 'SCALE_UNSPECIFIED').map(([displayName, enumValue]) => html`<option value=${enumValue}>${displayName}</option>`)}</select></div>
        <div class="setting"><div class="checkbox-setting"><input type="checkbox" id="muteBass" .checked=${!!cfg.muteBass} @change=${this.handleInputChange} /><label for="muteBass" style="font-weight: normal;">Mute Bass</label></div><div class="checkbox-setting"><input type="checkbox" id="muteDrums" .checked=${!!cfg.muteDrums} @change=${this.handleInputChange} /><label for="muteDrums" style="font-weight: normal;">Mute Drums</label></div><div class="checkbox-setting"><input type="checkbox" id="onlyBassAndDrums" .checked=${!!cfg.onlyBassAndDrums} @change=${this.handleInputChange} /><label for="onlyBassAndDrums" style="font-weight: normal;">Only Bass & Drums</label></div></div>
        <div class="setting"><label for="musicGenerationMode">Generation Mode</label><select id="musicGenerationMode" .value=${cfg.musicGenerationMode || 'MUSIC_GENERATION_MODE_UNSPECIFIED'} @change=${this.handleInputChange}><option value="MUSIC_GENERATION_MODE_UNSPECIFIED">Auto (Default)</option><option value="QUALITY">Quality</option><option value="DIVERSITY">Diversity</option></select></div>
      </div>
      <div class="advanced-toggle" @click=${this.toggleAdvancedSettings}>${this.showAdvanced ? 'Hide' : 'Show'} Advanced Settings</div>`;
    }
}


@customElement('prompt-dj-controller')
class PromptDjController extends LitElement {
  @state() private prompts!: Map<string, Prompt>;
  @state() private playbackState: PlaybackState = 'stopped';
  @state() private promptsLoaded: boolean = false;

  private session!: LiveMusicSession;
  private audioContext!: AudioContext;
  private outputNode!: GainNode;
  private nextStartTime = 0;
  private readonly bufferTime = 1.5;

  @state() private filteredPrompts = new Set<string>();
  @state() private connectionError = false;

  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;

  private mediaArtwork = [ { src: 'music_icon_192.png', sizes: '192x192', type: 'image/png' }, ];

  private nextPromptIdCounter: number = 0;

  @state() private currentBPM: number | undefined = undefined;
  @state() private currentTemperature: number = 1.1;
  @state() private currentBrightness: number | undefined = undefined;
  @state() private currentDensity: number | undefined = undefined;
  @state() private muteBass: boolean = false;
  @state() private muteDrums: boolean = false;
  @state() private showAdvancedSettingsPanel = false;

  constructor() {
    super();
    this.initializeAudioContext();
    const initialConfigFromDetailedSettings = { temperature: 1.1, bpm: undefined, brightness: undefined, density: undefined, muteBass: false, muteDrums: false, };
    this.currentTemperature = initialConfigFromDetailedSettings.temperature;
    this.currentBPM = initialConfigFromDetailedSettings.bpm;
    this.currentBrightness = initialConfigFromDetailedSettings.brightness;
    this.currentDensity = initialConfigFromDetailedSettings.density;
    this.muteBass = initialConfigFromDetailedSettings.muteBass;
    this.muteDrums = initialConfigFromDetailedSettings.muteDrums;
  }

  override createRenderRoot() { return this; }

  async connectedCallback() {
    super.connectedCallback();
    if (!this.promptsLoaded) { await this.loadAndInitializePrompts(); this.promptsLoaded = true; }
  }

  private async loadAndInitializePrompts() {
    try {
      const response = await fetch('./default-prompts.json');
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      LOADED_DEFAULT_PROMPTS = await response.json();
      this.prompts = getInitialPrompts();
      this.nextPromptIdCounter = Math.max(0, ...Array.from(this.prompts.keys()).map(k => parseInt(k.split('-')[1] || '0'))) + 1;
      this.requestUpdate();
    } catch (error) {
      console.error("Could not load default prompts:", error);
      LOADED_DEFAULT_PROMPTS = []; this.prompts = getInitialPrompts();
      this.toastMessage?.show("Error loading default prompts. Using fallback.", 5000);
    }
  }

  private initializeAudioContext() {
    if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
        this.outputNode = this.audioContext.createGain(); this.outputNode.connect(this.audioContext.destination);
    }
  }
  private async ensureAudioContextResumed() { if (this.audioContext.state === 'suspended') await this.audioContext.resume(); }

  override async firstUpdated() {
    this.updateMediaSessionState();
    if (!this.promptsLoaded) { await this.loadAndInitializePrompts(); this.promptsLoaded = true; }
    // Initial sync of quick settings visuals
    requestAnimationFrame(() => {
        this.shadowRoot?.querySelectorAll('.quick-setting input[type="range"]').forEach(slider => {
            this.updateSliderVisual(slider as HTMLInputElement, parseFloat((slider as HTMLInputElement).value));
        });
    });
  }

  private async connectToSession() {
    if (!this.promptsLoaded) { this.toastMessage?.show("Prompts loading. Please wait.", 3000); return false; }
    if (this.session && !this.connectionError) return true;
    try {
        this.playbackState = 'loading'; this.connectionError = false;
        this.session = await ai.live.music.connect({ model: model, callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
              if (e.setupComplete) this.connectionError = false;
              if (e.filteredPrompt) { this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text]); this.toastMessage.show(`Filtered: ${e.filteredPrompt.text} (${e.filteredPrompt.filteredReason || 'Policy'})`); this.requestUpdate('filteredPrompts'); }
              if (e.serverContent?.audioChunks !== undefined) {
                  if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
                  await this.ensureAudioContextResumed();
                  const audioBuffer = await decodeAudioData(decode(e.serverContent?.audioChunks[0].data), this.audioContext, 48000, 2);
                  const source = this.audioContext.createBufferSource(); source.buffer = audioBuffer; source.connect(this.outputNode);
                  if (this.nextStartTime === 0 && this.playbackState === 'loading') {
                      this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                      setTimeout(() => { if(this.playbackState === 'loading') { this.playbackState = 'playing'; this.updateMediaSessionState(); } }, this.bufferTime * 1000);
                  } else if (this.nextStartTime === 0) return;
                  if (this.nextStartTime < this.audioContext.currentTime && this.playbackState !== 'paused' && this.playbackState !== 'stopped') { console.warn("Audio underrun."); this.playbackState = 'loading'; this.updateMediaSessionState(); this.nextStartTime = this.audioContext.currentTime + 0.2; }
                  source.start(this.nextStartTime); this.nextStartTime += audioBuffer.duration;
              }
            },
            onerror: (err: ErrorEvent | Event) => { const error = err as ErrorEvent; console.error('Session Error:', error.message || err); this.connectionError = true; this.playbackState = 'stopped'; this.updateMediaSessionState(); this.toastMessage.show('Connection error.'); if (this.session) this.session.close(); },
            onclose: (e: CloseEvent) => { console.log('Connection closed:', e.reason, 'Clean:', e.wasClean); if (!e.wasClean && this.playbackState !== 'stopped') { this.connectionError = true; this.playbackState = 'stopped'; this.updateMediaSessionState(); this.toastMessage.show('Connection closed.'); } /*@ts-ignore*/ this.session = null; },
        },});
        await this.updateLiveSettings(); // Send initial settings on connect
        return true;
    } catch (error: any) { console.error("Failed to connect:", error); this.connectionError = true; this.playbackState = 'stopped'; this.updateMediaSessionState(); this.toastMessage.show(`Connection failed: ${error.message || 'Unknown'}.`); return false; }
  }

  private getPromptsToSend() { if (!this.prompts) return []; return Array.from(this.prompts.values()).filter((p) => !this.filteredPrompts.has(p.text) && p.weight > 0).map(p => ({text: p.text, weight: p.weight})); }
  private setSessionPrompts = throttle(async () => {
    if (!this.promptsLoaded || !this.session || this.connectionError) return;
    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) { this.toastMessage.show('No active prompts. Pausing.', 3000); this.pause(); return; }
    if (promptsToSend.length === 0) return;
    try { await this.session.setWeightedPrompts({ weightedPrompts: promptsToSend });
      const currentPromptTexts = new Set(promptsToSend.map(p => p.text)); let changedFiltered = false;
      this.filteredPrompts.forEach(filteredText => { if (!currentPromptTexts.has(filteredText)) { this.filteredPrompts.delete(filteredText); changedFiltered = true; } });
      if (changedFiltered) this.requestUpdate('filteredPrompts'); this.updateMediaSessionMetadata();
    } catch (e: any) { this.toastMessage.show(`Error setting prompts: ${e.message}`); }
  }, 250);

  private dispatchPromptsChange() { if (!this.prompts) return; this.dispatchEvent(new CustomEvent<Map<string, Prompt>>('prompts-changed', { detail: new Map(this.prompts), bubbles: true, composed: true }),); }
  private handlePromptChanged(e: CustomEvent<Prompt>) {
    if (!this.prompts) return; const { promptId, text, weight, color } = e.detail; const prompt = this.prompts.get(promptId); if (!prompt) return;
    const oldText = prompt.text; let changed = false;
    if (prompt.text !== text) { prompt.text = text; changed = true; } if (prompt.weight !== weight) { prompt.weight = weight; changed = true; } if (prompt.color !== color) { prompt.color = color; changed = true; }
    if (changed) { if (this.filteredPrompts.has(oldText) && text !== oldText) { this.filteredPrompts.delete(oldText); this.requestUpdate('filteredPrompts'); }
        const newPrompts = new Map(this.prompts); newPrompts.set(promptId, { ...prompt }); this.prompts = newPrompts;
        this.setSessionPrompts(); this.dispatchPromptsChange(); }
  }

  private handleAddPrompt() {
    if (!this.promptsLoaded) return;
    const newPromptId = `prompt-${this.nextPromptIdCounter++}`;
    const usedColors = [...this.prompts.values()].map(p => p.color);
    const newPrompt: Prompt = { promptId: newPromptId, text: "New Prompt", weight: 0, color: getUnusedRandomColor(usedColors) };
    const newPrompts = new Map(this.prompts); newPrompts.set(newPromptId, newPrompt); this.prompts = newPrompts;
    this.setSessionPrompts(); this.dispatchPromptsChange(); // Save new prompt structure
    this.requestUpdate(); // Ensure new prompt is rendered
    // Scroll and focus logic would go here, after await this.updateComplete;
  }
  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation(); if (!this.prompts) return; const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) { this.prompts.delete(promptIdToRemove); const newPrompts = new Map(this.prompts); this.prompts = newPrompts; this.setSessionPrompts(); this.dispatchPromptsChange(); }
  }
  private handlePromptsContainerWheel(e: WheelEvent) { const container = e.currentTarget as HTMLElement; if (e.deltaX !== 0) { e.preventDefault(); container.scrollLeft += e.deltaX; } }

  private getCombinedGenerationConfig(): LiveMusicGenerationConfig {
    const baseConfig = this.settingsController?.config || { temperature: 1.1, topK: 40, guidance: 4.0 };
    const combined: LiveMusicGenerationConfig = { ...baseConfig };
    if (this.currentBPM !== undefined) combined.bpm = this.currentBPM;
    if (this.currentTemperature !== undefined) combined.temperature = this.currentTemperature; // Always defined
    if (this.currentBrightness !== undefined) combined.brightness = this.currentBrightness;
    if (this.currentDensity !== undefined) combined.density = this.currentDensity;
    combined.muteBass = this.muteBass; combined.muteDrums = this.muteDrums;
    return combined;
  }
  private updateLiveSettings = throttle(async () => {
    if (!this.session || this.connectionError) return; const configToSend = this.getCombinedGenerationConfig();
    console.log("Updating live settings with:", configToSend);
    try { await this.session.setMusicGenerationConfig({ musicGenerationConfig: configToSend }); }
    catch (e: any) { this.toastMessage.show(`Error updating settings: ${e.message}`); }
  }, 300);

  private handleQuickSettingChange(e: Event) {
    const target = e.target as HTMLInputElement; const setting = target.id;
    let value: number | boolean | undefined = target.type === 'checkbox' ? target.checked : parseFloat(target.value);
    if (target.type === 'range' || target.type === 'number') this.updateSliderVisual(target, parseFloat(target.value));
    switch(setting) {
        case 'quick-bpm': this.currentBPM = isNaN(Number(value)) ? undefined : Number(value); break;
        case 'quick-temperature': this.currentTemperature = Number(value); break;
        case 'quick-brightness': this.currentBrightness = isNaN(Number(value)) ? undefined : Number(value); break;
        case 'quick-density': this.currentDensity = isNaN(Number(value)) ? undefined : Number(value); break;
        case 'quick-mute-bass': this.muteBass = Boolean(value); break;
        case 'quick-mute-drums': this.muteDrums = Boolean(value); break;
    }
    this.updateLiveSettings();
  }
  private updateSliderVisual(slider: HTMLInputElement, value: number) {
    const min = parseFloat(slider.min) || 0; const max = parseFloat(slider.max) || 1;
    const percent = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--value-percent', `${Math.max(0, Math.min(100, percent))}%`);
  }
  private handleAdvancedSettingsUpdate(e: CustomEvent<LiveMusicGenerationConfig>) { this.updateLiveSettings(); this.requestUpdate(); }
  private toggleAdvancedSettingsPanel() { this.showAdvancedSettingsPanel = !this.showAdvancedSettingsPanel; }

  private readonly makeBackground = throttle(() => { /* ... same as before, ensure LOADED_DEFAULT_PROMPTS is used if this.prompts isn't ready ... */
    if (!this.promptsLoaded || !this.prompts || this.prompts.size === 0) return '';
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const MAX_WEIGHT_EFFECT = 2.0; const MAX_ALPHA_PER_PROMPT = 0.5; const bg: string[] = [];
    const numPrompts = this.prompts.size; const numCols = 4; const numRows = Math.ceil(numPrompts / numCols);
    const defaultPromptsForIndexing = LOADED_DEFAULT_PROMPTS.length > 0 ? LOADED_DEFAULT_PROMPTS : Array.from(this.prompts.values());
    [...this.prompts.values()].filter(p => p.weight > 0.01).forEach((p, i_active) => {
        const originalIndex = defaultPromptsForIndexing.findIndex(dp => dp.text === p.text && dp.color === p.color);
        const i = originalIndex !== -1 ? originalIndex : i_active;
        const alphaPct = clamp01(p.weight / MAX_WEIGHT_EFFECT) * MAX_ALPHA_PER_PROMPT;
        const alphaHex = Math.round(alphaPct * 255).toString(16).padStart(2, '0');
        const stopPercentage = (p.weight / MAX_WEIGHT_EFFECT) * 70 + 30;
        const colIndex = i % numCols; const rowIndex = Math.floor(i / numCols);
        const xJitter = ((p.text.length % 10) / 10 - 0.5) * 0.1; const yJitter = (((p.text.length * 3) % 10) / 10 - 0.5) * 0.1;
        const x = numCols > 1 ? colIndex / (numCols -1 ) + xJitter : 0.5 + xJitter; const y = numRows > 1 ? rowIndex / (numRows -1) + yJitter : 0.5 + yJitter;
        const clampedX = clamp01(x) * 100; const clampedY = clamp01(y) * 100;
        bg.push(`radial-gradient(circle at ${clampedX}% ${clampedY}%, ${p.color}${alphaHex} 0%, ${p.color}00 ${clamp01(stopPercentage / 100) * 100}%)`);
    });
    return bg.join(', ');
  }, 50);

  private async pause() { /* ... same ... */
    await this.ensureAudioContextResumed(); if (this.session && (this.playbackState === 'playing' || this.playbackState === 'loading')) this.session.pause();
    this.playbackState = 'paused'; if (this.audioContext.state === 'running') { const currentGain = this.outputNode.gain.value; this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime); this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime); this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.2); }
    this.updateMediaSessionState();
  }
  private async play() { /* ... same ... */
    if (!this.promptsLoaded) { this.toastMessage?.show("Initializing prompts...", 3000); return; } await this.ensureAudioContextResumed();
    if (!this.session || this.connectionError) { this.toastMessage.show('Connecting...'); const connected = await this.connectToSession(); if (!connected) { this.playbackState = 'stopped'; this.updateMediaSessionState(); return; } }
    const promptsToSend = this.getPromptsToSend(); if (promptsToSend.length === 0) { this.toastMessage.show('Add vibes!', 3000); if (this.playbackState === 'playing' || this.playbackState === 'loading') this.pause(); return; }
    await this.setSessionPrompts(); if (this.getPromptsToSend().length === 0 && this.playbackState !== 'playing' && this.playbackState !== 'loading') return;
    this.session.play(); this.playbackState = 'loading'; const currentGain = this.outputNode.gain.value; this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime); this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime); this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
    this.nextStartTime = 0; this.updateMediaSessionState(); this.updateMediaSessionMetadata();
  }
  private async stop() { /* ... same ... */
    await this.ensureAudioContextResumed(); if (this.session) { this.session.stop(); /*@ts-ignore*/ this.session = null; } this.playbackState = 'stopped';
    if (this.audioContext.state === 'running') { const currentGain = this.outputNode.gain.value; this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime); this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime); this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1); }
    this.nextStartTime = 0; this.updateMediaSessionState();
  }
  private async handlePlayPause() { /* ... same ... */ await this.ensureAudioContextResumed(); if (this.playbackState === 'playing') this.pause(); else if (this.playbackState === 'paused' || this.playbackState === 'stopped') this.play(); else if (this.playbackState === 'loading') this.stop(); }
  private async handleReset() {
    await this.ensureAudioContextResumed();
    if (this.connectionError && !this.session) await this.connectToSession(); // Try to connect if fully disconnected
    if (this.session) {
        this.pause(); // Pause audio before resetting context
        this.session.resetContext();
        // Re-apply current settings after reset
        // Small delay to allow resetContext to process
        setTimeout(() => {
             this.updateLiveSettings();
             if (this.playbackState === 'paused' && this.getPromptsToSend().length > 0) {
                 this.play(); // Resume play if it was paused and there are active prompts
             }
        }, 200);
    }
    this.settingsController?.resetToDefaults(); // Reset advanced settings UI
    // Reset quick settings to their initial state
    const initialConfigFromDetailedSettings = { temperature: 1.1, bpm: undefined, brightness: undefined, density: undefined, muteBass: false, muteDrums: false, };
    this.currentTemperature = initialConfigFromDetailedSettings.temperature; this.currentBPM = initialConfigFromDetailedSettings.bpm;
    this.currentBrightness = initialConfigFromDetailedSettings.brightness; this.currentDensity = initialConfigFromDetailedSettings.density;
    this.muteBass = initialConfigFromDetailedSettings.muteBass; this.muteDrums = initialConfigFromDetailedSettings.muteDrums;
    this.requestUpdate(); // Re-render quick settings
    this.toastMessage.show("Context Reset", 2000);
  }

  private updateMediaSessionMetadata() { /* ... same ... */
    if (!('mediaSession' in navigator) || !this.prompts) return; const activePrompts = Array.from(this.prompts.values()).filter(p => p.weight > 0.5); let title = "musicDJ AI";
    if (activePrompts.length > 0) { title = activePrompts.slice(0, 2).map(p => p.text).join(' + '); if (activePrompts.length > 2) title += " & more"; }
    navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: "Google Generative AI", album: "Lyria Realtime Stream", artwork: this.mediaArtwork });
  }
  private updateMediaSessionState() { /* ... same ... */
    if (!('mediaSession' in navigator)) return; navigator.mediaSession.playbackState = this.playbackState === 'playing' || this.playbackState === 'loading' ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => this.handlePlayPause()); navigator.mediaSession.setActionHandler('pause', () => this.handlePlayPause());
  }

  override render() {
    if (!this.promptsLoaded) { const loadingStyle = `display: flex; justify-content: center; align-items: center; width: 100%; height: 100vh; text-align: center; font-size: 1.2rem; color: var(--md-sys-color-on-background);`; return html`<div class="loading-prompts" style="${loadingStyle}">Loading prompts...</div>`; }
    const bg = styleMap({ backgroundImage: this.makeBackground(), });
    const advancedOverlayClasses = classMap({ 'advanced-settings-panel-overlay': true, 'visible': this.showAdvancedSettingsPanel });
    return html`
      <div id="background-layer" style=${bg}></div>
      <div class="app-layout">
        <header class="app-header"><h1>musicDJ AI</h1></header>
        <main class="app-main-content">
          <div id="prompt-grid-container">
            ${this.prompts && [...this.prompts.values()].map((prompt) => html`<prompt-controller .promptId=${prompt.promptId} ?filtered=${this.filteredPrompts.has(prompt.text)} .text=${prompt.text} .weight=${prompt.weight} .color=${prompt.color} @prompt-changed=${this.handlePromptChanged} @prompt-removed=${this.handlePromptRemoved}></prompt-controller>`)}
          </div>
           <div class="add-prompt-button-container"> <add-prompt-button @click=${this.handleAddPrompt}></add-prompt-button> </div>
        </main>
        <div class=${advancedOverlayClasses} @click=${this.toggleAdvancedSettingsPanel}><div class="advanced-settings-modal" @click=${(e: Event) => e.stopPropagation()}><settings-controller @settings-changed=${this.handleAdvancedSettingsUpdate}></settings-controller><button @click=${this.toggleAdvancedSettingsPanel} class="close-advanced-settings">Done</button></div></div>
        <footer class="control-bar">
          <div class="main-playback-controls">
            <reset-button @click=${this.handleReset}></reset-button>
            <play-pause-button @click=${this.handlePlayPause} .playbackState=${this.playbackState}></play-pause-button>
            <button class="settings-main-toggle-button" @click=${this.toggleAdvancedSettingsPanel} aria-label="Toggle Advanced Settings"><span class="material-symbols-outlined">tune</span></button>
          </div>
          <div class="quick-settings-grid">
            <div class="quick-setting"><label for="quick-bpm">BPM <span class="value">${this.currentBPM ?? 'Auto'}</span></label><input type="range" id="quick-bpm" min="60" max="180" step="1" .value=${(this.currentBPM ?? 120).toString()} @input=${this.handleQuickSettingChange} style="--slider-thumb-color: #FFC107;"></div>
            <div class="quick-setting"><label for="quick-temperature">Temp <span class="value">${this.currentTemperature.toFixed(1)}</span></label><input type="range" id="quick-temperature" min="0.1" max="3.0" step="0.1" .value=${this.currentTemperature.toString()} @input=${this.handleQuickSettingChange} style="--slider-thumb-color: #00BCD4;"></div>
            <div class="quick-setting"><label for="quick-brightness">Bright <span class="value">${this.currentBrightness?.toFixed(2) ?? 'Auto'}</span></label><input type="range" id="quick-brightness" min="0" max="1" step="0.05" .value=${(this.currentBrightness ?? 0.5).toString()} @input=${this.handleQuickSettingChange} style="--slider-thumb-color: #FFEB3B;"></div>
            <div class="quick-setting"><label for="quick-density">Dense <span class="value">${this.currentDensity?.toFixed(2) ?? 'Auto'}</span></label><input type="range" id="quick-density" min="0" max="1" step="0.05" .value=${(this.currentDensity ?? 0.5).toString()} @input=${this.handleQuickSettingChange} style="--slider-thumb-color: #8BC34A;"></div>
          </div>
          <div class="mute-toggles">
            <label><input type="checkbox" id="quick-mute-bass" .checked=${this.muteBass} @change=${this.handleQuickSettingChange}> Mute Bass</label>
            <label><input type="checkbox" id="quick-mute-drums" .checked=${this.muteDrums} @change=${this.handleQuickSettingChange}> Mute Drums</label>
          </div>
        </footer>
      </div>
      <toast-message></toast-message>`;
  }
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY!, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';

const COLORS = ['#D0BCFF', '#A8C7FA', '#F48FB1', '#80DEEA', '#FFE082', '#A5D6A7', '#CE93D8', '#B39DDB',];
function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) return COLORS[Math.floor(Math.random() * COLORS.length)];
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

async function main(parent: HTMLElement) {
  if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY not available in main function."); return; }
  const pdjController = new PromptDjController(); parent.appendChild(pdjController);
  pdjController.addEventListener('prompts-changed', (e: Event) => { const customEvent = e as CustomEvent<Map<string, Prompt>>; setStoredPrompts(customEvent.detail); });
}
function getInitialPrompts(): Map<string, Prompt> {
  const { localStorage } = window; const storedPrompts = localStorage.getItem('prompts-v2');
  if (storedPrompts) { try { const parsedPromptsArray = JSON.parse(storedPrompts) as Prompt[]; const defaultPromptsMap = new Map(LOADED_DEFAULT_PROMPTS.map(p => [p.text, p.color])); const cleanPrompts = parsedPromptsArray.map(p => ({ promptId: p.promptId, text: p.text, weight: typeof p.weight === 'number' && !isNaN(p.weight) ? p.weight : 0, color: p.color || defaultPromptsMap.get(p.text) || '#D0BCFF', })); return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt])); } catch (e) { console.error('Failed to parse stored prompts, using defaults.', e); localStorage.removeItem('prompts-v2'); } }
  const prompts = new Map<string, Prompt>(); if (LOADED_DEFAULT_PROMPTS.length === 0) { console.warn("LOADED_DEFAULT_PROMPTS is empty. No default prompts will be set."); return prompts; }
  const startOnTexts = [...LOADED_DEFAULT_PROMPTS].sort(() => Math.random() - 0.5).slice(0, Math.min(3, LOADED_DEFAULT_PROMPTS.length)).map(p => p.text);
  let initialPromptIdCounter = 0;
  LOADED_DEFAULT_PROMPTS.forEach((defaultPromptData) => { const promptId = `prompt-${initialPromptIdCounter++}`; prompts.set(promptId, { promptId, text: defaultPromptData.text, weight: startOnTexts.includes(defaultPromptData.text) ? 1 : 0, color: defaultPromptData.color, }); });
  return prompts;
}
function setStoredPrompts(prompts: Map<string, Prompt>) { const promptsArray = [...prompts.values()].map(p => ({ promptId: p.promptId, text: p.text, weight: p.weight, color: p.color, })); const storedPrompts = JSON.stringify(promptsArray); try { window.localStorage.setItem('prompts-v2', storedPrompts); } catch (e) { console.error("Error saving prompts to localStorage:", e); } }

if (GEMINI_API_KEY) { main(document.body).catch(err => { console.error("Error in main execution:", err); document.body.innerHTML = `<div style="color: red; padding: 20px; text-align: center;"><h2>Critical Application Error</h2><p>An unexpected error occurred. Please check the console and try refreshing.</p></div>`; }); }
else { const errorMsg = "FATAL ERROR: GEMINI_API_KEY is not set. Application cannot run. Please set the GEMINI_API_KEY environment variable."; console.error(errorMsg); document.body.innerHTML = `<div style="color: #F44336; background-color: #FFEBEE; border: 1px solid #FFCDD2; padding: 20px; margin: 20px; font-family: 'Roboto', sans-serif; border-radius: 8px; text-align: center;"><h2>Configuration Error</h2><p>${errorMsg}</p></div>`; }

declare global {
  interface Window { webkitAudioContext: typeof AudioContext; }
  interface HTMLElementTagNameMap {
    'prompt-dj-controller': PromptDjController;
    'prompt-controller': PromptController;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'toast-message': ToastMessage;
  }
}