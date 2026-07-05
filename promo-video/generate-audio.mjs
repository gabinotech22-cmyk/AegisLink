/**
 * AegisLink Promo – Dark Ambient Cyberpunk Audio Generator
 * Generates a 32-second WAV file with layered synth drones, sub-bass,
 * arpeggiated pads, and a subtle rhythmic pulse.
 * 
 * WAV encoder uses DataView for byte-accurate header writing.
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 44100;
const DURATION = 32;
const NUM_SAMPLES = SAMPLE_RATE * DURATION;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

// --- Utility functions ---
function clamp(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
function sine(phase) { return Math.sin(phase * 2 * Math.PI); }

function saw(phase, harmonics = 8) {
  let v = 0;
  for (let k = 1; k <= harmonics; k++) {
    v += ((-1) ** (k + 1)) * Math.sin(k * phase * 2 * Math.PI) / k;
  }
  return v * (2 / Math.PI);
}

class LPF {
  constructor(cutoff, sr = SAMPLE_RATE) {
    this.a = Math.exp(-2 * Math.PI * cutoff / sr);
    this.z = 0;
  }
  process(x) {
    this.z = x * (1 - this.a) + this.z * this.a;
    return this.z;
  }
}

function masterEnv(t) {
  const fadeIn = 2.0;
  const fadeOut = 2.5;
  if (t < fadeIn) return t / fadeIn;
  if (t > DURATION - fadeOut) return (DURATION - t) / fadeOut;
  return 1.0;
}

// --- Generate interleaved samples ---
const totalSamples = NUM_SAMPLES * CHANNELS;
const samples = new Int16Array(totalSamples);

let phase1 = 0, phase2 = 0, phase3 = 0, phase4 = 0;
let phaseSub = 0, phaseArp = 0, phasePulse = 0;
let phaseNoise = 0.5;

const lpfDrone1 = new LPF(400);
const lpfSub = new LPF(120);
const lpfMasterL = new LPF(8000);
const lpfMasterR = new LPF(8000);

const droneFreqs = [65.41, 77.78, 98.0, 116.54];
const arpNotes = [261.63, 311.13, 392.0, 466.16, 523.25, 587.33, 466.16, 392.0];
let arpIndex = 0;
let arpTimer = 0;
const arpSpeed = 0.18;

const DELAY_L = Math.floor(0.073 * SAMPLE_RATE);
const DELAY_R = Math.floor(0.091 * SAMPLE_RATE);
const delayBufL = new Float32Array(DELAY_L);
const delayBufR = new Float32Array(DELAY_R);
let delayIdxL = 0, delayIdxR = 0;
const FEEDBACK = 0.35;

for (let i = 0; i < NUM_SAMPLES; i++) {
  const t = i / SAMPLE_RATE;
  const mEnv = masterEnv(t);
  
  // Sub-bass
  phaseSub += (droneFreqs[0] / 2) / SAMPLE_RATE;
  phaseSub %= 1;
  const subFiltered = lpfSub.process(sine(phaseSub) * 0.25);
  
  // Dark pad drones
  const detune1 = 1 + 0.002 * sine(t * 0.3);
  const detune2 = 1 - 0.003 * sine(t * 0.4);
  phase1 += (droneFreqs[0] * detune1) / SAMPLE_RATE; phase1 %= 1;
  phase2 += (droneFreqs[1] * detune2) / SAMPLE_RATE; phase2 %= 1;
  phase3 += (droneFreqs[2] * detune1) / SAMPLE_RATE; phase3 %= 1;
  phase4 += (droneFreqs[3] * detune2) / SAMPLE_RATE; phase4 %= 1;
  
  let drone = saw(phase1, 6) * 0.12 + saw(phase2, 6) * 0.10 +
              saw(phase3, 5) * 0.08 + sine(phase4) * 0.09;
  
  const cutoffMod = 300 + 200 * sine(t * 0.07) + 100 * sine(t * 0.13);
  lpfDrone1.a = Math.exp(-2 * Math.PI * cutoffMod / SAMPLE_RATE);
  drone = lpfDrone1.process(drone);
  
  // Arpeggio
  arpTimer += 1 / SAMPLE_RATE;
  if (arpTimer >= arpSpeed) { arpTimer = 0; arpIndex = (arpIndex + 1) % arpNotes.length; }
  phaseArp += arpNotes[arpIndex] / SAMPLE_RATE; phaseArp %= 1;
  const noteEnv = Math.exp(-(arpTimer / arpSpeed) * 5) * 0.4;
  let arp = sine(phaseArp) * noteEnv * 0.07 + sine(phaseArp * 2.01) * noteEnv * 0.03;
  const arpPanL = (arpIndex % 2 === 0) ? 0.7 : 0.3;
  
  // Pulse
  phasePulse += 1.5 / SAMPLE_RATE; phasePulse %= 1;
  const pulse = sine(phasePulse * 0.5) * Math.exp(-phasePulse * 8) * 0.12 * (0.5 + 0.5 * sine(t * 0.05));
  
  // Noise
  phaseNoise = (phaseNoise * 16807 + 0.5) % 1;
  const noise = (phaseNoise * 2 - 1) * 0.015 * (0.3 + 0.7 * sine(t * 0.02));
  
  // Mix stereo
  let mixL = subFiltered + drone * 0.9 + arp * arpPanL + pulse + noise;
  let mixR = subFiltered + drone * 1.1 + arp * (1 - arpPanL) + pulse * 0.8 + noise * 0.9;
  
  // Reverb
  mixL += delayBufL[delayIdxL] * 0.25;
  mixR += delayBufR[delayIdxR] * 0.25;
  delayBufL[delayIdxL] = mixR * FEEDBACK;
  delayBufR[delayIdxR] = mixL * FEEDBACK;
  delayIdxL = (delayIdxL + 1) % DELAY_L;
  delayIdxR = (delayIdxR + 1) % DELAY_R;
  
  // Master
  mixL = Math.tanh(lpfMasterL.process(mixL) * mEnv * 1.8) * 0.85;
  mixR = Math.tanh(lpfMasterR.process(mixR) * mEnv * 1.8) * 0.85;
  
  // Write interleaved 16-bit samples
  samples[i * 2]     = Math.floor(clamp(mixL) * 32767);
  samples[i * 2 + 1] = Math.floor(clamp(mixR) * 32767);
}

// --- WAV Encoder using ArrayBuffer + DataView ---
function encodeWAV(interleavedSamples, sampleRate, numChannels, bitsPerSample) {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleavedSamples.length * bytesPerSample;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;
  
  const arrayBuffer = new ArrayBuffer(fileSize);
  const view = new DataView(arrayBuffer);
  
  // "RIFF" chunk descriptor
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, fileSize - 8, true); // ChunkSize
  view.setUint8(8, 0x57);  // W
  view.setUint8(9, 0x41);  // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E
  
  // "fmt " sub-chunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6D); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true);           // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);            // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);   // NumChannels
  view.setUint32(24, sampleRate, true);    // SampleRate
  view.setUint32(28, byteRate, true);      // ByteRate
  view.setUint16(32, blockAlign, true);    // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample
  
  // "data" sub-chunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataSize, true);      // Subchunk2Size
  
  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < interleavedSamples.length; i++) {
    view.setInt16(offset, interleavedSamples[i], true);
    offset += 2;
  }
  
  return Buffer.from(arrayBuffer);
}

const wavBuffer = encodeWAV(samples, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
const outputPath = join(__dirname, 'public', 'bgm.wav');
writeFileSync(outputPath, wavBuffer);

console.log(`✅ Audio generated: ${outputPath}`);
console.log(`   Duration: ${DURATION}s | Sample rate: ${SAMPLE_RATE}Hz | Channels: ${CHANNELS} | ${BITS_PER_SAMPLE}-bit`);
console.log(`   File size: ${(wavBuffer.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`   Expected: ${(44 + NUM_SAMPLES * CHANNELS * 2) / 1024 / 1024} MB`);
