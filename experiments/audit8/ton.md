# Audit 8: TON / wallet / deals / autonomous / ton-proxy

---

## 1. One received gift can verify any number of deals (no gift msgId reuse protection), so the agent pays out more than once

- **Severity:** high
- **Category:** financial-safety
- **Location:** `src/deals/gift-matcher.ts:23-35`, `src/agent/tools/deals/verify-payment.ts:150-208`, `src/bot/services/verification-poller.ts:218-282`, `src/deals/db.ts:42` (no UNIQUE on `user_payment_gift_msgid`)

### Problem
TON payments are de-duplicated through `used_transactions` (INSERT OR IGNORE on the tx hash). Gift payments have no equivalent. The matcher accepts any gift with the right slug and sender that arrived after the deal was created:

```ts
const gift = gifts.find(
  (g) =>
    g.slug === deal.user_gives_gift_slug &&
    g.fromUserId === deal.user_telegram_id &&
    g.receivedAt >= deal.created_at * 1000
);
```

`verify-payment.ts` creates a new `GiftDetector()` on every call, so its `seenGifts` cache is always empty and every gift in the inbox counts as "new". The poller (`verification-poller.ts:221`) works the same way. Neither path checks whether another deal already stored that `msgId` in `user_payment_gift_msgid`, and the column has no UNIQUE index. Nothing limits how many open deals a user can have (`propose.ts` has no such check).

### How to reproduce
1. User 42 opens two deals A and B, each "user gives gift `plush-pepe`, agent gives X TON", and accepts both.
2. User sends one `plush-pepe` gift.
3. Call `deal_verify_payment` for A, then for B (or let the poller handle both). Both match msgId 777, both move to `verified`, and `executeDeal` pays out twice.

Repro (pure logic): `node experiments/audit8/repro-ton-gift-reuse.mts`
```
deal A: 777
deal B: 777
```

### Impact
The agent pays out N times for one gift. Anyone can do this with N parallel deals.

### Proposed fix
- Add `CREATE UNIQUE INDEX ... ON deals(user_payment_gift_msgid) WHERE user_payment_gift_msgid IS NOT NULL`, or insert `gift:<msgId>` into a used-payments table inside the same transaction as the `accepted→verified` UPDATE.
- When matching, skip gifts whose msgId is already linked to another deal: `NOT EXISTS (SELECT 1 FROM deals WHERE user_payment_gift_msgid = ?)`.
- Apply the same check in both `verify-payment.ts` and `verification-poller.ts`.

### Regression test sketch
```ts
it("does not let one gift settle two deals", async () => {
  // seed deals A and B (accepted, same user and slug), mock get_my_gifts -> [{msgId:"777",...}]
  expect((await dealVerifyPaymentExecutor({dealId:"A"}, ctx)).success).toBe(true);
  expect((await dealVerifyPaymentExecutor({dealId:"B"}, ctx)).success).toBe(false);
  expect(sendTonMock).toHaveBeenCalledTimes(1);
});
```

### Acceptance criteria
- A gift msgId can move at most one deal to `verified`, in both the tool path and the poller path.
- The DB rejects a second deal row with the same `user_payment_gift_msgid`.

### Verification evidence
- Read both verification paths and the deals schema. The only indexes on `deals` are status, user, chat, inline_msg, payment_claimed and expires. None is unique on the gift msgid.
- The repro above shows both deals matching the same gift.

---

## 2. `toUnits()` uses `Number.toFixed(decimals)`, which gives wrong on-chain amounts for 18-decimal jettons and large amounts, and throws for amounts of 1e21 or more

- **Severity:** medium
- **Category:** financial-safety
- **Location:** `src/ton/units.ts:10-15`; duplicate copies in `src/agent/tools/dedust/asset-cache.ts:75-80` and `src/sdk/ton.ts` (`sendJetton` / `createJettonTransfer`: `amount.toFixed(decimals)`). Used by `jetton_send`, `stonfi_swap`, `dedust_swap`, the quote tools and `sdk.ton.dex`.

### Problem
```ts
export function toUnits(amount: number, decimals: number): bigint {
  const str = amount.toFixed(decimals);   // prints the binary double, not the decimal the user typed
  const [whole, frac = ""] = str.split(".");
  ...
```
The comment says the function is "string-based to avoid floating-point precision loss". It is not: `toFixed(d)` prints the exact binary value of the double. With `d >= 17`, or with amounts large enough that `d` digits go past 15-17 significant digits, the result includes floating-point noise.

