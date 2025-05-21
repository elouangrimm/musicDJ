// index.ts

import { html, LitElement, svg } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'; // Ensure ./utils.ts exists and exports these

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
  @query('.weight-slider') private _sliderEl!: HTMLInputElement; // Query the slider element

  private lastValidText!: string;

  override createRenderRoot() {
    return this;
  }

  private _updateSliderFill() {
    if (this._sliderEl) {
      const min = parseFloat(this._sliderEl.min) || 0;
      const max = parseFloat(this._sliderEl.max) || 2; // Matches your HTML
      const value = this.weight;
      const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
      this._sliderEl.style.setProperty('--slider-fill-percent', `${percentage}%`);
    }
  }

  override firstUpdated() {
    if (this.textInputEl) {
        this.textInputEl.textContent = this.text;
    }
    this.lastValidText = this.text;
    this._updateSliderFill(); // Set initial fill
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has('text') && this.textInputEl) {
      this.textInputEl.textContent = this.text;
    }
    
    if (changedProperties.has('weight')) {
      this._updateSliderFill(); // Update fill if weight changes
    }
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

  private handleTextInput(e: Event) {
    // Your existing logic if any, or can be empty if not actively used
  }

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

    // Update CSS variable directly on input event for immediate feedback
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 2;
    const value = this.weight;
    const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    slider.style.setProperty('--slider-fill-percent', `${percentage}%`);
    
    this.dispatchPromptChange();
  }

  override render() {
    const haloStyle = styleMap({
        '--prompt-halo-color': this.color,
        'opacity': (this.weight / 2 * 0.7).toString()
    });
    const sliderContainerStyles = styleMap({
        '--slider-thumb-color': this.color,
    });

    return html`
    <div class="prompt-card">
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
      >${this.text}</span>
      <div class="slider-container" style=${sliderContainerStyles}>
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
      const jsonString = `
      [
        { "color": "#D0BCFF", "text": "Bossa Nova" },
        { "color": "#A8C7FA", "text": "Chillwave" },
        { "color": "#F48FB1", "text": "Drum and Bass" },
        { "color": "#80DEEA", "text": "Post Punk" },
        { "color": "#FFE082", "text": "Shoegaze" },
        { "color": "#A5D6A7", "text": "Funk" },
        { "color": "#CE93D8", "text": "Chiptune" },
        { "color": "#C5E1A5", "text": "Lush Strings" },
        { "color": "#FFF59D", "text": "Sparkling Arpeggios" },
        { "color": "#B39DDB", "text": "Staccato Rhythms" },
        { "color": "#81C784", "text": "Punchy Kick" },
        { "color": "#FFB74D", "text": "Dubstep" },
        { "color": "#F8BBD0", "text": "LoFi" },
        { "color": "#E6EE9C", "text": "Neo Soul" },
        { "color": "#B0BEC5", "text": "Trip Hop" },
        { "color": "#EF9A9A", "text": "Thrash" }
      ]
      `;
      LOADED_DEFAULT_PROMPTS = JSON.parse(jsonString);
      
      this.prompts = getInitialPrompts();
      this.requestUpdate(); // Ensure Lit re-renders if needed
    } catch (error) {
      console.error("Could not load default prompts:", error);
      LOADED_DEFAULT_PROMPTS = []; // Fallback to empty array
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
    // If prompts haven't loaded by now (e.g. connectedCallback didn't fire first or fast enough)
    // ensure they are loaded. This can happen in some rendering scenarios.
    if (!this.promptsLoaded) {
        await this.loadAndInitializePrompts();
        this.promptsLoaded = true;
    }
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
                  this.requestUpdate('filteredPrompts'); // Lit specific update request
              }
              if (e.serverContent?.audioChunks !== undefined) {
                  if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
                  
                  await this.ensureAudioContextResumed();

                  const audioBuffer = await decodeAudioData(
                    decode(e.serverContent?.audioChunks[0].data),
                    this.audioContext,
                    48000, // sampleRate
                    2,     // numberOfChannels (assuming stereo)
                  );
                  const source = this.audioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(this.outputNode);
                  
                  if (this.nextStartTime === 0 && this.playbackState === 'loading') {
                      this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                      setTimeout(() => {
                          if(this.playbackState === 'loading') { // Check state again
                            this.playbackState = 'playing';
                            this.updateMediaSessionState();
                          }
                      }, this.bufferTime * 1000);
                  } else if (this.nextStartTime === 0) { // If not loading but startTime is 0, means it was reset
                      return;
                  }

                  if (this.nextStartTime < this.audioContext.currentTime && this.playbackState !== 'paused' && this.playbackState !== 'stopped') {
                      console.warn("Audio underrun. Resetting nextStartTime.");
                      this.playbackState = 'loading'; // Go back to loading to re-buffer
                      this.updateMediaSessionState();
                      this.nextStartTime = this.audioContext.currentTime + 0.2; // Small buffer
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
                if (!e.wasClean && this.playbackState !== 'stopped') { // If not a deliberate stop
                    this.connectionError = true;
                    this.playbackState = 'stopped';
                     this.updateMediaSessionState();
                    this.toastMessage.show('Connection closed. Please restart audio.');
                }
                // @ts-ignore - session might have a different type, but nulling it is fine.
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
            this.requestUpdate('filteredPrompts'); // Lit specific
        }
        // Create a new map to trigger Lit's reactivity for the prompts list
        const newPrompts = new Map(this.prompts);
        newPrompts.set(promptId, { ...prompt }); // Update the specific prompt
        this.prompts = newPrompts; // Assign new map

        this.setSessionPrompts();
        this.dispatchPromptsChange();
        // No need to call this.requestUpdate() for 'prompts' here,
        // as assigning a new Map to @state() property `this.prompts` will trigger an update.
    }
  }

  private readonly makeBackground = throttle(() => {
      if (!this.prompts || this.prompts.size === 0) return '';
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
      const MAX_WEIGHT_EFFECT = 2.0; // Corresponds to slider max="2"
      const MAX_ALPHA_PER_PROMPT = 0.5;
      const bg: string[] = [];
      const numPrompts = this.prompts.size;
      const numCols = 4;
      const numRows = Math.ceil(numPrompts / numCols);
      
      // Use current prompts' colors and texts if default prompts are not loaded or don't match
      const defaultPromptsForIndexing = LOADED_DEFAULT_PROMPTS.length > 0 ? LOADED_DEFAULT_PROMPTS : Array.from(this.prompts.values());


      [...this.prompts.values()].filter(p => p.weight > 0.01).forEach((p, i_active) => {
          // Try to find original index for more stable positioning if default prompts are used
          const originalIndex = defaultPromptsForIndexing.findIndex(dp => dp.text === p.text && dp.color === p.color);
          const i = originalIndex !== -1 ? originalIndex : i_active; // Fallback to active index


          const alphaPct = clamp01(p.weight / MAX_WEIGHT_EFFECT) * MAX_ALPHA_PER_PROMPT;
          const alphaHex = Math.round(alphaPct * 255).toString(16).padStart(2, '0');
          const stopPercentage = (p.weight / MAX_WEIGHT_EFFECT) * 70 + 30; // 30% to 100% spread

          const colIndex = i % numCols;
          const rowIndex = Math.floor(i / numCols);
          
          // Add some jitter for a more organic feel, consistent per prompt based on its text length
          const xJitter = ((p.text.length % 10) / 10 - 0.5) * 0.1; 
          const yJitter = (((p.text.length * 3) % 10) / 10 - 0.5) * 0.1;


          const x = numCols > 1 ? colIndex / (numCols -1 ) + xJitter : 0.5 + xJitter;
          const y = numRows > 1 ? rowIndex / (numRows -1) + yJitter : 0.5 + yJitter;
          
          const clampedX = clamp01(x) * 100;
          const clampedY = clamp01(y) * 100;

          bg.push(`radial-gradient(circle at ${clampedX}% ${clampedY}%, ${p.color}${alphaHex} 0%, ${p.color}00 ${clamp01(stopPercentage / 100) * 100}%)`);
      });
      return bg.join(', ');
  }, 50); // Throttle background updates


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
            // connectToSession already shows a message on failure
            this.playbackState = 'stopped'; // Ensure state is correct
            this.updateMediaSessionState();
            return;
        }
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('Add some vibes! Turn up a prompt slider to begin.', 3000)
      if (this.playbackState === 'playing' || this.playbackState === 'loading') {
        this.pause(); // Pause if playing/loading with no prompts
      }
      return;
    }
    
    // Important: set prompts before calling play if it's a new session or prompts changed
    await this.setSessionPrompts(); 
    // Check again if prompts are still zero after setSessionPrompts (it might pause)
    if (this.getPromptsToSend().length === 0 && this.playbackState !== 'playing' && this.playbackState !== 'loading') {
        return; 
    }


    this.session.play();
    this.playbackState = 'loading'; // Go to loading, then to playing once audio comes in
    const currentGain = this.outputNode.gain.value;
    this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
    this.nextStartTime = 0; // Reset for buffering
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
    } else if (this.playbackState === 'loading') { // Allow stopping if stuck in loading
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
    // Optionally add stop, etc.
    // navigator.mediaSession.setActionHandler('stop', () => this.stop());
  }


  override render() {
    if (!this.promptsLoaded) {
        const loadingStyle = `
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 100vh; 
          text-align: center;
          font-size: 1.2rem;
          color: var(--md-sys-color-on-background); 
      `;
      return html`<div class="loading-prompts" style="${loadingStyle}">Loading prompts...</div>`;
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
                ${this.prompts && [...this.prompts.values()].map((prompt) => html`
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
                aria-label=${this.playbackState === 'playing' || this.playbackState === 'loading' ? 'Pause audio generation' : 'Play audio generation'}
            ></play-pause-button>
        </footer>
      </div>
      <toast-message></toast-message>
    `;
  }
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY!, apiVersion: 'v1alpha' }); // Added '!' assuming key is checked
const model = 'lyria-realtime-exp'; // Or your specific model

async function main(parent: HTMLElement) {
  if (!GEMINI_API_KEY) {
    // Error is handled by the global check below, but good to have a specific error for main if needed
    console.error("GEMINI_API_KEY not available in main function.");
    return; // Exit if key is not set
  }

  const pdjController = new PromptDjController();
  parent.appendChild(pdjController);

  // Persist prompts on change
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
        weight: typeof p.weight === 'number' && !isNaN(p.weight) ? p.weight : 0, // Ensure weight is valid
        color: p.color || defaultPromptsMap.get(p.text) || '#D0BCFF', // Fallback color
      }));
      return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
      localStorage.removeItem('prompts-v2'); // Clear corrupted data
    }
  }

  // If no stored prompts or parsing failed, use defaults
  const prompts = new Map<string, Prompt>();
  if (LOADED_DEFAULT_PROMPTS.length === 0) {
      // This case can happen if default-prompts.json fails to load
      // and then getInitialPrompts is called before LOADED_DEFAULT_PROMPTS is populated.
      console.warn("LOADED_DEFAULT_PROMPTS is empty during getInitialPrompts. No default prompts will be set initially.");
      // You might want to add some hardcoded fallback prompts here if default-prompts.json is critical
      // For example:
      // prompts.set("fallback-1", { promptId: "fallback-1", text: "Chill Beats", weight: 0, color: "#AA99FF" });
      return prompts;
  }

  // Randomly select some default prompts to start with some weight
  const startOnTexts = [...LOADED_DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5) // Shuffle
    .slice(0, Math.min(3, LOADED_DEFAULT_PROMPTS.length)) // Select up to 3
    .map(p => p.text);

  LOADED_DEFAULT_PROMPTS.forEach((defaultPromptData, i) => {
    const promptId = `prompt-${i}`; // Generate a unique ID
    prompts.set(promptId, {
      promptId,
      text: defaultPromptData.text,
      weight: startOnTexts.includes(defaultPromptData.text) ? 1 : 0, // Start some prompts with weight
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
    // Handle potential storage errors (e.g., quota exceeded)
    console.error("Error saving prompts to localStorage:", e);
    // Optionally, notify the user if storage fails
    // this.toastMessage.show("Could not save prompt settings.", 3000);
  }
}

// Global execution block
if (GEMINI_API_KEY) {
    main(document.body).catch(err => {
        console.error("Error in main execution:", err);
        document.body.innerHTML = `<div style="color: red; padding: 20px; text-align: center;"><h2>Critical Application Error</h2><p>An unexpected error occurred. Please check the console for details and try refreshing the page.</p></div>`;
    });
} else {
    const errorMsg = "FATAL ERROR: GEMINI_API_KEY is not set. The application cannot run. Please set the GEMINI_API_KEY environment variable and rebuild/redeploy.";
    console.error(errorMsg); // Also log to console
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