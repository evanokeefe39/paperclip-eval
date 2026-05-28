// Monotonic ULID generator — Crockford Base32, ms precision, no deps

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom = 0;

export function ulid(): string {
  let now = Date.now();
  if (now === lastTime) {
    lastRandom++;
  } else {
    lastTime = now;
    lastRandom = Math.floor(Math.random() * 0xffffffffffff);
  }
  let id = "";
  for (let i = 9; i >= 0; i--) {
    id = CROCKFORD[now & 0x1f] + id;
    now = Math.floor(now / 32);
  }
  let r = lastRandom;
  for (let i = 15; i >= 0; i--) {
    id += CROCKFORD[r & 0x1f];
    r = Math.floor(r / 32);
  }
  return id;
}
