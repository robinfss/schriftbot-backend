// Deno benötigt kein require("dotenv").config(),
// Umgebungsvariablen werden direkt via Deno.env.get() gelesen.

import express from "npm:express";
import cors from "npm:cors";
import Stripe from "npm:stripe";
import admin from "npm:firebase-admin";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY"));
const app = express();

// --- 1. FIREBASE INITIALISIERUNG ---
// In Deno Deploy laden wir das Service-Account-JSON am besten über eine Env-Variable
const serviceAccountVar = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
const serviceAccount = serviceAccountVar ? JSON.parse(serviceAccountVar) : null;

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else if (!serviceAccount) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT Env-Variable fehlt!");
}

const db = admin.firestore();

app.use(cors());

// --- 2. STRIPE WEBHOOK ---
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // req.body ist bei express.raw ein Buffer, das funktioniert auch in Deno
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        Deno.env.get("STRIPE_WEBHOOK_SECRET")
      );
    } catch (err) {
      console.error(`❌ Webhook Signatur Fehler: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("✅ Webhook empfangen:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.client_reference_id;

      if (!uid) {
        console.error("❌ Keine UID in Checkout Session gefunden");
        return res.json({ received: true });
      }

      try {
        const sessionWithItems = await stripe.checkout.sessions.retrieve(
          session.id,
          { expand: ["line_items.data.price.product"] }
        );

        const product = sessionWithItems.line_items.data[0].price.product;
        const creditsToAdd = parseInt(product.metadata.credits || "0");
        const isUnlimited = product.metadata.isUnlimited === "true";
        const planName = product.metadata.planName || product.name;

        await updateFirestoreUser(uid, {
          creditsToAdd,
          isUnlimited,
          planName,
          subscriptionId: session.subscription,
          customerId: session.customer,
          invoiceId: session.invoice,
          isRenewal: false,
        });
      } catch (err) {
        console.error("❌ Fehler bei Erstkauf:", err);
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      if (invoice.billing_reason === "subscription_cycle") {
        try {
          const subscription = await stripe.subscriptions.retrieve(
            invoice.subscription
          );
          const uid = subscription.metadata.uid;

          if (uid) {
            const product = await stripe.products.retrieve(
              invoice.lines.data[0].price.product
            );
            const creditsToAdd = parseInt(product.metadata.credits || "0");
            const isUnlimited = product.metadata.isUnlimited === "true";
            const planName = product.metadata.planName || product.name;

            await updateFirestoreUser(uid, {
              creditsToAdd,
              isUnlimited,
              planName,
              subscriptionId: invoice.subscription,
              customerId: invoice.customer,
              invoiceId: invoice.id,
              isRenewal: true,
            });
          }
        } catch (err) {
          console.error("❌ Fehler bei Verlängerung:", err);
        }
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const uid = subscription.metadata.uid;
      if (uid) {
        await db.collection("users").doc(uid).set(
          {
            credits: 0,
            isUnlimited: false,
            plan: "expired",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

    res.json({ received: true });
  }
);

// Hilfsfunktion (unverändert, nur Deno-kompatible Imports genutzt)
async function updateFirestoreUser(uid, data) {
  const userRef = db.collection("users").doc(uid);
  const doc = await userRef.get();

  if (
    doc.exists &&
    doc.data().payments?.some((p) => p.invoiceId === data.invoiceId)
  ) {
    return;
  }

  const currentCredits = doc.exists ? doc.data().credits || 0 : 0;
  const newCredits = data.isUnlimited
    ? 999999
    : currentCredits + data.creditsToAdd;

  await userRef.set(
    {
      credits: newCredits,
      isUnlimited: data.isUnlimited,
      plan: data.planName,
      lastPaymentStatus: "active",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      payments: admin.firestore.FieldValue.arrayUnion({
        invoiceId: data.invoiceId,
        date: new Date().toISOString(),
      }),
    },
    { merge: true }
  );
}

// --- 3. CHECKOUT & API ---
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { uid, email, priceId } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      client_reference_id: uid,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { uid } },
      success_url: `https://schriftbot.com/success`,
      cancel_url: `https://schriftbot.com/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Deno Backend Active"));

// Starten des Servers
const PORT = Deno.env.get("PORT") || 8000;
app.listen(PORT, () => console.log(`🚀 Deno Server läuft auf Port ${PORT}`));
