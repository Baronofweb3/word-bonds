# Word Bonds: spec and threat model (v1)

Status: live on X Layer mainnet since 16 Nov 2026. Rule circuit #19 on processor `0x57F319CF056F72F48cF1dbb670F2A3DB007Aa355`. Word Bonds at `0x25d816626bd0ab53e468b8f8452b000043f6cb01`. Two bonds exist on mainnet: bond 0 was broken on purpose and slashed by the circuit's verdict; bond 1 is active and due for release on 18 Nov 2026. Addresses and transactions: `deployments/xlayer.json`.

## What it does

A maker locks a bond in OKB behind one public promise:

> "These wallets will keep at least X% of the token they hold today, until date D."

A TapeOut circuit decides the outcome. If the promise holds until D, the maker gets the bond back and a kept-word entry on their record. If the wallets drop under the promised share at any point and someone calls it out, the bond is slashed and the maker gets a broken-word entry.

## Who does what

| Actor | Can do | Cannot do |
|---|---|---|
| Maker | Create a bond. Get it back after the deadline if the promise held. | Withdraw early. Change the wallets, floor, deadline or rule. |
| Anyone | Call `challenge` on a broken promise and earn the bounty. Call `release` for a maker. Read every bond and record. | Slash a promise that is being kept. Redirect a refund. |
| Admin | Add new promise templates (rule circuits). | Touch a bond, its funds or its rule. Change or remove a template. Change the fee, treasury or slash sink. |

## How a verdict is reached

1. The contract reads the token balance of each declared wallet and adds them up.
2. It converts the total into basis points of the amount held when the bond was created (capped at 65535).
3. It sends three facts to the circuit: `held`, `floor`, `expired`.
4. The circuit returns two bits: `breach` and `release`.
5. The contract moves money only as those bits allow. If the circuit ever answers both at once, nothing moves.

The rule (`circuits/hold_rule.v`):

```
breach  = held < floor
release = expired AND NOT (held < floor)
```

Synthesised with TapeSynth to 119 NAND gates, no latches, 33 inputs, 2 outputs.

## Money flow

| Event | Where the money goes |
|---|---|
| Create | 1% fee credited to the treasury. The rest is the bond. |
| Kept | 100% of the bond back to the maker. |
| Broken | 10% bounty to the challenger. 90% credited to the slash sink. |

The fee, treasury and slash sink are fixed when the contract is deployed. The treasury and sink are credited and collect with `withdraw`, so a sink that rejects funds can never block a slash.

## Design decisions

- **No betting in v1.** Backing or betting against a promise is the bigger idea, but it brings a self-betting loophole and may fall under prediction-market rules. Version 1 is bond, slash and record only.
- **The maker cannot choose where slashed money goes.** If they could, they would name their own second wallet and lose nothing.
- **Templates are add-only and admin-registered.** A maker cannot point a bond at a circuit they wrote to always say "kept".
- **A balance read that fails counts as zero.** A token that stops answering cannot be used to dodge a slash.
- **The record counts value as well as number.** Ten kept bonds of dust do not look like one kept bond of size.

## Threats considered and how they are handled

| Threat | Handling | Tested |
|---|---|---|
| Maker points the bond at a fake rule | Only admin-registered templates; shape checked (33 in, 2 out, no memory) | yes |
| Maker routes slashed funds back to themselves | Slash sink fixed at deployment | by design |
| Maker challenges their own broken promise | Possible. They recover the 10% bounty and lose 90%. Stated limit. | n/a |
| Challenger starves the balance read of gas to fake an empty wallet | Gas reserve check; a starved read also leaves too little gas to finish | yes, gas sweep |
| Token returns an oversized answer to burn gas | Only 32 bytes are copied | yes |
| Token reverts, hangs or returns garbage after creation | Counted as zero held, so the bond becomes slashable | yes |
| Absurd balances overflow the maths | Saturating sum and a cap | yes |
| Reentrancy on refund or bounty | State updated before paying, plus a lock | yes |
| Circuit returns a contradictory or empty answer | Reverts, nothing moves | yes |
| Slash sink rejects funds to block slashing | Sink is credited, not paid | yes |
| Admin tries to take or redirect funds | No function gives the admin that power | yes |

## Known limits (stated plainly)

1. **Sell and buy back.** A breach is only caught if someone calls `challenge` while the wallets are under the floor. A maker who sells and rebuys before anyone notices is not caught. A watcher bot paid by the bounty narrows this but does not close it.
2. **Whose wallets.** A bond proves the declared wallets kept holding. It does not prove those are the team's only wallets, or the team's wallets at all.
3. **Token honesty.** The contract trusts the token's `balanceOf`. A token the maker controls or can upgrade could misreport. Rebasing and fee-on-transfer tokens are not supported.
4. **Tokens moved into staking, vesting or liquidity contracts count as sold**, because they leave the declared wallets.
5. **Hedging is invisible.** A maker can hold the tokens and short them elsewhere.
6. **No escape hatch.** If the TapeOut processor stopped answering, active bonds could be neither slashed nor released. There is deliberately no admin override.
7. **Bond is in OKB**, so its dollar value moves.
8. **Shared processor.** The rule lives on a processor created by another project (OrderGuard). A taped-out circuit cannot be changed by anyone, but Word Bonds does not own the processor it reads.
9. **Unaudited.**

## Test status

41 tests pass (`forge test`): 28 for the bond contract, 11 for the handle registry and 2 tying the rule to the circuit. They include a 512-run fuzz test over bond size, floor, amount sold and time. Line coverage of `WordBonds.sol` is 98.7%.

The tests use a stand-in processor. To tie it to the real circuit, `tools/vectors.mjs` simulates the synthesised NAND netlist on 4,512 inputs (edge values plus random) and `HoldRuleVectors.t.sol` checks that the stand-in gives the same answer on every one.

Six guards were removed one at a time to see whether a test would notice. Five removals made tests fail. The sixth, the gas reserve check, did not, because a starved read already fails for a second reason.

## X handles

`src/HandleRegistry.sol` lets a wallet point at an X handle. The maker posts one line from their X account naming the wallet, then saves the link to that post. The contract checks that the link is a post on the claimed handle's own account (`https://x.com/<handle>/status/<id>`); it cannot read X, so it cannot check what the post says. The site therefore labels a handle as claimed, with the proof post one click away, never as verified. Several wallets can claim one handle; the site lists them all with their proofs. 11 tests.

## Live check

After the tape-out, the on-chain netlist was read back and matched ours byte for byte, `circuitInfo` returned 33 inputs, 2 outputs, no memory and 119 gates, and 48 live `eval` calls matched the tested rule.

## Not built yet

- Release of a kept bond on mainnet (bond 1, due 18 Nov 2026)
- The web page (create a bond, public bond page, maker record)
- A watcher that challenges breaches automatically
- A second promise type (for example "token launches by date D")
- Backing and betting on promises
