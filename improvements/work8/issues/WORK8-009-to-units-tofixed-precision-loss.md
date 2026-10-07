---
title: "[AUDIT/V8] `toUnits()` uses `Number.toFixed(decimals)`, which gives wrong on-chain amounts for 18-decimal jettons and large amounts, and throws for amounts of 1e21 or more"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "financial-safety"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-009"
severity: "medium"
category: "financial-safety"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/748"
---

## Problem Description

```ts
export function toUnits(amount: number, decimals: number): bigint {
  const str = amount.toFixed(decimals);   // prints the binary double, not the decimal the user typed
  const [whole, frac = ""] = str.split(".");
  ...
```
The comment says the function is "string-based to avoid floating-point precision loss". It is not: `toFixed(d)` prints the exact binary value of the double. With `d >= 17`, or with amounts large enough that `d` digits go past 15-17 significant digits, the result includes floating-point noise.

## Location

- `src/ton/units.ts:10-15`
- duplicate copies in `src/agent/tools/dedust/asset-cache.ts:75-80` and `src/sdk/ton.ts:562` and `:776` (`sendJetton` / `createJettonTransfer`: `amount.toFixed(decimals)`). Used by `jetton_send`, `stonfi_swap`, `dedust_swap`, the quote tools and `sdk.ton.dex`.

## How To Reproduce

`node experiments/audit8/repro-ton-units.mts`
```
toUnits(0.1,18) = 100000000000000006n   expected 100000000000000000n
toUnits(0.3,18) = 299999999999999989n   expected 300000000000000000n
toUnits(1234567.89,18) = 1234567889999999897554517n
toUnits(20000000.123456789,9) = 20000000123456787n expected 20000000123456789n
toUnits(1e21,9) throws: Cannot convert 1e+21000000000 to a BigInt
```
Also: `toFixed` throws a RangeError when decimals > 100. TEP-64 allows up to 255.

**Verification evidence:** Ran the real `src/ton/units.ts` under Node (output above). Checked that prior issues #700 and #723 only covered the `decimals || 9` fallback, not the `toFixed` precision.

## Impact

- `jetton_send` and swaps send a different amount from the one requested: sometimes more (0.1 becomes +6 units), sometimes less (0.3).
- "Send my whole balance of 0.1 X" fails with a false "Insufficient balance" because `100000000000000006n > 100000000000000000n`.
- The DEX `minAmountOut` and quote math run on the wrong input.
- A large `amount` crashes the tool with a raw SyntaxError.

## Proposed Fix

Build the units from the shortest round-trip decimal string (`String(amount)`, which is exactly what the LLM or user wrote), expand any exponent form, then pad or truncate the fraction to `decimals`. Reject `decimals > 255` and non-finite amounts. Better still, accept the amount as a string end-to-end. Replace the duplicate copies in `asset-cache.ts` and `sdk/ton.ts` with this one helper.

## Regression Test

```ts
it.each([[0.1,18,"100000000000000000"],[0.3,18,"300000000000000000"],
         [20000000.123456789,9,"20000000123456789"],[1e21,9,"1000000000000000000000000000000"]])(
  "toUnits(%s,%s)", (a,d,exp) => expect(toUnits(a,d).toString()).toBe(exp));
```

## Acceptance Criteria

- [ ] `toUnits(x, d)` equals the exact decimal value of `String(x)` scaled by 10^d, truncated, for d from 0 to 255.
- [ ] No throw for amounts written in exponent form.
- [ ] Only one implementation remains.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-009`
- Audit track notes: `experiments/audit8/ton.md` (finding 2)
- Repro: `experiments/audit8/repro-ton-units.mts`
