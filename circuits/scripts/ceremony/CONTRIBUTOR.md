# Contributing to the DAVINCI DKG Council phase-2 ceremony

Thank you for taking part. Each contributor folds secret randomness into the Groth16 proving keys of
the two Council circuits (`deal`, `partial`). If at least **one** contributor in the whole ceremony
generated their randomness honestly and destroyed it, nobody can forge a proof. You don't have to
trust the coordinator or the other contributors, only yourself.

You receive three files from the coordinator: `deal_NNNN.zkey`, `partial_NNNN.zkey` (the current
head, about 75 MB together) and `ceremony.json`. You send back two new zkeys, an attestation and
its signature. A contribution takes a few minutes on a laptop.

## Before you start

- Use a machine you control. A fresh VM or live USB is best, offline during the contribution if
  you can manage it.
- Install Node 22 and either a checkout of this repository at the tag the coordinator names
  (`npx -y pnpm@10 install`) or plain `snarkjs@0.7.6`.
- Check the files are the ones the coordinator published. `sha256sum deal_NNNN.zkey partial_NNNN.zkey`
  must match `ceremony.json`: the last entry of `contributions` (or `initial` for NNNN = 0000).
- Optional but recommended: verify the chain so far yourself. You need the r1cs files (compile with
  `make circuits-restore` or take them from the coordinator's transcript) and the Hermez ptau
  (`bash scripts/ci-fetch-ptau.sh powersOfTau28_hez_final_18.ptau`). Then:

  ```bash
  npx snarkjs@0.7.6 zkey verify deal.r1cs powersOfTau28_hez_final_18.ptau deal_NNNN.zkey
  npx snarkjs@0.7.6 zkey verify partial.r1cs powersOfTau28_hez_final_18.ptau partial_NNNN.zkey
  ```

  Each must end with `ZKey Ok!` and list the contributions published so far.

## Contribute

### With this repository (writes the attestation for you)

```bash
make ceremony ARGS="contribute --in ./inbox --out ./outbox --name 'Your Name'"
```

`--in` is the directory holding the three files you received. The tool:
1. Generates 64 bytes of CSPRNG output and, at a terminal, asks you to type some random text as
   well. snarkjs mixes in 64 bytes of its own on top.
2. Contributes to both circuits.
3. Writes `outbox/deal_{NNNN+1}.zkey`, `outbox/partial_{NNNN+1}.zkey` and
   `outbox/attestation_{NNNN+1}.json`.
4. Prints your two contribution hashes.

The randomness lives only in that process's memory and is never written to disk.

### With plain snarkjs

```bash
npx snarkjs@0.7.6 zkey contribute deal_NNNN.zkey deal_MMMM.zkey --name="Your Name"
npx snarkjs@0.7.6 zkey contribute partial_NNNN.zkey partial_MMMM.zkey --name="Your Name"
```

MMMM is NNNN + 1. Type random text when asked; snarkjs adds its own randomness. Copy the
`Contribution Hash` it prints for each circuit. Then write `attestation_MMMM.json` by hand in the
shape `contribute` produces (see `ceremony.ts`): `format`, `tag`, `index`, `name`, `inputs` and
`outputs` with their sha256 and contribution hashes. The coordinator's `accept` checks every field
against the zkeys.

## Afterwards

1. **Destroy the randomness.** Close the terminal, then reboot or destroy the VM. Do not keep
   shell history containing typed entropy.
2. **Sign the attestation.** Any of these works:
   ```bash
   ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n davinci-dkg-council-ceremony outbox/attestation_MMMM.json
   gpg --detach-sign --armor outbox/attestation_MMMM.json
   ```
3. **Publish your two contribution hashes and the attestation yourself**, on a channel people
   associate with you (a GitHub comment on the ceremony issue, your website, a social post). Your
   public statement is what makes the ceremony verifiable. Without it, nobody can tell your
   contribution from one the coordinator made up.
4. **Send the coordinator** the two zkeys, the attestation and its signature (`*.sig` / `*.asc`).
   The coordinator verifies everything before passing the new head on. If the hashes in the
   published transcript ever differ from the ones you published, say so publicly.

Once the ceremony closes, anyone can re-check the transcript with
`make ceremony ARGS="verify --dir <published transcript>"`. That includes you: check that your
contribution hash appears, in order, in both final zkeys.