### How to reproduce
`node experiments/audit8/repro-ton-units.mts`
```
toUnits(0.1,18) = 100000000000000006n   expected 100000000000000000n
toUnits(0.3,18) = 299999999999999989n   expected 300000000000000000n
toUnits(1234567.89,18) = 1234567889999999897554517n
toUnits(20000000.123456789,9) = 20000000123456787n expected 20000000123456789n
toUnits(1e21,9) throws: Cannot convert 1e+21000000000 to a BigInt
```
Also: `toFixed` throws a RangeError when decimals > 100. TEP-64 allows up to 255.

### Impact
- `jetton_send` and swaps send a different amount from the one requested: sometimes more (0.1 becomes +6 units), sometimes less (0.3).
- "Send my whole balance of 0.1 X" fails with a false "Insufficient balance" because `100000000000000006n > 100000000000000000n`.
- The DEX `minAmountOut` and quote math run on the wrong input.
- A large `amount` crashes the tool with a raw SyntaxError.

### Proposed fix
Build the units from the shortest round-trip decimal string (`String(amount)`, which is exactly what the LLM or user wrote), expand any exponent form, then pad or truncate the fraction to `decimals`. Reject `decimals > 255` and non-finite amounts. Better still, accept the amount as a string end-to-end. Replace the duplicate copies in `asset-cache.ts` and `sdk/ton.ts` with this one helper.

### Regression test sketch
```ts
it.each([[0.1,18,"100000000000000000"],[0.3,18,"300000000000000000"],
         [20000000.123456789,9,"20000000123456789"],[1e21,9,"1000000000000000000000000000000"]])(
  "toUnits(%s,%s)", (a,d,exp) => expect(toUnits(a,d).toString()).toBe(exp));
```

### Acceptance criteria
- `toUnits(x, d)` equals the exact decimal value of `String(x)` scaled by 10^d, truncated, for d from 0 to 255.
- No throw for amounts written in exponent form.
- Only one implementation remains.

### Verification evidence
Ran the real `src/ton/units.ts` under Node (output above). Checked that prior issues #700 and #723 only covered the `decimals || 9` fallback, not the `toFixed` precision.

---

## 3. On-chain confirmation window (20 s) is shorter than the wallet message validity (about 60 s): a transfer reported as "failed" can still land, which leads to double payouts

- **Severity:** medium
- **Category:** financial-safety
- **Location:** `src/ton/confirm.ts:96-123` (`sendWalletTx` calls `contract.sendTransfer` without `timeout`), `src/ton/confirm.ts:53-90` (`confirmWalletTx`), `src/constants/timeouts.ts:22` (`TON_CONFIRM_TIMEOUT_MS = 20_000`); used by `transfer.ts`, `sdk/ton.ts`, `jetton-send.ts`, `deals/executor.ts`

### Problem
```ts
await contract.sendTransfer({ seqno, secretKey, sendMode, messages }); // no `timeout`
...
const confirmed = await confirmWalletTx(client, contract.address, sinceLt); // gives up after 20 s
if (!confirmed) { if (broadcastError) throw broadcastError; return null; }
```
`@ton/ton` `WalletContractV5R1.createTransfer` sets `valid_until` to `now + 60` when no `timeout` is passed. A signed external message can therefore be accepted up to about 60 s after broadcast. Liteserver lag, masterchain delays or a slow toncenter index can push inclusion past 20 s. In that case:
- `sendTon` returns `null` and `sendWalletTx` may rethrow. `jetton_send` / `ton_send` report failure. `executeDeal` marks the deal `failed` (`executor.ts:257-262`) and the user is told nothing was sent.
- The tx-lock is released. If the LLM, the user or an admin retries after the first message lands (between seconds 20 and 60), the retry reads the new seqno and sends the funds a second time.

### How to reproduce
Mock `client.getTransactions` to return the external-in tx only after 25 s and stub `sendTransfer` to succeed. `sendTon` returns `null`. A second `sendTon` call at 30 s builds seqno+1, so both transfers are effective.

### Impact
False "failed" results while funds actually left the wallet, followed by duplicate transfers on retry. In deals, the deal is marked failed even though the payout was made.

### Proposed fix
Pass an explicit `timeout: now + N` to `sendTransfer`. Make `TON_CONFIRM_TIMEOUT_MS` strictly greater than `N` plus a margin (for example `N = 45 s`, confirm for 75 s). If a timeout still happens, keep polling until `valid_until` has passed before returning "not sent", and report "unknown / pending" rather than failure.

### Regression test sketch
```ts
it("does not report failure while the signed message is still valid", async () => {
  vi.useFakeTimers();
  // getTransactions returns the external-in tx only after 25 s
  const p = sendWalletTx(client, contract, {...});
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(p).resolves.toMatchObject({ hash: expect.any(String) });
  expect(sendTransferMock.mock.calls[0][0].timeout).toBeLessThanOrEqual(nowSec + TON_CONFIRM_TIMEOUT_MS/1000);
});
```

