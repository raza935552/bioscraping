// Bootstrap the first admin account:
//   pnpm --filter @biolinx/api seed:admin -- <email> <name>
// Prints a one-time invite path; open it in the admin app to set a password.

import { loadEnv } from "@biolinx/core";
loadEnv();

const { connect, schema } = await import("@biolinx/db");
const { eq } = await import("drizzle-orm");
const { newInviteToken } = await import("./auth.js");

const email = (process.argv[2] ?? "").trim().toLowerCase();
const name = process.argv[3] ?? "Admin";
if (!email.includes("@")) {
  console.error("usage: seed-admin <email> [name]");
  process.exit(1);
}

const { db } = connect();
const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
if (existing) {
  console.error(`user ${email} already exists (id ${existing.id})`);
  process.exit(1);
}
const token = newInviteToken();
await db.insert(schema.users).values({
  name,
  email,
  role: "admin",
  inviteToken: token,
  invitedAt: new Date(),
});
console.log(`admin invited: ${email}`);
console.log(`open the admin app at:  /#/accept-invite/${token}`);
process.exit(0);
