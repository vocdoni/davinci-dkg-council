pragma circom 2.2.3;

// Council dealing circuit, protocol §8.5: one Feldman dealing at capacity N = T = 16.
// Public inputs (87, in this order): ctxHi, ctxLo, dealerIndex, n, t, C[16][2], E[2], X[16][2],
// masked[16]. Private: a[16], e, s[16].

include "circomlib/circuits/poseidon.circom";
include "lib/gadgets.circom";

template Deal() {
    var N = 16;
    var T = 16;
    var MASK_CONST = 10214054970402064552395134490408265161209242095674905809605444618984955431150;
    var G[2] = GEN();

    signal input ctxHi;
    signal input ctxLo;
    signal input dealerIndex;
    signal input n;
    signal input t;
    signal input C[T][2];
    signal input E[2];
    signal input X[N][2];
    signal input masked[N];
    signal input a[T];
    signal input e;
    signal input s[N];

    // (5) one dedicated x·x row per public input, in public-input order.
    signal pubSq[87];
    pubSq[0] <== ctxHi * ctxHi;
    pubSq[1] <== ctxLo * ctxLo;
    pubSq[2] <== dealerIndex * dealerIndex;
    pubSq[3] <== n * n;
    pubSq[4] <== t * t;
    for (var k = 0; k < T; k++) {
        pubSq[5 + 2 * k] <== C[k][0] * C[k][0];
        pubSq[6 + 2 * k] <== C[k][1] * C[k][1];
    }
    pubSq[37] <== E[0] * E[0];
    pubSq[38] <== E[1] * E[1];
    for (var i = 0; i < N; i++) {
        pubSq[39 + 2 * i] <== X[i][0] * X[i][0];
        pubSq[40 + 2 * i] <== X[i][1] * X[i][1];
        pubSq[71 + i] <== masked[i] * masked[i];
    }

    // (1) ranges: 1 <= t <= n <= 16, 1 <= dealerIndex <= n, ctx limbs < 2^128.
    component u = ActiveBits(N); // u.out[i] = (i < n): recipient slot i is a member
    u.count <== n;
    component v = ActiveBits(T); // v.out[k] = (k < t): coefficient k is live
    v.count <== t;
    for (var k = 0; k < T; k++) {
        v.out[k] * (1 - u.out[k]) === 0; // t <= n
    }
    signal w[N]; // one-hot dealer slot within the active members
    var wSum = 0;
    var wIdx = 0;
    for (var i = 0; i < N; i++) {
        w[i] <-- (dealerIndex == i + 1) ? 1 : 0;
        w[i] * (w[i] - 1) === 0;
        w[i] * (1 - u.out[i]) === 0;
        wSum += w[i];
        wIdx += (i + 1) * w[i];
    }
    wSum === 1;
    wIdx === dealerIndex;

    component ctxHiBits = Num2Bits(128);
    ctxHiBits.in <== ctxHi;
    component ctxLoBits = Num2Bits(128);
    ctxLoBits.in <== ctxLo;

    // (2) canonical scalars; e != 0; e's bits are shared by E and every ECDH.
    component aBits[T];
    for (var k = 0; k < T; k++) {
        aBits[k] = ScalarBits();
        aBits[k].in <== a[k];
    }
    component eBits = ScalarBits();
    eBits.in <== e;
    signal eInv;
    eInv <-- e != 0 ? 1 / e : 0;
    e * eInv === 1;
    component sBits[N];
    for (var i = 0; i < N; i++) {
        sBits[i] = ScalarBits();
        sBits[i].in <== s[i];
    }

    // (3) commitments: C[k] = a_k·G for every k, and a_k = 0 (so C[k] = O) for k >= t; E = e·G.
    component aG[T];
    for (var k = 0; k < T; k++) {
        aG[k] = MulG();
        aG[k].bits <== aBits[k].out;
        C[k][0] === aG[k].out[0];
        C[k][1] === aG[k].out[1];
        (1 - v.out[k]) * a[k] === 0;
    }
    component eG = MulG();
    eG.bits <== eBits.out;
    E[0] === eG.out[0];
    E[1] === eG.out[1];

    // (4) per recipient slot i (member i + 1).
    component sG[N];
    component horner[N];
    component ecdh[N];
    component mask[N];
    for (var i = 0; i < N; i++) {
        // inactive slots: zero share, Base8 recipient base, zero masked output
        (1 - u.out[i]) * s[i] === 0;
        (1 - u.out[i]) * (X[i][0] - G[0]) === 0;
        (1 - u.out[i]) * (X[i][1] - G[1]) === 0;

        // Feldman: s_i·G == Horner(C, i + 1), gated by u_i
        sG[i] = MulG();
        sG[i].bits <== sBits[i].out;
        horner[i] = Horner(T, i + 1);
        horner[i].C <== C;
        u.out[i] * (sG[i].out[0] - horner[i].out[0]) === 0;
        u.out[i] * (sG[i].out[1] - horner[i].out[1]) === 0;

        // ECDH S_i = e·X_i (X_i is a non-identity prime-subgroup point: roster key or Base8)
        ecdh[i] = EscalarMulAny(251);
        ecdh[i].e <== eBits.out;
        ecdh[i].p <== X[i];

        // masked_i = u_i·(s_i + Poseidon7(MASK_CONST, ctxHi, ctxLo, j, i + 1, S.x, S.y)) in F_p
        mask[i] = Poseidon(7);
        mask[i].inputs[0] <== MASK_CONST;
        mask[i].inputs[1] <== ctxHi;
        mask[i].inputs[2] <== ctxLo;
        mask[i].inputs[3] <== dealerIndex;
        mask[i].inputs[4] <== i + 1;
        mask[i].inputs[5] <== ecdh[i].out[0];
        mask[i].inputs[6] <== ecdh[i].out[1];
        masked[i] === u.out[i] * (s[i] + mask[i].out);
    }
}

component main {public [ctxHi, ctxLo, dealerIndex, n, t, C, E, X, masked]} = Deal();
