# Word Bonds

**Put money behind your word.**

A founder or KOL locks a bond in OKB behind one public promise about their tokens:

> "Our team wallets will keep at least 80% of their tokens until 1 March 2027."

A TapeOut circuit on X Layer decides the outcome. If the wallets stay above the promised share until the deadline, anyone can release the bond back to the maker and the promise goes on their record as kept. If the wallets drop under the floor at any point, anyone can challenge: the circuit rules the promise broken, 90% of the bond is burned, 10% goes to whoever caught it, and the breach stays on the maker's record for good.

There are no votes, no committee and no admin override. The maker cannot change the promise after signing, and nobody can slash a promise that is being kept.

## Why

In crypto, "the team is not selling" costs nothing to say. Holders have no way to tell a founder who means it from one who does not until it is too late. A bond is intended to make that promise expensive to break and cheap to check, and to turn a wallet's history of kept and broken promises into a record anyone can search, by wallet or by X handle.

## Live on X Layer mainnet (chain 196)

| What | Address |
|---|---|
| Word Bonds contract | [`0x25d816626bd0ab53e468b8f8452b000043f6cb01`](https://www.oklink.com/xlayer/address/0x25d816626bd0ab53e468b8f8452b000043f6cb01) |
| Rule circuit | TapeOut circuit **#19** on processor [`0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355`](https://www.oklink.com/xlayer/address/0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355) |
| Handle registry | [`0x22c27b5a70b9c082911d7ec555d8fc9d8de1e0e3`](https://www.oklink.com/xlayer/address/0x22c27b5a70b9c082911d7ec555d8fc9d8de1e0e3) |

After the tape-out, the on-chain netlist was read back and matched ours byte for byte, `circuitInfo` returned 33 inputs, 2 outputs, no memory and 119 gates, and 48 live `eval` calls matched the tested rule. Real bonds have since been created, broken and slashed on mainnet. Every transaction is listed in [`deployments/xlayer.json`](deployments/xlayer.json).

## How a verdict is reached

1. The contract reads the token balance of each declared wallet and adds them up.
2. It converts the total into basis points of the amount held when the bond was made.
3. It sends three facts to the TapeOut circuit with `eval`: `held`, `floor`, `expired`.
4. The circuit returns two bits, `breach` and `release`. The contract moves money only as those bits allow. If the circuit ever answers both at once, nothing moves.

The rule itself ([`circuits/hold_rule.v`](circuits/hold_rule.v)):

```
breach  = held < floor
release = expired AND NOT (held < floor)
```

Synthesised with [TapeSynth](https://github.com/Cheeeeez/tapesynth) to 119 NAND gates and taped out on X Layer. Because a taped-out circuit cannot be changed by anyone, the rule a bond was made under stays the same for the life of the bond.

## X handles

People search by name, not by wallet. [`src/HandleRegistry.sol`](src/HandleRegistry.sol) lets a wallet point at an X handle: the maker posts one line from their X account naming the wallet, then saves the link to that post. The contract checks that the link is a post on the claimed handle's own account. It cannot read X, so the site labels a handle as *claimed*, with the proof post one click away, and never as *verified*.

## Money flow

| Event | Where the money goes |
|---|---|
| Bond made | 1% fee to the treasury. The rest is locked. |
| Promise kept | 100% of the bond back to the maker. |
| Promise broken | 10% to the challenger, 90% burned. |

The fee, treasury and burn address are fixed at deployment. The maker cannot choose where slashed money goes; if they could, they would name their own second wallet.

## What a bond does not prove

These limits are shown on every bond page, not hidden:

- **Whose wallets these are.** A bond proves the listed wallets kept holding. It does not prove they are the maker's only wallets.
- **That nobody sold and bought back.** A breach counts only if someone challenges while the wallets are under the floor. The 10% bounty is designed to pay people to watch.
- **That the token reports honestly.** The rule trusts the token's own balances. Rebasing and fee-on-transfer tokens are not supported.

The full threat model and the rest of the known limits are in [`docs/SPEC.md`](docs/SPEC.md). The contracts are **unaudited**.

## Repository

```
src/WordBonds.sol              bonds, challenges, releases, records
src/HandleRegistry.sol         wallet -> X handle, with proof link
src/ITapeOutProcessor.sol      the TapeOut processor calls Word Bonds uses
circuits/hold_rule.v           the promise rule, in Verilog
circuits/hold_rule.tsyn.json   the rule synthesised to 119 NAND gates (TAP-02 netlist)
circuits/hold_rule.vectors.txt 4,512 inputs simulated on that netlist
test/                          41 Foundry tests, including fuzzing and a gas sweep
script/Deploy.s.sol            deployment script
web/                           the site: plain JavaScript and viem, no framework
site/index.html                the built site, one self-contained file
deployments/xlayer.json        live addresses and transactions
docs/SPEC.md                   design decisions, threat model, known limits
```

## Run it

Contracts (needs [Foundry](https://book.getfoundry.sh)):

```
forge install foundry-rs/forge-std --no-git
forge test
```

The tests use a stand-in processor. `test/HoldRuleVectors.t.sol` ties it to the real circuit by checking it against all 4,512 simulated vectors of the synthesised netlist.

Site:

```
cd web && npm install && node build.mjs
```

This writes `site/index.html`. Open it through any static server; the wallet connects to X Layer mainnet.

Re-running synthesis needs a local TapeSynth checkout at `./tapesynth` (`node tools/synth.mjs`, `node tools/vectors.mjs`).

## Built for

TapeOut Accelerate on X Layer, 2026.

## License

MIT
