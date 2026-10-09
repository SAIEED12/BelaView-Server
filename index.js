const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);


const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();
const { MongoClient, ServerApiVersion, ObjectId  } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const uri = process.env.MONGODB_URI;
const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.port || 5000;

const MAX_IMAGES = 4;
const DEFAULT_DELIVERY_CHARGE = 60;
const ORDER_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];
const FINAL_ORDER_STATUSES = ["delivered", "cancelled"];

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

// Sub-categories 
const normalizeSubcategory = (sub) => {
  const name = typeof sub?.name === "string" ? sub.name.trim() : "";
  return {
    _id: sub?._id ?? new ObjectId(),
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

const isDuplicateKeyError = (error) => error?.code === 11000;


const resolveCategoryAssignment = async (raw) => {
  const parentInput = typeof raw?.category === "string" ? raw.category.trim() : "";
  const subInput = typeof raw?.subcategory === "string" ? raw.subcategory.trim() : "";
  if (!parentInput) return { error: "category is required" };

  const parentSlug = slugifyCategory(parentInput);
  const subSlug = slugifyCategory(subInput);
  if (!parentSlug) return { error: "category must contain letters or numbers" };

  const categories = await categoriesCollection.find({}).toArray();
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
    if (!ObjectId.isValid(productId)) {
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
    items.push({ productId, quantity });
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

  const IMMUTABLE = ["_id", "userId", "paymentMethod", "totalAmount", "subtotal", "itemCount", "createdAt"];
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
      if (!ObjectId.isValid(productId)) {
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
      items.push({ productId, quantity });
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
    if (!ObjectId.isValid(productId)) {
      return { error: `invalid productId: ${entry}` };
    }
    if (seen.has(productId)) continue;
    seen.add(productId);
    clean.push(productId);
  }
  return { value: clean };
};

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token || token === "null" || token === "undefined") return null;
  return token;
};

const normalizeAuthUser = (payload) => {
  const userId = String(payload?.id ?? payload?.sub ?? "").trim();
  if (!userId) return null;
  return {
    userId,
    role: typeof payload?.role === "string" && payload.role ? payload.role : "customer",
    email: typeof payload?.email === "string" ? payload.email : "",
  };
};

const verifyToken = async (req, res, next) => {
  const token = getBearerToken(req);
  if(!token) {
     return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try{
    const {payload} = await jwtVerify(token, JWKS, {
      issuer: process.env.CLIENT_URL,
      audience: process.env.CLIENT_URL,
    })
    const user = normalizeAuthUser(payload);
    if (!user) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    req.user = user;
    req.auth = user;
    return next();
  }
  catch(err){
    console.error("JWT verify failed:", err?.message || err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Optional auth: attaches req.user when a valid JWT is present, otherwise continues as guest.
// Used for public endpoints (e.g. POST /orders guest COD checkout).
const optionalAuth = async (req, _res, next) => {
  const token = getBearerToken(req);
  if (!token) return next();
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: process.env.CLIENT_URL,
      audience: process.env.CLIENT_URL,
    });
    const user = normalizeAuthUser(payload);
    if (user) {
      req.user = user;
      req.auth = user;
    }
  } catch {
    // ignore invalid token on optional route — treated as guest
  }
  return next();
};

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

// async function run() {
//   try {
    // await client.connect();

    const db = client.db("dolna_db");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");
    const wishlistsCollection = db.collection("wishlists");
    const categoriesCollection = db.collection("categories");
    client.connect()
      .then(() => Promise.all([
        wishlistsCollection.createIndex({ userId: 1 }, { unique: true }),
        ordersCollection.createIndex({ userId: 1 }),
        categoriesCollection.createIndex({ slug: 1 }, { unique: true }),
        productsCollection.createIndex({ category: 1, subcategory: 1 }),
      ]))
      .catch(console.dir);

    //Add Products API
    app.post('/add-products', verifyToken, async (req, res) => {
      try {
        const product = req.body;
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

        const result = await productsCollection.insertOne({
          ...product,
          ...policies,
          category,
          subcategory,
          image,
          images,
          price: Number(product.price),
          stock: Number(product.stock),
        });
        res.status(201).json(result);
      } catch (error) {
        console.error("Error adding product:", error);
        res.status(500).json({ error: "Failed to add product" });
      }
    });


    //Get Products API
    const PRODUCT_SORTS = {
      "newest": { _id: -1 },
      "price-asc": { price: 1, _id: -1 },
      "price-desc": { price: -1, _id: -1 },
      "name": { name: 1, _id: -1 },
    };
    // Values are stored as slugs, but products created before categories existed
    // hold display names. Match the exact value plus a separator-insensitive
    // pattern so those legacy rows stay reachable without a migration.
    const looseValuePattern = (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return null;
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped.replace(/[-\s_]+/g, "[-\\s_]*")}$`, "i");
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
    const matchList = (field, values) => {
      const clauses = values.map((value) => ({ [field]: value }));
      for (const value of values) {
        const pattern = looseValuePattern(value);
        if (pattern) clauses.push({ [field]: pattern });
      }
      return clauses.length === 1 ? clauses[0] : { $or: clauses };
    };
    const parseProductFilter = (req) => {
      const searchText = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const baseAnd = [];
      if (searchText) {
        const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        baseAnd.push({
          $or: [
            { name: { $regex: escaped, $options: "i" } },
            { category: { $regex: escaped, $options: "i" } },
            { subcategory: { $regex: escaped, $options: "i" } },
            {
              $expr: {
                $regexMatch: {
                  input: { $toString: "$price" },
                  regex: escaped,
                  options: "i",
                },
              },
            },
          ],
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
      const priceCond = {};
      if (minPrice !== null) priceCond.$gte = minPrice;
      if (maxPrice !== null) priceCond.$lte = maxPrice;
      if (Object.keys(priceCond).length > 0) baseAnd.push({ price: priceCond });
      const inStock = String(Array.isArray(req.query.inStock) ? req.query.inStock[0] : (req.query.inStock ?? "")).toLowerCase() === "true";
      if (inStock) baseAnd.push({ stock: { $gt: 0 } });
      const rawSort = String(Array.isArray(req.query.sort) ? req.query.sort[0] : (req.query.sort ?? "")).trim().toLowerCase();
      const sortKey = PRODUCT_SORTS[rawSort] ? rawSort : "newest";
      const andAll = (clauses) => {
        if (clauses.length === 0) return {};
        if (clauses.length === 1) return clauses[0];
        return { $and: clauses };
      };
      return {
        searchText,
        categories,
        subcategories,
        minPrice,
        maxPrice,
        inStock,
        sortKey,
        sort: PRODUCT_SORTS[sortKey],
        query: andAll([
          ...baseAnd,
          ...(categories.length > 0 ? [matchList("category", categories)] : []),
          ...(subcategories.length > 0 ? [matchList("subcategory", subcategories)] : []),
        ]),
        facetQuery: andAll(baseAnd),
      };
    };
    app.get('/products', async (req, res) => {
      try {
        const { query, facetQuery, sortKey, sort, categories, subcategories, minPrice, maxPrice, inStock } = parseProductFilter(req);
        const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
        if (!wantsPagination) {
          const products = await productsCollection.find(query).sort(sort).toArray();
          return res.status(200).json(products);
        }
        let page = Number.parseInt(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page, 10);
        let limit = Number.parseInt(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit, 10);
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(limit) || limit < 1) limit = 20;
        limit = Math.min(limit, 100);
        const [total, facetResult, categoryDocs] = await Promise.all([
          productsCollection.countDocuments(query),
          productsCollection.aggregate([
            { $match: facetQuery },
            {
              $facet: {
                categories: [
                  {
                    $group: {
                      _id: { category: "$category", subcategory: { $ifNull: ["$subcategory", ""] } },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1 } },
                ],
                priceBounds: [
                  { $group: { _id: null, min: { $min: "$price" }, max: { $max: "$price" } } },
                ],
              },
            },
          ]).toArray(),
          categoriesCollection.find({}).toArray(),
        ]);
        const totalPages = Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) page = totalPages;
        const products = await productsCollection
          .find(query)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();
        const facets = facetResult?.[0] ?? { categories: [], priceBounds: [] };
        // Resolve display names from the categories collection so facets read
        // "Tea Table" while the client keeps filtering by slug.
        const nameBySlug = new Map();
        for (const doc of categoryDocs) {
          nameBySlug.set(doc.slug, {
            name: doc.name,
            subcategories: new Map(
              (Array.isArray(doc.subcategories) ? doc.subcategories : [])
                .map((sub) => [slugifyCategory(sub?.slug ?? sub?.name ?? ""), sub?.name])
                .filter(([slug]) => slug),
            ),
          });
        }
        const facetTree = new Map();
        for (const row of facets.categories ?? []) {
          const rawCategory = row._id?.category;
          if (typeof rawCategory !== "string" || !rawCategory.trim()) continue;
          const categorySlug = nameBySlug.has(rawCategory) ? rawCategory : slugifyCategory(rawCategory);
          const meta = nameBySlug.get(categorySlug);
          const entry = facetTree.get(categorySlug) ?? {
            name: meta?.name ?? rawCategory,
            slug: categorySlug,
            count: 0,
            subcategories: new Map(),
          };
          entry.count += row.count ?? 0;
          const subSlug = slugifyCategory(row._id?.subcategory);
          if (subSlug) {
            const existing = entry.subcategories.get(subSlug);
            entry.subcategories.set(subSlug, {
              name: meta?.subcategories?.get(subSlug) ?? row._id.subcategory,
              slug: subSlug,
              count: (existing?.count ?? 0) + (row.count ?? 0),
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
          products,
          total,
          page,
          limit,
          totalPages,
          sort: sortKey,
          appliedFilters: { categories, subcategories, minPrice, maxPrice, inStock },
          facets: {
            categories: facetCategories,
            priceBounds: {
              min: Number(facets.priceBounds?.[0]?.min ?? 0),
              max: Number(facets.priceBounds?.[0]?.max ?? 0),
            },
          },
        });
      } catch (error) {
        console.error("Error fetching products:", error);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    })

   //Products Details API
    app.get('/products/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        const result = await productsCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).json({ error: "Product not found" });
        }
        res.status(200).json(result);
      } catch (error) {
        console.error("Error fetching product:", error);
        res.status(500).json({ error: "Failed to fetch product" });
      }
    })

    //Update Product API (admin only)
    app.patch('/products/:id', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        if (!req.body || Object.keys(req.body).length === 0) {
          return res.status(400).json({ error: "No fields to update" });
        }

        const { _id, ...fields } = req.body;
        const updateDoc = {};
        const existing = await productsCollection.findOne({ _id: new ObjectId(id) });
        if (!existing) {
          return res.status(404).json({ error: "Product not found" });
        }

        if ('images' in fields) {
          const imagesError = validateImages(fields.images);
          if (imagesError) {
            return res.status(400).json({ error: imagesError });
          }
          const images = fields.images.map((url) => url.trim());
          updateDoc.images = images;
          if ('image' in fields && isValidUrl(fields.image)) {
            updateDoc.image = fields.image.trim();
          } else {
            updateDoc.image = images[0];
          }
        } else if ('image' in fields) {
          if (!isValidUrl(fields.image)) {
            return res.status(400).json({ error: "image must be a valid http(s) URL" });
          }
          updateDoc.image = fields.image.trim();
        }

        if ('price' in fields) {
          const price = Number(fields.price);
          if (Number.isNaN(price)) {
            return res.status(400).json({ error: "price must be a valid number" });
          }
          updateDoc.price = price;
        }

        if ('stock' in fields) {
          const stock = Number(fields.stock);
          if (Number.isNaN(stock)) {
            return res.status(400).json({ error: "stock must be a valid number" });
          }
          updateDoc.stock = stock;
        }

        // Hierarchy fields are resolved together so a sub-category change without
        // an explicit category still validates against the product's parent.
        if ('category' in fields || 'subcategory' in fields) {
          const assignment = await resolveCategoryAssignment({
            category: 'category' in fields ? fields.category : existing.category,
            subcategory: 'subcategory' in fields ? fields.subcategory : existing.subcategory,
          });
          if (assignment.error) {
            return res.status(400).json({ error: assignment.error });
          }
          updateDoc.category = assignment.value.category;
          updateDoc.subcategory = assignment.value.subcategory;
        }

        const SKIP_FIELDS = ['_id', 'image', 'images', 'price', 'stock', 'category', 'subcategory', ...POLICY_FIELDS];
        for (const [key, value] of Object.entries(fields)) {
          if (SKIP_FIELDS.includes(key)) continue;
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

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateDoc }
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        const updated = await productsCollection.findOne({ _id: new ObjectId(id) });
        res.status(200).json(updated);
      } catch (error) {
        console.error("Error updating product:", error);
        res.status(500).json({ error: "Failed to update product" });
      }
    })

    //Delete Product API (admin only)
    app.delete('/products/:id', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product id" });
        }
        const result = await productsCollection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }
        res.status(200).json({ success: true, deletedId: id, deletedCount: result.deletedCount });
      } catch (error) {
        console.error("Error deleting product:", error);
        res.status(500).json({ error: "Failed to delete product" });
      }
    })

    //Category APIs
    // GET /categories (public): full tree with per-level product counts.
    const loadCategoryTree = async () => {
      const categories = await categoriesCollection.find({}).sort({ name: 1 }).toArray();
      const rows = await productsCollection.aggregate([
        {
          $group: {
            _id: { category: "$category", subcategory: { $ifNull: ["$subcategory", ""] } },
            count: { $sum: 1 },
          },
        },
      ]).toArray();

      const tree = categories.map((doc) => ({
        _id: doc._id,
        name: doc.name,
        slug: doc.slug,
        image: isValidUrl(doc.image) ? doc.image : null,
        productCount: 0,
        subcategories: (Array.isArray(doc.subcategories) ? doc.subcategories : [])
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
      for (const row of rows) {
        const rawCategory = row._id?.category;
        const count = row.count ?? 0;
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
        const subSlug = slugifyCategory(row._id?.subcategory);
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
      if (!ObjectId.isValid(id)) return { error: "Invalid category id", status: 400 };
      const doc = await categoriesCollection.findOne({ _id: new ObjectId(id) });
      if (!doc) return { error: "Category not found", status: 404 };
      return { doc };
    };

    app.get('/categories', async (req, res) => {
      try {
        const { tree, unassignedCount } = await loadCategoryTree();
        res.status(200).json({ categories: tree, unassignedCount });
      } catch (error) {
        console.error("Error fetching categories:", error);
        res.status(500).json({ error: "Failed to fetch categories" });
      }
    })

    //Create Category API (admin only)
    app.post('/categories', verifyToken, requireAdmin, async (req, res) => {
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
        const existing = await categoriesCollection.findOne({ slug });
        if (existing) {
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
        const result = await categoriesCollection.insertOne(doc);
        res.status(201).json({ ...doc, _id: result.insertedId });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return res.status(409).json({ error: "A category with that name already exists" });
        }
        console.error("Error creating category:", error);
        res.status(500).json({ error: "Failed to create category" });
      }
    })

    //Update Category API (admin only) — renaming re-slugs products too.
    app.patch('/categories/:id', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { doc, error, status } = await loadCategoryDoc(req.params.id);
        if (error) return res.status(status).json({ error });

        const updateDoc = { updatedAt: new Date() };
        let renamedFrom = null;

        if ('name' in (req.body ?? {})) {
          const nameCheck = validateCategoryName(req.body.name);
          if (nameCheck.error) {
            return res.status(400).json({ error: nameCheck.error });
          }
          const { name, slug } = nameCheck.value;
          if (slug !== doc.slug) {
            const clash = await categoriesCollection.findOne({ slug, _id: { $ne: doc._id } });
            if (clash) {
              return res.status(409).json({ error: `A category named "${name}" already exists` });
            }
            renamedFrom = doc.slug;
          }
          updateDoc.name = name;
          updateDoc.slug = slug;
        }

        if ('image' in (req.body ?? {})) {
          const imageCheck = validateCategoryImage(req.body.image);
          if (imageCheck.error) {
            return res.status(400).json({ error: imageCheck.error });
          }
          updateDoc.image = imageCheck.value;
        }

        if (Object.keys(updateDoc).length === 1) {
          return res.status(400).json({ error: "No fields to update" });
        }

        await categoriesCollection.updateOne({ _id: doc._id }, { $set: updateDoc });
        if (renamedFrom) {
          await productsCollection.updateMany(
            { category: renamedFrom },
            { $set: { category: updateDoc.slug, updatedAt: new Date() } }
          );
        }

        const updated = await categoriesCollection.findOne({ _id: doc._id });
        res.status(200).json(updated);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return res.status(409).json({ error: "A category with that name already exists" });
        }
        console.error("Error updating category:", error);
        res.status(500).json({ error: "Failed to update category" });
      }
    })

    //Delete Category API (admin only) — blocked while products still use it.
    app.delete('/categories/:id', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { doc, error, status } = await loadCategoryDoc(req.params.id);
        if (error) return res.status(status).json({ error });

        const productCount = await productsCollection.countDocuments({ category: doc.slug });
        if (productCount > 0) {
          return res.status(400).json({
            error: `Move or delete the ${productCount} product(s) in this category first`,
            productCount,
          });
        }

        await categoriesCollection.deleteOne({ _id: doc._id });
        res.status(200).json({ success: true, deletedId: req.params.id });
      } catch (error) {
        console.error("Error deleting category:", error);
        res.status(500).json({ error: "Failed to delete category" });
      }
    })

    //Create Sub-category API (admin only)
    app.post('/categories/:id/subcategories', verifyToken, requireAdmin, async (req, res) => {
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
        await categoriesCollection.updateOne(
          { _id: doc._id },
          { $push: { subcategories: sub }, $set: { updatedAt: new Date() } }
        );
        res.status(201).json(sub);
      } catch (error) {
        console.error("Error creating sub-category:", error);
        res.status(500).json({ error: "Failed to create sub-category" });
      }
    })

    //Update Sub-category API (admin only)
    app.patch('/categories/:id/subcategories/:subId', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { doc, error, status } = await loadCategoryDoc(req.params.id);
        if (error) return res.status(status).json({ error });

        const { subId } = req.params;
        if (!ObjectId.isValid(subId)) {
          return res.status(400).json({ error: "Invalid sub-category id" });
        }
        const current = findSubcategory(doc, subId);
        if (!current) {
          return res.status(404).json({ error: "Sub-category not found" });
        }

        const setFields = { "subcategories.$.updatedAt": new Date() };
        let renamedFrom = null;
        let renamedTo = null;

        if ('name' in (req.body ?? {})) {
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
          setFields["subcategories.$.name"] = name;
          setFields["subcategories.$.slug"] = slug;
        }

        if ('image' in (req.body ?? {})) {
          const imageCheck = validateCategoryImage(req.body.image);
          if (imageCheck.error) {
            return res.status(400).json({ error: imageCheck.error });
          }
          setFields["subcategories.$.image"] = imageCheck.value;
        }

        if (Object.keys(setFields).length === 1) {
          return res.status(400).json({ error: "No fields to update" });
        }

        await categoriesCollection.updateOne(
          { _id: doc._id },
          { $set: setFields },
          { arrayFilters: [{ "subcategories._id": new ObjectId(subId) }] }
        );
        if (renamedFrom) {
          await productsCollection.updateMany(
            { category: doc.slug, subcategory: renamedFrom },
            { $set: { subcategory: renamedTo, updatedAt: new Date() } }
          );
        }

        const updated = await categoriesCollection.findOne({ _id: doc._id });
        res.status(200).json(findSubcategory(updated, subId));
      } catch (error) {
        console.error("Error updating sub-category:", error);
        res.status(500).json({ error: "Failed to update sub-category" });
      }
    })

    //Delete Sub-category API (admin only)
    app.delete('/categories/:id/subcategories/:subId', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { doc, error, status } = await loadCategoryDoc(req.params.id);
        if (error) return res.status(status).json({ error });

        const { subId } = req.params;
        if (!ObjectId.isValid(subId)) {
          return res.status(400).json({ error: "Invalid sub-category id" });
        }
        const current = findSubcategory(doc, subId);
        if (!current) {
          return res.status(404).json({ error: "Sub-category not found" });
        }

        const productCount = await productsCollection.countDocuments({
          category: doc.slug,
          subcategory: current.slug,
        });
        if (productCount > 0) {
          return res.status(400).json({
            error: `Move or delete the ${productCount} product(s) in this sub-category first`,
            productCount,
          });
        }

        await categoriesCollection.updateOne(
          { _id: doc._id },
          { $pull: { subcategories: { _id: new ObjectId(subId) } }, $set: { updatedAt: new Date() } }
        );
        res.status(200).json({ success: true, deletedId: subId });
      } catch (error) {
        console.error("Error deleting sub-category:", error);
        res.status(500).json({ error: "Failed to delete sub-category" });
      }
    })

    //Create Order API (public for guest COD; links to account when JWT present)
    app.post('/orders', optionalAuth, async (req, res) => {
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

      try {
        const objectIds = value.items.map((item) => new ObjectId(item.productId));
        const products = await productsCollection
          .find({ _id: { $in: objectIds } })
          .toArray();
        const productById = new Map(products.map((p) => [p._id.toString(), p]));

        for (const item of value.items) {
          const product = productById.get(item.productId);
          if (!product) {
            return res.status(404).json({ error: `Product not found: ${item.productId}` });
          }
          const stock = Number(product.stock);
          if (!Number.isFinite(stock) || stock < item.quantity) {
            return res.status(400).json({ error: `Insufficient stock for product: ${item.productId}` });
          }
        }

        const orderItems = value.items.map((item) => {
          const product = productById.get(item.productId);
          const unitPrice = Number(product.price);
          return {
            productId: new ObjectId(item.productId),
            title: product.title || product.name || "",
            image: product.image || "",
            unitPrice,
            quantity: item.quantity,
            subtotal: unitPrice * item.quantity,
          };
        });

        const subtotal = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
        const totalAmount = subtotal + value.deliveryCharge;
        const now = new Date();
        const orderDoc = {
          customer: value.customer,
          userId: value.userId,
          items: orderItems,
          itemCount: orderItems.reduce((sum, item) => sum + item.quantity, 0),
          subtotal,
          deliveryCharge: value.deliveryCharge,
          totalAmount,
          paymentMethod: "cod",
          orderStatus: "pending",
          note: value.note,
          createdAt: now,
          updatedAt: now,
        };

        const session = client.startSession();
        try {
          let insertedId = null;
          await session.withTransaction(async () => {
            const insertResult = await ordersCollection.insertOne(orderDoc, { session });
            insertedId = insertResult.insertedId;

            for (const item of value.items) {
              const stockResult = await productsCollection.updateOne(
                { _id: new ObjectId(item.productId), stock: { $gte: item.quantity } },
                { $inc: { stock: -item.quantity }, $set: { updatedAt: new Date() } },
                { session }
              );
              if (stockResult.matchedCount === 0) {
                throw new Error(`Insufficient stock for product: ${item.productId}`);
              }
            }
          });
          const order = await ordersCollection.findOne({ _id: insertedId });
          res.status(201).json(order);
        } finally {
          await session.endSession();
        }
      } catch (error) {
        if (error.message && error.message.startsWith("Insufficient stock")) {
          return res.status(400).json({ error: error.message });
        }
        console.error("Error creating order:", error);
        res.status(500).json({ error: "Failed to create order" });
      }
    });

    //Get Orders API (JWT required; admin sees all, customer sees own userId only)
    app.get('/orders', verifyToken, async (req, res) => {
      try {
        const filter = {};
        if (req.query.phone) {
          // Phone filtering is admin-only; customers must scope by their own userId
          if (req.user.role !== "admin") {
            return res.status(403).json({ error: "Forbidden" });
          }
          filter["customer.phone"] = String(req.query.phone).trim();
        }
        if (req.query.userId) {
          const userId = normalizeUserId(req.query.userId);
          if (!userId) {
            return res.status(400).json({ error: "Invalid user id" });
          }
          if (req.user.role !== "admin" && userId !== req.user.userId) {
            return res.status(403).json({ error: "Forbidden" });
          }
          filter.userId = userId;
        } else if (req.user.role !== "admin") {
          // Customers must always scope by userId; bare /orders is admin-only
          return res.status(403).json({ error: "Forbidden: userId query required" });
        }
        const rawStatus = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
        if (rawStatus && rawStatus !== "all") {
          if (!ORDER_STATUSES.includes(rawStatus)) {
            return res.status(400).json({ error: `status must be one of: all, ${ORDER_STATUSES.join(", ")}` });
          }
          filter.orderStatus = rawStatus;
        }
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if (q) {
          const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const orClauses = [
            { "customer.name": { $regex: escaped, $options: "i" } },
            { "customer.phone": { $regex: escaped, $options: "i" } },
            { "customer.address": { $regex: escaped, $options: "i" } },
          ];
          if (ObjectId.isValid(q)) {
            orClauses.push({ _id: new ObjectId(q) });
          }
          filter.$or = orClauses;
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
          filter.createdAt = { $gte: start, $lt: end };
        }
        const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
        if (!wantsPagination) {
          const orders = await ordersCollection.find(filter).sort({ createdAt: -1 }).toArray();
          return res.status(200).json(orders);
        }
        let page = Number.parseInt(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page, 10);
        let limit = Number.parseInt(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit, 10);
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(limit) || limit < 1) limit = 10;
        limit = Math.min(limit, 100);
        const total = await ordersCollection.countDocuments(filter);
        const totalPages = Math.max(1, Math.ceil(total / limit));
        if (page > totalPages) page = totalPages;
        const orders = await ordersCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();
        const [pendingCount, revenueAgg] = await Promise.all([
          ordersCollection.countDocuments({ ...filter, orderStatus: "pending" }),
          ordersCollection
            .aggregate([
              { $match: { ...filter, orderStatus: "delivered" } },
              { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
            ])
            .toArray(),
        ]);
        return res.status(200).json({
          orders,
          total,
          page,
          limit,
          totalPages,
          pendingCount,
          deliveredRevenue: Number(revenueAgg?.[0]?.revenue ?? 0),
        });
      } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: "Failed to fetch orders" });
      }
    });

    //Bulk assign category API (admin only)
    app.patch('/products/category/bulk', verifyToken, requireAdmin, async (req, res) => {
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
          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: `invalid productId: ${entry}` });
          }
          ids.push(new ObjectId(id));
        }

        const assignment = await resolveCategoryAssignment(req.body);
        if (assignment.error) {
          return res.status(400).json({ error: assignment.error });
        }
        const { category, subcategory } = assignment.value;

        const result = await productsCollection.updateMany(
          { _id: { $in: ids } },
          { $set: { category, subcategory, updatedAt: new Date() } }
        );
        res.status(200).json({
          success: true,
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
          category,
          subcategory,
        });
      } catch (error) {
        console.error("Error bulk assigning category:", error);
        res.status(500).json({ error: "Failed to update products" });
      }
    })

    //Update Order API (admin full access; customers may only cancel their own pending orders)
    app.patch('/orders/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid order id" });
        }
        const { error, value } = validateOrderPatch(req.body);
        if (error) {
          return res.status(400).json({ error });
        }

        const existing = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!existing) {
          return res.status(404).json({ error: "Order not found" });
        }

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

        const isFinal = FINAL_ORDER_STATUSES.includes(existing.orderStatus);
        const wantsDataChange = ("customer" in value) || ("note" in value) || ("deliveryCharge" in value) || ("items" in value);
        if (isFinal && wantsDataChange) {
          return res.status(400).json({ error: `Order is ${existing.orderStatus} and cannot be edited` });
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
            it.productId.toString(),
            { quantity: it.quantity, unitPrice: it.unitPrice, title: it.title, image: it.image },
          ]));
          const newIds = value.items.map((it) => new ObjectId(it.productId));
          const products = await productsCollection.find({ _id: { $in: newIds } }).toArray();
          const productById = new Map(products.map((p) => [p._id.toString(), p]));

          for (const it of value.items) {
            if (!oldMap.has(it.productId) && !productById.has(it.productId)) {
              return res.status(404).json({ error: `Product not found: ${it.productId}` });
            }
          }

          finalItems = value.items.map((it) => {
            if (oldMap.has(it.productId)) {
              const old = oldMap.get(it.productId);
              return {
                productId: new ObjectId(it.productId),
                title: old.title || "",
                image: old.image || "",
                unitPrice: old.unitPrice,
                quantity: it.quantity,
                subtotal: old.unitPrice * it.quantity,
              };
            }
            const product = productById.get(it.productId);
            const unitPrice = Number(product.price);
            return {
              productId: new ObjectId(it.productId),
              title: product.title || product.name || "",
              image: product.image || "",
              unitPrice,
              quantity: it.quantity,
              subtotal: unitPrice * it.quantity,
            };
          });
        }

        const subtotal = finalItems.reduce((sum, it) => sum + it.subtotal, 0);
        const itemCount = finalItems.reduce((sum, it) => sum + it.quantity, 0);
        const totalAmount = subtotal + newDeliveryCharge;

        // Stock adjustments
        const oldQty = new Map((existing.items || []).map((it) => [it.productId.toString(), it.quantity]));
        const newQty = new Map(finalItems.map((it) => [it.productId.toString(), it.quantity]));
        const isCancelling = existing.orderStatus !== "cancelled" && newStatus === "cancelled";
        const isReopening = existing.orderStatus === "cancelled" && newStatus !== "cancelled";

        const deltas = new Map();
        if ("items" in value && !isCancelling && !isReopening) {
          const allIds = new Set([...oldQty.keys(), ...newQty.keys()]);
          for (const pid of allIds) {
            const d = (newQty.get(pid) || 0) - (oldQty.get(pid) || 0);
            if (d !== 0) deltas.set(pid, d);
          }
        }

        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            if (!isCancelling) {
              const needCheck = isReopening
                ? [...newQty.entries()]
                : [...deltas.entries()].filter(([, d]) => d > 0).map(([pid, d]) => [pid, d]);
              for (const [pid, need] of needCheck) {
                const qtyNeeded = isReopening ? need : need;
                const prod = await productsCollection.findOne({ _id: new ObjectId(pid) }, { session });
                if (!prod) throw new Error(`Product not found: ${pid}`);
                if (!Number.isFinite(Number(prod.stock)) || Number(prod.stock) < qtyNeeded) {
                  throw new Error(`Insufficient stock for product: ${pid}`);
                }
              }
            }

            await ordersCollection.updateOne(
              { _id: new ObjectId(id) },
              {
                $set: {
                  customer: newCustomer,
                  items: finalItems,
                  itemCount,
                  subtotal,
                  deliveryCharge: newDeliveryCharge,
                  totalAmount,
                  orderStatus: newStatus,
                  note: newNote,
                  updatedAt: new Date(),
                },
              },
              { session }
            );

            if (isCancelling) {
              for (const [pid, qty] of oldQty.entries()) {
                await productsCollection.updateOne(
                  { _id: new ObjectId(pid) },
                  { $inc: { stock: qty }, $set: { updatedAt: new Date() } },
                  { session }
                );
              }
            } else if (isReopening) {
              for (const [pid, qty] of newQty.entries()) {
                const r = await productsCollection.updateOne(
                  { _id: new ObjectId(pid), stock: { $gte: qty } },
                  { $inc: { stock: -qty }, $set: { updatedAt: new Date() } },
                  { session }
                );
                if (r.matchedCount === 0) throw new Error(`Insufficient stock for product: ${pid}`);
              }
            } else {
              for (const [pid, d] of deltas.entries()) {
                if (d > 0) {
                  const r = await productsCollection.updateOne(
                    { _id: new ObjectId(pid), stock: { $gte: d } },
                    { $inc: { stock: -d }, $set: { updatedAt: new Date() } },
                    { session }
                  );
                  if (r.matchedCount === 0) throw new Error(`Insufficient stock for product: ${pid}`);
                } else {
                  await productsCollection.updateOne(
                    { _id: new ObjectId(pid) },
                    { $inc: { stock: -d }, $set: { updatedAt: new Date() } },
                    { session }
                  );
                }
              }
            }
          });

          const updated = await ordersCollection.findOne({ _id: new ObjectId(id) });
          res.status(200).json(updated);
        } finally {
          await session.endSession();
        }
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
    app.get('/orders/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid order id" });
        }
        const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).json({ error: "Order not found" });
        }
        if (req.user.role !== "admin" && String(result.userId ?? "") !== req.user.userId) {
          return res.status(403).json({ error: "Forbidden" });
        }
        res.status(200).json(result);
      } catch (error) {
        console.error("Error fetching order:", error);
        res.status(500).json({ error: "Failed to fetch order" });
      }
    })

    //Wishlist APIs (JWT required; owner or admin)
    app.get('/wishlist/:userId', verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
      try {
        const userId = normalizeUserId(req.params.userId);
        if (!userId) {
          return res.status(400).json({ error: "Invalid user id" });
        }
        const doc = await wishlistsCollection.findOne({ userId });
        res.status(200).json({ userId, productIds: doc?.productIds ?? [] });
      } catch (error) {
        console.error("Error fetching wishlist:", error);
        res.status(500).json({ error: "Failed to fetch wishlist" });
      }
    })

    app.post('/wishlist/:userId/toggle', verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
      try {
        const userId = normalizeUserId(req.params.userId);
        if (!userId) {
          return res.status(400).json({ error: "Invalid user id" });
        }
        const productId = typeof req.body?.productId === "string" ? req.body.productId.trim() : "";
        if (!ObjectId.isValid(productId)) {
          return res.status(400).json({ error: `invalid productId: ${req.body?.productId}` });
        }
        const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
        if (!product) {
          return res.status(404).json({ error: `Product not found: ${productId}` });
        }
        const existing = await wishlistsCollection.findOne({ userId });
        const current = Array.isArray(existing?.productIds) ? existing.productIds : [];
        if (current.includes(productId)) {
          await wishlistsCollection.updateOne(
            { userId },
            { $pull: { productIds: productId }, $set: { updatedAt: new Date() } },
            { upsert: true }
          );
          const doc = await wishlistsCollection.findOne({ userId });
          return res.status(200).json({ userId, productIds: doc?.productIds ?? [], wishlisted: false });
        }
        if (current.length >= MAX_WISHLIST_ITEMS) {
          return res.status(400).json({ error: `wishlist can hold at most ${MAX_WISHLIST_ITEMS} items` });
        }
        await wishlistsCollection.updateOne(
          { userId },
          {
            $addToSet: { productIds: productId },
            $set: { updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );
        const doc = await wishlistsCollection.findOne({ userId });
        res.status(200).json({ userId, productIds: doc?.productIds ?? [], wishlisted: true });
      } catch (error) {
        console.error("Error toggling wishlist:", error);
        res.status(500).json({ error: "Failed to update wishlist" });
      }
    })

    app.delete('/wishlist/:userId/:productId', verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
      try {
        const userId = normalizeUserId(req.params.userId);
        const productId = typeof req.params.productId === "string" ? req.params.productId.trim() : "";
        if (!userId) {
          return res.status(400).json({ error: "Invalid user id" });
        }
        if (!ObjectId.isValid(productId)) {
          return res.status(400).json({ error: `invalid productId: ${req.params.productId}` });
        }
        await wishlistsCollection.updateOne(
          { userId },
          { $pull: { productIds: productId }, $set: { updatedAt: new Date() } },
          { upsert: true }
        );
        const doc = await wishlistsCollection.findOne({ userId });
        res.status(200).json({ userId, productIds: doc?.productIds ?? [], wishlisted: false });
      } catch (error) {
        console.error("Error removing wishlist item:", error);
        res.status(500).json({ error: "Failed to update wishlist" });
      }
    })

    app.delete('/wishlist/:userId', verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
      try {
        const userId = normalizeUserId(req.params.userId);
        if (!userId) {
          return res.status(400).json({ error: "Invalid user id" });
        }
        await wishlistsCollection.deleteOne({ userId });
        res.status(200).json({ userId, productIds: [], wishlisted: false });
      } catch (error) {
        console.error("Error clearing wishlist:", error);
        res.status(500).json({ error: "Failed to clear wishlist" });
      }
    })

    app.put('/wishlist/:userId', verifyToken, requireOwnerOrAdmin((req) => req.params.userId), async (req, res) => {
      try {
        const userId = normalizeUserId(req.params.userId);
        if (!userId) {
          return res.status(400).json({ error: "Invalid user id" });
        }
        const { error, value } = validateWishlistIds(req.body?.productIds);
        if (error) {
          return res.status(400).json({ error });
        }
        await wishlistsCollection.updateOne(
          { userId },
          {
            $set: { productIds: value, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );
        res.status(200).json({ userId, productIds: value });
      } catch (error) {
        console.error("Error saving wishlist:", error);
        res.status(500).json({ error: "Failed to save wishlist" });
      }
    })
    

    app.post('/admin/backfill-order-userIds', verifyToken, requireAdmin, async (req, res) => {
      try {
        const users = await db.collection("user").find(
          {},
          { projection: { phone: 1 } }
        ).toArray();
        let matchedUsers = 0;
        let modifiedOrders = 0;
        for (const user of users) {
          const userId = String(user._id ?? user.id ?? "");
          const rawPhone = typeof user.phone === "string" ? user.phone : "";
          const candidates = [...new Set([rawPhone, rawPhone.trim()].filter(Boolean))];
          if (!userId || candidates.length === 0) continue;
          const result = await ordersCollection.updateMany(
            {
              $or: [
                { userId: { $exists: false } },
                { userId: null },
              ],
              "customer.phone": { $in: candidates },
            },
            { $set: { userId } }
          );
          if (result.matchedCount > 0) matchedUsers += 1;
          modifiedOrders += result.modifiedCount || 0;
        }
        res.status(200).json({ success: true, matchedUsers, modifiedOrders });
      } catch (error) {
        console.error("Error backfilling order userIds:", error);
        res.status(500).json({ error: "Failed to backfill order userIds" });
      }
    })

    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  // } finally {
    // await client.close();
//   }
// }
// run().catch(console.dir);

// Starter taxonomy. Admin can edit or extend all of it afterwards.
    const STARTER_CATEGORIES = [
      { name: "Swing Chair", subcategories: ["Hanging Swing Chair", "Swing Chair with Stand", "Baby Swing Chair"] },
      { name: "Furniture", subcategories: ["Chair Table Set", "Tea Table", "Mirror", "Dressing Table"] },
      { name: "Women's", subcategories: ["Sarees", "3 Piece", "Kurti", "Jewellery", "Cosmetics"] },
      { name: "Others", subcategories: [] },
    ];

    //Seed starter categories (admin only, idempotent — never overwrites)
    app.post('/admin/seed-categories', verifyToken, requireAdmin, async (req, res) => {
      try {
        const now = new Date();
        const created = [];
        const skipped = [];
        for (const entry of STARTER_CATEGORIES) {
          const slug = slugifyCategory(entry.name);
          const existing = await categoriesCollection.findOne({ slug });
          if (existing) {
            skipped.push(slug);
            continue;
          }
          const doc = {
            name: entry.name,
            slug,
            image: null,
            subcategories: entry.subcategories.map((subName) => normalizeSubcategory({
              name: subName,
              slug: slugifyCategory(subName),
              image: null,
            })),
            createdAt: now,
            updatedAt: now,
          };
          await categoriesCollection.insertOne(doc);
          created.push(slug);
        }
        res.status(200).json({ success: true, created, skipped });
      } catch (error) {
        console.error("Error seeding categories:", error);
        res.status(500).json({ error: "Failed to seed categories" });
      }
    })

    //Migrate legacy free-text product categories onto slugs (admin only, idempotent)
    app.post('/admin/migrate-product-categories', verifyToken, requireAdmin, async (req, res) => {
      try {
        const { tree } = await loadCategoryTree();
        const bySlug = new Map(tree.map((entry) => [entry.slug, entry]));
        const products = await productsCollection.find({}).toArray();
        let updatedProducts = 0;
        const unmapped = new Map();
        for (const product of products) {
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
          await productsCollection.updateOne(
            { _id: product._id },
            { $set: { category: nextCategory, subcategory: nextSub, updatedAt: new Date() } }
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
    })

    app.get('/', (req, res) => {
      res.send('Hello World!');
    });

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

module.exports = app;
