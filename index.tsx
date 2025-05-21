/**
 * @fileoverview Control real time music with sliders
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup } from 'lit';
import { customElement, property, query, state } from 'lit/decorators';
import { styleMap } from 'lit/directives/style-map';
import { classMap } from 'lit/directives/class-map';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';


interface Prompt {
  readonly promptId: string;
  text: string;
  weight: number;
  // cc: number; // Removed MIDI CC
  color: string;
}

// ControlChange interface removed as it's MIDI specific

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


// WeightKnob component removed. Will be replaced by a slider in PromptController.

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

// MidiDispatcher class removed.

// AudioAnalyser class removed (as its primary consumer, WeightKnob halo, is gone).

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
      /* margin-top: 0.5vmin; // Adjusted margin */
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
  @property({ type: String }) color = ''; // Used for slider accent color

  // Removed cc, channel, learnMode, showCC, midiDispatcher, audioLevel

  @query('#text') private textInput!: HTMLInputElement;
  // @query('weight-knob') private weightInput!: WeightKnob; // Removed

  private lastValidText!: string;

  // connectedCallback related to MIDI removed.

  override firstUpdated() {
    this.textInput.setAttribute('contenteditable', 'plaintext-only');
    this.textInput.textContent = this.text;
    this.lastValidText = this.text;
  }

  update(changedProperties: Map<string, unknown>) {
    // Removed learnMode/showCC logic
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
          // cc: this.cc, // Removed
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

  // toggleLearnMode removed.

  override render() {
    const sliderStyle = styleMap({
        '--slider-color': this.color,
        '--slider-thumb-color': this.color // Or a contrasted color
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
      <!-- MIDI learn UI removed -->
    </div>`;
  }
}

/** The grid of prompt inputs. */
@customElement('prompt-dj-controller') // Renamed from PromptDjMidi
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
      aspect-ratio: 1; /* May need adjustment depending on slider height */
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      width: 80vmin;
      gap: 1.5vmin; /* Adjusted gap */
      margin-top: 5vmin; /* Adjusted margin */
    }
    play-pause-button {
      position: relative;
      top: -2vmin; /* Adjusted position */
      width: 15vmin;
      margin-top: 3vmin; /* Added margin for spacing */
    }
    #buttons { /* This section is now empty as MIDI buttons are removed */
      position: absolute;
      top: 0;
      left: 0;
      padding: 5px;
      display: flex;
      gap: 5px;
    }
    /* Button and select styles for MIDI removed */
  `;

  private prompts: Map<string, Prompt>;
  // private midiDispatcher: MidiDispatcher; // Removed
  // private audioAnalyser: AudioAnalyser; // Removed

  @state() private playbackState: PlaybackState = 'stopped';

  private session!: LiveMusicSession; // Added definite assignment assertion
  private audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  private outputNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency

  // Removed showMidi, audioLevel, midiInputIds, activeMidiInputId
  // private audioLevelRafId: number | null = null; // Removed

  @property({ type: Object })
  private filteredPrompts = new Set<string>();

  private connectionError = false; // Initialized to false, will be true on error

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;

  constructor(
    prompts: Map<string, Prompt>,
    // midiDispatcher: MidiDispatcher, // Removed
  ) {
    super();
    this.prompts = prompts;
    // this.midiDispatcher = midiDispatcher; // Removed
    // this.audioAnalyser = new AudioAnalyser(this.audioContext); // Removed
    // this.audioAnalyser.node.connect(this.audioContext.destination); // Removed
    this.outputNode.connect(this.audioContext.destination); // AudioAnalyser removed from chain
    // this.updateAudioLevel = this.updateAudioLevel.bind(this); // Removed
    // this.updateAudioLevel(); // Removed
  }

  override async firstUpdated() {
    await this.connectToSession();
    await this.setSessionPrompts(); // Ensure prompts are set after connection
  }

  private async connectToSession() {
    try {
        this.playbackState = 'loading'; // Indicate loading during connection
        this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
            console.log('Received message from the server:', e);
            if (e.setupComplete) {
                this.connectionError = false;
                // If it was loading due to connection, and now setup is complete,
                // and it was supposed to be playing, then set to playing.
                // This needs careful state management if play was clicked before connection.
                // For now, let's assume play() will be called again if needed.
                 if (this.playbackState === 'loading' && this.nextStartTime > 0) {
                    // this implies we were trying to play but got interrupted by connection
                    // and now connection is re-established.
                    // If play was initiated, playbackState would be 'loading' or 'playing'.
                 }
            }
            if (e.filteredPrompt) {
                this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text])
                this.toastMessage.show(e.filteredPrompt.filteredReason || 'A prompt was filtered.');
            }
            if (e.serverContent?.audioChunks !== undefined) {
                if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
                
                // Ensure context is running
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data),
                this.audioContext,
                48000, // Assuming server sends 48kHz
                2,     // Assuming server sends stereo
                );
                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.outputNode);
                
                if (this.nextStartTime === 0) {
                    // First chunk, schedule with buffer time
                    this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                    setTimeout(() => {
                        if(this.playbackState === 'loading') this.playbackState = 'playing';
                    }, this.bufferTime * 1000);
                }

                if (this.nextStartTime < this.audioContext.currentTime) {
                    console.warn("Audio underrun or scheduling in the past. Resetting.");
                    this.playbackState = 'loading'; // Indicate buffering
                    // Attempt to resync: discard old time, schedule new chunk with a slight delay
                    this.nextStartTime = this.audioContext.currentTime + 0.1; // Small delay to catch up
                }
                source.start(this.nextStartTime);
                this.nextStartTime += audioBuffer.duration;
            }
            },
            onerror: (e: ErrorEvent | Event) => { // Error can be generic Event too
                console.error('Error occurred:', e);
                this.connectionError = true;
                this.stop(); // Or pause, depending on desired behavior
                this.toastMessage.show('Connection error. Please try restarting audio.');
            },
            onclose: (e: CloseEvent) => {
                console.log('Connection closed:', e);
                if (!e.wasClean) {
                    this.connectionError = true;
                    this.stop(); // Or pause
                    this.toastMessage.show('Connection closed unexpectedly. Please try restarting audio.');
                }
            },
        },
        });
        this.connectionError = false; // Reset on successful connection attempt
    } catch (error) {
        console.error("Failed to connect to session:", error);
        this.connectionError = true;
        this.playbackState = 'stopped';
        this.toastMessage.show('Failed to connect. Please check API key and network.');
    }
  }


  private getPromptsToSend() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight !== 0;
      })
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) {
        // If no session or connection error, don't try to set prompts.
        // Optionally, queue this action or try to reconnect.
        if (this.playbackState === 'playing' || this.playbackState === 'loading') {
            this.toastMessage.show('Connection lost. Cannot update prompts.');
            this.pause();
        }
        return;
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('At least one active prompt is needed to play. Pausing.')
      this.pause(); // Pause if no prompts are active while playing
      return;
    }
    // If paused or stopped and no prompts, that's fine, don't send empty.
    if (promptsToSend.length === 0 && (this.playbackState === 'paused' || this.playbackState === 'stopped')) {
        // If we intend to clear all prompts on the server when none are active:
        // await this.session.setWeightedPrompts({ weightedPrompts: [] });
        return; // Or simply do nothing if server handles empty prompts gracefully
    }

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
      // Clear specific filtered prompts if they are no longer in the promptsToSend list
      // (e.g., user changed text)
      const currentPromptTexts = new Set(promptsToSend.map(p => p.text));
      this.filteredPrompts.forEach(filteredText => {
          if (!currentPromptTexts.has(filteredText)) {
              this.filteredPrompts.delete(filteredText);
          }
      });
      this.requestUpdate('filteredPrompts');

    } catch (e: any) {
      this.toastMessage.show(e.message || 'Error setting prompts.');
      // Decide if pausing is appropriate here
      // this.pause();
    }
  }, 200);

  // updateAudioLevel removed.

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', { detail: this.prompts }),
    );
    // setSessionPrompts is already throttled and will be called by setPrompts
    // return this.setSessionPrompts(); // This might be redundant if setPrompts calls it
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    // const { promptId, text, weight, cc } = e.detail; // cc removed
    const { promptId, text, weight, color } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;
    // prompt.cc = cc; // Removed
    prompt.color = color; // Ensure color is also updated if it can change

    // If text changed, it might no longer be filtered
    if (this.filteredPrompts.has(prompt.text) && e.detail.text !== prompt.text) {
        this.filteredPrompts.delete(prompt.text); // old text
        // The new text will be checked by the server.
    }


    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.setPrompts(newPrompts);
  }

  private setPrompts(newPrompts: Map<string, Prompt>) {
    this.prompts = newPrompts;
    this.requestUpdate('prompts'); // Explicitly request update for 'prompts'
    this.dispatchPromptsChange(); // This will notify parent/listeners
    this.setSessionPrompts(); // Update server (throttled)
    setStoredPrompts(this.prompts); // Persist changes
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private readonly makeBackground = throttle(
    () => {
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT = 0.5; // Max weight influence for a single gradient stop for full opacity
      const MAX_ALPHA = 0.6;  // Max alpha for a single gradient

      const bg: string[] = [];

      [...this.prompts.values()].forEach((p, i) => {
        // Alpha based on weight, capped by MAX_ALPHA
        const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
        const alphaHex = Math.round(alphaPct * 255) // Alpha is 0-255
          .toString(16)
          .padStart(2, '0');

        // Gradient spread based on weight.
        // p.weight is 0-2. A weight of 2 could mean 100% spread.
        // Let's map weight 0-2 to 0%-100% spread for the color stop.
        const stopPercentage = (p.weight / 2) * 100;

        const x = (i % 4) / 3; // 0, 0.33, 0.66, 1 for 4 columns
        const y = Math.floor(i / 4) / (Math.ceil(this.prompts.size / 4) -1  || 1) ; // Normalize Y based on rows

        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alphaHex} 0%, ${p.color}00 ${stopPercentage}%)`;
        bg.push(s);
      });

      return bg.join(', ');
    },
    30, // don't re-render more than once every XXms
  );

  private pause() {
    if (this.session && this.playbackState !== 'paused' && this.playbackState !== 'stopped') {
        this.session.pause();
    }
    this.playbackState = 'paused';
    if (this.audioContext.state === 'running') { // Only manipulate gain if context is running
        this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime); // Start from current gain
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
    // Don't reset nextStartTime immediately, allow current buffer to finish if any fadeout is desired
    // For a hard pause, reset it:
    // this.nextStartTime = 0;
    // Re-creating outputNode on pause might be too disruptive. Better to manage its gain.
  }

  private async play() { // Make play async for audioContext.resume()
    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('There needs to be one active prompt to play. Turn up a slider to resume playback.')
      this.pause(); // No, this should be stop or just prevent play
      this.playbackState = 'paused'; // or 'stopped' if we don't want it to resume easily
      return;
    }

    if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
    }
    
    if (this.session) {
        this.session.play(); // Tell server to start sending data
    } else {
        console.warn("Play called without a session.");
        // Optionally try to connect here if appropriate
        // await this.connectToSession();
        // if (this.session) this.session.play(); else return;
        return;
    }

    this.playbackState = 'loading'; // Will change to 'playing' once first audio chunk is scheduled
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime); // Ensure gain is 0 before ramping up
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.1);
    // nextStartTime will be set when the first audio chunk arrives
  }

  private stop() {
    if (this.session) {
        this.session.stop();
    }
    this.playbackState = 'stopped';
    // No gain ramp, just cut. Or a very quick ramp to 0.
    if (this.audioContext.state === 'running') {
        this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.05); // Fast fade
    }
    this.nextStartTime = 0; // Reset scheduling
    // Consider if outputNode needs reset or just gain to 1 for next play
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime + 0.1); // Prepare for next play
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      if (this.connectionError || !this.session) {
        this.toastMessage.show('Reconnecting...');
        await this.connectToSession(); // Attempt to reconnect
        if (this.connectionError || !this.session) {
            this.toastMessage.show('Failed to reconnect. Cannot play.');
            return;
        }
      }
      // Ensure prompts are sent if they changed while paused/stopped
      await this.setSessionPrompts();
      await this.play();
    } else if (this.playbackState === 'loading') {
      // If loading, typically means we are waiting for audio.
      // Pressing again could mean "cancel loading and stop".
      this.stop();
    }
  }

  // Removed toggleShowMidi, handleMidiInputChange

  // resetAll function could be added here if needed, similar to:
  // private resetAll() {
  //   this.setPrompts(buildDefaultPrompts());
  // }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div id="buttons">
        <!-- MIDI buttons and select removed -->
      </div>
      <div id="grid">${this.renderPrompts()}</div>
      <play-pause-button .playbackState=${this.playbackState} @click=${this.handlePlayPause}></play-pause-button>
      <toast-message></toast-message>`;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        promptId=${prompt.promptId}
        ?filtered=${this.filteredPrompts.has(prompt.text)}
        text=${prompt.text}
        weight=${prompt.weight}
        color=${prompt.color}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

async function main(parent: HTMLElement) {
  // const midiDispatcher = new MidiDispatcher(); // Removed
  const initialPrompts = getInitialPrompts();

  const pdjController = new PromptDjController( // Renamed instance
    initialPrompts,
    // midiDispatcher, // Removed
  );
  parent.appendChild(pdjController);

  // Listen for prompt changes to save them
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
      // Ensure prompts don't have old 'cc' fields or handle them gracefully
      const cleanPrompts = parsedPromptsArray.map(p => ({
        promptId: p.promptId,
        text: p.text,
        weight: p.weight,
        color: p.color,
      }));
      console.log('Loading stored prompts', cleanPrompts);
      return new Map(cleanPrompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
    }
  }
  console.log('No stored prompts, using default prompts');
  return buildDefaultPrompts();
}

function buildDefaultPrompts() {
  // Construct default prompts
  // Pick 3 random prompts to start with weight 1
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
      // cc: i, // Removed
      color,
    });
  });
  return prompts;
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  // Ensure prompts being stored don't have 'cc'
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
    // Potentially show a toast message to the user
  }
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj-controller': PromptDjController; // Renamed
    'prompt-controller': PromptController;
    // 'weight-knob': WeightKnob; // Removed
    'play-pause-button': PlayPauseButton;
    'toast-message': ToastMessage
  }
}