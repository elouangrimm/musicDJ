import { html, LitElement, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

  override createRenderRoot() {
    return this;
  }

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

  hide() {
    this.showing = false;
  }
}

class IconButtonBase extends LitElement {
  protected renderIcon() {
    return svg``;
  }

  override createRenderRoot() {
    return this;
  }

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

  private renderPause() {
    return svg`<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>`;
  }
  private renderPlay() {
    return svg`<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>`;
  }
  private renderLoading() {
    return svg`
        <svg class="loader-svg" viewBox="0 0 24 24">
            <circle class="loader-bg" cx="12" cy="12" r="10" />
            <circle class="loader-fg" cx="12" cy="12" r="10" />
        </svg>`;
  }

  override renderIcon() {
    let icon;
    let label = "Play";
    if (this.playbackState === 'playing') {
      icon = this.renderPause();
      label = "Pause";
    } else if (this.playbackState === 'loading') {
      icon = this.renderLoading();
      label = "Loading";
    } else {
      icon = this.renderPlay();
      label = "Play";
    }
    this.setAttribute('aria-label', label);
    return icon;
  }
}

@customElement('prompt-controller')
class PromptController extends LitElement {
  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';
  @property({ type: Boolean, reflect: true }) filtered = false;

  @query('#text-input') private textInputEl!: HTMLSpanElement;

  private lastValidText!: string;

