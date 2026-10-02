// SHA-256 compression state is serializable only at a 64-byte block boundary.
// This small implementation keeps the eight chaining words so B2 range reads
// can resume without trusting an ETag or concatenating per-part digests.
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

export type Sha256Checkpoint = {
  version: 1;
  oid: string;
  size: number;
  versionId: string;
  offset: number;
  words: number[];
};

export class CheckpointSha256 {
  private readonly state: number[];
  private readonly buffer = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private readonly view = new DataView(this.buffer.buffer);
  private buffered = 0;
  private bytes = 0;

  constructor(words: number[] = INITIAL, offset = 0) {
    if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffffffff) ||
        !Number.isSafeInteger(offset) || offset < 0 || offset % 64 !== 0) {
      throw new Error("Invalid SHA-256 checkpoint");
    }
    this.state = [...words];
    this.bytes = offset;
  }

  get offset(): number { return this.bytes; }

  snapshot(): { offset: number; words: number[] } {
    if (this.buffered) throw new Error("SHA-256 checkpoint is not block aligned");
    return { offset: this.bytes, words: [...this.state] };
  }

  update(input: Uint8Array): void {
    if (!Number.isSafeInteger(this.bytes + input.byteLength)) throw new RangeError("SHA-256 input is too large");
    let offset = 0;
    while (offset < input.byteLength) {
      const count = Math.min(64 - this.buffered, input.byteLength - offset);
      this.buffer.set(input.subarray(offset, offset + count), this.buffered);
      this.buffered += count;
      this.bytes += count;
      offset += count;
      if (this.buffered === 64) {
        this.compress();
        this.buffered = 0;
      }
    }
  }

  digestHex(): string {
    const length = this.bytes;
    const tail = this.buffered;
    this.buffer[tail] = 0x80;
    this.buffer.fill(0, tail + 1);
    if (tail >= 56) {
      this.compress();
      this.buffer.fill(0);
    }
    const bits = BigInt(length) * BigInt(8);
    const view = this.view;
    view.setUint32(56, Number((bits >> BigInt(32)) & BigInt(0xffffffff)));
    view.setUint32(60, Number(bits & BigInt(0xffffffff)));
    this.compress();
    return this.state.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(): void {
    const words = this.schedule;
    const view = this.view;
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15];
      const b = words[i - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + K[i] + words[i]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a,b,c,d,e,f,g,h];
    for (let i = 0; i < 8; i++) this.state[i] = (this.state[i] + next[i]) >>> 0;
  }
}
