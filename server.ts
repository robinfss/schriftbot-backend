// server.ts
// deno run --allow-env --allow-net server.ts
import { Hono } from "https://deno.land/x/hono@v3.11.7/mod.ts";
import { cors } from "https://deno.land/x/hono@v3.11.7/middleware/cors/index.ts";
import Stripe from "npm:stripe";

const app = new Hono();
app.use("*", cors({ origin: "*" }));

// -------------------- STRIPE INIT --------------------
const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
if (!stripeKey) throw new Error("STRIPE_SECRET_KEY fehlt!");

const stripe = new Stripe(stripeKey, {
  apiVersion: "2024-11-20.acacia",
});

// -------------------- FIRESTORE REST --------------------
const PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID");
const SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");

if (!PROJECT_ID || !SERVICE_ACCOUNT_JSON) {
  throw new Error("FIREBASE_PROJECT_ID oder FIREBASE_SERVICE_ACCOUNT fehlt!");
}

const SERVICE_ACCOUNT = JSON.parse(SERVICE_ACCOUNT_JSON);
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// -------------------- GOOGLE AUTH --------------------
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600;

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      iss: SERVICE_ACCOUNT.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      exp: expiry,
      iat: now,
    })
  );

  const signatureInput = `${header}.${payload}`;

  const pemKey = SERVICE_ACCOUNT.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const binaryKey = Uint8Array.from(atob(pemKey), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const signatureBase64 = btoa(
    String.fromCharCode(...new Uint8Array(signature))
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const jwt = `${signatureInput}.${signatureBase64}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token Fehler: ${error}`);
  }

  const tokenData = await tokenResponse.json();

  cachedToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000 - 60000,
  };

  return cachedToken.token;
}

// -------------------- FIRESTORE FUNKTIONEN --------------------
async function getUser(uid: string) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/users/${uid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Firestore GET Error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.fields ? parseFields(data.fields) : null;
}

async function patchUser(uid: string, fields: any) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/users/${uid}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    throw new Error(`Firestore PATCH Error: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

function parseFields(fields: any): any {
  const obj: any = {};
  for (const k in fields) {
    const v = fields[k];
    if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
    else if (v.stringValue !== undefined) obj[k] = v.stringValue;
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.arrayValue) {
      obj[k] =
        v.arrayValue.values?.map((x: any) =>
          x.mapValue ? parseFields(x.mapValue.fields) : x
        ) ?? [];
    }
  }
  return obj;
}

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(v) });
const bool = (v: boolean) => ({ booleanValue: v });
const arr = (v: any[]) => ({
  arrayValue: { values: v.map((x) => ({ mapValue: { fields: x } })) },
});

// -------------------- STRIPE WEBHOOK --------------------
app.post("/webhook", async (c) => {
  console.log("📨 Webhook empfangen");

  const sig = c.req.header("stripe-signature");
  if (!sig) {
    console.error("❌ Keine Stripe Signatur");
    return c.text("Missing signature", 400);
  }

  const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
  console.log("📦 Body Size:", rawBody.length);

  let event;
  try {
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET fehlt!");

    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    console.log("✅ Event verifiziert:", event.type);
  } catch (err: any) {
    console.error("❌ Webhook Signatur Fehler:", err.message);
    return c.text(`Webhook Error: ${err.message}`, 400);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log("🛒 Checkout Session:", session.id);

      const uid = session.client_reference_id;
      if (!uid) return c.json({ received: true });

      const sessionFull = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price.product"],
      });

      const lineItem = sessionFull.line_items?.data[0];
      if (!lineItem) return c.json({ received: true });

      const product = lineItem.price?.product as Stripe.Product;
      const credits = Number(product.metadata?.credits || 0);
      const isUnlimited = product.metadata?.isUnlimited === "true";
      const plan = product.metadata?.planName || product.name || "Unknown";

      await applyCredits(uid, {
        credits,
        isUnlimited,
        plan,
        invoiceId: (session.invoice as string) || session.id,
      });
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      console.log("🧾 Invoice paid:", invoice.id);

      if (invoice.billing_reason !== "subscription_cycle") {
        return c.json({ received: true });
      }

      const sub = await stripe.subscriptions.retrieve(
        invoice.subscription as string
      );
      const uid = sub.metadata?.uid;
      if (!uid) return c.json({ received: true });

      const productId = invoice.lines.data[0]?.price?.product as string;
      const product = await stripe.products.retrieve(productId);

      await applyCredits(uid, {
        credits: Number(product.metadata?.credits || 0),
        isUnlimited: product.metadata?.isUnlimited === "true",
        plan: product.metadata?.planName || product.name || "Unknown",
        invoiceId: invoice.id,
      });
    }

    return c.json({ received: true });
  } catch (err: any) {
    console.error("❌ Webhook Verarbeitung Fehler:", err);
    return c.text(`Processing Error: ${err.message}`, 500);
  }
});

// -------------------- CREATE CHECKOUT SESSION --------------------
app.post("/create-checkout-session", async (c) => {
  try {
    const { uid, email, priceId } = await c.req.json();
    if (!uid || !email || !priceId) {
      return c.json({ error: "Missing parameters" }, 400);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      client_reference_id: uid,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { uid } },
      success_url: "https://schriftbot.com/success",
      cancel_url: "https://schriftbot.com/",
    });

    return c.json({ url: session.url });
  } catch (err: any) {
    console.error("❌ Checkout Error:", err);
    return c.json({ error: err.message }, 500);
  }
});

// -------------------- APPLY CREDITS --------------------
async function applyCredits(
  uid: string,
  data: {
    credits: number;
    isUnlimited: boolean;
    plan: string;
    invoiceId: string;
  }
) {
  console.log("💾 Credit-Vergabe:", uid, data);

  try {
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
      lastPaymentDate: str(new Date().toISOString()),
      payments: arr([
        ...payments.map((p: any) => ({ invoiceId: str(p.invoiceId) })),
        {
          invoiceId: str(data.invoiceId),
          credits: int(data.credits),
          date: str(new Date().toISOString()),
        },
      ]),
    });

    console.log(`✅ Firestore: ${uid} → ${newCredits} Credits`);
  } catch (err: any) {
    console.error("❌ applyCredits Fehler:", err);
    throw err;
  }
}

// -------------------- HEALTH --------------------
app.get("/", (c) => c.json({ status: "ok", runtime: "deno" }));

const port = Number(Deno.env.get("PORT")) || 8000;
console.log(`🚀 Server auf Port ${port}`);
Deno.serve({ port }, app.fetch);
