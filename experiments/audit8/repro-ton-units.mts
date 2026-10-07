import { toUnits } from "../../src/ton/units.ts";
console.log("toUnits(0.1,18) =", toUnits(0.1, 18), "expected 100000000000000000n");
console.log("toUnits(0.3,18) =", toUnits(0.3, 18), "expected 300000000000000000n");
console.log("toUnits(1234567.89,18) =", toUnits(1234567.89, 18));
console.log("toUnits(20000000.123456789,9) =", toUnits(20000000.123456789, 9), "expected 20000000123456789n");
try { toUnits(1e21, 9); } catch (e) { console.log("toUnits(1e21,9) throws:", (e as Error).message); }
