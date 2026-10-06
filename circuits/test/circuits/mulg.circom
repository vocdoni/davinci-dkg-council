pragma circom 2.2.3;

// TEST ONLY: the Council canonical-scalar decomposition and split fixed-base multiplication.

include "../../lib/gadgets.circom";

template MulGTest() {
    signal input k;
    signal output out[2];
    component bits = ScalarBits();
    bits.in <== k;
    component mul = MulG();
    mul.bits <== bits.out;
    out <== mul.out;
}

component main = MulGTest();
