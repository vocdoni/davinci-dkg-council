pragma circom 2.2.3;

// Shared Council gadgets (protocol §8.5 gadget rules, circomlib 2.0.5).

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/compconstant.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/escalarmulfix.circom";

// BabyJubJub prime subgroup order r and the generator G = circomlib Base8 (protocol §2.1).
function SUBGROUP_ORDER() { return 2736030358979909402780800718157159386076813972158567259200215660948447373041; }
function GEN() {
    return [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
}
// [2^246]·G, pinned in vectors/constants.json (curve.G246).
function GEN_2_246() {
    return [
        8448361671856611094368094893873528300213448016874278049008935486981108396466,
        3719130040286663224590128240427185068966755285258175280098621282171226423213
    ];
}

// Canonical scalar: 251 little-endian bits with an explicit in < r comparison. Num2Bits(251)
// alone admits [r, 2^251), so the CompConstant(r - 1) row is load-bearing.
template ScalarBits() {
    signal input in;
    signal output out[251];

    component n2b = Num2Bits(251);
    n2b.in <== in;

    component gt = CompConstant(SUBGROUP_ORDER() - 1);
    for (var i = 0; i < 251; i++) {
        out[i] <== n2b.out[i];
        gt.in[i] <== n2b.out[i];
    }
    for (var i = 251; i < 254; i++) {
        gt.in[i] <== 0;
    }
    gt.out === 0;
}

// bits·G for a canonical 251-bit scalar. EscalarMulFix(251, Base8) is incomplete for three
// canonical scalars (protocol §8.5), so the vector is split into b[0..245] and b[246..250]:
// EscalarMulFix(246, G) + EscalarMulFix(5, [2^246]·G), joined with the complete BabyAdd.
template MulG() {
    signal input bits[251];
    signal output out[2];

    component lo = EscalarMulFix(246, GEN());
    component hi = EscalarMulFix(5, GEN_2_246());
    for (var i = 0; i < 246; i++) {
        lo.e[i] <== bits[i];
    }
    for (var i = 0; i < 5; i++) {
        hi.e[i] <== bits[246 + i];
    }

    component add = BabyAdd();
    add.x1 <== lo.out[0];
    add.y1 <== lo.out[1];
    add.x2 <== hi.out[0];
    add.y2 <== hi.out[1];
    out[0] <== add.xout;
    out[1] <== add.yout;
}

// m·P for a compile-time constant m >= 2, left-to-right double-and-add with the complete BabyAdd.
template MulSmall(m) {
    signal input in[2];
    signal output out[2];

    assert(m >= 2);
    var nb = 0;
    var tmp = m;
    while (tmp > 0) {
        nb++;
        tmp = tmp \ 2;
    }
    var nops = 0;
    for (var j = 0; j < nb - 1; j++) {
        nops++;
        if (((m >> (nb - 2 - j)) & 1) == 1) {
            nops++;
        }
    }

    component ops[nops];
    signal acc[nops + 1][2];
    acc[0][0] <== in[0];
    acc[0][1] <== in[1];
    var c = 0;
    for (var j = 0; j < nb - 1; j++) {
        ops[c] = BabyAdd();
        ops[c].x1 <== acc[c][0];
        ops[c].y1 <== acc[c][1];
        ops[c].x2 <== acc[c][0];
        ops[c].y2 <== acc[c][1];
        acc[c + 1][0] <== ops[c].xout;
        acc[c + 1][1] <== ops[c].yout;
        c++;
        if (((m >> (nb - 2 - j)) & 1) == 1) {
            ops[c] = BabyAdd();
            ops[c].x1 <== acc[c][0];
            ops[c].y1 <== acc[c][1];
            ops[c].x2 <== in[0];
            ops[c].y2 <== in[1];
            acc[c + 1][0] <== ops[c].xout;
            acc[c + 1][1] <== ops[c].yout;
            c++;
        }
    }
    out[0] <== acc[nops][0];
    out[1] <== acc[nops][1];
}

// Horner(C, m) = Σ_{k<N} m^k·C[k], folded from C[N-1] down: Acc <- m·Acc + C[k].
template Horner(N, m) {
    signal input C[N][2];
    signal output out[2];

    signal acc[N][2];
    component adds[N - 1];
    acc[0][0] <== C[N - 1][0];
    acc[0][1] <== C[N - 1][1];
    if (m == 1) {
        for (var j = 0; j < N - 1; j++) {
            adds[j] = BabyAdd();
            adds[j].x1 <== acc[j][0];
            adds[j].y1 <== acc[j][1];
            adds[j].x2 <== C[N - 2 - j][0];
            adds[j].y2 <== C[N - 2 - j][1];
            acc[j + 1][0] <== adds[j].xout;
            acc[j + 1][1] <== adds[j].yout;
        }
    } else {
        component muls[N - 1];
        for (var j = 0; j < N - 1; j++) {
            muls[j] = MulSmall(m);
            muls[j].in[0] <== acc[j][0];
            muls[j].in[1] <== acc[j][1];
            adds[j] = BabyAdd();
            adds[j].x1 <== muls[j].out[0];
            adds[j].y1 <== muls[j].out[1];
            adds[j].x2 <== C[N - 2 - j][0];
            adds[j].y2 <== C[N - 2 - j][1];
            acc[j + 1][0] <== adds[j].xout;
            acc[j + 1][1] <== adds[j].yout;
        }
    }
    out[0] <== acc[N - 1][0];
    out[1] <== acc[N - 1][1];
}

// Activity vector for a count c in 1..N: out[i] = (i < c), enforced as booleans, out[0] = 1,
// non-increasing, and Σ out = c. Rejects c = 0 and c > N.
template ActiveBits(N) {
    signal input count;
    signal output out[N];

    var sum = 0;
    for (var i = 0; i < N; i++) {
        out[i] <-- (i < count) ? 1 : 0;
        out[i] * (out[i] - 1) === 0;
        if (i > 0) {
            out[i] * (1 - out[i - 1]) === 0;
        }
        sum += out[i];
    }
    out[0] === 1;
    sum === count;
}
