const mysql = require("mysql2/promise");

// Shared mysql2 pool. Read config comes from the environment so the same
// code runs on cPanel shared hosting (localhost + cpanel-prefixed DB name).
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // DECIMAL columns (price/stock/totals) arrive as JS numbers, not strings,
  // so API responses keep the exact types MongoDB used to produce.
  decimalNumbers: true,
  // Treat every DATETIME as UTC. Values are written from JS Date objects and
  // read back as UTC so res.json() emits the same ISO strings as before.
  timezone: "Z",
  charset: "UTF8MB4_UNICODE_CI",
});

module.exports = pool;
