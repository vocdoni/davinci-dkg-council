pragma circom 2.2.3;

// TEST ONLY: the forbidden direct EscalarMulFix(251, Base8), kept to demonstrate its
// completeness defect (protocol §8.5 gadget rules). Never use in a Council circuit.

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/escalarmulfix.circom";

template ForbiddenFixMul() {
    signal input k;
    signal output out[2];
    var G[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    component bits = Num2Bits(251);
    bits.in <== k;
    component mul = EscalarMulFix(251, G);
    mul.e <== bits.out;
    out <== mul.out;
}

component main = ForbiddenFixMul();
