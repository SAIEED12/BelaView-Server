const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const cors = require("cors");
const multer = require("multer");
const pool = require("./db/pool");
const verifyJWT = require("./middleware/verifyJWT");

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 5000;

const verifyToken = verifyJWT(pool);
const optionalAuth = verifyJWT.optionalAuth(pool);

const requireAdmin = (req, res, next) => {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ error: "Admin only" });
};

const requireOwnerOrAdmin = (getUserId) => (req, res, next) => {
  const target = String(getUserId(req) ?? "").trim();
  if (!target) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  if (req.user?.role === "admin" || target === req.user?.userId) return next();
  return res.status(403).json({ error: "Forbidden" });
};

const MAX_IMAGES = 4;
const DEFAULT_DELIVERY_CHARGE = 60;
const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

const isValidUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

//Image Handler
const validateImages = (images) => {
  if (!Array.isArray(images)) return "images must be an array of URLs";
  if (images.length < 1 || images.length > MAX_IMAGES) {
    return `images must contain between 1 and ${MAX_IMAGES} URLs`;
  }
  if (!images.every(isValidUrl)) return "every item in images must be a valid http(s) URL";
  return null;
};

//Category Handler
const MAX_CATEGORY_NAME = 80;

// Mirrors the client slugifyCategory so names stay consistent across apps.
const slugifyCategory = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return raw
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u0980-\u09FF-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

const validateCategoryName = (raw) => {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { error: "name is required" };
  if (name.length > MAX_CATEGORY_NAME) {
    return { error: `name must be at most ${MAX_CATEGORY_NAME} characters` };
  }
  const slug = slugifyCategory(name);
  if (!slug) return { error: "name must contain letters or numbers" };
  return { value: { name, slug } };
};

const validateCategoryImage = (raw) => {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === "") return { value: null };
  if (!isValidUrl(raw)) return { error: "image must be a valid http(s) URL" };
  return { value: String(raw).trim() };
};

// Optional product policy fields shown on the product details page.
// Empty / whitespace-only means absent and is hidden on the storefront.
const POLICY_FIELDS = ["disclaimer", "note", "deliveryPayment", "returnPolicy"];
const MAX_POLICY_LEN = 5000;

const normalizePolicyField = (raw) => {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: "" };
  if (typeof raw !== "string") return { error: "must be a string" };
  const value = raw.trim();
  if (value.length > MAX_POLICY_LEN) {
    return { error: `must be at most ${MAX_POLICY_LEN} characters` };
  }
  return { value };
};

// SIZE
const MAX_SIZES = 30;
const MAX_SIZE_LEN = 16;

const normalizeSizes = (raw) => {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === "") return { value: [] };
  let list;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    list = raw.split(",");
  } else {
    return { error: "must be an array or a comma-separated string" };
  }
  const sizes = [];
  for (const entry of list) {
    if (typeof entry !== "string" && typeof entry !== "number") {
      return { error: "each size must be a string" };
    }
    const token = String(entry).trim();
    if (!token) continue;
    if (token.length > MAX_SIZE_LEN) {
      return { error: `each size must be at most ${MAX_SIZE_LEN} characters` };
    }
    // ":" would collide with the client cart line separator (productId::size).
    if (token.includes(":")) {
      return { error: `size "${token}" cannot contain ":"` };
    }
    if (!sizes.includes(token)) sizes.push(token);
  }
  if (sizes.length > MAX_SIZES) {
    return { error: `can hold at most ${MAX_SIZES} entries` };
  }
  return { value: sizes };
};

const normalizeOrderItemSize = (raw) => {
  if (raw === undefined || raw === null) return { value: "" };
  if (typeof raw !== "string") return { error: "must be a string" };
  const size = raw.trim();
  if (size.length > MAX_SIZE_LEN) {
    return { error: `must be at most ${MAX_SIZE_LEN} characters` };
  }
  return { value: size };
};

// Sub-categories
const normalizeSubcategory = (sub) => {
  const name = typeof sub?.name === "string" ? sub.name.trim() : "";
  return {
    _id: String(sub?._id ?? newId()),
    name,
    slug: slugifyCategory(sub?.slug ?? name),
    image: isValidUrl(sub?.image) ? sub.image : null,
    createdAt: sub?.createdAt ?? new Date(),
  };
};

const findSubcategory = (doc, slug) => {
  const target = String(slug ?? "").trim().toLowerCase();
  if (!target) return null;
  const subs = Array.isArray(doc?.subcategories) ? doc.subcategories : [];
  return (
    subs.find((s) => String(s?._id?.toString?.() ?? "") === target) ??
    subs.find((s) => String(s?.slug ?? "").toLowerCase() === target || String(s?.name ?? "").toLowerCase() === target) ??
    null
  );
};

const isDuplicateKeyError = (error) =>
  error?.code === "ER_DUP_ENTRY" || error?.code === 11000;

// ------------------------------------------------------------
// MongoDB compatibility helpers
// ------------------------------------------------------------

// Every id in the system is a 24-char hex string (old ObjectId values kept
// verbatim, new rows get a time-sortable hex id), so URL/body ids must pass
// the same ObjectId.isValid-style check the MongoDB version used.
const isHexId = (value) => typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value.trim());
const normalizeHexId = (value) => String(value ?? "").trim().toLowerCase();

// Generates an ObjectId-like id: 4-byte seconds timestamp + 8 random bytes,
// so `ORDER BY _id DESC` keeps working as "newest first".
const newId = () => {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  return `${timestamp}${crypto.randomBytes(8).toString("hex")}`;
};

const parseJSON = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
};

