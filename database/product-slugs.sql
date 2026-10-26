-- ============================================================
-- Product URL slugs (/products/<name-with-dashes>)
--
-- Run this ONCE on databases created before product slugs existed.
-- Fresh installs already get the column + unique index from schema.sql,
-- so do not run this there (the ALTER would fail with "duplicate column").
--
-- Tested on MySQL 8.0+ / MariaDB 10.2+:
--   * REGEXP_REPLACE needs MySQL 8.0 / MariaDB 10.0+
--   * ROW_NUMBER() needs MySQL 8.0 / MariaDB 10.2+
-- ============================================================
SET NAMES utf8mb4;

ALTER TABLE `products`
  ADD COLUMN `slug` varchar(255) NULL AFTER `_id`;

-- 1. Base slug from the product name: lowercase, spaces/underscores -> dash,
--    drop punctuation/emoji, collapse repeated dashes, trim leading/trailing.
UPDATE `products`
SET `slug` = TRIM(BOTH '-' FROM
  REGEXP_REPLACE(
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER(TRIM(`name`)), '[[:space:]_]+', '-'),
      '[^[:alnum:]-]+', ''
    ),
    '-+', '-'
  )
);

-- 2. Names with no letters/numbers fall back to the internal id.
UPDATE `products`
SET `slug` = CONCAT('product-', `_id`)
WHERE `slug` IS NULL OR `slug` = '';

-- 3. Duplicate names get -2, -3, ... in id order (same scheme as the API).
UPDATE `products` p
JOIN (
  SELECT `_id`, `slug`,
         ROW_NUMBER() OVER (PARTITION BY `slug` ORDER BY `_id`) AS rn
  FROM `products`
) ranked ON ranked.`_id` = p.`_id`
SET p.`slug` = CONCAT(LEFT(p.`slug`, 250), '-', ranked.rn)
WHERE ranked.rn > 1;

-- 4. Storefront lookups rely on the slug being present and unique.
ALTER TABLE `products`
  MODIFY `slug` varchar(255) NOT NULL,
  ADD UNIQUE KEY `products_slug_unique` (`slug`);
