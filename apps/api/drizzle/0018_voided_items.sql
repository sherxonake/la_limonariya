CREATE TABLE "voided_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"note" text,
	"performed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voided_items" ADD CONSTRAINT "voided_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voided_items" ADD CONSTRAINT "voided_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voided_items" ADD CONSTRAINT "voided_items_performed_by_id_users_id_fk" FOREIGN KEY ("performed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vi_order_idx" ON "voided_items" USING btree ("order_id");