const parseJSONArray = (value) => {
  const parsed = parseJSON(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

// Escapes LIKE wildcards; used together with `LIKE ? ESCAPE '\\'`.
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (match) => `\\${match}`);

const buildWhere = (clauses) => {
  const usable = clauses.filter(Boolean);
  // Fail loudly on a malformed clause. Silently dropping one (e.g. a bare SQL
  // string instead of { sql, params }) turns the query into an unfiltered
  // SELECT, which is how the orders list ended up leaking every customer's
  // orders to every signed-in customer.
  for (const part of usable) {
    if (!part || typeof part.sql !== "string" || !part.sql.trim()) {
      throw new Error("buildWhere: every clause must be { sql, params }");
    }
  }
  if (usable.length === 0) return { sql: "", params: [] };
  return {
    sql: `WHERE ${usable.map((part) => part.sql).join(" AND ")}`,
    params: usable.flatMap((part) => part.params ?? []),
  };
};

const rowToProduct = (row) => ({
  _id: row._id,
  name: row.name ?? "",
  description: row.description ?? "",
  price: Number(row.price ?? 0),
  stock: Number(row.stock ?? 0),
  category: row.category ?? "",
  subcategory: row.subcategory ?? "",
  image: row.image ?? "",
  images: parseJSONArray(row.images),
  sizes: parseJSONArray(row.sizes),
  disclaimer: row.disclaimer ?? "",
  note: row.note ?? "",
  deliveryPayment: row.deliveryPayment ?? "",
  returnPolicy: row.returnPolicy ?? "",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const rowToOrder = (row) => ({
  _id: row._id,
  customer: {
    name: row.customerName ?? "",
    phone: row.customerPhone ?? "",
    address: row.customerAddress ?? "",
  },
  userId: row.userId ?? null,
  items: parseJSONArray(row.items),
  itemCount: Number(row.itemCount ?? 0),
  subtotal: Number(row.subtotal ?? 0),
  deliveryCharge: Number(row.deliveryCharge ?? 0),
  totalAmount: Number(row.totalAmount ?? 0),
  totalOverridden: row.totalOverridden === true || Number(row.totalOverridden) === 1,
  paymentMethod: row.paymentMethod ?? "cod",
  orderStatus: row.orderStatus ?? "pending",
  note: row.note ?? "",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const rowToCategory = (row) => ({
  _id: row._id,
  name: row.name,
  slug: row.slug,
  image: row.image ?? null,
  subcategories: parseJSONArray(row.subcategories),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const withTransaction = async (work) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // ignore rollback failures — the original error matters more
    }
    throw error;
  } finally {
    conn.release();
  }
};

const resolveCategoryAssignment = async (raw) => {
  const parentInput = typeof raw?.category === "string" ? raw.category.trim() : "";
  const subInput = typeof raw?.subcategory === "string" ? raw.subcategory.trim() : "";
  if (!parentInput) return { error: "category is required" };

  const parentSlug = slugifyCategory(parentInput);
  const subSlug = slugifyCategory(subInput);
  if (!parentSlug) return { error: "category must contain letters or numbers" };

  const [rows] = await pool.query("SELECT * FROM categories");
  const categories = rows.map(rowToCategory);
  if (categories.length === 0) {
    return { value: { category: parentSlug, subcategory: subSlug } };
  }

  const parent =
    categories.find((c) => c.slug === parentSlug) ??
    categories.find((c) => String(c.name).toLowerCase() === parentInput.toLowerCase());
  if (!parent) return { error: `unknown category: ${parentInput}` };

  if (!subSlug) return { value: { category: parent.slug, subcategory: "" } };

  const sub = findSubcategory(parent, subSlug);
  if (!sub) return { error: `unknown sub-category "${subInput}" in ${parent.name}` };

  return { value: { category: parent.slug, subcategory: sub.slug } };
};

//Order Handler (COD only)
const validateOrder = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "order body must be an object" };
  }

  const customer = body.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
    return { error: "customer { name, phone, address } is required" };
  }
  const name = typeof customer.name === "string" ? customer.name.trim() : "";
  const phone = typeof customer.phone === "string" ? customer.phone.trim() : "";
  const address = typeof customer.address === "string" ? customer.address.trim() : "";
  if (!name) return { error: "customer.name is required" };
  if (!phone) return { error: "customer.phone is required" };
  if (!address) return { error: "customer.address is required" };

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { error: "items must be a non-empty array of { productId, quantity }" };
  }

  const seen = new Set();
  const items = [];
  for (const entry of body.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "each item must be an object { productId, quantity }" };
    }
    const productId = typeof entry.productId === "string" ? entry.productId.trim() : "";
    if (!isHexId(productId)) {
      return { error: `invalid productId: ${entry.productId}` };
    }
    if (seen.has(productId)) {
      return { error: `duplicate productId: ${productId}` };
    }
    seen.add(productId);

    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { error: `quantity for product ${productId} must be a positive integer` };
    }

    const sizeCheck = normalizeOrderItemSize(entry.size);
    if (sizeCheck.error) {
      return { error: `size for product ${productId} ${sizeCheck.error}` };
    }

    items.push({ productId, quantity, size: sizeCheck.value });
  }

  // COD only: default to cod, reject anything else
  let paymentMethod = "cod";
  if (body.paymentMethod !== undefined) {
    paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim().toLowerCase() : "";
    if (paymentMethod !== "cod") {
      return { error: "paymentMethod must be cod" };
    }
  }

  let deliveryCharge = DEFAULT_DELIVERY_CHARGE;
  if (body.deliveryCharge !== undefined) {
    deliveryCharge = Number(body.deliveryCharge);
    if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
      return { error: "deliveryCharge must be a number >= 0" };
    }
  }

  let note = "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      return { error: "note must be a string" };
    }
    note = body.note.trim();
    if (note.length > 500) {
      return { error: "note must be at most 500 characters" };
    }
  }

  let userId = null;
  if (body.userId !== undefined && body.userId !== null) {
    userId = normalizeUserId(body.userId);
    if (!userId) {
      return { error: "userId must be a non-empty string" };
    }
  }

  return {
    value: {
      customer: { name, phone, address },
      items,
      paymentMethod,
      deliveryCharge,
      note,
      userId,
    },
  };
};

const validateOrderPatch = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "order update body must be an object" };
  }

  const IMMUTABLE = ["_id", "userId", "paymentMethod", "subtotal", "itemCount", "createdAt"];
  for (const key of IMMUTABLE) {
    if (key in body) {
      return { error: `${key} cannot be updated` };
    }
  }

  const value = {};
  let hasField = false;

  if ("customer" in body) {
    const customer = body.customer;
    if (!customer || typeof customer !== "object" || Array.isArray(customer)) {
      return { error: "customer must be an object { name?, phone?, address? }" };
    }
    const patch = {};
    for (const key of ["name", "phone", "address"]) {
      if (key in customer) {
        if (typeof customer[key] !== "string" || !customer[key].trim()) {
          return { error: `customer.${key} must be a non-empty string` };
        }
        patch[key] = customer[key].trim();
      }
    }
    if (Object.keys(patch).length === 0) {
      return { error: "customer must contain at least one of name, phone, address" };
    }
    value.customer = patch;
    hasField = true;
  }

  if ("note" in body) {
    if (typeof body.note !== "string") {
      return { error: "note must be a string" };
    }
    const note = body.note.trim();
    if (note.length > 500) {
      return { error: "note must be at most 500 characters" };
    }
    value.note = note;
    hasField = true;
  }

  if ("deliveryCharge" in body) {
    const deliveryCharge = Number(body.deliveryCharge);
    if (!Number.isFinite(deliveryCharge) || deliveryCharge < 0) {
      return { error: "deliveryCharge must be a number >= 0" };
    }
    value.deliveryCharge = deliveryCharge;
    hasField = true;
  }

  if ("totalAmount" in body) {
    const totalAmount = Number(body.totalAmount);
    if (!Number.isFinite(totalAmount) || totalAmount < 0) {
      return { error: "totalAmount must be a number >= 0" };
    }
    value.totalAmount = totalAmount;
    hasField = true;
  }

  if ("orderStatus" in body) {
    const orderStatus = typeof body.orderStatus === "string" ? body.orderStatus.trim().toLowerCase() : "";
    if (!ORDER_STATUSES.includes(orderStatus)) {
      return { error: `orderStatus must be one of: ${ORDER_STATUSES.join(", ")}` };
    }
    value.orderStatus = orderStatus;
    hasField = true;
  }

  if ("items" in body) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return { error: "items must be a non-empty array of { productId, quantity }" };
    }
    const seen = new Set();
    const items = [];
    for (const entry of body.items) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { error: "each item must be an object { productId, quantity }" };
      }
      const productId = typeof entry.productId === "string" ? entry.productId.trim() : "";
      if (!isHexId(productId)) {
        return { error: `invalid productId: ${entry.productId}` };
      }
      if (seen.has(productId)) {
        return { error: `duplicate productId: ${productId}` };
      }
      seen.add(productId);
      const quantity = Number(entry.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return { error: `quantity for product ${productId} must be a positive integer` };
      }

      const sizeCheck = normalizeOrderItemSize(entry.size);
      if (sizeCheck.error) {
        return { error: `size for product ${productId} ${sizeCheck.error}` };
      }

      items.push({ productId, quantity, size: sizeCheck.value });
    }
    value.items = items;
    hasField = true;
  }

  if (!hasField) {
    return { error: "No fields to update" };
  }
  return { value };
};

const MAX_WISHLIST_ITEMS = 200;

const normalizeUserId = (raw) => {
  const id = typeof raw === "string" ? raw.trim() : "";
  return id.length > 0 && id.length <= 128 ? id : null;
};

//Wishlist Handler
const validateWishlistIds = (ids, { allowEmpty = true } = {}) => {
  if (!Array.isArray(ids)) {
    return { error: "productIds must be an array of product ids" };
  }
  if (!allowEmpty && ids.length === 0) {
    return { error: "productIds must be a non-empty array" };
  }
  if (ids.length > MAX_WISHLIST_ITEMS) {
    return { error: `wishlist can hold at most ${MAX_WISHLIST_ITEMS} items` };
  }
  const seen = new Set();
  const clean = [];
  for (const entry of ids) {
    const productId = typeof entry === "string" ? entry.trim() : "";
    if (!isHexId(productId)) {
      return { error: `invalid productId: ${entry}` };
    }
    if (seen.has(productId)) continue;
    seen.add(productId);
    clean.push(productId);
  }
  return { value: clean };
};

