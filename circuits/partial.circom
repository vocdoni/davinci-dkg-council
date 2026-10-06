pragma circom 2.2.3;

// Council partial decryption circuit, protocol §10.1: D[k] = s·C1[k] for k < activeCount.
// Public inputs (67, in this order): PK[2], activeCount, C1[16][2], D[16][2]. Private: s.

include "lib/gadgets.circom";

template Partial() {
    var F = 16;
    var G[2] = GEN();

    signal input PK[2];
    signal input activeCount;
    signal input C1[F][2];
    signal input D[F][2];
    signal input s;

    // (5) one dedicated x·x row per public input, in public-input order.
    signal pubSq[67];
    pubSq[0] <== PK[0] * PK[0];
    pubSq[1] <== PK[1] * PK[1];
    pubSq[2] <== activeCount * activeCount;
    for (var k = 0; k < F; k++) {
        pubSq[3 + 2 * k] <== C1[k][0] * C1[k][0];
        pubSq[4 + 2 * k] <== C1[k][1] * C1[k][1];
        pubSq[35 + 2 * k] <== D[k][0] * D[k][0];
        pubSq[36 + 2 * k] <== D[k][1] * D[k][1];
    }

    // (1) canonical share, bits shared by every multiplication.
    component sBits = ScalarBits();
    sBits.in <== s;

    // (2) PK = s·G (split fixed-base construction).
    component sG = MulG();
    sG.bits <== sBits.out;
    PK[0] === sG.out[0];
    PK[1] === sG.out[1];

    // (4) 1 <= activeCount <= 16; act[k] = (k < activeCount).
    component act = ActiveBits(F);
    act.count <== activeCount;

    // (3) D[k] = s·C1[k] for active fields; inactive: C1[k] = Base8 and D[k] = O.
    component mul[F];
    for (var k = 0; k < F; k++) {
        (1 - act.out[k]) * (C1[k][0] - G[0]) === 0;
        (1 - act.out[k]) * (C1[k][1] - G[1]) === 0;
        mul[k] = EscalarMulAny(251);
        mul[k].e <== sBits.out;
        mul[k].p <== C1[k];
        D[k][0] === act.out[k] * mul[k].out[0];
        D[k][1] - 1 === act.out[k] * (mul[k].out[1] - 1);
    }
}

component main {public [PK, activeCount, C1, D]} = Partial();
