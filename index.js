// deno run --allow-env --allow-net server.ts

import { Hono } from "https://deno.land/x/hono@v3.11.7/mod.ts";
import Stripe from "npm:stripe";

const app = new Hono();
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

// -----------------------------------------------------------------------------
// FIRESTORE REST HELFER
// -----------------------------------------------------------------------------
const PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID")!;
const API_KEY = Deno.env.get("FIREBASE_API_KEY")!;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function getUser(uid: string) {
  const res = await fetch(`${BASE_URL}/users/${uid}?key=${API_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.fields ? parseFields(data.fields) : null;
}

async function patchUser(uid: string, fields: any) {
  await fetch(`${BASE_URL}/users/${uid}?key=${API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
}

function parseFields(fields: any) {
  const obj: any = {};
  for (const k in fields) {
    const v = fields[k];
    if (v.integerValue) obj[k] = Number(v.integerValue);
    else if (v.stringValue) obj[k] = v.stringValue;
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.arrayValue)
      obj[k] =
        v.arrayValue.values?.map((x: any) => parseFields(x.mapValue.fields)) ??
        [];
  }
  return obj;
}

function str(v: string) {
  return { stringValue: v };
}
function int(v: number) {
  return { integerValue: String(v) };
}
function bool(v: boolean) {
  return { booleanValue: v };
}
function arr(v: any[]) {
  return {
    arrayValue: {
      values: v.map((x) => ({
        mapValue: { fields: x },
      })),
    },
  };
}

// -----------------------------------------------------------------------------
// STRIPE WEBHOOK
// -----------------------------------------------------------------------------
app.post("/webhook", async (c) => {
  const sig = c.req.header("stripe-signature");
  const rawBody = await c.req.raw.arrayBuffer();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("❌ Webhook Signatur ungültig");
    return c.text("Invalid signature", 400);
  }

  console.log("✅ Webhook:", event.type);

  // ---------------------------------------------------------------------------
  // CHECKOUT COMPLETED (ERSTKAUF)
  // ---------------------------------------------------------------------------
  if (event.type === "checkout.session.completed") {
    const session: any = event.data.object;
    const uid = session.client_reference_id;
    if (!uid) return c.json({ received: true });

    const sessionFull = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["line_items.data.price.product"],
    });

    const product: any =
      sessionFull.line_items!.data[0].price.product;
    const credits = Number(product.metadata.credits || 0);
    const isUnlimited = product.metadata.isUnlimited === "true";
    const plan = product.metadata.planName || product.name;

    await applyCredits(uid, {
      credits,
      isUnlimited,
      plan,
      invoiceId: session.invoice,
    });
  }

  // ---------------------------------------------------------------------------
  // MONATLICHE VERLÄNGERUNG
  // ---------------------------------------------------------------------------
  if (event.type === "invoice.paid") {
    const invoice: any = event.data.object;
    if (invoice.billing_reason !== "subscription_cycle")
      return c.json({ received: true });

    const sub = await stripe.subscriptions.retrieve(invoice.subscription);
    const uid = sub.metadata.uid;
    if (!uid) return c.json({ received: true });

    const product = await stripe.products.retrieve(
      invoice.lines.data[0].price.product
    );

    await applyCredits(uid, {
      credits: Number(product.metadata.credits || 0),
      isUnlimited: product.metadata.isUnlimited === "true",
      plan: product.metadata.planName || product.name,
      invoiceId: invoice.id,
    });
  }

  return c.json({ received: true });
});

// -----------------------------------------------------------------------------
// CREDIT LOGIK (IDEMPOTENT, STABIL)
// -----------------------------------------------------------------------------
async function applyCredits(
  uid: string,
  data: {
    credits: number;
    isUnlimited: boolean;
    plan: string;
    invoiceId: string;
  }
) {
  const user = (await getUser(uid)) || {};
  const payments = user.payments || [];

  if (payments.some((p: any) => p.invoiceId === data.invoiceId)) {
    console.log("⚠️ Invoice bereits verarbeitet:", data.invoiceId);
    return;
  }

  const newCredits = data.isUnlimited
    ? 999999
    : (user.credits || 0) + data.credits;

  await patchUser(uid, {
    credits: int(newCredits),
    isUnlimited: bool(data.isUnlimited),
    plan: str(data.plan),
    lastPaymentStatus: str("active"),
    payments: arr([
      ...payments.map((p: any) => ({
        invoiceId: str(p.invoiceId),
      })),
      {
        invoiceId: str(data.invoiceId),
        credits: int(data.credits),
      },
    ]),
  });

  console.log(`✅ Firestore OK → ${uid}: ${newCredits} Credits`);
}

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------
app.get("/", (c) => c.json({ status: "ok", runtime: "deno" }));

Deno.serve(app.fetch);