// ------------------------------------------------------------
// Image uploads (multer -> public/uploads, served by express.static)
// ------------------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const MIME_TO_EXTENSION = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const pickUploadExtension = (file) => {
  const nameExt = path.extname(file?.originalname || "").toLowerCase();
  if (UPLOAD_EXTENSIONS.includes(nameExt)) return nameExt;
  return MIME_TO_EXTENSION[file?.mimetype] || null;
};

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = pickUploadExtension(file) || ".jpg";
    cb(null, `${crypto.randomBytes(16).toString("hex")}${ext}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = pickUploadExtension(file);
    if (!ext) {
      return cb(new Error("only jpeg, png, webp or gif images are allowed"));
    }
    cb(null, true);
  },
});

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "365d", immutable: true }));

const mediaBaseUrl = (req) => {
  const configured = String(process.env.MEDIA_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
};

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------

//Add Products API (admin only)
app.post("/add-products", verifyToken, requireAdmin, async (req, res) => {
  try {
    const product = req.body ?? {};
    const imagesError = validateImages(product.images);
    if (imagesError) {
      return res.status(400).json({ error: imagesError });
    }

    const images = product.images.map((url) => url.trim());
    // Cover image
    const image = isValidUrl(product.image) ? product.image.trim() : images[0];

    const assignment = await resolveCategoryAssignment(product);
    if (assignment.error) {
      return res.status(400).json({ error: assignment.error });
    }

    const { category, subcategory } = assignment.value;

    const policies = {};
    for (const field of POLICY_FIELDS) {
      const check = normalizePolicyField(product[field]);
      if (check.error) {
        return res.status(400).json({ error: `${field} ${check.error}` });
      }
      if (check.value !== undefined) policies[field] = check.value;
    }

    const sizesCheck = normalizeSizes(product.sizes);
    if (sizesCheck.error) {
      return res.status(400).json({ error: `sizes ${sizesCheck.error}` });
    }

    const price = Number(product.price);
    const stock = Number(product.stock);
    const now = new Date();
    const id = newId();

    await pool.query(
      `INSERT INTO products
        (\`_id\`, name, description, price, stock, category, subcategory,
         image, \`images\`, sizes, disclaimer, note, deliveryPayment, returnPolicy,
         createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        typeof product.name === "string" ? product.name : String(product.name ?? ""),
        typeof product.description === "string" ? product.description : null,
        Number.isFinite(price) ? price : 0,
        Number.isFinite(stock) ? stock : 0,
        category,
        subcategory,
        image,
        JSON.stringify(images),
        JSON.stringify(sizesCheck.value ?? []),
        policies.disclaimer ?? null,
        policies.note ?? null,
        policies.deliveryPayment ?? null,
        policies.returnPolicy ?? null,
        now,
        now,
      ],
    );
    res.status(201).json({ acknowledged: true, insertedId: id });
  } catch (error) {
    console.error("Error adding product:", error);
    res.status(500).json({ error: "Failed to add product" });
  }
});

//Get Products API
const PRODUCT_SORTS = {
  newest: "`_id` DESC",
  "price-asc": "`price` ASC, `_id` DESC",
  "price-desc": "`price` DESC, `_id` DESC",
  name: "`name` ASC, `_id` DESC",
};

// Values are stored as slugs, but products created before categories existed
// hold display names. Compare with separators (space/-/_) stripped on both
// sides so those legacy rows stay reachable without a migration.
const looseColumnMatch = (column, values) => {
  const ors = [];
  const params = [];
  for (const value of values) {
    ors.push(`\`${column}\` = ?`);
    params.push(value);
    ors.push(
      `REPLACE(REPLACE(REPLACE(\`${column}\`,' ',''),'-',''),'_','') = REPLACE(REPLACE(REPLACE(?,' ',''),'-',''),'_','')`,
    );
    params.push(value);
  }
  return { sql: `(${ors.join(" OR ")})`, params };
};

const parseListFilter = (raw) => {
  const inputs = Array.isArray(raw) ? raw : (raw !== undefined ? [raw] : []);
  const rawValues = [];
  const slugs = [];
  for (const entry of inputs) {
    for (const part of String(entry).split(",")) {
      const value = part.trim();
      if (!value) continue;
      rawValues.push(value);
      const slug = slugifyCategory(value);
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
  }
  return [...new Set([...slugs, ...rawValues])];
};

const parseProductFilter = (req) => {
  const searchText = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const baseAnd = [];
  if (searchText) {
    const like = `%${escapeLike(searchText)}%`;
    baseAnd.push({
      sql:
        "(name LIKE ? ESCAPE '\\\\' OR category LIKE ? ESCAPE '\\\\' OR subcategory LIKE ? ESCAPE '\\\\' OR CAST(price AS CHAR) LIKE ? ESCAPE '\\\\')",
      params: [like, like, like, like],
    });
  }
  const categories = parseListFilter(req.query.category);
  const subcategories = parseListFilter(req.query.subcategory);
  let minPrice = Number(Array.isArray(req.query.minPrice) ? req.query.minPrice[0] : req.query.minPrice);
  let maxPrice = Number(Array.isArray(req.query.maxPrice) ? req.query.maxPrice[0] : req.query.maxPrice);
  if (!Number.isFinite(minPrice)) minPrice = null;
  if (!Number.isFinite(maxPrice)) maxPrice = null;
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  if (minPrice !== null || maxPrice !== null) {
    const parts = [];
    const params = [];
    if (minPrice !== null) {
      parts.push("price >= ?");
      params.push(minPrice);
    }
    if (maxPrice !== null) {
      parts.push("price <= ?");
      params.push(maxPrice);
    }
    baseAnd.push({ sql: parts.join(" AND "), params });
  }
  const inStock = String(Array.isArray(req.query.inStock) ? req.query.inStock[0] : (req.query.inStock ?? "")).toLowerCase() === "true";
  if (inStock) baseAnd.push({ sql: "stock > 0", params: [] });
  const rawSort = String(Array.isArray(req.query.sort) ? req.query.sort[0] : (req.query.sort ?? "")).trim().toLowerCase();
  const sortKey = PRODUCT_SORTS[rawSort] ? rawSort : "newest";
  return {
    searchText,
    categories,
    subcategories,
    minPrice,
    maxPrice,
    inStock,
    sortKey,
    sortSql: PRODUCT_SORTS[sortKey],
    query: buildWhere([
      ...baseAnd,
      ...(categories.length > 0 ? [looseColumnMatch("category", categories)] : []),
      ...(subcategories.length > 0 ? [looseColumnMatch("subcategory", subcategories)] : []),
    ]),
    facetQuery: buildWhere(baseAnd),
  };
};

app.get("/products", async (req, res) => {
  try {
    const { query, facetQuery, sortKey, sortSql, categories, subcategories, minPrice, maxPrice, inStock } = parseProductFilter(req);
    const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
    if (!wantsPagination) {
      const [rows] = await pool.query(
        `SELECT * FROM products ${query.sql} ORDER BY ${sortSql}`,
        query.params,
      );
      return res.status(200).json(rows.map(rowToProduct));
    }
    let page = Number.parseInt(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page, 10);
    let limit = Number.parseInt(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 20;
    limit = Math.min(limit, 100);

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM products ${query.sql}`,
      query.params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    if (page > totalPages) page = totalPages;

    const [rows] = await pool.query(
      `SELECT * FROM products ${query.sql} ORDER BY ${sortSql} LIMIT ? OFFSET ?`,
      [...query.params, limit, (page - 1) * limit],
    );

    const [facetRows] = await pool.query(
      `SELECT category, IFNULL(subcategory, '') AS subcategory, COUNT(*) AS count
         FROM products ${facetQuery.sql}
        GROUP BY category, IFNULL(subcategory, '')
        ORDER BY count DESC`,
      facetQuery.params,
    );
    const [boundsRows] = await pool.query(
      `SELECT MIN(price) AS minPrice, MAX(price) AS maxPrice FROM products ${facetQuery.sql}`,
      facetQuery.params,
    );
    const [categoryRows] = await pool.query("SELECT name, slug, subcategories FROM categories");

    // Resolve display names from the categories table so facets read
    // "Tea Table" while the client keeps filtering by slug.
    const nameBySlug = new Map();
    for (const doc of categoryRows) {
      nameBySlug.set(doc.slug, {
        name: doc.name,
        subcategories: new Map(
          parseJSONArray(doc.subcategories)
            .map((sub) => [slugifyCategory(sub?.slug ?? sub?.name ?? ""), sub?.name])
            .filter(([slug]) => slug),
        ),
      });
    }
    const facetTree = new Map();
    for (const row of facetRows) {
      const rawCategory = row.category;
      if (typeof rawCategory !== "string" || !rawCategory.trim()) continue;
      const count = Number(row.count ?? 0);
      const categorySlug = nameBySlug.has(rawCategory) ? rawCategory : slugifyCategory(rawCategory);
      const meta = nameBySlug.get(categorySlug);
      const entry = facetTree.get(categorySlug) ?? {
        name: meta?.name ?? rawCategory,
        slug: categorySlug,
        count: 0,
        subcategories: new Map(),
      };
      entry.count += count;
      const subSlug = slugifyCategory(row.subcategory);
      if (subSlug) {
        const existing = entry.subcategories.get(subSlug);
        entry.subcategories.set(subSlug, {
          name: meta?.subcategories?.get(subSlug) ?? row.subcategory,
          slug: subSlug,
          count: (existing?.count ?? 0) + count,
        });
      }
      facetTree.set(categorySlug, entry);
    }
    const facetCategories = [...facetTree.values()]
      .map((entry) => ({
        name: entry.name,
        slug: entry.slug,
        count: entry.count,
        subcategories: [...entry.subcategories.values()].sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
    return res.status(200).json({
      products: rows.map(rowToProduct),
      total,
      page,
      limit,
      totalPages,
      sort: sortKey,
      appliedFilters: { categories, subcategories, minPrice, maxPrice, inStock },
      facets: {
        categories: facetCategories,
        priceBounds: {
          min: Number(boundsRows[0]?.minPrice ?? 0),
          max: Number(boundsRows[0]?.maxPrice ?? 0),
        },
      },
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

//Products Details API
app.get("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isHexId(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }
    const [rows] = await pool.query("SELECT * FROM products WHERE `_id` = ? LIMIT 1", [normalizeHexId(id)]);
    if (!rows[0]) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.status(200).json(rowToProduct(rows[0]));
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

//Update Product API (admin only)
app.patch("/products/:id", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isHexId(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const productId = normalizeHexId(id);
    const { _id, ...fields } = req.body;
    const updateDoc = {};
    const [existingRows] = await pool.query("SELECT * FROM products WHERE `_id` = ? LIMIT 1", [productId]);
    if (!existingRows[0]) {
      return res.status(404).json({ error: "Product not found" });
    }
    const existing = rowToProduct(existingRows[0]);

    if ("images" in fields) {
      const imagesError = validateImages(fields.images);
      if (imagesError) {
        return res.status(400).json({ error: imagesError });
      }
      const images = fields.images.map((url) => url.trim());
      updateDoc.images = images;
      if ("image" in fields && isValidUrl(fields.image)) {
        updateDoc.image = fields.image.trim();
      } else {
        updateDoc.image = images[0];
      }
    } else if ("image" in fields) {
      if (!isValidUrl(fields.image)) {
        return res.status(400).json({ error: "image must be a valid http(s) URL" });
      }
      updateDoc.image = fields.image.trim();
    }

    if ("price" in fields) {
      const price = Number(fields.price);
      if (Number.isNaN(price)) {
        return res.status(400).json({ error: "price must be a valid number" });
      }
      updateDoc.price = price;
    }

    if ("stock" in fields) {
      const stock = Number(fields.stock);
      if (Number.isNaN(stock)) {
        return res.status(400).json({ error: "stock must be a valid number" });
      }
      updateDoc.stock = stock;
    }

    if ("sizes" in fields) {
      const sizesCheck = normalizeSizes(fields.sizes);
      if (sizesCheck.error) {
        return res.status(400).json({ error: `sizes ${sizesCheck.error}` });
      }
      updateDoc.sizes = sizesCheck.value ?? [];
    }

    // Hierarchy fields are resolved together so a sub-category change without
    // an explicit category still validates against the product's parent.
    if ("category" in fields || "subcategory" in fields) {
      const assignment = await resolveCategoryAssignment({
        category: "category" in fields ? fields.category : existing.category,
        subcategory: "subcategory" in fields ? fields.subcategory : existing.subcategory,
      });
      if (assignment.error) {
        return res.status(400).json({ error: assignment.error });
      }
      updateDoc.category = assignment.value.category;
      updateDoc.subcategory = assignment.value.subcategory;
    }

    const SKIP_FIELDS = ["_id", "image", "images", "price", "stock", "sizes", "category", "subcategory", ...POLICY_FIELDS];
    const EXTRA_WRITABLE_COLUMNS = new Set(["name", "description"]);
    for (const [key, value] of Object.entries(fields)) {
      if (SKIP_FIELDS.includes(key)) continue;
      if (!EXTRA_WRITABLE_COLUMNS.has(key)) continue;
      updateDoc[key] = value;
    }

    for (const field of POLICY_FIELDS) {
      if (field in fields) {
        const check = normalizePolicyField(fields[field]);
        if (check.error) {
          return res.status(400).json({ error: `${field} ${check.error}` });
        }
        updateDoc[field] = check.value;
      }
    }

    if (Object.keys(updateDoc).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    updateDoc.updatedAt = new Date();

    const setParts = [];
    const setParams = [];
    for (const [key, value] of Object.entries(updateDoc)) {
      setParts.push(`\`${key}\` = ?`);
      if (key === "images" || key === "sizes") {
        setParams.push(JSON.stringify(value ?? []));
      } else {
        setParams.push(value === undefined ? null : value);
      }
    }
    // NOTE: don't rely on affectedRows here — MySQL counts only *changed* rows,
    // so saving identical values would wrongly 404. The row was already loaded
    // above; just re-read it after the update.
    await pool.query(
      `UPDATE products SET ${setParts.join(", ")} WHERE \`_id\` = ?`,
      [...setParams, productId],
    );

    const [updatedRows] = await pool.query("SELECT * FROM products WHERE `_id` = ? LIMIT 1", [productId]);
    if (!updatedRows[0]) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.status(200).json(rowToProduct(updatedRows[0]));
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ error: "Failed to update product" });
  }
});

