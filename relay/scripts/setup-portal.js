// One-off: create/refresh the Stripe Customer Portal configuration using the
// relay's own STRIPE_SECRET_KEY (so the key never leaves the server).
//
// Run on the deployed machine:  fly ssh console -C "node scripts/setup-portal.js"
// Then set the printed id:       fly secrets set STRIPE_PORTAL_CONFIG_ID=bpc_...

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("STRIPE_SECRET_KEY not set");
const stripe = new Stripe(key);
const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const cfg = await stripe.billingPortal.configurations.create({
  business_profile: {
    privacy_policy_url: `${base}/privacy`,
    terms_of_service_url: `${base}/terms`,
  },
  features: {
    customer_update: { enabled: true, allowed_updates: ["email"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
  },
  default_return_url: `${base}/billing/return`,
});

console.log("PORTAL_CONFIG_ID=" + cfg.id);