  override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    if (this.textInputEl) {
        this.textInputEl.textContent = this.text;
    }
    this.lastValidText = this.text;
  }

  update(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('text') && this.textInputEl) {
      this.textInputEl.textContent = this.text;
    }
    super.update(changedProperties);
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          color: this.color,
        },
        bubbles: true,
        composed: true
      }),
    );
  }

  private handleTextInput(e: Event) {}

  private handleTextBlur(e: Event) {
    const newText = this.textInputEl.textContent?.trim();
    if (!newText || newText.length === 0) {
      this.textInputEl.textContent = this.lastValidText;
    } else {
      if (this.text !== newText) {
        this.text = newText;
        this.lastValidText = newText;
        this.dispatchPromptChange();
      }
    }
  }

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.textInputEl.blur();
    }
  }


  private onFocus() {
    const selection = window.getSelection();
    if (!selection || !this.textInputEl) return;
    const range = document.createRange();
    range.selectNodeContents(this.textInputEl);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private updateWeight(e: Event) {
    const slider = e.target as HTMLInputElement;
    this.weight = parseFloat(slider.value);
    this.dispatchPromptChange();
  }

  override render() {
    const haloStyle = styleMap({
        '--prompt-halo-color': this.color,
        'opacity': (this.weight / 2 * 0.7).toString()
    });
    const sliderThumbStyle = styleMap({
        '--slider-thumb-color': this.color,
    });

    return html`
    <div class="prompt-card" style=${sliderThumbStyle}>
      <div class="prompt-halo" style=${haloStyle}></div>
      <span
        id="text-input"
        class="prompt-text-input"
        contenteditable="plaintext-only"
        spellcheck="false"
        @focus=${this.onFocus}
        @blur=${this.handleTextBlur}
        @keydown=${this.handleTextKeyDown}
        @input=${this.handleTextInput}
      ></span>
      <div class="slider-container">
        <input
            type="range"
            class="weight-slider"
            min="0"
            max="2"
            step="0.01"
            .value=${this.weight.toString()}
            @input=${this.updateWeight}
            aria-label="Prompt weight for ${this.text}"
        />
        <div class="slider-track-fill" style="width: ${(this.weight / 2) * 100}%"></div>
      </div>
    </div>`;
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

  private mediaArtwork = [
    { src: 'music_icon_192.png', sizes: '192x192', type: 'image/png' },
  ];

  constructor() {
    super();
    this.initializeAudioContext();
  }

  override createRenderRoot() {
    return this;
  }

  async connectedCallback() {
    super.connectedCallback();
    if (!this.promptsLoaded) {
      await this.loadAndInitializePrompts();
      this.promptsLoaded = true;
    }
  }

  private async loadAndInitializePrompts() {
    try {
      const response = await fetch('./default-prompts.json');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      LOADED_DEFAULT_PROMPTS = await response.json();
      this.prompts = getInitialPrompts();
      this.requestUpdate();
    } catch (error) {
      console.error("Could not load default prompts:", error);
      LOADED_DEFAULT_PROMPTS = [];
      this.prompts = getInitialPrompts();
      this.toastMessage?.show("Error loading default prompts. Using fallback.", 5000);
    }
  }

  private initializeAudioContext() {
    if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
             sampleRate: 48000,
             latencyHint: 'interactive'
        });
        this.outputNode = this.audioContext.createGain();
        this.outputNode.connect(this.audioContext.destination);
    }
  }

  private async ensureAudioContextResumed() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  override async firstUpdated() {
    this.updateMediaSessionState();
  }

  private async connectToSession() {
    if (!this.promptsLoaded) {
        this.toastMessage?.show("Prompts not loaded yet. Please wait.", 3000);
        return false;
    }
    if (this.session && !this.connectionError) return true;

    try {
        this.playbackState = 'loading';
        this.connectionError = false;
        this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
              if (e.setupComplete) {
                  this.connectionError = false;
              }
              if (e.filteredPrompt) {
                  this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text])
                  this.toastMessage.show(`Filtered: ${e.filteredPrompt.text} (${e.filteredPrompt.filteredReason || 'Policy'})`);
                  this.requestUpdate('filteredPrompts');
              }
              if (e.serverContent?.audioChunks !== undefined) {
                  if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
                  
                  await this.ensureAudioContextResumed();

                  const audioBuffer = await decodeAudioData(
                    decode(e.serverContent?.audioChunks[0].data),
                    this.audioContext,
                    48000,
                    2,
                  );
                  const source = this.audioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(this.outputNode);
                  
                  if (this.nextStartTime === 0 && this.playbackState === 'loading') {
                      this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                      setTimeout(() => {
                          if(this.playbackState === 'loading') {
                            this.playbackState = 'playing';
                            this.updateMediaSessionState();
                          }
                      }, this.bufferTime * 1000);
                  } else if (this.nextStartTime === 0) {
                      return;
                  }

                  if (this.nextStartTime < this.audioContext.currentTime && this.playbackState !== 'paused' && this.playbackState !== 'stopped') {
                      console.warn("Audio underrun. Resetting nextStartTime.");
                      this.playbackState = 'loading';
                      this.updateMediaSessionState();
                      this.nextStartTime = this.audioContext.currentTime + 0.2;
                  }
                  source.start(this.nextStartTime);
                  this.nextStartTime += audioBuffer.duration;
              }
            },
            onerror: (err: ErrorEvent | Event) => {
                const error = err as ErrorEvent;
                console.error('Session Error:', error.message || err);
                this.connectionError = true;
                this.playbackState = 'stopped';
                this.updateMediaSessionState();
                this.toastMessage.show('Connection error. Please try again.');
                if (this.session) this.session.close();
            },
            onclose: (e: CloseEvent) => {
                console.log('Connection closed:', e.reason, 'Clean:', e.wasClean);
                if (!e.wasClean && this.playbackState !== 'stopped') {
                    this.connectionError = true;
                    this.playbackState = 'stopped';
                     this.updateMediaSessionState();
                    this.toastMessage.show('Connection closed. Please restart audio.');
                }
                // @ts-ignore
                this.session = null;
            },
        },
        });
        return true;
    } catch (error: any) {
        console.error("Failed to connect to session:", error);
        this.connectionError = true;
        this.playbackState = 'stopped';
        this.updateMediaSessionState();
        this.toastMessage.show(`Connection failed: ${error.message || 'Unknown error'}. Check API key & network.`);
        return false;
    }
  }


  private getPromptsToSend() {
    if (!this.prompts) return [];
    return Array.from(this.prompts.values())
      .filter((p) => !this.filteredPrompts.has(p.text) && p.weight > 0)
      .map(p => ({text: p.text, weight: p.weight}));
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.promptsLoaded || !this.session || this.connectionError) return;

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('No active prompts. Pausing music.', 3000)
      this.pause();
      return;
    }
    if (promptsToSend.length === 0) return;

    try {
      await this.session.setWeightedPrompts({ weightedPrompts: promptsToSend });
      const currentPromptTexts = new Set(promptsToSend.map(p => p.text));
      let changedFiltered = false;
      this.filteredPrompts.forEach(filteredText => {
          if (!currentPromptTexts.has(filteredText)) {
              this.filteredPrompts.delete(filteredText);
              changedFiltered = true;
          }
      });
      if (changedFiltered) this.requestUpdate('filteredPrompts');
      this.updateMediaSessionMetadata();

    } catch (e: any) {
      this.toastMessage.show(`Error setting prompts: ${e.message}`);
    }
  }, 250);


  private dispatchPromptsChange() {
    if (!this.prompts) return;
    this.dispatchEvent(
      new CustomEvent<Map<string, Prompt>>('prompts-changed', { detail: new Map(this.prompts), bubbles: true, composed: true }),
    );
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    if (!this.prompts) return;
    const { promptId, text, weight, color } = e.detail;
    const prompt = this.prompts.get(promptId);
    if (!prompt) return;

    const oldText = prompt.text;
    let changed = false;
    if (prompt.text !== text) { prompt.text = text; changed = true; }
    if (prompt.weight !== weight) { prompt.weight = weight; changed = true; }
    if (prompt.color !== color) { prompt.color = color; changed = true; }


    if (changed) {
        if (this.filteredPrompts.has(oldText) && text !== oldText) {
            this.filteredPrompts.delete(oldText);
            this.requestUpdate('filteredPrompts');
        }
        const newPrompts = new Map(this.prompts);
        newPrompts.set(promptId, { ...prompt });
        this.prompts = newPrompts;

        this.setSessionPrompts();
        this.dispatchPromptsChange();
    }
  }

  private readonly makeBackground = throttle(() => {
      if (!this.prompts || this.prompts.size === 0) return '';
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
      const MAX_WEIGHT_EFFECT = 2.0;
      const MAX_ALPHA_PER_PROMPT = 0.5;
      const bg: string[] = [];
      const numPrompts = this.prompts.size;
      const numCols = 4;
      const numRows = Math.ceil(numPrompts / numCols);
      const defaultPromptsForIndexing = LOADED_DEFAULT_PROMPTS.length > 0 ? LOADED_DEFAULT_PROMPTS : Array.from(this.prompts.values());


      [...this.prompts.values()].filter(p => p.weight > 0.01).forEach((p, i_active) => {
          const originalIndex = defaultPromptsForIndexing.findIndex(dp => dp.text === p.text && dp.color === p.color);
          const i = originalIndex !== -1 ? originalIndex : i_active;


          const alphaPct = clamp01(p.weight / MAX_WEIGHT_EFFECT) * MAX_ALPHA_PER_PROMPT;
          const alphaHex = Math.round(alphaPct * 255).toString(16).padStart(2, '0');
          const stopPercentage = (p.weight / MAX_WEIGHT_EFFECT) * 70 + 30;

          const colIndex = i % numCols;
          const rowIndex = Math.floor(i / numCols);
          
          const xJitter = (Math.random() - 0.5) * 0.1;
          const yJitter = (Math.random() - 0.5) * 0.1;

          const x = numCols > 1 ? colIndex / (numCols -1 ) + xJitter : 0.5 + xJitter;
          const y = numRows > 1 ? rowIndex / (numRows -1) + yJitter : 0.5 + yJitter;
          
          const clampedX = clamp01(x) * 100;
          const clampedY = clamp01(y) * 100;

          bg.push(`radial-gradient(circle at ${clampedX}% ${clampedY}%, ${p.color}${alphaHex} 0%, ${p.color}00 ${clamp01(stopPercentage / 100) * 100}%)`);
      });
      return bg.join(', ');
  }, 50);


  private async pause() {
    await this.ensureAudioContextResumed();
    if (this.session && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
        this.session.pause();
    }
    this.playbackState = 'paused';
    if (this.audioContext.state === 'running') {
        const currentGain = this.outputNode.gain.value;
        this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
        this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.2);
    }
    this.updateMediaSessionState();
  }

  private async play() {
    if (!this.promptsLoaded) {
        this.toastMessage?.show("Initializing prompts... Please try again shortly.", 3000);
        return;
    }
    await this.ensureAudioContextResumed();
    
    if (!this.session || this.connectionError) {
        this.toastMessage.show('Connecting to Lyria...');
        const connected = await this.connectToSession();
        if (!connected) {
            this.toastMessage.show('Connection failed. Cannot play.');
            this.playbackState = 'stopped';
            this.updateMediaSessionState();
            return;
        }
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('Add some vibes! Turn up a prompt slider to begin.', 3000)
      if (this.playbackState === 'playing' || this.playbackState === 'loading') {
        this.pause();
      }
      return;
    }
    
    await this.setSessionPrompts();
    if (this.playbackState === 'paused' && this.getPromptsToSend().length === 0) {
        return; 
    }

    this.session.play();
    this.playbackState = 'loading';
    const currentGain = this.outputNode.gain.value;
    this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
    this.nextStartTime = 0;
    this.updateMediaSessionState();
    this.updateMediaSessionMetadata();
  }

  private async stop() {
    await this.ensureAudioContextResumed();
    if (this.session) {
        this.session.stop();
        // @ts-ignore
        this.session = null; 
    }
    this.playbackState = 'stopped';
    if (this.audioContext.state === 'running') {
        const currentGain = this.outputNode.gain.value;
        this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
        this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
    this.nextStartTime = 0;
    this.updateMediaSessionState();
  }

  private async handlePlayPause() {
    await this.ensureAudioContextResumed();
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      this.play();
    } else if (this.playbackState === 'loading') {
      this.stop();
    }
  }

  private updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !this.prompts) return;

    const activePrompts = Array.from(this.prompts.values()).filter(p => p.weight > 0.5);
    let title = "musicDJ AI";
    if (activePrompts.length > 0) {
        title = activePrompts.slice(0, 2).map(p => p.text).join(' + ');
        if (activePrompts.length > 2) title += " & more";
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: "Google Generative AI",
      album: "Lyria Realtime Stream",
      artwork: this.mediaArtwork
    });
  }

  private updateMediaSessionState() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.playbackState = this.playbackState === 'playing' || this.playbackState === 'loading'
      ? 'playing'
      : 'paused';

    navigator.mediaSession.setActionHandler('play', () => this.handlePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => this.handlePlayPause());
  }


  override render() {
    if (!this.promptsLoaded) {
        const loadingStyle = `
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 100vh; /* Make the loading div itself take full viewport height */
          text-align: center;
          font-size: 1.2rem;
          color: var(--md-sys-color-on-background); 
      `;
      return html`<div class="loading-prompts" style="${loadingStyle}">Loading...</div>`;
    }
    const backgroundStyle = styleMap({
      backgroundImage: this.makeBackground(),
    });

    return html`
      <div id="background-layer" style=${backgroundStyle}></div>
      <div class="app-layout">
        <header class="app-header">
            <h1>musicDJ AI</h1>
        </header>
        <main class="app-main-content">
            <div id="prompt-grid-container">
                ${[...this.prompts.values()].map((prompt) => html`
                <prompt-controller
                    .promptId=${prompt.promptId}
                    ?filtered=${this.filteredPrompts.has(prompt.text)}
                    .text=${prompt.text}
                    .weight=${prompt.weight}
                    .color=${prompt.color}
                    @prompt-changed=${this.handlePromptChanged}>
                </prompt-controller>`)}
            </div>
        </main>
        <footer class="app-footer">
            <play-pause-button
                .playbackState=${this.playbackState}
                @click=${this.handlePlayPause}
                aria-label=${this.playbackState === 'playing' ? 'Pause audio generation' : 'Play audio generation'}
            ></play-pause-button>
        </footer>
      </div>
      <toast-message></toast-message>
    `;
  }
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';

