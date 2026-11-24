-- "blog": users, posts, comments; an application account and a read-only one
CREATE DATABASE blog CHARACTER SET utf8mb4;
CREATE DATABASE inventory;
CREATE USER 'blog'@'localhost' IDENTIFIED BY 'blog-pw';
CREATE USER 'readonly'@'%' IDENTIFIED BY 'readonly-pw';
GRANT ALL PRIVILEGES ON blog.* TO 'blog'@'localhost';
GRANT SELECT ON blog.* TO 'readonly'@'%';
USE blog;
CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, login VARCHAR(40) UNIQUE NOT NULL, email VARCHAR(120), bio TEXT, created DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE posts (id INT AUTO_INCREMENT PRIMARY KEY, author_id INT NOT NULL, title VARCHAR(200) NOT NULL, body MEDIUMTEXT, published TINYINT(1) DEFAULT 0, views INT DEFAULT 0, KEY (author_id), FOREIGN KEY (author_id) REFERENCES users(id));
CREATE TABLE comments (id INT AUTO_INCREMENT PRIMARY KEY, post_id INT NOT NULL, body TEXT, at DATETIME, KEY (post_id));
INSERT INTO users (login, email, bio) SELECT CONCAT('author', seq), CONCAT('author', seq, '@blog.test'), IF(seq % 4 = 0, NULL, CONCAT('Bio with\ttab and\nnewline ', seq)) FROM seq_1_to_300;
INSERT INTO posts (author_id, title, body, published, views) SELECT 1 + seq % 300, CONCAT('Post #', seq, ' — été'), REPEAT('Lorem ipsum ', 1 + seq % 20), seq % 2, seq * 3 FROM seq_1_to_3000;
INSERT INTO comments (post_id, body, at) SELECT 1 + seq % 3000, CONCAT('Comment ', seq), NOW() - INTERVAL seq MINUTE FROM seq_1_to_12000;
USE inventory;
CREATE TABLE items (id INT PRIMARY KEY, label VARCHAR(50), qty INT);
INSERT INTO items VALUES (1, 'Screws', 500), (2, 'Bolts', 120);
