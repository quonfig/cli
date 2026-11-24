/**
 * Test-only X25519 (RFC 7748 section 5) used as an ORACLE for the
 * small-order membership test in src/verify/secrets.ts (qfg-8seuf.4). The
 * spec (6.1) defines "small order" as: X25519 with the fixed scalar 0x01 x 32
 * is all zero. Production code uses the equivalent, much cheaper membership
 * test; these tests prove the two agree. Not constant time; public inputs only.
 */

const P = 2n ** 255n - 19n
const A24 = 121_665n

const mod = (a: bigint): bigint => {
  const r = a % P
  return r < 0n ? r + P : r
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }

  return result
}

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

function encodeLittleEndian(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }

  return out
}

/** X25519(k, u): clamps k, masks the top bit of u, reduces a non-canonical u mod p. */
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  if (scalar.length !== 32 || u.length !== 32) throw new Error('x25519 needs 32-byte inputs')
  const k = Uint8Array.from(scalar)
  k[0] &= 248
  k[31] &= 127
  k[31] |= 64
  const kn = decodeLittleEndian(k)
  const uMasked = Uint8Array.from(u)
  uMasked[31] &= 127
  const x1 = mod(decodeLittleEndian(uMasked))

  let x2 = 1n
  let z2 = 0n
  let x3 = x1
  let z3 = 1n
  let swap = 0n
  for (let t = 254n; t >= 0n; t--) {
    const kt = (kn >> t) & 1n
    swap ^= kt
    if (swap) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }

    swap = kt
    const a = mod(x2 + z2)
    const aa = mod(a * a)
    const b = mod(x2 - z2)
    const bb = mod(b * b)
    const e = mod(aa - bb)
    const c = mod(x3 + z3)
    const d = mod(x3 - z3)
    const da = mod(d * a)
    const cb = mod(c * b)
    x3 = mod((da + cb) ** 2n)
    z3 = mod(x1 * mod((da - cb) ** 2n))
    x2 = mod(aa * bb)
    z2 = mod(e * mod(aa + A24 * e))
  }

  if (swap) {
    ;[x2, x3] = [x3, x2]
    ;[z2, z3] = [z3, z2]
  }

  return encodeLittleEndian(mod(x2 * modPow(z2, P - 2n)))
}

/** Spec 6.1 definition of small order: X25519(0x01 x 32, u) is all zero. */
export function isSmallOrderByLadder(u: Uint8Array): boolean {
  return x25519(new Uint8Array(32).fill(0x01), u).every((byte) => byte === 0)
}
