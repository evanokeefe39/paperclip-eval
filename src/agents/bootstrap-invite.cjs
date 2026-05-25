const crypto = require("crypto");
const { Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

const token = "pcp_bootstrap_" + crypto.randomBytes(24).toString("hex");
const hash = crypto.createHash("sha256").update(token).digest("hex");
const expires = new Date(Date.now() + 72 * 3600000).toISOString();

const c = new Client({
  connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
});

c.connect()
  .then(() =>
    c.query(
      "INSERT INTO invites (invite_type, token_hash, allowed_join_types, expires_at, invited_by_user_id) VALUES ($1,$2,$3,$4,$5)",
      ["bootstrap_ceo", hash, "human", expires, "system"]
    )
  )
  .then(() => {
    console.log("http://localhost:3100/invite/" + token);
    return c.end();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
