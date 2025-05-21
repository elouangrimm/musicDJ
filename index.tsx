/**
 * @fileoverview Control real time music with sliders
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup } from 'lit';
// MODIFIED IMPORT: Add .js extension
import { customElement, property, query, state } from 'lit/decorators.js';
// MODIFIED IMPORTS: Add .js extension
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';


import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';


interface Prompt {
  readonly promptId: string;
  text: string;
  weight: number;
  color: string;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/**
 * Throttles a callback to be called at most once per `delay` milliseconds.
 * Also returns the result of the last "fresh" call...
 */
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
  { color: '#9900ff', text: 'Bossa Nova' },
  { color: '#5200ff', text: 'Chillwave' },
  { color: '#ff25f6', text: 'Drum and Bass' },
  { color: '#2af6de', text: 'Post Punk' },
  { color: '#ffdd28', text: 'Shoegaze' },
  { color: '#2af6de', text: 'Funk' },
  { color: '#9900ff', text: 'Chiptune' },
  { color: '#3dffab', text: 'Lush Strings' },
  { color: '#d8ff3e', text: 'Sparkling Arpeggios' },
  { color: '#d9b2ff', text: 'Staccato Rhythms' },
  { color: '#3dffab', text: 'Punchy Kick' },
  { color: '#ffdd28', text: 'Dubstep' },
  { color: '#ff25f6', text: 'K Pop' },
  { color: '#d8ff3e', text: 'Neo Soul' },
  { color: '#5200ff', text: 'Trip Hop' },
  { color: '#d9b2ff', text: 'Thrash' },
];

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #000;
      color: white;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 1000;
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      cursor: pointer;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;

  override render() {
    return html`<div class=${classMap({ showing: this.showing, toast: true })}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}


// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48"
        fill="black"
        fill-opacity="0.05" />
      <rect
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="black"
        stroke-opacity="0.3"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          fill="white"
          fill-opacity="0.05"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({ type: String }) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(359deg); }
      }
    `
  ]

  private renderPause() {
    return svg`<path
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
      fill="#FEFEFE"
    />`;
  }

  private renderPlay() {
    return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

/** A single prompt input controlled by a slider. */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-evenly; /* Adjusted for slider */
      padding: 1vmin;
      box-sizing: border-box;
    }
    input[type="range"] {
      width: 80%;
      cursor: grab;
      margin: 1vmin 0;
      accent-color: var(--slider-color, #fff); /* Use CSS var for dynamic color */
    }
    input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 2vmin;
        height: 2vmin;
        background: var(--slider-thumb-color, #555);
        border-radius: 50%;
        cursor: pointer;
    }
    input[type="range"]::-moz-range-thumb {
        width: 2vmin;
        height: 2vmin;
        background: var(--slider-thumb-color, #555);
        border-radius: 50%;
        cursor: pointer;
        border: none;
    }

    #text {
      font-family: 'Google Sans', sans-serif;
      font-weight: 500;
      font-size: 1.8vmin;
      max-width: 19vmin;
      min-width: 2vmin;
      padding: 0.1em 0.3em;
      flex-shrink: 0;
      border-radius: 0.25vmin;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      background: #000;
      color: #fff;
      &:not(:focus) {
        text-overflow: ellipsis;
      }
    }
    :host([filtered=true]) #text {
      background: #da2000;
    }
  `;

  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';

  @query('#text') private textInput!: HTMLInputElement;

  private lastValidText!: string;

  override firstUpdated() {
    this.textInput.setAttribute('contenteditable', 'plaintext-only');
    this.textInput.textContent = this.text;
    this.lastValidText = this.text;
  }

  update(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('text') && this.textInput) {
      this.textInput.textContent = this.text;
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
      }),
    );
  }

  private async updateText() {
    const newText = this.textInput.textContent?.trim();
    if (!newText) {
      this.text = this.lastValidText;
      this.textInput.textContent = this.lastValidText;
    } else {
      this.text = newText;
      this.lastValidText = newText;
    }
    this.dispatchPromptChange();
  }

  private onFocus() {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(this.textInput);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private updateWeight(e: Event) {
    const slider = e.target as HTMLInputElement;
    this.weight = parseFloat(slider.value);
    this.dispatchPromptChange();
  }

  override render() {
    const sliderStyle = styleMap({
        '--slider-color': this.color,
        '--slider-thumb-color': this.color
    });

    return html`
    <div class="prompt">
      <input
        type="range"
        min="0"
        max="2"
        step="0.01"
        .value=${this.weight.toString()}
        style=${sliderStyle}
        @input=${this.updateWeight}
      />
      <span
        id="text"
        spellcheck="false"
        @focus=${this.onFocus}
        @blur=${this.updateText}></span>
    </div>`;
  }
}

/** The grid of prompt inputs. */
@customElement('prompt-dj-controller')
class PromptDjController extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
      overflow: hidden;
    }
    #background {
      will-change: background-image;
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111;
    }
    #grid {
      aspect-ratio: 1;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      width: 80vmin;
      gap: 1.5vmin;
      margin-top: 5vmin;
    }
    play-pause-button {
      position: relative;
      top: -2vmin;
      width: 15vmin;
      margin-top: 3vmin;
    }
    #buttons {
      position: absolute;
      top: 0;
      left: 0;
      padding: 5px;
      display: flex;
      gap: 5px;
    }
  `;

  @state() private prompts: Map<string, Prompt>;
  @state() private playbackState: PlaybackState = 'stopped';

  private session!: LiveMusicSession;
  private audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  private outputNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private readonly bufferTime = 2;

  @state() private filteredPrompts = new Set<string>();
  @state() private connectionError = false;

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;

  constructor(initialPrompts: Map<string, Prompt>) {
    super();
    this.prompts = initialPrompts; // Initialize prompts from constructor argument
    this.outputNode.connect(this.audioContext.destination);
  }

  override async firstUpdated() {
    await this.connectToSession();
    if (this.session) { // Only set prompts if session connection was successful
        await this.setSessionPrompts();
    }
  }

  private async connectToSession() {
    try {
        this.playbackState = 'loading';
        this.connectionError = false; // Reset error state on new attempt
        this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
            console.log('Received message from the server:', e);
            if (e.setupComplete) {
                this.connectionError = false;
                 if (this.playbackState === 'loading' && this.nextStartTime > 0) {
                    // This implies play was clicked, we were connecting/buffering, now ready
                 } else if (this.playbackState === 'loading') {
                    // If just connecting without explicit play, don't auto-set to playing
                 }
            }
            if (e.filteredPrompt) {
                this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text])
                this.toastMessage.show(e.filteredPrompt.filteredReason || 'A prompt was filtered.');
                this.requestUpdate('filteredPrompts');
            }
            if (e.serverContent?.audioChunks !== undefined) {
                if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
                
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

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
                        // Only transition to playing if still in loading state (not paused/stopped by user)
                        if(this.playbackState === 'loading') this.playbackState = 'playing';
                    }, this.bufferTime * 1000);
                } else if (this.nextStartTime === 0 && this.playbackState !== 'loading') {
                    // If not loading (e.g., reconnected while paused), don't auto-start playback scheduling here
                    return;
                }


                if (this.nextStartTime < this.audioContext.currentTime && this.playbackState !== 'paused' && this.playbackState !== 'stopped') {
                    console.warn("Audio underrun or scheduling in the past. Resetting nextStartTime.");
                    this.playbackState = 'loading'; 
                    this.nextStartTime = this.audioContext.currentTime + 0.1; 
                }
                source.start(this.nextStartTime);
                this.nextStartTime += audioBuffer.duration;
            }
            },
            onerror: (e: ErrorEvent | Event) => {
                console.error('Error occurred:', e);
                this.connectionError = true;
                this.playbackState = 'stopped'; // Or paused, to allow resume
                this.toastMessage.show('Connection error. Please try restarting audio.');
            },
            onclose: (e: CloseEvent) => {
                console.log('Connection closed:', e);
                if (!e.wasClean) { // If not a clean close (e.g. session.stop())
                    this.connectionError = true;
                    this.playbackState = 'stopped'; // Or paused
                    this.toastMessage.show('Connection closed unexpectedly. Please try restarting audio.');
                }
            },
        },
        });
    } catch (error) {
        console.error("Failed to connect to session:", error);
        this.connectionError = true;
        this.playbackState = 'stopped';
        this.toastMessage.show('Failed to connect. Check API key and network, then retry.');
    }
  }


  private getPromptsToSend() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight > 0; // weight > 0 for active
      })
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) {
        if ((this.playbackState === 'playing' || this.playbackState === 'loading')) {
            // this.toastMessage.show('Connection issue. Cannot update prompts.');
            // this.pause(); // Don't pause automatically if just a prompt update fails transiently
        }
        return;
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('At least one active prompt is needed to play. Pausing.')
      this.pause();
      return;
    }
    if (promptsToSend.length === 0 && (this.playbackState === 'paused' || this.playbackState === 'stopped')) {
        return;
    }

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
      const currentPromptTexts = new Set(promptsToSend.map(p => p.text));
      let changedFiltered = false;
      this.filteredPrompts.forEach(filteredText => {
          if (!currentPromptTexts.has(filteredText)) {
              this.filteredPrompts.delete(filteredText);
              changedFiltered = true;
          }
      });
      if (changedFiltered) this.requestUpdate('filteredPrompts');

    } catch (e: any) {
      this.toastMessage.show(e.message || 'Error setting prompts.');
    }
  }, 200);


  private dispatchPromptsChange() {
    // This event is for external listeners, e.g., saving to localStorage
    this.dispatchEvent(
      new CustomEvent<Map<string, Prompt>>('prompts-changed', { detail: new Map(this.prompts) }),
    );
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const { promptId, text, weight, color } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    const oldText = prompt.text;
    prompt.text = text;
    prompt.weight = weight;
    prompt.color = color;

    if (this.filteredPrompts.has(oldText) && text !== oldText) {
        this.filteredPrompts.delete(oldText);
        this.requestUpdate('filteredPrompts');
    }

    // Create a new map to trigger Lit's reactivity for the 'prompts' state property
    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);
    this.prompts = newPrompts; // This will trigger re-render of the grid

    this.setSessionPrompts(); // Update server (throttled)
    this.dispatchPromptsChange(); // Notify external listeners (e.g., for localStorage)
  }


  /** Generates radial gradients for each prompt based on weight and color. */
  private readonly makeBackground = throttle(
    () => {
      if (!this.prompts || this.prompts.size === 0) return '';
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT_EFFECT = 2.0; // Max weight of a prompt (0-2 range)
      const MAX_ALPHA_PER_PROMPT = 0.6;

      const bg: string[] = [];
      const numPrompts = this.prompts.size;
      const numCols = 4;
      const numRows = Math.ceil(numPrompts / numCols);


      [...this.prompts.values()].forEach((p, i) => {
        const alphaPct = clamp01(p.weight / MAX_WEIGHT_EFFECT) * MAX_ALPHA_PER_PROMPT;
        const alphaHex = Math.round(alphaPct * 255)
          .toString(16)
          .padStart(2, '0');

        const stopPercentage = (p.weight / MAX_WEIGHT_EFFECT) * 100;

        const colIndex = i % numCols;
        const rowIndex = Math.floor(i / numCols);

        // Ensure x and y are between 0 and 1 for positioning
        // For 1 row, y should be 0.5 (or 0 if numRows-1 is 0)
        // For x, if only 1 item in row, x should be 0.5
        const x = numCols > 1 ? colIndex / (numCols -1 ) : 0.5;
        const y = numRows > 1 ? rowIndex / (numRows -1) : 0.5;


        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alphaHex} 0%, ${p.color}00 ${stopPercentage}%)`;
        bg.push(s);
      });

      return bg.join(', ');
    },
    30,
  );

  private pause() {
    if (this.session && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
        this.session.pause();
    }
    this.playbackState = 'paused';
    if (this.audioContext.state === 'running') {
        const currentGain = this.outputNode.gain.value;
        this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
        this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
  }

  private async play() {
    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('At least one active prompt is needed. Turn up a slider.')
      // Don't change playbackState here, let user adjust and try again.
      // If it was playing/loading, it will pause via setSessionPrompts.
      // If it was paused/stopped, it just won't start.
      if (this.playbackState === 'playing' || this.playbackState === 'loading') {
        this.pause();
      }
      return;
    }

    if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
    }
    
    if (!this.session || this.connectionError) {
        this.toastMessage.show('Not connected. Attempting to reconnect...');
        await this.connectToSession();
        if (!this.session || this.connectionError) {
            this.toastMessage.show('Connection failed. Cannot play.');
            this.playbackState = 'stopped'; // Or 'paused'
            return;
        }
    }
    
    // Ensure prompts are up-to-date before telling server to play
    await this.setSessionPrompts(); 
    // If setSessionPrompts paused due to no prompts, check again
    if (this.playbackState === 'paused' && this.getPromptsToSend().length === 0) {
        return; // Stay paused if no prompts became active
    }

    this.session.play();
    this.playbackState = 'loading';
    const currentGain = this.outputNode.gain.value;
    this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
    this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime); // Start from current (likely 0 if paused)
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    this.nextStartTime = 0; // Reset scheduling, will be set by first audio chunk
  }

  private stop() {
    if (this.session) {
        this.session.stop(); // This should trigger onclose with wasClean=true
    }
    this.playbackState = 'stopped';
    if (this.audioContext.state === 'running') {
        const currentGain = this.outputNode.gain.value;
        this.outputNode.gain.cancelScheduledValues(this.audioContext.currentTime);
        this.outputNode.gain.setValueAtTime(currentGain, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.05);
    }
    this.nextStartTime = 0;
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      await this.play();
    } else if (this.playbackState === 'loading') {
      this.stop(); // Cancel loading and stop
    }
  }


  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div id="buttons">
      </div>
      <div id="grid">
        ${[...this.prompts.values()].map((prompt) => {
          return html`<prompt-controller
            .promptId=${prompt.promptId}
            ?filtered=${this.filteredPrompts.has(prompt.text)}
            .text=${prompt.text}
            .weight=${prompt.weight}
            .color=${prompt.color}
            @prompt-changed=${this.handlePromptChanged}>
          </prompt-controller>`;
        })}
      </div>
      <play-pause-button .playbackState=${this.playbackState} @click=${this.handlePlayPause}></play-pause-button>
      <toast-message></toast-message>`;
  }
}

