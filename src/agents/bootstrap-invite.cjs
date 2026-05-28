const crypto = require("crypto");
let pgPath;
try { pgPath = require.resolve("pg", { paths: ["/app"] }); }
catch { pgPath = require("child_process").execSync("find /app/node_modules/.pnpm -path '*/pg/lib/index.js' | head -1", { encoding: "utf8" }).trim(); }
const { Client } = require(pgPath);

const connStr = process.env.PG_CONNECTION_STRING
  || process.env.DATABASE_URL
  || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const c = new Client({ connectionString: connStr });

c.connect()
  .then(() =>
    c.query(
      "SELECT 1 FROM invites WHERE invite_type = 'bootstrap_ceo' AND expires_at > NOW() LIMIT 1"
    )
  )
  .then((res) => {
    if (res.rowCount > 0) {
      console.error("Bootstrap invite already exists (unexpired). Skipping insert.");
      return c.end();
    }

    const token = "pcp_bootstrap_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const expires = new Date(Date.now() + 72 * 3600000).toISOString();

    return c.query(
      "INSERT INTO invites (invite_type, token_hash, allowed_join_types, expires_at, invited_by_user_id) VALUES ($1,$2,$3,$4,$5)",
      ["bootstrap_ceo", hash, "human", expires, "system"]
    ).then(() => {
      console.log("http://localhost:3100/invite/" + token);
      return c.end();
    });
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
