/**
 * @fileoverview Control real time music with sliders
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { html, LitElement, svg, CSSResultGroup } from 'lit'; // css removed from here
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'

// --- Environment Variable Check ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  const errorMsg = "GEMINI_API_KEY is not set. Please set it in your environment variables.";
  document.body.innerHTML = `<div style="color: red; font-family: sans-serif; padding: 20px;">${errorMsg}</div>`;
  throw new Error(errorMsg);
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';


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

const DEFAULT_PROMPTS = [
  { color: '#7B61FF', text: 'Bossa Nova' }, // Purple
  { color: '#5271FF', text: 'Chillwave' },  // Blue
  { color: '#E91E63', text: 'Drum and Bass' },// Pink
  { color: '#00BCD4', text: 'Post Punk' },    // Cyan
  { color: '#FFC107', text: 'Shoegaze' },     // Amber
  { color: '#4CAF50', text: 'Funk' },         // Green
  { color: '#9C27B0', text: 'Chiptune' },     // Deep Purple
  { color: '#8BC34A', text: 'Lush Strings' }, // Light Green
  { color: '#FFEB3B', text: 'Sparkling Arpeggios' }, // Yellow
  { color: '#BEABFF', text: 'Staccato Rhythms' }, // Lavender
  { color: '#A1F7B9', text: 'Punchy Kick' },   // Mint Green
  { color: '#FF9800', text: 'Dubstep' },      // Orange
  { color: '#F06292', text: 'K Pop' },        // Light Pink
  { color: '#CDDC39', text: 'Neo Soul' },     // Lime
  { color: '#607D8B', text: 'Trip Hop' },     // Blue Grey
  { color: '#D32F2F', text: 'Thrash' },       // Red
];

// --- Toast Message component ---
@customElement('toast-message')
class ToastMessage extends LitElement {
  // static override styles removed

  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;

  override render() {
    // Added classes for external styling
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

// --- Base class for icon buttons (simplified for CSS styling) ---
class IconButtonBase extends LitElement {
  // static override styles removed
  // Removed complex SVG shell, will use simpler button structure
  protected renderIcon() {
    return svg``;
  }
  override render() {
    return html`
        <button class="icon-button" part="button" aria-label=${this.getAttribute('aria-label') || 'icon button'}>
            ${this.renderIcon()}
        </button>
    `;
  }
}


// --- PlayPauseButton ---
@customElement('play-pause-button')
export class PlayPauseButton extends IconButtonBase {
  // static override styles removed

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

// --- PromptController ---
@customElement('prompt-controller')
class PromptController extends LitElement {
  // static override styles removed

  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';
  @property({ type: Boolean, reflect: true }) filtered = false;

  @query('#text-input') private textInputEl!: HTMLSpanElement;

  private lastValidText!: string;

  override firstUpdated() {
    this.textInputEl.textContent = this.text;
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

  private handleTextInput(e: Event) {
    // Not strictly needed for contenteditable span, blur is main trigger
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
    if (!selection) return;
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
        'opacity': (this.weight / 2 * 0.7).toString() // Max opacity 0.7 for halo
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

// --- PromptDjController (Main App) ---
@customElement('prompt-dj-controller')
class PromptDjController extends LitElement {
  // static override styles removed

  @state() private prompts: Map<string, Prompt>;
  @state() private playbackState: PlaybackState = 'stopped';

  private session!: LiveMusicSession;
  private audioContext!: AudioContext; // Will be initialized on first user interaction
  private outputNode!: GainNode;
  private nextStartTime = 0;
  private readonly bufferTime = 1.5; // Reduced buffer time slightly

  @state() private filteredPrompts = new Set<string>();
  @state() private connectionError = false;

  @query('toast-message') private toastMessage!: ToastMessage;

  // Artwork for Media Session API
  private mediaArtwork = [
    { src: 'music_icon_192.png', sizes: '192x192', type: 'image/png' },
    // Add other sizes if you have them
  ];
  // Create a dummy PNG for the artwork if not available.
  // You should replace 'music_icon_192.png' with an actual icon.
  // For now, I'll skip creating it dynamically here.

  constructor() {
    super();
    this.prompts = getInitialPrompts();
    this.initializeAudioContext(); // Initialize on creation
  }

  private initializeAudioContext() {
    if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
             sampleRate: 48000,
             latencyHint: 'interactive' // or 'playback'
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
    // Defer connection until first play or explict connect button
    // await this.connectToSession();
    // if (this.session) {
    //     await this.setSessionPrompts();
    // }
    this.updateMediaSessionState(); // Initial state for media session
  }

  private async connectToSession() {
    if (this.session && !this.connectionError) return true; // Already connected

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
                      this.nextStartTime = this.audioContext.currentTime + 0.2; // थोड़ा सा गैप
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
                if (!e.wasClean && this.playbackState !== 'stopped') { // If not manually stopped
                    this.connectionError = true;
                    this.playbackState = 'stopped';
                     this.updateMediaSessionState();
                    this.toastMessage.show('Connection closed. Please restart audio.');
                }
                // @ts-ignore
                this.session = null; // Clear session
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
    return Array.from(this.prompts.values())
      .filter((p) => !this.filteredPrompts.has(p.text) && p.weight > 0)
      .map(p => ({text: p.text, weight: p.weight})); // Only send text and weight
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) return;

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('No active prompts. Pausing music.', 3000)
      this.pause();
      return;
    }
    if (promptsToSend.length === 0) return; // Don't send if nothing to send and not playing

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
      this.updateMediaSessionMetadata(); // Update metadata if prompts change

    } catch (e: any) {
      this.toastMessage.show(`Error setting prompts: ${e.message}`);
    }
  }, 250);


  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent<Map<string, Prompt>>('prompts-changed', { detail: new Map(this.prompts), bubbles: true, composed: true }),
    );
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
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
        newPrompts.set(promptId, { ...prompt }); // Ensure new object for Lit's dirty checking
        this.prompts = newPrompts;

        this.setSessionPrompts();
        this.dispatchPromptsChange(); // For localStorage
    }
  }

  private readonly makeBackground = throttle(() => {
      if (!this.prompts || this.prompts.size === 0) return '';
      // ... (background generation logic - keep as is or adapt for CSS variables)
      // This logic can remain, as it sets an inline style on the #background div.
      // For a more Material You approach, this could influence CSS custom properties
      // that other elements then use, but direct inline style is fine for the background.
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
      const MAX_WEIGHT_EFFECT = 2.0;
      const MAX_ALPHA_PER_PROMPT = 0.5; // Reduced max alpha for subtlety
      const bg: string[] = [];
      const numPrompts = this.prompts.size;
      const numCols = 4; // Assume 4 columns for positioning calculations
      const numRows = Math.ceil(numPrompts / numCols);

      [...this.prompts.values()].filter(p => p.weight > 0.01).forEach((p, i_active) => {
          // Use original index for positioning to keep it stable
          const originalIndex = DEFAULT_PROMPTS.findIndex(dp => dp.text === p.text && dp.color === p.color);
          const i = originalIndex !== -1 ? originalIndex : i_active;


          const alphaPct = clamp01(p.weight / MAX_WEIGHT_EFFECT) * MAX_ALPHA_PER_PROMPT;
          const alphaHex = Math.round(alphaPct * 255).toString(16).padStart(2, '0');
          const stopPercentage = (p.weight / MAX_WEIGHT_EFFECT) * 70 + 30; // Spread from 30% to 100%

          const colIndex = i % numCols;
          const rowIndex = Math.floor(i / numCols);
          
          const xJitter = (Math.random() - 0.5) * 0.1; // Small jitter for organic feel
          const yJitter = (Math.random() - 0.5) * 0.1;

          const x = numCols > 1 ? colIndex / (numCols -1 ) + xJitter : 0.5 + xJitter;
          const y = numRows > 1 ? rowIndex / (numRows -1) + yJitter : 0.5 + yJitter;
          
          const clampedX = clamp01(x) * 100;
          const clampedY = clamp01(y) * 100;

          // Make gradients larger and softer
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
    await this.ensureAudioContextResumed();
    
    if (!this.session || this.connectionError) {
        this.toastMessage.show('Connecting to Lyria...');
        const connected = await this.connectToSession();
        if (!connected) {
            this.toastMessage.show('Connection failed. Cannot play.');
            this.playbackState = 'stopped'; // Ensure state reflects failure
            this.updateMediaSessionState();
            return;
        }
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('Add some vibes! Turn up a prompt slider to begin.', 3000)
      if (this.playbackState === 'playing' || this.playbackState === 'loading') {
        this.pause(); // It will pause if it was playing/loading
      }
      return;
    }
    
    await this.setSessionPrompts();
    if (this.playbackState === 'paused' && this.getPromptsToSend().length === 0) {
        return; 
    }

    this.session.play();
    this.playbackState = 'loading'; // Will transition to 'playing' via onmessage
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
        this.session.stop(); // This should trigger onclose with wasClean=true
        // @ts-ignore - Allow setting to null
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
    // navigator.mediaSession.metadata = null; // Clear metadata
  }

  private async handlePlayPause() {
    await this.ensureAudioContextResumed(); // Crucial for user-initiated actions
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      this.play();
    } else if (this.playbackState === 'loading') {
      this.stop();
    }
  }

  // --- Media Session API Integration ---
  private updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator)) return;

    const activePrompts = Array.from(this.prompts.values()).filter(p => p.weight > 0.5);
    let title = "Lyria Realtime DJ";
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
    // navigator.mediaSession.setActionHandler('stop', () => this.stop()); // Optional
  }


  override render() {
    const backgroundStyle = styleMap({
      backgroundImage: this.makeBackground(),
    });

    return html`
      <div id="background-layer" style=${backgroundStyle}></div>
      <div class="app-layout">
        <header class="app-header">
            <h1>Lyria Realtime DJ</h1>
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

// --- Main Initialization ---
async function main(parent: HTMLElement) {
  if (!GEMINI_API_KEY) return; // Stop if API key not found

  const pdjController = new PromptDjController();
  parent.appendChild(pdjController);

  pdjController.addEventListener('prompts-changed', (e: Event) => {
    const customEvent = e as CustomEvent<Map<string, Prompt>>;
    setStoredPrompts(customEvent.detail);
  });
}

function getInitialPrompts(): Map<string, Prompt> {
  const { localStorage } = window;
  const storedPrompts = localStorage.getItem('prompts-v2'); // Use new key for new structure/colors

  if (storedPrompts) {
    try {
      const parsedPromptsArray = JSON.parse(storedPrompts) as Prompt[];
      const cleanPrompts = parsedPromptsArray.map(p => ({
        promptId: p.promptId,
        text: p.text,
        weight: typeof p.weight === 'number' ? p.weight : 0,
        color: p.color || DEFAULT_PROMPTS.find(dp => dp.text === p.text)?.color || '#7B61FF', // Fallback color
      }));
      return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
      localStorage.removeItem('prompts-v2');
    }
  }
  // Build default prompts with new colors
  const prompts = new Map<string, Prompt>();
  const startOnTexts = [...DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3).map(p => p.text);

  DEFAULT_PROMPTS.forEach((defaultPromptData, i) => {
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

main(document.body);

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