async function main(parent: HTMLElement) {
  const initialPrompts = getInitialPrompts();

  const pdjController = new PromptDjController(
    initialPrompts,
  );
  parent.appendChild(pdjController);

  pdjController.addEventListener('prompts-changed', (e: Event) => {
    const customEvent = e as CustomEvent<Map<string, Prompt>>;
    setStoredPrompts(customEvent.detail);
  });
}

function getInitialPrompts(): Map<string, Prompt> {
  const { localStorage } = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const parsedPromptsArray = JSON.parse(storedPrompts) as Prompt[];
      const cleanPrompts = parsedPromptsArray.map(p => ({
        promptId: p.promptId,
        text: p.text,
        weight: typeof p.weight === 'number' ? p.weight : 0, // Ensure weight is a number
        color: p.color || '#ffffff', // Ensure color exists
      }));
      console.log('Loading stored prompts', cleanPrompts);
      return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
      localStorage.removeItem('prompts'); // Clear corrupted data
    }
  }
  console.log('No stored prompts, using default prompts');
  return buildDefaultPrompts();
}

function buildDefaultPrompts() {
  const startOn = [...DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  const prompts = new Map<string, Prompt>();

  DEFAULT_PROMPTS.forEach((defaultPromptData, i) => {
    const promptId = `prompt-${i}`;
    const { text, color } = defaultPromptData;
    prompts.set(promptId, {
      promptId,
      text,
      weight: startOn.some(startPrompt => startPrompt.text === text) ? 1 : 0,
      color,
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
    window.localStorage.setItem('prompts', storedPrompts);
  } catch (e) {
    console.error("Error saving prompts to localStorage:", e);
  }
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj-controller': PromptDjController;
    'prompt-controller': PromptController;
    'play-pause-button': PlayPauseButton;
    'toast-message': ToastMessage
  }
}