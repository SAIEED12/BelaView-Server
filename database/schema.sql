-- ============================================================
-- Belaview - MySQL schema (Better Auth tables + storefront data)
-- Import: cPanel -> phpMyAdmin -> select database -> Import -> schema.sql
-- Engine: InnoDB, utf8mb4 (Bengali text friendly).
--
-- ID policy: app tables keep the old MongoDB hex ids in `_id char(24)` so
-- existing URLs, links, wishlists and order items stay valid after the swap.
-- Datetimes are stored as UTC (datetime(3) keeps milliseconds).
-- ============================================================
SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- Better Auth tables (written by the Next.js app, read by this API)
-- `role` and `phone` are Belaview additions to the default Better Auth user.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `email_verified` tinyint(1) NOT NULL DEFAULT 0,
  `image` text,
  `role` varchar(50) NOT NULL DEFAULT 'customer',
  `phone` varchar(255) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `session` (
  `id` varchar(255) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `token` varchar(255) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `ip_address` varchar(255) DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `user_id` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `session_token_unique` (`token`),
  KEY `session_user_id_idx` (`user_id`),
  CONSTRAINT `session_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account` (
  `id` varchar(255) NOT NULL,
  `account_id` varchar(255) NOT NULL,
  `provider_id` varchar(255) NOT NULL,
  `user_id` varchar(255) NOT NULL,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` datetime(3) DEFAULT NULL,
  `refresh_token_expires_at` datetime(3) DEFAULT NULL,
  `scope` text,
  `password` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `account_user_id_idx` (`user_id`),
  KEY `account_provider_account_idx` (`provider_id`, `account_id`),
  CONSTRAINT `account_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `verification` (
  `id` varchar(255) NOT NULL,
  `identifier` varchar(255) NOT NULL,
  `value` text NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `verification_identifier_idx` (`identifier`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- JWT signing keys: written by the Next.js app, read by this API to verify
-- tokens. Both apps MUST point at the same database.
CREATE TABLE IF NOT EXISTS `jwks` (
  `id` varchar(255) NOT NULL,
  `public_key` text NOT NULL,
  `private_key` text NOT NULL,
  `alg` varchar(50) DEFAULT NULL,
  `crv` varchar(50) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `expires_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Storefront tables (written and read by this API)
-- Column names intentionally mirror the old MongoDB field names so JSON
-- responses stay byte-compatible with the deployed clients.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `products` (
  `_id` char(24) NOT NULL,
  `name` varchar(255) NOT NULL DEFAULT '',
  `description` mediumtext,
  `price` decimal(12,2) NOT NULL DEFAULT 0,
  `stock` int NOT NULL DEFAULT 0,
  `category` varchar(255) NOT NULL DEFAULT '',
  `subcategory` varchar(255) NOT NULL DEFAULT '',
  `image` text,
  `images` longtext,
  `sizes` longtext,
  `disclaimer` text,
  `note` text,
  `deliveryPayment` text,
  `returnPolicy` text,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`_id`),
  KEY `products_category_subcategory_idx` (`category`, `subcategory`),
  KEY `products_price_idx` (`price`),
  KEY `products_stock_idx` (`stock`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `categories` (
  `_id` char(24) NOT NULL,
  `name` varchar(255) NOT NULL,
  `slug` varchar(255) NOT NULL,
  `image` text,
  `subcategories` longtext,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`_id`),
  UNIQUE KEY `categories_slug_unique` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `orders` (
  `_id` char(24) NOT NULL,
  `userId` varchar(255) DEFAULT NULL,
  `customerName` varchar(255) NOT NULL,
  `customerPhone` varchar(100) NOT NULL,
  `customerAddress` text,
  `items` longtext,
  `itemCount` int NOT NULL DEFAULT 0,
  `subtotal` decimal(12,2) NOT NULL DEFAULT 0,
  `deliveryCharge` decimal(12,2) NOT NULL DEFAULT 0,
  `totalAmount` decimal(12,2) NOT NULL DEFAULT 0,
  `totalOverridden` tinyint(1) NOT NULL DEFAULT 0,
  `paymentMethod` varchar(50) NOT NULL DEFAULT 'cod',
  `orderStatus` varchar(50) NOT NULL DEFAULT 'pending',
  `note` varchar(1000) DEFAULT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`_id`),
  KEY `orders_userId_idx` (`userId`),
  KEY `orders_customerPhone_idx` (`customerPhone`),
  KEY `orders_orderStatus_idx` (`orderStatus`),
  KEY `orders_createdAt_idx` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `wishlists` (
  `_id` char(24) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `productIds` longtext,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`_id`),
  UNIQUE KEY `wishlists_userId_unique` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Product ratings/reviews. Any signed-in customer can rate a product; one row
-- per (userId, productId) so re-submitting updates the existing review.
-- `hidden` lets admins moderate without losing the rating for later review.
CREATE TABLE IF NOT EXISTS `reviews` (
  `_id` char(24) NOT NULL,
  `productId` char(24) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `rating` tinyint unsigned NOT NULL,
  `comment` text,
  `hidden` tinyint(1) NOT NULL DEFAULT 0,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`_id`),
  UNIQUE KEY `reviews_user_product_unique` (`userId`, `productId`),
  KEY `reviews_product_hidden_idx` (`productId`, `hidden`),
  KEY `reviews_createdAt_idx` (`createdAt`),
  CONSTRAINT `reviews_userId_fk` FOREIGN KEY (`userId`) REFERENCES `user` (`id`) ON DELETE CASCADE,
  CONSTRAINT `reviews_productId_fk` FOREIGN KEY (`productId`) REFERENCES `products` (`_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Signed-in cart persisted by the Next.js client. One JSON document per user,
-- matching the shape the storefront already uses.
CREATE TABLE IF NOT EXISTS `carts` (
  `userId` varchar(255) NOT NULL,
  `items` longtext NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`userId`),
  CONSTRAINT `carts_userId_fk` FOREIGN KEY (`userId`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Admin bootstrap: after a user signs up on the site, promote them in
-- phpMyAdmin's SQL tab with:
--   UPDATE `user` SET role = 'admin' WHERE email = 'you@example.com';
-- then sign out and back in on the client so the new role takes effect.
-- ------------------------------------------------------------
