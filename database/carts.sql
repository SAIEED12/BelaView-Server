-- Run this once in cPanel -> phpMyAdmin -> belaview_database -> SQL
-- (or import this file) to enable signed-in cart sync for the new client.
-- The full database/schema.sql already includes this table.

CREATE TABLE IF NOT EXISTS `carts` (
  `userId` varchar(255) NOT NULL,
  `items` longtext NOT NULL,
  `createdAt` datetime(3) NOT NULL,
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`userId`),
  CONSTRAINT `carts_userId_fk` FOREIGN KEY (`userId`) REFERENCES `user` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
