pragma circom 2.2.3;

// TEST ONLY: public input x appears only in a linear relation, so after --O2 it has no dedicated
// left-hand row; y is squared and does. The public-row checker must flag x and only x.

template NoRows() {
    signal input x;
    signal input y;
    signal z;
    z <== y * y;
    x === z + 1;
}

component main {public [x, y]} = NoRows();