async function main(parent: HTMLElement) {
  if (!GEMINI_API_KEY) {
    const errorMsg = "FATAL ERROR: GEMINI_API_KEY is not set. The application cannot run. Please set the GEMINI_API_KEY environment variable and rebuild/redeploy.";
    console.error(errorMsg);
    parent.innerHTML = `<div style="color: #F44336; background-color: #FFEBEE; border: 1px solid #FFCDD2; padding: 20px; margin: 20px; font-family: 'Roboto', sans-serif; border-radius: 8px; text-align: center;"><h2>Configuration Error</h2><p>${errorMsg}</p></div>`;
    return;
  }

  const pdjController = new PromptDjController();
  parent.appendChild(pdjController);

  pdjController.addEventListener('prompts-changed', (e: Event) => {
    const customEvent = e as CustomEvent<Map<string, Prompt>>;
    setStoredPrompts(customEvent.detail);
  });
}

function getInitialPrompts(): Map<string, Prompt> {
  const { localStorage } = window;
  const storedPrompts = localStorage.getItem('prompts-v2');

  if (storedPrompts) {
    try {
      const parsedPromptsArray = JSON.parse(storedPrompts) as Prompt[];
      const defaultPromptsMap = new Map(LOADED_DEFAULT_PROMPTS.map(p => [p.text, p.color]));

      const cleanPrompts = parsedPromptsArray.map(p => ({
        promptId: p.promptId,
        text: p.text,
        weight: typeof p.weight === 'number' ? p.weight : 0,
        color: p.color || defaultPromptsMap.get(p.text) || '#D0BCFF',
      }));
      return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
      localStorage.removeItem('prompts-v2');
    }
  }

  const prompts = new Map<string, Prompt>();
  if (LOADED_DEFAULT_PROMPTS.length === 0) {
      console.warn("LOADED_DEFAULT_PROMPTS is empty during getInitialPrompts.");
      return prompts;
  }

  const startOnTexts = [...LOADED_DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3).map(p => p.text);

  LOADED_DEFAULT_PROMPTS.forEach((defaultPromptData, i) => {
    const promptId = `prompt-${i}`;
    prompts.set(promptId, {
      promptId,
      text: defaultPromptData.text,
      weight: startOnTexts.includes(defaultPromptData.text) ? 1 : 0,
      color: defaultPromptData.color,
    });
  });
  return prompts;
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const promptsArray = [...prompts.values()].map(p => ({
    promptId: p.promptId,
    text: p.text,
    weight: p.weight,
    color: p.color,
  }));
  const storedPrompts = JSON.stringify(promptsArray);
  try {
    window.localStorage.setItem('prompts-v2', storedPrompts);
  } catch (e) {
    console.error("Error saving prompts to localStorage:", e);
  }
}

if (GEMINI_API_KEY) {
    main(document.body).catch(err => {
        console.error("Error in main execution:", err);
        document.body.innerHTML = `<div style="color: red; padding: 20px;">Critical error during app startup. Check console.</div>`;
    });
} else {
    const errorMsg = "FATAL ERROR: GEMINI_API_KEY is not set. The application cannot run. Please set the GEMINI_API_KEY environment variable and rebuild/redeploy.";
    document.body.innerHTML = `<div style="color: #F44336; background-color: #FFEBEE; border: 1px solid #FFCDD2; padding: 20px; margin: 20px; font-family: 'Roboto', sans-serif; border-radius: 8px; text-align: center;"><h2>Configuration Error</h2><p>${errorMsg}</p></div>`;
}


declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
  interface HTMLElementTagNameMap {
    'prompt-dj-controller': PromptDjController;
    'prompt-controller': PromptController;
    'play-pause-button': PlayPauseButton;
    'toast-message': ToastMessage
  }
}