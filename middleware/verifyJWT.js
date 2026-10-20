const { jwtVerify, importJWK } = require("jose-cjs");

// Better Auth signs every JWT with a key whose `kid` is stored in the shared
// `jwks` table, so the public key is fetched from MySQL instead of calling the
// client's /api/auth/jwks endpoint over HTTP.
function extractKid(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    return header.kid || header.jwk?.kid || null;
  } catch {
    return null;
  }
}

const ROLE_LOOKUP_SQL = "SELECT role FROM `user` WHERE id = ? LIMIT 1";

// The `user` table is the source of truth for roles, so promotions done in
// phpMyAdmin apply to the very next request. The JWT role is only a fallback
// for accounts that still live in MongoDB during the server-first rollout.
const resolveUser = async (pool, payload) => {
  const userId = String(payload?.id ?? payload?.sub ?? "").trim();
  if (!userId) return null;
  const jwtRole =
    typeof payload?.role === "string" && payload.role ? payload.role : "customer";
  let role = jwtRole;
  try {
    const [rows] = await pool.query(ROLE_LOOKUP_SQL, [userId]);
    const dbRole = rows[0]?.role;
    if (typeof dbRole === "string" && dbRole) role = dbRole;
  } catch (error) {
    console.error("Role lookup failed:", error?.message || error);
  }
  return {
    userId,
    role,
    email: typeof payload?.email === "string" ? payload.email : "",
  };
};

const verifyAgainstDb = async (pool, token) => {
  const kid = extractKid(token);
  if (!kid) throw new Error("Missing kid");
  const [rows] = await pool.query("SELECT * FROM jwks WHERE id = ? LIMIT 1", [kid]);
  const key = rows[0];
  if (!key) throw new Error(`Unknown signing key: ${kid}`);
  const publicKey = JSON.parse(key.public_key);
  const algorithm =
    (typeof publicKey?.alg === "string" && publicKey.alg) ||
    (typeof key.alg === "string" && key.alg) ||
    "EdDSA";
  const cryptoKey = await importJWK(publicKey, algorithm);
  const verifyOptions = {};
  if (process.env.AUTH_BASE_URL) {
    verifyOptions.issuer = process.env.AUTH_BASE_URL;
    verifyOptions.audience = process.env.AUTH_BASE_URL;
  }
  const { payload } = await jwtVerify(token, cryptoKey, verifyOptions);
  return resolveUser(pool, payload);
};

const readBearerToken = (req) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token === "null" || token === "undefined") return null;
  return token;
};

const verifyJWT = (pool) => async (req, res, next) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  try {
    const user = await verifyAgainstDb(pool, token);
    if (!user) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    req.user = user;
    req.auth = user;
    return next();
  } catch (error) {
    console.error("JWT verify failed:", error?.message || error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Optional auth: attaches req.user when a valid JWT is present, otherwise
// continues as a guest (used by POST /orders for public COD checkout).
verifyJWT.optionalAuth = (pool) => async (req, _res, next) => {
  const token = readBearerToken(req);
  if (!token) return next();
  try {
    const user = await verifyAgainstDb(pool, token);
    if (user) {
      req.user = user;
      req.auth = user;
    }
  } catch {
    // ignore invalid token on optional routes — treated as guest
  }
  return next();
};

module.exports = verifyJWT;