//Delete Product API (admin only)
app.delete("/products/:id", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isHexId(id)) {
      return res.status(400).json({ error: "Invalid product id" });
    }
    const [result] = await pool.query("DELETE FROM products WHERE `_id` = ?", [normalizeHexId(id)]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.status(200).json({ success: true, deletedId: normalizeHexId(id), deletedCount: result.affectedRows });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// ------------------------------------------------------------
// Categories
// ------------------------------------------------------------

// GET /categories (public): full tree with per-level product counts.
const loadCategoryTree = async () => {
  const [categoryRows] = await pool.query("SELECT * FROM categories ORDER BY name ASC");
  const [countRows] = await pool.query(
    `SELECT category, IFNULL(subcategory, '') AS subcategory, COUNT(*) AS count
       FROM products
      GROUP BY category, IFNULL(subcategory, '')`,
  );

  const tree = categoryRows.map((doc) => ({
    _id: doc._id,
    name: doc.name,
    slug: doc.slug,
    image: isValidUrl(doc.image) ? doc.image : null,
    productCount: 0,
    subcategories: parseJSONArray(doc.subcategories)
      .map(normalizeSubcategory)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => ({
        _id: sub._id,
        name: sub.name,
        slug: sub.slug,
        image: sub.image,
        productCount: 0,
      })),
  }));

  const bySlug = new Map(tree.map((entry) => [entry.slug, entry]));
  let unassignedCount = 0;
  for (const row of countRows) {
    const rawCategory = row.category;
    const count = Number(row.count ?? 0);
    if (typeof rawCategory !== "string" || !rawCategory.trim()) {
      unassignedCount += count;
      continue;
    }
    // Products created before categories existed may store a display name
    // rather than a slug, so fall back to slugifying the stored value.
    const parent = bySlug.get(rawCategory) ?? bySlug.get(slugifyCategory(rawCategory));
    if (!parent) {
      unassignedCount += count;
      continue;
    }
    parent.productCount += count;
    const subSlug = slugifyCategory(row.subcategory);
    if (!subSlug) continue;
    const sub = parent.subcategories.find((entry) => entry.slug === subSlug);
    if (sub) {
      sub.productCount += count;
    } else {
      parent.productCount -= count;
      unassignedCount += count;
    }
  }

  return { tree, unassignedCount };
};

const loadCategoryDoc = async (id) => {
  if (!isHexId(id)) return { error: "Invalid category id", status: 400 };
  const [rows] = await pool.query("SELECT * FROM categories WHERE `_id` = ? LIMIT 1", [normalizeHexId(id)]);
  if (!rows[0]) return { error: "Category not found", status: 404 };
  return { doc: rowToCategory(rows[0]) };
};

app.get("/categories", async (req, res) => {
  try {
    const { tree, unassignedCount } = await loadCategoryTree();
    res.status(200).json({ categories: tree, unassignedCount });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

//Create Category API (admin only)
app.post("/categories", verifyToken, requireAdmin, async (req, res) => {
  try {
    const nameCheck = validateCategoryName(req.body?.name);
    if (nameCheck.error) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const imageCheck = validateCategoryImage(req.body?.image);
    if (imageCheck.error) {
      return res.status(400).json({ error: imageCheck.error });
    }
    const { name, slug } = nameCheck.value;
    const [existingRows] = await pool.query("SELECT `_id` FROM categories WHERE slug = ? LIMIT 1", [slug]);
    if (existingRows[0]) {
      return res.status(409).json({ error: `A category named "${name}" already exists` });
    }
    const now = new Date();
    const doc = {
      name,
      slug,
      image: imageCheck.value ?? null,
      subcategories: [],
      createdAt: now,
      updatedAt: now,
    };
    const id = newId();
    await pool.query(
      "INSERT INTO categories (`_id`, name, slug, image, subcategories, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, doc.name, doc.slug, doc.image, JSON.stringify(doc.subcategories), now, now],
    );
    res.status(201).json({ ...doc, _id: id });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: "A category with that name already exists" });
    }
    console.error("Error creating category:", error);
    res.status(500).json({ error: "Failed to create category" });
  }
});

