/** Loaded with --env-file=.env.e2e by e2e-stack.sh and pnpm e2e:seed. */
import { seedAllE2ePrerequisites } from "../tests/e2e/src/helpers/prerequisites.js";

console.log("Seeding e2e trader balances, approvals, sub-solver collateral, and Trampoline...");
await seedAllE2ePrerequisites();
console.log("E2e prerequisites ready.");