### Acceptance criteria
- Every wallet transfer carries an explicit `timeout`.
- `confirmWalletTx` never gives up before that `valid_until` has passed.

### Verification evidence
Read `confirm.ts` and `timeouts.ts`. No caller passes `timeout`: grepped `sendTransfer(` in src/ton and src/agent/tools. `createTransfer` in `sdk/ton.ts` does set `TX_VALID_UNTIL_SECONDS = 120`, but the broadcast paths do not. Not covered by #311/#335 (those added confirmation, not the validity-window mismatch). I could not run this: node_modules is not installed. The 60 s default is the documented `@ton/ton` V5R1 behaviour.

---

## 4. TON Proxy start sends SIGTERM to whatever process listens on the configured port (default 8080) and to a stale, possibly reused PID

- **Severity:** medium
- **Category:** reliability
- **Location:** `src/ton-proxy/manager.ts:189-231` (`killOrphan`), called from `start()` at `:262`; default port `src/config/schema.ts:507` (`default(8080)`)

### Problem
```ts
const portLine = out.split("\n").find((line) => line.includes(`:${this.config.port} `));
const pidMatch = portLine?.match(/pid=(\d+)/);
if (pidMatch) { ... process.kill(pid, "SIGTERM"); }
```
and
```ts
const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
process.kill(pid, 0); process.kill(pid, "SIGTERM");
```
Neither check confirms that the target is a `tonutils-proxy-cli` process (no `/proc/<pid>/cmdline` or exe check). Port 8080 is a common default for other services (dev servers, Jupyter, local APIs). The line match `:8080 ` also matches peer-address columns. A PID file left by a crash can point to a PID the OS has since reused.

### How to reproduce
1. Run `python3 -m http.server 8080` as the same user.
2. Set `ton_proxy.enabled: true` (default port), or start it from WebUI `/api/ton-proxy`.
3. The log shows "Port 8080 occupied by PID N, killing it" and the Python server is terminated.

### Impact
Enabling the feature silently kills unrelated user processes. The function also calls `Atomics.wait`, which blocks the event loop for 500 ms.

### Proposed fix
Only kill a PID after checking that its command line or executable is the proxy binary under `BINARY_DIR` (`/proc/<pid>/exe` or `ps -o comm=`). If the port is held by something else, fail start with a clear "port in use" error.

### Regression test sketch
Mock `spawnSync("ss")` to return a line with `pid=1234` and mock the cmdline as `python3`. Expect `process.kill` not to be called and `start()` to reject with "port in use".

### Acceptance criteria
- No signal is ever sent to a process that is not the managed proxy binary.
- Start fails cleanly when the port is taken.

### Verification evidence
Read `killOrphan` and `start`, and confirmed the 8080 default in the config schema. No prior issue covers this (searched prior titles for "orphan", "kill", "pid").

---

## 5. Payment verification scans only the latest 20 wallet transactions: cheap dust spam (or normal traffic) hides a real payment and the deal expires

- **Severity:** low
- **Category:** reliability
- **Location:** `src/ton/payment-verifier.ts:28-31` (`getTransactions(botAddress, { limit: 20 })`), `src/sdk/ton.ts` `verifyPayment` (`this.getTransactions(address, 20)`); deal expiry is 120 s (`src/deals/config.ts:12`)

### Problem
Only one page of 20 transactions is checked, with no pagination down to `requestTime`. Outgoing transactions, gas refunds, jetton notifications and dust deposits all count toward the 20.

### How to reproduce
A buyer pays deal A. A third party, or the agent's own traffic, then adds more than 20 transactions within the 10-minute window (for example 21 transfers of 1 nanoTON, costing about 0.06 TON in fees). `deal_verify_payment` returns "Payment not found" and the deal expires. The buyer's TON stays with the bot and the deal is never executed.

### Impact
A paying user gets no service and needs manual refund handling. Deals can be griefed cheaply.

### Proposed fix
Paginate with `lt`/`hash` until `tx.now * 1000 < requestTime`, with a hard cap (for example 200 txs). Optionally filter by comment server-side through TonAPI.

### Regression test sketch
Mock `getTransactions` to return 20 dust txs on page 1 and the matching payment on page 2. Expect `verified: true`.

### Acceptance criteria
- A matching payment inside the time window is found no matter how many other transactions arrived after it, up to the documented cap.

### Verification evidence
Read both verifiers. Neither paginates. No prior issue about this (searched prior titles for "limit"/"spam"/"pagination").