//Update Category API (admin only) — renaming re-slugs products too.
app.patch("/categories/:id", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { doc, error, status } = await loadCategoryDoc(req.params.id);
    if (error) return res.status(status).json({ error });

    const now = new Date();
    const next = {
      name: doc.name,
      slug: doc.slug,
      image: doc.image,
      updatedAt: now,
    };
    let hasField = false;
    let renamedFrom = null;

    if ("name" in (req.body ?? {})) {
      const nameCheck = validateCategoryName(req.body.name);
      if (nameCheck.error) {
        return res.status(400).json({ error: nameCheck.error });
      }
      const { name, slug } = nameCheck.value;
      if (slug !== doc.slug) {
        const [clashRows] = await pool.query(
          "SELECT `_id` FROM categories WHERE slug = ? AND `_id` <> ? LIMIT 1",
          [slug, doc._id],
        );
        if (clashRows[0]) {
          return res.status(409).json({ error: `A category named "${name}" already exists` });
        }
        renamedFrom = doc.slug;
      }
      next.name = name;
      next.slug = slug;
      hasField = true;
    }

    if ("image" in (req.body ?? {})) {
      const imageCheck = validateCategoryImage(req.body.image);
      if (imageCheck.error) {
        return res.status(400).json({ error: imageCheck.error });
      }
      next.image = imageCheck.value;
      hasField = true;
    }

    if (!hasField) {
      return res.status(400).json({ error: "No fields to update" });
    }

    await pool.query(
      "UPDATE categories SET name = ?, slug = ?, image = ?, updatedAt = ? WHERE `_id` = ?",
      [next.name, next.slug, next.image, now, doc._id],
    );
    if (renamedFrom) {
      await pool.query(
        "UPDATE products SET category = ?, updatedAt = ? WHERE category = ?",
        [next.slug, now, renamedFrom],
      );
    }

    const [updatedRows] = await pool.query("SELECT * FROM categories WHERE `_id` = ? LIMIT 1", [doc._id]);
    res.status(200).json(rowToCategory(updatedRows[0]));
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({ error: "A category with that name already exists" });
    }
    console.error("Error updating category:", error);
    res.status(500).json({ error: "Failed to update category" });
  }
});

//Delete Category API (admin only) — blocked while products still use it.
app.delete("/categories/:id", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { doc, error, status } = await loadCategoryDoc(req.params.id);
    if (error) return res.status(status).json({ error });

    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS count FROM products WHERE category = ?",
      [doc.slug],
    );
    const productCount = Number(countRows[0]?.count ?? 0);
    if (productCount > 0) {
      return res.status(400).json({
        error: `Move or delete the ${productCount} product(s) in this category first`,
        productCount,
      });
    }

    await pool.query("DELETE FROM categories WHERE `_id` = ?", [doc._id]);
    res.status(200).json({ success: true, deletedId: doc._id });
  } catch (error) {
    console.error("Error deleting category:", error);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

//Create Sub-category API (admin only)
app.post("/categories/:id/subcategories", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { doc, error, status } = await loadCategoryDoc(req.params.id);
    if (error) return res.status(status).json({ error });

    const nameCheck = validateCategoryName(req.body?.name);
    if (nameCheck.error) {
      return res.status(400).json({ error: nameCheck.error });
    }
    const imageCheck = validateCategoryImage(req.body?.image);
    if (imageCheck.error) {
      return res.status(400).json({ error: imageCheck.error });
    }
    const { name, slug } = nameCheck.value;
    if (findSubcategory(doc, slug)) {
      return res.status(409).json({
        error: `"${name}" already exists in ${doc.name}`,
      });
    }

    const sub = normalizeSubcategory({ name, slug, image: imageCheck.value ?? null });
    const subcategories = [...doc.subcategories, sub];
    await pool.query(
      "UPDATE categories SET subcategories = ?, updatedAt = ? WHERE `_id` = ?",
      [JSON.stringify(subcategories), new Date(), doc._id],
    );
    res.status(201).json(sub);
  } catch (error) {
    console.error("Error creating sub-category:", error);
    res.status(500).json({ error: "Failed to create sub-category" });
  }
});

//Update Sub-category API (admin only)
app.patch("/categories/:id/subcategories/:subId", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { doc, error, status } = await loadCategoryDoc(req.params.id);
    if (error) return res.status(status).json({ error });

    const { subId } = req.params;
    if (!isHexId(subId)) {
      return res.status(400).json({ error: "Invalid sub-category id" });
    }
    const targetId = normalizeHexId(subId);
    const current = findSubcategory(doc, targetId);
    if (!current) {
      return res.status(404).json({ error: "Sub-category not found" });
    }

    const next = { ...current };
    let hasField = false;
    let renamedFrom = null;
    let renamedTo = null;

    if ("name" in (req.body ?? {})) {
      const nameCheck = validateCategoryName(req.body.name);
      if (nameCheck.error) {
        return res.status(400).json({ error: nameCheck.error });
      }
      const { name, slug } = nameCheck.value;
      const clash = findSubcategory(doc, slug);
      if (clash && String(clash._id) !== String(current._id)) {
        return res.status(409).json({ error: `"${name}" already exists in ${doc.name}` });
      }
      if (slug !== current.slug) {
        renamedFrom = current.slug;
        renamedTo = slug;
      }
      next.name = name;
      next.slug = slug;
      hasField = true;
    }

    if ("image" in (req.body ?? {})) {
      const imageCheck = validateCategoryImage(req.body.image);
      if (imageCheck.error) {
        return res.status(400).json({ error: imageCheck.error });
      }
      next.image = imageCheck.value;
      hasField = true;
    }

    if (!hasField) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const now = new Date();
    next.updatedAt = now;
    const subcategories = doc.subcategories.map((entry) =>
      String(entry?._id) === String(current._id) ? next : entry,
    );
    await pool.query(
      "UPDATE categories SET subcategories = ?, updatedAt = ? WHERE `_id` = ?",
      [JSON.stringify(subcategories), now, doc._id],
    );
    if (renamedFrom) {
      await pool.query(
        "UPDATE products SET subcategory = ?, updatedAt = ? WHERE category = ? AND subcategory = ?",
        [renamedTo, now, doc.slug, renamedFrom],
      );
    }

    const [updatedRows] = await pool.query("SELECT * FROM categories WHERE `_id` = ? LIMIT 1", [doc._id]);
    res.status(200).json(findSubcategory(rowToCategory(updatedRows[0]), targetId));
  } catch (error) {
    console.error("Error updating sub-category:", error);
    res.status(500).json({ error: "Failed to update sub-category" });
  }
});

//Delete Sub-category API (admin only)
app.delete("/categories/:id/subcategories/:subId", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { doc, error, status } = await loadCategoryDoc(req.params.id);
    if (error) return res.status(status).json({ error });

    const { subId } = req.params;
    if (!isHexId(subId)) {
      return res.status(400).json({ error: "Invalid sub-category id" });
    }
    const targetId = normalizeHexId(subId);
    const current = findSubcategory(doc, targetId);
    if (!current) {
      return res.status(404).json({ error: "Sub-category not found" });
    }

    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS count FROM products WHERE category = ? AND subcategory = ?",
      [doc.slug, current.slug],
    );
    const productCount = Number(countRows[0]?.count ?? 0);
    if (productCount > 0) {
      return res.status(400).json({
        error: `Move or delete the ${productCount} product(s) in this sub-category first`,
        productCount,
      });
    }

    const subcategories = doc.subcategories.filter(
      (entry) => String(entry?._id) !== String(current._id),
    );
    await pool.query(
      "UPDATE categories SET subcategories = ?, updatedAt = ? WHERE `_id` = ?",
      [JSON.stringify(subcategories), new Date(), doc._id],
    );
    res.status(200).json({ success: true, deletedId: targetId });
  } catch (error) {
    console.error("Error deleting sub-category:", error);
    res.status(500).json({ error: "Failed to delete sub-category" });
  }
});

// ------------------------------------------------------------
// Orders
// ------------------------------------------------------------

