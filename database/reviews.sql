-- Run this once in cPanel -> phpMyAdmin -> belaview_database -> SQL
-- (or import this file) to enable product ratings/reviews.
-- The full database/schema.sql already includes this table.
--
-- Any signed-in customer can rate a product. One review per user per
-- product; submitting again updates the existing row.

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
