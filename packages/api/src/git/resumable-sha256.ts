// SHA-256 whose state survives between requests. An LFS object arrives as
// separate tus PATCH requests; each one continues the hash from the state the
// repository object recorded at the accepted offset, so the final request
// knows the object's digest without reading the stored bytes back.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,
  0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,
  0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,
  0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
  0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const INITIAL = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
  0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Chaining words plus the bytes after the last full block (base64, under 64 bytes). */
export type Sha256State = { words: number[]; tail: string };

export class ResumableSha256 {
  private readonly state = new Uint32Array(8);
  private readonly buffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private buffered = 0;
  private bytes = 0;

  /** Resumes after `length` bytes from `state`; without a state, `length` must be zero. */
  constructor(state?: Sha256State, length = 0) {
    const words = state?.words ?? INITIAL;
    let tail = new Uint8Array();
    try { if (state) tail = Uint8Array.from(atob(state.tail), (c) => c.charCodeAt(0)); }
    catch {
      // atob rejects a malformed tail; report it as the invalid state it is.
      throw new Error("Invalid SHA-256 state");
    }
    if (!Array.isArray(words) || words.length !== 8 ||
        words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffffffff) ||
        !Number.isSafeInteger(length) || length < 0 || (!state && length !== 0) ||
        tail.length >= 64 || length < tail.length || (length - tail.length) % 64 !== 0) {
      throw new Error("Invalid SHA-256 state");
    }
    this.state.set(words);
    this.bytes = length - tail.length;
    this.update(tail);
  }

  /** The state after every byte so far, for a later request to resume from. */
  snapshot(): Sha256State {
    return { words: [...this.state], tail: btoa(String.fromCharCode(...this.buffer.subarray(0, this.buffered))) };
  }

  update(input: Uint8Array): void {
    if (!Number.isSafeInteger(this.bytes + input.byteLength)) throw new RangeError("SHA-256 input is too large");
    this.bytes += input.byteLength;
    let offset = 0;
    if (this.buffered) {
      offset = Math.min(64 - this.buffered, input.byteLength);
      this.buffer.set(input.subarray(0, offset), this.buffered);
      this.buffered += offset;
      if (this.buffered < 64) return;
      this.compress(this.buffer, 0);
      this.buffered = 0;
    }
    // Whole blocks are hashed where they are, without copying.
    for (; offset + 64 <= input.byteLength; offset += 64) this.compress(input, offset);
    this.buffer.set(input.subarray(offset));
    this.buffered = input.byteLength - offset;
  }

  /** Finishes the hash; the instance cannot be updated afterwards. */
  digestHex(): string {
    const tail = this.buffered;
    this.buffer[tail] = 0x80;
    this.buffer.fill(0, tail + 1);
    if (tail >= 56) {
      this.compress(this.buffer, 0);
      this.buffer.fill(0);
    }
    // The message length in bits, as a big-endian 64-bit integer.
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(this.bytes / 0x20000000));
    view.setUint32(60, (this.bytes % 0x20000000) * 8);
    this.compress(this.buffer, 0);
    return [...this.state].map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = this.schedule;
    for (let i = 0, j = offset; i < 16; i++, j += 4) {
      w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
    }
    // Uint32Array stores wrap each sum modulo 2^32.
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      w[i] = w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    const s = this.state;
    let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    s[0] += a; s[1] += b; s[2] += c; s[3] += d;
    s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
}