//Create Order API (public for guest COD; links to account when JWT present)
app.post("/orders", optionalAuth, async (req, res) => {
  const { error, value } = validateOrder(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  // Strict ownership: an authenticated customer may only create orders for themselves.
  if (req.user && req.user.role !== "admin") {
    if (value.userId && value.userId !== req.user.userId) {
      return res.status(403).json({ error: "Forbidden: userId does not match session" });
    }
    // Link authenticated orders to the account even if client omitted userId
    if (!value.userId) value.userId = req.user.userId;
  }
  // Guests cannot attach orders to an arbitrary account id.
  if (!req.user) {
    value.userId = null;
  }

  try {
    const objectIds = value.items.map((item) => normalizeHexId(item.productId));
    const placeholders = objectIds.map(() => "?").join(", ");
    const [productRows] = await pool.query(
      `SELECT * FROM products WHERE \`_id\` IN (${placeholders})`,
      objectIds,
    );
    const productById = new Map(productRows.map((row) => [row._id, rowToProduct(row)]));

    for (const item of value.items) {
      const product = productById.get(normalizeHexId(item.productId));
      if (!product) {
        return res.status(404).json({ error: `Product not found: ${item.productId}` });
      }
      // Products with a size list require one of those sizes per item.
      const productSizes = Array.isArray(product.sizes) ? product.sizes.filter(Boolean) : [];
      if (productSizes.length > 0) {
        if (!item.size) {
          return res.status(400).json({ error: `size is required for product: ${item.productId}` });
        }
        if (!productSizes.includes(item.size)) {
          return res.status(400).json({ error: `size "${item.size}" is not available for product: ${item.productId}` });
        }
      } else {
        item.size = "";
      }
      const stock = Number(product.stock);
      if (!Number.isFinite(stock) || stock < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for product: ${item.productId}` });
      }
    }

    const orderItems = value.items.map((item) => {
      const product = productById.get(normalizeHexId(item.productId));
      const unitPrice = Number(product.price);
      return {
        productId: normalizeHexId(item.productId),
        title: product.name || "",
        image: product.image || "",
        unitPrice,
        quantity: item.quantity,
        size: item.size || "",
        subtotal: unitPrice * item.quantity,
      };
    });

    const subtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const totalAmount = subtotal + value.deliveryCharge;
    const now = new Date();
    const orderId = newId();

    await withTransaction(async (conn) => {
      await conn.query(
        `INSERT INTO orders
          (\`_id\`, userId, customerName, customerPhone, customerAddress, items,
           itemCount, subtotal, deliveryCharge, totalAmount, totalOverridden,
           paymentMethod, orderStatus, note, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          value.userId,
          value.customer.name,
          value.customer.phone,
          value.customer.address,
          JSON.stringify(orderItems),
          orderItems.reduce((sum, item) => sum + item.quantity, 0),
          subtotal,
          value.deliveryCharge,
          totalAmount,
          0,
          "cod",
          "pending",
          value.note,
          now,
          now,
        ],
      );

      for (const item of value.items) {
        const [stockResult] = await conn.query(
          "UPDATE products SET stock = stock - ?, updatedAt = ? WHERE `_id` = ? AND stock >= ?",
          [item.quantity, now, normalizeHexId(item.productId), item.quantity],
        );
        if (stockResult.affectedRows === 0) {
          throw new Error(`Insufficient stock for product: ${item.productId}`);
        }
      }
    });

    const [orderRows] = await pool.query("SELECT * FROM orders WHERE `_id` = ? LIMIT 1", [orderId]);
    res.status(201).json(rowToOrder(orderRows[0]));
  } catch (error) {
    if (error.message && error.message.startsWith("Insufficient stock")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("Error creating order:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

//Get Orders API (JWT required; admin sees all, customer sees own userId only)
app.get("/orders", verifyToken, async (req, res) => {
  try {
    // Every clause carries its own params so buildWhere() can join them and
    // flatten the params in the same order.
    const clauses = [];
    if (req.query.phone) {
      // Phone filtering is admin-only; customers must scope by their own userId
      if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }
      clauses.push({ sql: "customerPhone = ?", params: [String(req.query.phone).trim()] });
    }
    if (req.query.userId) {
      const userId = normalizeUserId(req.query.userId);
      if (!userId) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      if (req.user.role !== "admin" && userId !== req.user.userId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      clauses.push({ sql: "userId = ?", params: [userId] });
    } else if (req.user.role !== "admin") {
      // Customers must always scope by userId; bare /orders is admin-only
      return res.status(403).json({ error: "Forbidden: userId query required" });
    }
    const rawStatus = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    if (rawStatus && rawStatus !== "all") {
      if (!ORDER_STATUSES.includes(rawStatus)) {
        return res.status(400).json({ error: `status must be one of: all, ${ORDER_STATUSES.join(", ")}` });
      }
      clauses.push({ sql: "orderStatus = ?", params: [rawStatus] });
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const like = `%${escapeLike(q)}%`;
      const ors = [
        "customerName LIKE ? ESCAPE '\\\\'",
        "customerPhone LIKE ? ESCAPE '\\\\'",
        "customerAddress LIKE ? ESCAPE '\\\\'",
      ];
      const qParams = [like, like, like];
      if (isHexId(q)) {
        ors.push("`_id` = ?");
        qParams.push(normalizeHexId(q));
      }
      clauses.push({ sql: `(${ors.join(" OR ")})`, params: qParams });
    }
    // Single-day filter: ?date=YYYY-MM-DD (Asia/Dhaka business day)
    const rawDate = typeof req.query.date === "string" ? req.query.date.trim() : "";
    if (rawDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      const dateParts = rawDate.split("-").map(Number);
      const start = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], -6, 0, 0, 0));
      if (Number.isNaN(start.getTime())) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD" });
      }
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      clauses.push({ sql: "createdAt >= ?", params: [start] });
      clauses.push({ sql: "createdAt < ?", params: [end] });
    }
    const where = buildWhere(clauses);

    const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
    if (!wantsPagination) {
      const [rows] = await pool.query(
        `SELECT * FROM orders ${where.sql} ORDER BY createdAt DESC`,
        where.params,
      );
      return res.status(200).json(rows.map(rowToOrder));
    }
    let page = Number.parseInt(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page, 10);
    let limit = Number.parseInt(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 10;
    limit = Math.min(limit, 100);

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM orders ${where.sql}`,
      where.params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    if (page > totalPages) page = totalPages;

    const [rows] = await pool.query(
      `SELECT * FROM orders ${where.sql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      [...where.params, limit, (page - 1) * limit],
    );

    const pendingWhere = buildWhere([...clauses, { sql: "orderStatus = ?", params: ["pending"] }]);
    const deliveredWhere = buildWhere([...clauses, { sql: "orderStatus = ?", params: ["delivered"] }]);
    const [[pendingRows], [revenueRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM orders ${pendingWhere.sql}`, pendingWhere.params),
      pool.query(
        `SELECT COALESCE(SUM(totalAmount), 0) AS revenue FROM orders ${deliveredWhere.sql}`,
        deliveredWhere.params,
      ),
    ]);
    return res.status(200).json({
      orders: rows.map(rowToOrder),
      total,
      page,
      limit,
      totalPages,
      pendingCount: Number(pendingRows[0]?.count ?? 0),
      deliveredRevenue: Number(revenueRows[0]?.revenue ?? 0),
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

//Bulk assign category API (admin only)
app.patch("/products/category/bulk", verifyToken, requireAdmin, async (req, res) => {
  try {
    const rawIds = req.body?.productIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return res.status(400).json({ error: "productIds must be a non-empty array" });
    }
    if (rawIds.length > 500) {
      return res.status(400).json({ error: "at most 500 products can be updated at once" });
    }
    const ids = [];
    for (const entry of rawIds) {
      const id = typeof entry === "string" ? entry.trim() : "";
      if (!isHexId(id)) {
        return res.status(400).json({ error: `invalid productId: ${entry}` });
      }
      ids.push(normalizeHexId(id));
    }

    const assignment = await resolveCategoryAssignment(req.body);
    if (assignment.error) {
      return res.status(400).json({ error: assignment.error });
    }
    const { category, subcategory } = assignment.value;

    const placeholders = ids.map(() => "?").join(", ");
    const [[matchedRows], [result]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM products WHERE \`_id\` IN (${placeholders})`, ids),
      pool.query(
        `UPDATE products SET category = ?, subcategory = ?, updatedAt = ? WHERE \`_id\` IN (${placeholders})`,
        [category, subcategory, new Date(), ...ids],
      ),
    ]);
    res.status(200).json({
      success: true,
      matchedCount: Number(matchedRows[0]?.count ?? 0),
      modifiedCount: result.affectedRows,
      category,
      subcategory,
    });
  } catch (error) {
    console.error("Error bulk assigning category:", error);
    res.status(500).json({ error: "Failed to update products" });
  }
});

//Update Order API (admin full access; customers may only cancel their own pending orders)
app.patch("/orders/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isHexId(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const orderId = normalizeHexId(id);
    const { error, value } = validateOrderPatch(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    const [existingRows] = await pool.query("SELECT * FROM orders WHERE `_id` = ? LIMIT 1", [orderId]);
    if (!existingRows[0]) {
      return res.status(404).json({ error: "Order not found" });
    }
    const existing = rowToOrder(existingRows[0]);

    if (req.user.role !== "admin") {
      const isOwner = String(existing.userId ?? "") !== "" && String(existing.userId) === req.user.userId;
      if (!isOwner) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const keys = Object.keys(value);
      const isSelfCancel = keys.length === 1 && value.orderStatus === "cancelled";
      if (!isSelfCancel) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (existing.orderStatus !== "pending") {
        return res.status(400).json({ error: "Only pending orders can be cancelled" });
      }
    }

    if (existing.orderStatus === "delivered" && value.orderStatus === "cancelled") {
      return res.status(400).json({ error: "Delivered order cannot be cancelled" });
    }

    const newStatus = value.orderStatus || existing.orderStatus;
    const newDeliveryCharge = ("deliveryCharge" in value) ? value.deliveryCharge : existing.deliveryCharge;
    const newCustomer = ("customer" in value) ? { ...existing.customer, ...value.customer } : existing.customer;
    const newNote = ("note" in value) ? value.note : (existing.note || "");

    //keep old unitPrice, new products use DB price
    let finalItems = existing.items;
    if ("items" in value) {
      const oldMap = new Map((existing.items || []).map((it) => [
        String(it.productId ?? ""),
        { quantity: it.quantity, unitPrice: it.unitPrice, title: it.title, image: it.image, size: it.size || "" },
      ]));
      const newIds = value.items.map((it) => normalizeHexId(it.productId));
      const newPlaceholders = newIds.map(() => "?").join(", ");
      const [productRows] = await pool.query(
        `SELECT * FROM products WHERE \`_id\` IN (${newPlaceholders})`,
        newIds,
      );
      const productById = new Map(productRows.map((row) => [row._id, rowToProduct(row)]));

      for (const it of value.items) {
        const pid = normalizeHexId(it.productId);
        if (!oldMap.has(pid) && !productById.has(pid)) {
          return res.status(404).json({ error: `Product not found: ${it.productId}` });
        }
      }

      finalItems = value.items.map((it) => {
        const pid = normalizeHexId(it.productId);
        if (oldMap.has(pid)) {
          const old = oldMap.get(pid);
          return {
            productId: pid,
            title: old.title || "",
            image: old.image || "",
            unitPrice: old.unitPrice,
            quantity: it.quantity,
            size: it.size || old.size || "",
            subtotal: old.unitPrice * it.quantity,
          };
        }
        const product = productById.get(pid);
        const unitPrice = Number(product.price);
        return {
          productId: pid,
          title: product.name || "",
          image: product.image || "",
          unitPrice,
          quantity: it.quantity,
          size: it.size || "",
          subtotal: unitPrice * it.quantity,
        };
      });
    }

    const subtotal = finalItems.reduce((sum, it) => sum + it.subtotal, 0);
    const itemCount = finalItems.reduce((sum, it) => sum + it.quantity, 0);
    const calculatedTotal = subtotal + newDeliveryCharge;
    // Admins may override the order total (e.g. a negotiated price). When the
    // patch omits totalAmount, an existing override is preserved so status-only
    // updates never wipe it.
    let totalAmount = calculatedTotal;
    let totalOverridden = false;
    if ("totalAmount" in value) {
      totalAmount = value.totalAmount;
      totalOverridden = Math.abs(totalAmount - calculatedTotal) > 0.009;
    } else if (existing.totalOverridden) {
      totalAmount = Number(existing.totalAmount ?? calculatedTotal);
      totalOverridden = true;
    }

    // Stock adjustments
    const oldQty = new Map((existing.items || []).map((it) => [String(it.productId ?? ""), it.quantity]));
    const newQty = new Map(finalItems.map((it) => [String(it.productId ?? ""), it.quantity]));
    const isCancelling = existing.orderStatus !== "cancelled" && newStatus === "cancelled";
    const isReopening = existing.orderStatus === "cancelled" && newStatus !== "cancelled";

    const deltas = new Map();
    // A cancelled order keeps its stock restored; editing its items while it
    // stays cancelled must not move stock. Reopening/cancelling is handled above.
    const staysCancelled = existing.orderStatus === "cancelled" && newStatus === "cancelled";
    if ("items" in value && !isCancelling && !isReopening && !staysCancelled) {
      const allIds = new Set([...oldQty.keys(), ...newQty.keys()]);
      for (const pid of allIds) {
        const d = (newQty.get(pid) || 0) - (oldQty.get(pid) || 0);
        if (d !== 0) deltas.set(pid, d);
      }
    }

    const now = new Date();
    await withTransaction(async (conn) => {
      if (!isCancelling) {
        const needCheck = isReopening
          ? [...newQty.entries()]
          : [...deltas.entries()].filter(([, d]) => d > 0);
        for (const [pid, need] of needCheck) {
          const [rows] = await conn.query("SELECT stock FROM products WHERE `_id` = ? FOR UPDATE", [pid]);
          if (!rows[0]) throw new Error(`Product not found: ${pid}`);
          if (!Number.isFinite(Number(rows[0].stock)) || Number(rows[0].stock) < need) {
            throw new Error(`Insufficient stock for product: ${pid}`);
          }
        }
      }

      await conn.query(
        `UPDATE orders SET
           customerName = ?, customerPhone = ?, customerAddress = ?, items = ?,
           itemCount = ?, subtotal = ?, deliveryCharge = ?, totalAmount = ?,
           totalOverridden = ?, orderStatus = ?, note = ?, updatedAt = ?
         WHERE \`_id\` = ?`,
        [
          newCustomer.name,
          newCustomer.phone,
          newCustomer.address,
          JSON.stringify(finalItems),
          itemCount,
          subtotal,
          newDeliveryCharge,
          totalAmount,
          totalOverridden ? 1 : 0,
          newStatus,
          newNote,
          now,
          orderId,
        ],
      );

      if (isCancelling) {
        for (const [pid, qty] of oldQty.entries()) {
          await conn.query(
            "UPDATE products SET stock = stock + ?, updatedAt = ? WHERE `_id` = ?",
            [qty, now, pid],
          );
        }
      } else if (isReopening) {
        for (const [pid, qty] of newQty.entries()) {
          const [r] = await conn.query(
            "UPDATE products SET stock = stock - ?, updatedAt = ? WHERE `_id` = ? AND stock >= ?",
            [qty, now, pid, qty],
          );
          if (r.affectedRows === 0) throw new Error(`Insufficient stock for product: ${pid}`);
        }
      } else {
        for (const [pid, d] of deltas.entries()) {
          if (d > 0) {
            const [r] = await conn.query(
              "UPDATE products SET stock = stock - ?, updatedAt = ? WHERE `_id` = ? AND stock >= ?",
              [d, now, pid, d],
            );
            if (r.affectedRows === 0) throw new Error(`Insufficient stock for product: ${pid}`);
          } else {
            await conn.query(
              "UPDATE products SET stock = stock + ?, updatedAt = ? WHERE `_id` = ?",
              [-d, now, pid],
            );
          }
        }
      }
    });

    const [updatedRows] = await pool.query("SELECT * FROM orders WHERE `_id` = ? LIMIT 1", [orderId]);
    res.status(200).json(rowToOrder(updatedRows[0]));
  } catch (err) {
    if (err.message && (err.message.startsWith("Insufficient stock") || err.message.startsWith("Product not found"))) {
      const code = err.message.startsWith("Product not found") ? 404 : 400;
      return res.status(code).json({ error: err.message });
    }
    console.error("Error updating order:", err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

//Order Details API (JWT required; admin or order owner)
app.get("/orders/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isHexId(id)) {
      return res.status(400).json({ error: "Invalid order id" });
    }
    const [rows] = await pool.query("SELECT * FROM orders WHERE `_id` = ? LIMIT 1", [normalizeHexId(id)]);
    if (!rows[0]) {
      return res.status(404).json({ error: "Order not found" });
    }
    const order = rowToOrder(rows[0]);
    if (req.user.role !== "admin" && String(order.userId ?? "") !== req.user.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.status(200).json(order);
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

// ------------------------------------------------------------
// Wishlists (JWT required; owner or admin)
// ------------------------------------------------------------

const loadWishlistIds = async (userId) => {
  const [rows] = await pool.query(
    "SELECT productIds FROM wishlists WHERE userId = ? LIMIT 1",
    [userId],
  );
  if (!rows[0]) return [];
  return parseJSONArray(rows[0].productIds).map((entry) => String(entry));
};

const saveWishlistIds = async (userId, productIds) => {
  const now = new Date();
  await pool.query(
    `INSERT INTO wishlists (\`_id\`, userId, productIds, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE productIds = VALUES(productIds), updatedAt = VALUES(updatedAt)`,
    [newId(), userId, JSON.stringify(productIds), now, now],
  );
};

app.get("/wishlist/:userId", verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const productIds = await loadWishlistIds(userId);
    res.status(200).json({ userId, productIds });
  } catch (error) {
    console.error("Error fetching wishlist:", error);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

app.post("/wishlist/:userId/toggle", verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const productId = typeof req.body?.productId === "string" ? req.body.productId.trim() : "";
    if (!isHexId(productId)) {
      return res.status(400).json({ error: `invalid productId: ${req.body?.productId}` });
    }
    const normalizedProductId = normalizeHexId(productId);
    const [productRows] = await pool.query("SELECT `_id` FROM products WHERE `_id` = ? LIMIT 1", [normalizedProductId]);
    if (!productRows[0]) {
      return res.status(404).json({ error: `Product not found: ${normalizedProductId}` });
    }
    const current = await loadWishlistIds(userId);
    if (current.includes(normalizedProductId)) {
      const next = current.filter((id) => id !== normalizedProductId);
      await saveWishlistIds(userId, next);
      return res.status(200).json({ userId, productIds: next, wishlisted: false });
    }
    if (current.length >= MAX_WISHLIST_ITEMS) {
      return res.status(400).json({ error: `wishlist can hold at most ${MAX_WISHLIST_ITEMS} items` });
    }
    const next = [...current, normalizedProductId];
    await saveWishlistIds(userId, next);
    res.status(200).json({ userId, productIds: next, wishlisted: true });
  } catch (error) {
    console.error("Error toggling wishlist:", error);
    res.status(500).json({ error: "Failed to update wishlist" });
  }
});

app.delete("/wishlist/:userId/:productId", verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const productId = typeof req.params.productId === "string" ? req.params.productId.trim() : "";
    if (!userId) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    if (!isHexId(productId)) {
      return res.status(400).json({ error: `invalid productId: ${req.params.productId}` });
    }
    const normalizedProductId = normalizeHexId(productId);
    const current = await loadWishlistIds(userId);
    const next = current.filter((id) => id !== normalizedProductId);
    await saveWishlistIds(userId, next);
    res.status(200).json({ userId, productIds: next, wishlisted: false });
  } catch (error) {
    console.error("Error removing wishlist item:", error);
    res.status(500).json({ error: "Failed to update wishlist" });
  }
});

app.delete("/wishlist/:userId", verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    await pool.query("DELETE FROM wishlists WHERE userId = ?", [userId]);
    res.status(200).json({ userId, productIds: [], wishlisted: false });
  } catch (error) {
    console.error("Error clearing wishlist:", error);
    res.status(500).json({ error: "Failed to clear wishlist" });
  }
});

app.put("/wishlist/:userId", verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: "Invalid user id" });
    }
    const { error, value } = validateWishlistIds(req.body?.productIds);
    if (error) {
      return res.status(400).json({ error });
    }
    await saveWishlistIds(userId, value);
    res.status(200).json({ userId, productIds: value });
  } catch (error) {
    console.error("Error saving wishlist:", error);
    res.status(500).json({ error: "Failed to save wishlist" });
  }
});

