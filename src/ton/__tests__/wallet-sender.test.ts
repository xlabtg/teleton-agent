import { expect, it } from "vitest";
import { Address, beginCell, SendMode } from "@ton/core";
import { createWalletMessageCollector } from "../confirm.js";

it("collects DeDust messages for the wallet path with explicit validity (#749)", async () => {
  const address = Address.parseRaw(`0:${"01".repeat(32)}`);
  const body = beginCell().storeUint(123, 32).endCell();
  const { sender, messages } = createWalletMessageCollector(address);
  await sender.send({
    to: address,
    value: 1n,
    body,
    bounce: false,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
  });
  expect(sender.address).toEqual(address);
  expect(messages).toHaveLength(1);
  expect(messages[0].body.equals(body)).toBe(true);
  expect(messages[0].info).toMatchObject({ type: "internal", value: { coins: 1n }, bounce: false });
  await expect(sender.send({ to: address, value: 1n, sendMode: 128 })).rejects.toThrow(/send mode/);
});
