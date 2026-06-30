CREATE TYPE "public"."expense_category" AS ENUM('ijara', 'gaz', 'elektr', 'ish_haqi', 'jihoz', 'boshqa');--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "expense_category" NOT NULL,
	"amount" integer NOT NULL,
	"method" "payment_method" DEFAULT 'cash' NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"note" text,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paid_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exp_spent_idx" ON "expenses" USING btree ("spent_at");