// ------------------------------------------------------------
// Admin maintenance endpoints
// ------------------------------------------------------------

app.post("/admin/backfill-order-userIds", verifyToken, requireAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, phone FROM `user` WHERE phone IS NOT NULL AND phone <> ''",
    );
    let matchedUsers = 0;
    let modifiedOrders = 0;
    for (const user of users) {
      const userId = String(user.id ?? "");
      const rawPhone = typeof user.phone === "string" ? user.phone : "";
      const candidates = [...new Set([rawPhone, rawPhone.trim()].filter(Boolean))];
      if (!userId || candidates.length === 0) continue;
      const placeholders = candidates.map(() => "?").join(", ");
      const [result] = await pool.query(
        `UPDATE orders SET userId = ? WHERE userId IS NULL AND customerPhone IN (${placeholders})`,
        [userId, ...candidates],
      );
      if (result.affectedRows > 0) matchedUsers += 1;
      modifiedOrders += result.affectedRows || 0;
    }
    res.status(200).json({ success: true, matchedUsers, modifiedOrders });
  } catch (error) {
    console.error("Error backfilling order userIds:", error);
    res.status(500).json({ error: "Failed to backfill order userIds" });
  }
});

// Starter taxonomy. Admin can edit or extend all of it afterwards.
const STARTER_CATEGORIES = [
  { name: "Swing Chair", subcategories: ["Hanging Swing Chair", "Swing Chair with Stand", "Baby Swing Chair"] },
  { name: "Furniture", subcategories: ["Chair Table Set", "Tea Table", "Mirror", "Dressing Table"] },
  { name: "Women's", subcategories: ["Sarees", "3 Piece", "Kurti", "Jewellery", "Cosmetics"] },
  { name: "Others", subcategories: [] },
];

