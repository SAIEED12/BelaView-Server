# Deploying belaview-server to cPanel

The server is a plain Express app (no build step). Deploy = upload code + install
dependencies + create the database. The database starts **empty** (fresh start):
products, categories and users are created through the app afterwards.

## 0. One-time: prepare the MySQL database

1. cPanel -> **MySQL Databases**: create a database and a user, then grant ALL
   PRIVILEGES to the user. cPanel prefixes both names, e.g. `myuser_belaview`.
2. phpMyAdmin -> select the database -> **Import** -> `database/schema.sql`.
   That is the only import - there is no data migration.
   If you imported an earlier version of `schema.sql` before the client moved to
   MySQL, also import `database/carts.sql` once to create the cart table.
   Existing databases also need `database/reviews.sql` once to enable product
   ratings and reviews, and `database/product-slugs.sql` once to add the
   name-based product URLs (`/products/<slug>`).

## 1. Upload the app

- On your PC: `npm run pack:cpanel` -> creates `belaview-server-cpanel.zip`
  (code + `.env` template + `package.json`, no `node_modules`).
- cPanel -> **File Manager** -> create a folder (e.g. `belaview-api`), upload the
  zip, extract it there.

## 2. Create the Node.js application

cPanel -> **Setup Node.js App** -> Create Application:

| Field | Value |
|---|---|
| Node.js version | 24 (production) |
| Application root | the folder from step 1 (e.g. `belaview-api`) |
| Application URL | your subdomain, e.g. `api.yourdomain.com` (create it under **Domains** first if it does not exist) |
| Application startup file | `index.js` |

Then click **Run NPM Install**.

## 3. Environment

The zip ships a `.env` template next to `index.js`; the app loads it with dotenv.
Edit it in File Manager (right click -> **Edit**) and fill in:

- `DB_USER`, `DB_PASSWORD`, `DB_NAME` -> the FULL cPanel names with prefix,
  e.g. `myuser_belaview` (from step 0).
- `AUTH_BASE_URL` -> the client site's public URL exactly as users open it
  (no trailing slash). May be left empty: the JWT issuer check is then skipped
  (tokens are still verified against the signing key).
- `MEDIA_BASE_URL` -> this API's public URL, i.e. the subdomain (no trailing
  slash). May be left empty: uploaded-image links are then built from the
  incoming request automatically.

Alternative: delete `.env` and set the same keys in
"Setup Node.js App" -> Environment variables instead (they win over `.env`).

Restart the app after any change. Keep `.env` outside `public` so it is never
web-accessible.

## 4. Uploads folder

File Manager -> make sure `<app root>/public/uploads` exists (the zip ships it).
Uploaded images are written there and served at `<app-url>/uploads/<file>`.

## 5. Smoke test

- `GET <app-url>/` -> `Hello World!`
- `GET <app-url>/products` -> `[]` (fresh database - expected)
- `POST <app-url>/upload` without a token -> 401
- Authenticated endpoints return 401 while the client still runs on MongoDB:
  its JWTs are signed with a key stored in the client's own database. This is
  expected - see below.

## 6. Client cutover

- Point the client at this API (`SERVER_URL`) and at this MySQL database.
- On the client's first login, Better Auth writes a fresh JWT signing key into
  the `jwks` table; this API accepts its tokens immediately.
- Users sign up again (fresh start - nothing was imported).
- First admin: sign up, then run this in phpMyAdmin's SQL tab and sign out/in
  on the client (its session is cached for 7 days):

  ```sql
  UPDATE `user` SET role = 'admin' WHERE email = 'you@example.com';
  ```

- In the dashboard: run the "Seed Categories" action to recreate the default
  categories, then add products.
- Keep MongoDB Atlas and the old deployment untouched until the client is fully
  switched, then retire them.
