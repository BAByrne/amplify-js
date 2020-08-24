import { exportBuffer } from './helper';
import { browserOrNode } from '@aws-amplify/core';
import {
  DEFAULT_EXPORT_SAMPLE_RATE,
  FFT_MAX_DECIBELS,
  FFT_MIN_DECIBELS,
  FFT_SIZE,
  FFT_SMOOTHING_TIME_CONSTANT,
} from './settings';

interface SilenceDetectionConfig {
  time: number;
  amplitude: number;
}

type SilenceHandler = () => void;
type Visualizer = (dataArray: Uint8Array, bufferLength: number) => void;

export class AudioRecorder {
  private options: SilenceDetectionConfig;
  private audioContext: AudioContext;
  private audioSupported: boolean;

  private analyserNode: AnalyserNode;
  private onSilence: SilenceHandler;
  private visualizer: Visualizer;

  // input mic stream is stored in a buffer
  private streamBuffer: Float32Array[] = [];
  private streamBufferLength = 0;

  // recording props
  private start: number;
  private recording = false;

  constructor(options: SilenceDetectionConfig) {
    this.options = options;
  }

  /**
   * This must be called first to enable audio context and request microphone access.
   * Once access granted, it connects all the necessary audio nodes to the context so that it can begin recording or playing.
   */
  async init() {
    if (browserOrNode().isBrowser) {
      window.AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContext();
      await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(stream => {
          this.audioSupported = true;
          this.setupAudioNodes(stream);
        })
        .catch(() => {
          this.audioSupported = false;
          return Promise.reject('Audio is not supported');
        });
    } else {
      this.audioSupported = false;
      return Promise.reject('Audio is not supported');
    }
  }

  /**
   * Setup audio nodes after successful `init`.
   */
  private async setupAudioNodes(stream: MediaStream) {
    await this.audioContext.resume();
    const sourceNode = this.audioContext.createMediaStreamSource(stream);
    const processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = audioProcessingEvent => {
      if (!this.recording) return;
      const stream = audioProcessingEvent.inputBuffer.getChannelData(0);
      this.streamBuffer.push(new Float32Array(stream)); // set to a copy of the stream
      this.streamBufferLength += stream.length;
      this.analyse();
    };

    const analyserNode = this.audioContext.createAnalyser();
    analyserNode.minDecibels = FFT_MIN_DECIBELS;
    analyserNode.maxDecibels = FFT_MAX_DECIBELS;
    analyserNode.smoothingTimeConstant = FFT_SMOOTHING_TIME_CONSTANT;

    sourceNode.connect(analyserNode);
    analyserNode.connect(processorNode);
    processorNode.connect(sourceNode.context.destination);

    this.analyserNode = analyserNode;
  }

  /**
   * Start recording audio and listen for silence.
   *
   * @param onSilence {SilenceHandler} - called whenever silence is detected
   * @param visualizer {Visualizer} - called with audio data on each audio process to be used for visualization.
   */
  public startRecording(onSilence?: SilenceHandler, visualizer?: Visualizer) {
    if (this.recording || !this.audioSupported) return;
    this.onSilence = onSilence || function() {};
    this.visualizer = visualizer || function() {};

    const context = this.audioContext;
    context.resume().then(() => {
      this.start = Date.now();
      this.recording = true;
    });
  }

  /**
   * Pause recording
   */
  public stopRecording() {
    if (!this.audioSupported) return;
    this.recording = false;
  }

  /**
   * Pause recording and clear audio buffer
   */
  public clear() {
    this.stopRecording();
    this.streamBufferLength = 0;
    this.streamBuffer = [];
  }

  /**
   * Plays given audioStream with audioContext
   *
   * @param buffer {Uint8Array} - audioStream to be played
   */
  public play(buffer: Uint8Array) {
    if (!buffer || !this.audioSupported) return;
    const myBlob = new Blob([buffer]);

    return new Promise((res, rej) => {
      const fileReader = new FileReader();
      fileReader.onload = () => {
        const playbackSource = this.audioContext.createBufferSource();
        this.audioContext
          .decodeAudioData(fileReader.result as ArrayBuffer)
          .then(buf => {
            playbackSource.buffer = buf;
            playbackSource.connect(this.audioContext.destination);
            playbackSource.onended = () => {
              return res();
            };
            playbackSource.start(0);
          })
          .catch(err => {
            return rej(err);
          });
      };
      fileReader.onerror = () => rej();
      fileReader.readAsArrayBuffer(myBlob);
    });
  }

  /**
   * Called after each audioProcess. Check for silence and give fft time domain data to visualizer.
   */
  private analyse() {
    if (!this.audioSupported) return;
    const analyser = this.analyserNode;
    analyser.fftSize = FFT_SIZE;

    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const amplitude = this.options.amplitude;
    const time = this.options.time;

    analyser.getByteTimeDomainData(dataArray);
    this.visualizer(dataArray, bufferLength);

    for (let i = 0; i < bufferLength; i++) {
      // Normalize between -1 and 1.
      const curr_value_time = dataArray[i] / 128 - 1.0;
      if (curr_value_time > amplitude || curr_value_time < -1 * amplitude) {
        this.start = Date.now();
      }
    }
    const newtime = Date.now();
    const elapsedTime = newtime - this.start;
    if (elapsedTime > time) {
      this.onSilence();
    }
  }

  /**
   * Encodes recorded buffer to a wav file and exports it to a blob.
   *
   * @param exportSampleRate {number} - desired sample rate of the exported buffer
   */
  public async exportWAV(exportSampleRate: number = DEFAULT_EXPORT_SAMPLE_RATE) {
    if (!this.audioSupported) return;
    const recordSampleRate = this.audioContext.sampleRate;
    const blob = exportBuffer(this.streamBuffer, this.streamBufferLength, recordSampleRate, exportSampleRate);
    this.clear();
    return blob;
  }
}