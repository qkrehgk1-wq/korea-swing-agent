CREATE TABLE `agent_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`analysis_id` int NOT NULL,
	`agent_role` varchar(100) NOT NULL,
	`report` text NOT NULL,
	`confidence` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`stock_id` int NOT NULL,
	`ticker` varchar(10) NOT NULL,
	`fundamental_analysis` text,
	`technical_analysis` text,
	`insider_analysis` text,
	`risk_analysis` text,
	`billionaire_framework` text,
	`investment_insight` text,
	`asymmetric_growth_score` int,
	`analysis_date` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stocks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(10) NOT NULL,
	`company_name` text,
	`industry` varchar(255),
	`website` varchar(255),
	`description` text,
	`last_updated` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `stocks_id` PRIMARY KEY(`id`),
	CONSTRAINT `stocks_ticker_unique` UNIQUE(`ticker`)
);
--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`ticker` varchar(10) NOT NULL,
	`added_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `watchlist_id` PRIMARY KEY(`id`)
);