//Seed starter categories (admin only, idempotent — never overwrites)
app.post("/admin/seed-categories", verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const created = [];
    const skipped = [];
    for (const entry of STARTER_CATEGORIES) {
      const slug = slugifyCategory(entry.name);
      const [existingRows] = await pool.query("SELECT `_id` FROM categories WHERE slug = ? LIMIT 1", [slug]);
      if (existingRows[0]) {
        skipped.push(slug);
        continue;
      }
      const subcategories = entry.subcategories.map((subName) => normalizeSubcategory({
        name: subName,
        slug: slugifyCategory(subName),
        image: null,
      }));
      await pool.query(
        "INSERT INTO categories (`_id`, name, slug, image, subcategories, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [newId(), entry.name, slug, null, JSON.stringify(subcategories), now, now],
      );
      created.push(slug);
    }
    res.status(200).json({ success: true, created, skipped });
  } catch (error) {
    console.error("Error seeding categories:", error);
    res.status(500).json({ error: "Failed to seed categories" });
  }
});

//Migrate legacy free-text product categories onto slugs (admin only, idempotent)
app.post("/admin/migrate-product-categories", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { tree } = await loadCategoryTree();
    const bySlug = new Map(tree.map((entry) => [entry.slug, entry]));
    const [rows] = await pool.query("SELECT * FROM products");
    let updatedProducts = 0;
    const unmapped = new Map();
    for (const row of rows) {
      const product = rowToProduct(row);
      const parentSlug = slugifyCategory(product?.category);
      const parent = bySlug.get(parentSlug);
      if (!parent) {
        const key = String(product?.category ?? "(none)");
        unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
        continue;
      }
      const subSlug = slugifyCategory(product?.subcategory);
      const sub = parent.subcategories.find((entry) => entry.slug === subSlug);
      const nextCategory = parent.slug;
      const nextSub = sub ? sub.slug : "";
      if (product.category === nextCategory && String(product.subcategory ?? "") === nextSub) continue;
      await pool.query(
        "UPDATE products SET category = ?, subcategory = ?, updatedAt = ? WHERE `_id` = ?",
        [nextCategory, nextSub, new Date(), product._id],
      );
      updatedProducts += 1;
    }
    res.status(200).json({
      success: true,
      updatedProducts,
      unmapped: [...unmapped.entries()].map(([category, count]) => ({ category, count })),
    });
  } catch (error) {
    console.error("Error migrating product categories:", error);
    res.status(500).json({ error: "Failed to migrate product categories" });
  }
});

// ------------------------------------------------------------
// Image upload (admin only) — replaces imgbb
// ------------------------------------------------------------

app.post("/upload", verifyToken, requireAdmin, (req, res) => {
  uploadMiddleware.single("image")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: `image must be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB` });
        }
        return res.status(400).json({ error: `upload failed: ${err.code}` });
      }
      return res.status(400).json({ error: err.message || "upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "image file is required" });
    }
    return res.status(201).json({ url: `${mediaBaseUrl(req)}/uploads/${req.file.filename}` });
  });
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Belaview API listening on port ${port}`);
});

module.exports = app;
